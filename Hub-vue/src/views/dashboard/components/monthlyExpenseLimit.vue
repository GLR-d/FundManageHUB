<template>
  <article class="monthly-limit" :aria-busy="monthlyLimitLoading || loading">
    <header class="limit-header">
      <h2>{{ periodLabel }}限额</h2>
      <div v-if="ready && progress.configured" class="limit-amounts">
        <strong :class="{ 'is-exceeded': progress.exceeded }">{{ formatCents(expenseCents) }}</strong>
        <span>/ {{ formatCents(monthlyLimitCents!) }}</span>
      </div>
      <RouterLink v-else-if="monthlyLimitLoaded && !monthlyLimitError && monthlyLimitCents === null" to="/setting" class="limit-settings">设置限额</RouterLink>
    </header>
    <div v-if="monthlyLimitError" class="limit-state" role="status">
      <span>限额加载失败</span>
      <UiButton size="small" :loading="monthlyLimitLoading" @click="loadMonthlyLimit(true)">重试</UiButton>
    </div>
    <div v-else-if="!monthlyLimitLoaded" class="limit-state" role="status">正在加载限额…</div>
    <div v-else-if="monthlyLimitCents === null" class="limit-track" aria-label="尚未设置每月花销限额" />
    <div v-else-if="!statisticsLoaded" class="limit-state" role="status">{{ loading ? '正在加载支出…' : '支出暂不可用' }}</div>
    <template v-else>
      <div ref="interactionElement" class="limit-interaction" role="group" aria-roledescription="可交互进度条" :tabindex="canInteract ? 0 : undefined" :aria-label="periodLabel + '分类支出，使用左右方向键查看分类，Home 跳到首项，End 跳到末项'" :aria-describedby="descriptionId" @pointerleave="handlePointerLeave" @focus="handleFocus" @blur="clearSelection" @keydown="handleKeydown">
        <div class="limit-track" role="progressbar" :aria-label="periodLabel + '支出限额'" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="progress.progressValue" :aria-valuetext="progressDescription" @pointerdown="handlePointerDown" @pointermove="handlePointerMove" @pointerup="finishPointer" @pointercancel="clearSelection">
          <span v-for="segment in progress.segments" :key="segment.type" class="limit-segment" :style="{ width: segment.widthPercentage + '%', background: 'color-mix(in srgb, ' + segment.backgroundColor + ' 90%, ' + segment.color + ')' }" aria-hidden="true" />
        </div>
        <div v-if="selectedSegment" class="limit-tooltip" :style="tooltipStyle" aria-hidden="true">
          <span>{{ selectedSegment.label }}</span><strong>{{ formatCents(selectedSegment.amountCents) }}</strong>
        </div>
        <p :id="descriptionId" class="limit-sr-only" aria-live="polite">{{ selectedSegment ? selectedSegment.label + '，支出 ' + formatCents(selectedSegment.amountCents) + ' 元' : '' }}</p>
      </div>
      <div class="limit-footer">
        <ul class="limit-tags" aria-label="限额支出分类">
          <li v-for="segment in progress.segments" :key="segment.type" :style="{ background: segment.backgroundColor, color: segment.color }" :title="segment.label + ' ' + formatCents(segment.amountCents)">
            <i :style="{ background: segment.color }" aria-hidden="true" />{{ segment.label }}
          </li>
        </ul>
        <p class="limit-usage"><span>已用 {{ progress.percentage }}</span><span>{{ progress.exceeded ? '超出 ' + formatCents(progress.overCents) : '剩余 ' + formatCents(progress.remainingCents) }}</span></p>
      </div>
    </template>
  </article>
</template>
<script setup lang="ts">
import type { CSSProperties } from 'vue'
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { CategoryExpensePoint } from '@/types/dashboard'

import UiButton from '@/components/ui/uiButton.vue'
import { formatCents } from '@/utils/funds'
import { buildMonthlyLimitProgress } from '@/utils/monthlyLimitProgress'
import { monthlyLimitCents, monthlyLimitLoaded, monthlyLimitLoading, monthlyLimitError, loadMonthlyLimit } from '@/stores/monthlyLimit'

const props = withDefaults(defineProps<{ expenseCents: number; categories: readonly CategoryExpensePoint[]; periodLabel?: string; statisticsLoaded?: boolean; loading?: boolean }>(), { periodLabel: '本月', statisticsLoaded: false, loading: false })
const ready = computed(() => props.statisticsLoaded && monthlyLimitLoaded.value && !monthlyLimitError.value)
const progress = computed(() => buildMonthlyLimitProgress(ready.value ? monthlyLimitCents.value : null, props.expenseCents, props.categories))
const progressDescription = computed(() => props.periodLabel + '已支出 ' + formatCents(props.expenseCents) + '，限额 ' + formatCents(monthlyLimitCents.value!) + '，已用 ' + progress.value.percentage + '，' + (progress.value.exceeded ? '超出 ' + formatCents(progress.value.overCents) : '剩余 ' + formatCents(progress.value.remainingCents)))
const descriptionId = 'monthly-limit-description-' + useId()
const interactionElement = ref<HTMLElement | null>(null)
const interactionWidth = ref(0)
const selectedIndex = ref<number | null>(null)
const canInteract = computed(() => ready.value && progress.value.configured && progress.value.segments.length > 0 && !monthlyLimitLoading.value && !props.loading)
const selectedSegment = computed(() => canInteract.value && selectedIndex.value !== null ? progress.value.segments[selectedIndex.value] ?? null : null)
let observer: ResizeObserver | null = null
let resizeFrame: number | undefined
let activePointer: number | null = null
let pointerSelection = false
const tooltipStyle = computed<CSSProperties>(() => {
  const segment = selectedSegment.value
  if (!segment) return {}
  const amount = formatCents(segment.amountCents)
  const labelWidth = segment.label.length * 14
  const width = Math.max(0, Math.min(320, Math.max(176, amount.length * 12 + labelWidth + 42), interactionWidth.value - 16))
  const previousWidth = progress.value.segments.slice(0, selectedIndex.value!).reduce((sum, point) => sum + point.widthPercentage, 0)
  const center = (previousWidth + segment.widthPercentage / 2) / 100 * interactionWidth.value
  return {
    width: width + 'px',
    left: Math.max(8, Math.min(center - width / 2, interactionWidth.value - width - 8)) + 'px',
    '--limit-amount-size': Math.min(20, (width - labelWidth - 42) / (amount.length * .62)) + 'px'
  }
})
const updateWidth = () => { if (interactionElement.value?.clientWidth) interactionWidth.value = interactionElement.value.clientWidth }
const queueWidthUpdate = () => {
  if (resizeFrame !== undefined) return
  resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; updateWidth() })
}
const clearSelection = () => { selectedIndex.value = null; activePointer = null; pointerSelection = false }
const selectAt = (event: PointerEvent) => {
  if (!canInteract.value) return
  const bounds = interactionElement.value?.getBoundingClientRect()
  if (!bounds?.width) return
  updateWidth()
  pointerSelection = true
  const percentage = (event.clientX - bounds.left) / bounds.width * 100
  if (percentage < 0 || percentage > 100) { selectedIndex.value = null; return }
  let end = 0
  const index = progress.value.segments.findIndex((segment, index) => {
    end += segment.widthPercentage
    return percentage < end || (index === progress.value.segments.length - 1 && end >= 100 && percentage === 100)
  })
  selectedIndex.value = index < 0 ? null : index
}
const handlePointerDown = (event: PointerEvent) => {
  if (!canInteract.value || (event.pointerType === 'mouse' && event.button !== 0)) return
  activePointer = event.pointerId
  selectAt(event)
}
const handlePointerMove = (event: PointerEvent) => {
  if (event.pointerType === 'touch' && activePointer !== event.pointerId) return
  selectAt(event)
}
const finishPointer = (event: PointerEvent) => { if (activePointer === event.pointerId) activePointer = null }
const handlePointerLeave = (event: PointerEvent) => { if (event.pointerType !== 'touch' && pointerSelection) clearSelection() }
const handleFocus = () => { if (canInteract.value && !pointerSelection && selectedIndex.value === null) { updateWidth(); selectedIndex.value = 0 } }
const handleKeydown = (event: KeyboardEvent) => {
  if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
  if (event.key === 'Escape') { event.preventDefault(); clearSelection(); return }
  if (!canInteract.value || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  pointerSelection = false
  const index = selectedIndex.value ?? 0
  selectedIndex.value = event.key === 'Home' ? 0 : event.key === 'End' ? progress.value.segments.length - 1 : Math.max(0, Math.min(progress.value.segments.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))
  updateWidth()
}
watch([progress, () => props.periodLabel, () => props.loading, monthlyLimitLoading], clearSelection)
watch(interactionElement, (element, previous) => {
  if (previous) observer?.unobserve(previous)
  if (element) { observer?.observe(element); queueWidthUpdate() }
}, { flush: 'post' })
onMounted(() => {
  observer = new ResizeObserver(queueWidthUpdate)
  if (interactionElement.value) observer.observe(interactionElement.value)
  queueWidthUpdate()
  void loadMonthlyLimit(true)
})
onUnmounted(() => { observer?.disconnect(); if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame); activePointer = null })
</script>
<style scoped>
.monthly-limit { min-width: 0; margin-top: 22px; padding: 22px 24px; border: 1px solid var(--line); border-radius: 20px; background: var(--surface); box-shadow: 0 5px 22px #27334b07; }
.limit-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px 20px; }
.limit-header h2 { margin: 0; color: var(--text); font-size: 18px; font-weight: 600; line-height: 1.5; }
.limit-amounts { display: flex; align-items: baseline; flex-wrap: wrap; justify-content: flex-end; gap: 6px; min-width: 0; font-variant-numeric: tabular-nums; }
.limit-amounts strong { color: var(--expense-color); font-size: 20px; font-weight: 600; overflow-wrap: anywhere; }
.limit-amounts strong.is-exceeded { color: var(--income-color); }
.limit-amounts > span { color: #7b8495; font-size: 15px; overflow-wrap: anywhere; }
.limit-settings { padding: 6px 12px; border-radius: 999px; background: var(--primary-soft); color: var(--primary); font-size: 14px; }
.limit-settings:hover { background: #e2e8ff; }
.limit-track { display: flex; min-width: 0; height: 18px; margin-top: 18px; overflow: hidden; border-radius: 999px; background: #eff2f6; }
.limit-segment { display: block; flex: 0 0 auto; height: 100%; }
.limit-interaction { position: relative; min-width: 0; margin-top: 18px; border-radius: 999px; outline: none; touch-action: pan-y; }
.limit-interaction:focus-visible { outline: 2px solid #a0b5ff; outline-offset: 5px; }
.limit-interaction .limit-track { margin-top: 0; }
.limit-tooltip { position: absolute; bottom: calc(100% + 12px); z-index: 2; display: flex; align-items: center; gap: 12px; box-sizing: border-box; max-width: calc(100% - 16px); min-height: 48px; padding: 12px 14px; border: 1px solid #e9edf5; border-radius: 13px; background: #fffffffa; box-shadow: 0 6px 24px #27334b14; pointer-events: none; }
.limit-tooltip > span { flex: 0 0 auto; color: #79859a; font-size: 14px; }
.limit-tooltip strong { color: #34425e; font-size: var(--limit-amount-size,20px); font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.3; white-space: nowrap; }
.limit-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); }
.limit-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px 20px; margin-top: 14px; }
.limit-tags { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; margin: 0; padding: 0; list-style: none; }
.limit-tags li { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; color: #59657a; font-size: 13px; line-height: 1.4; }
.limit-tags i { flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%; }
.limit-usage { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px 16px; margin: 0; color: #667187; font-size: 14px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.limit-state { display: flex; align-items: center; justify-content: center; gap: 14px; min-height: 52px; color: var(--muted); font-size: 14px; }
</style>
