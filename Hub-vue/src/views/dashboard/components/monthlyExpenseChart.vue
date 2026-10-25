<template>
  <article class="monthly-chart" :aria-busy="loading">
    <h2>月支出对比</h2>
    <div v-if="loading" class="monthly-chart-state" role="status">正在加载…</div>
    <div v-else-if="!months.length" class="monthly-chart-state">暂无支出数据</div>
    <div v-else ref="chartElement" class="monthly-chart-interaction" tabindex="0" role="group" aria-roledescription="可交互柱状图" aria-label="月支出对比，使用左右方向键选择月份，Home 跳到首月，End 跳到末月" :aria-describedby="descriptionId" @pointerdown="handlePointerDown" @pointermove="handlePointerMove" @pointerup="finishPointer" @pointercancel="finishPointer" @pointerleave="handlePointerLeave" @focus="handleFocus" @blur="clearSelection" @keydown="handleKeydown">
      <svg class="monthly-chart-svg" :viewBox="'0 0 ' + chartWidth + ' ' + chartHeight" :height="chartHeight" role="img" :aria-labelledby="titleId + ' ' + descriptionId">
        <title :id="titleId">月支出对比</title>
        <g v-for="tick in scale.ticks" :key="tick" class="monthly-grid">
          <line :x1="plotLeft" :x2="plotRight" :y1="valueY(tick)" :y2="valueY(tick)" />
          <text :x="plotLeft - 10" :y="valueY(tick) + 4" text-anchor="end">{{ formatExpenseAxis(tick) }}</text>
        </g>
        <g v-for="(point, index) in months" :key="point.month">
          <rect v-if="point.amountCents" class="monthly-bar" :class="{ 'is-selected': index === selectedIndex }" :x="pointX(index) - barWidth / 2" :y="barY(point.amountCents)" :width="barWidth" :height="barHeight(point.amountCents)" :rx="Math.min(6, barWidth / 2)" />
          <line v-else class="monthly-zero" :x1="pointX(index) - barWidth / 2" :x2="pointX(index) + barWidth / 2" :y1="plotBottom" :y2="plotBottom" />
        </g>
        <g class="monthly-labels">
          <text v-for="index in labelIndices" :key="index" :x="pointX(index)" :y="plotBottom + 27" text-anchor="middle">{{ months[index].month.replace('-', '/') }}</text>
        </g>
      </svg>
      <div v-if="selectedPoint" class="monthly-tooltip" :class="{ 'monthly-tooltip--inline': inlineTooltip }" :style="tooltipStyle" aria-hidden="true">
        <span>{{ selectedPoint.month.replace('-', '/') }}</span>
        <strong>{{ formatCents(selectedPoint.amountCents) }}</strong>
      </div>
      <p :id="descriptionId" class="monthly-sr-only" aria-live="polite">{{ selectedPoint ? selectedPoint.month.replace('-', '年') + '月，支出' + formatCents(selectedPoint.amountCents) + '元' : '选择月份查看支出。' }}</p>
    </div>
  </article>
</template>
<script setup lang="ts">
import type { CSSProperties } from 'vue'
import type { MonthlyExpensePoint } from '@/types/dashboard'

import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { createExpenseScale, formatExpenseAxis } from '@/utils/expenseChart'
import { getMonthlyExpenseLabels, nearestExpenseMonth } from '@/utils/monthlyExpenses'
import { formatCents } from '@/utils/funds'

const props = withDefaults(defineProps<{ points: readonly MonthlyExpensePoint[]; loading?: boolean }>(), { loading: false })
const identity = useId()
const titleId = 'monthly-expense-title-' + identity
const descriptionId = 'monthly-expense-description-' + identity
const chartElement = ref<HTMLElement | null>(null)
const chartWidth = ref(640)
const selectedIndex = ref<number | null>(null)
let observer: ResizeObserver | null = null
let resizeFrame: number | undefined
let activePointer: number | null = null
const months = computed(() => props.points)
// 提示独占顶部空间，柱形绘图区保留原有高度。
const inlineTooltip = computed(() => chartWidth.value >= 480)
const tooltipHeight = computed(() => inlineTooltip.value ? 48 : 78)
const chartHeight = computed(() => (chartWidth.value < 480 ? 252 : 280) + tooltipHeight.value)
const scale = computed(() => createExpenseScale(Math.max(0, ...months.value.map(point => point.amountCents))))
const plotLeft = computed(() => Math.max(42, Math.min(88, Math.max(...scale.value.ticks.map(tick => formatExpenseAxis(tick).length)) * 7 + 14)))
const plotRight = computed(() => chartWidth.value - 28)
const plotTop = computed(() => 16 + tooltipHeight.value)
const plotBottom = computed(() => chartHeight.value - 38)
const plotWidth = computed(() => Math.max(1, plotRight.value - plotLeft.value))
const slotWidth = computed(() => plotWidth.value / Math.max(1, months.value.length))
const barWidth = computed(() => Math.max(4, Math.min(34, slotWidth.value * .58)))
const labelIndices = computed(() => getMonthlyExpenseLabels(months.value.length, plotWidth.value))
const pointX = (index: number) => plotLeft.value + slotWidth.value * (index + .5)
const valueY = (cents: number) => plotBottom.value - cents / scale.value.maximum * (plotBottom.value - plotTop.value)
const barHeight = (cents: number) => cents ? Math.max(2, plotBottom.value - valueY(cents)) : 0
const barY = (cents: number) => plotBottom.value - barHeight(cents)
const selectedPoint = computed(() => selectedIndex.value === null ? null : months.value[selectedIndex.value] ?? null)
const tooltipStyle = computed<CSSProperties>(() => {
  const amount = formatCents(selectedPoint.value?.amountCents ?? 0)
  const width = Math.min(inlineTooltip.value ? 320 : 212, Math.max(inlineTooltip.value ? 176 : 132, amount.length * 12 + (inlineTooltip.value ? 106 : 30)), chartWidth.value - 16)
  return {
    width: width + 'px',
    height: tooltipHeight.value + 'px',
    left: Math.max(8, Math.min(pointX(selectedIndex.value ?? 0) - width / 2, chartWidth.value - width - 8)) + 'px',
    top: plotTop.value - tooltipHeight.value - 12 + 'px',
    '--monthly-amount-size': Math.min(20, (width - 30 - (inlineTooltip.value ? 72 : 0)) / (amount.length * .62)) + 'px'
  }
})
const selectAt = (event: PointerEvent) => {
  if (props.loading || !months.value.length) return
  const bounds = chartElement.value?.getBoundingClientRect()
  if (!bounds?.width) return
  const x = (event.clientX - bounds.left) / bounds.width * chartWidth.value
  selectedIndex.value = nearestExpenseMonth(x, plotLeft.value, plotWidth.value, months.value.length)
}
const handlePointerDown = (event: PointerEvent) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  activePointer = event.pointerId
  selectAt(event)
}
const handlePointerMove = (event: PointerEvent) => {
  if (event.pointerType === 'touch' && activePointer !== event.pointerId) return
  selectAt(event)
}
const finishPointer = (event?: PointerEvent) => { if (!event || activePointer === event.pointerId) activePointer = null }
const clearSelection = () => { selectedIndex.value = null; activePointer = null }
const handlePointerLeave = (event: PointerEvent) => {
  if (event.pointerType === 'touch') return
  const element = chartElement.value
  if (element?.ownerDocument.activeElement !== element) clearSelection()
}
const handleFocus = () => { if (!props.loading && months.value.length && selectedIndex.value === null) selectedIndex.value = months.value.length - 1 }
const handleKeydown = (event: KeyboardEvent) => {
  if (props.loading || !months.value.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = selectedIndex.value ?? months.value.length - 1
  selectedIndex.value = event.key === 'Home' ? 0 : event.key === 'End' ? months.value.length - 1 : Math.max(0, Math.min(months.value.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))
}
const updateWidth = () => { if (chartElement.value?.clientWidth) chartWidth.value = Math.max(180, chartElement.value.clientWidth) }
const queueWidthUpdate = () => {
  if (resizeFrame !== undefined) return
  resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; updateWidth() })
}
watch([months, () => props.loading], clearSelection)
watch(chartElement, (element, previous) => {
  if (previous) observer?.unobserve(previous)
  if (element) { observer?.observe(element); queueWidthUpdate() }
}, { flush: 'post' })
onMounted(() => {
  observer = new ResizeObserver(queueWidthUpdate)
  if (chartElement.value) observer.observe(chartElement.value)
  queueWidthUpdate()
})
onUnmounted(() => { observer?.disconnect(); if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame); activePointer = null })
</script>
<style scoped>
.monthly-chart { min-width: 0; padding: 24px 24px 20px; border: 1px solid var(--line,#e9edf3); border-radius: 22px; background: #fff; box-shadow: 0 5px 22px #27334b07; }
.monthly-chart h2 { margin: 0 0 20px; color: var(--text,#273248); font-size: 17px; font-weight: 600; }
.monthly-chart-interaction { position: relative; min-width: 0; border-radius: 12px; outline: none; touch-action: pan-y; }
.monthly-chart-interaction:focus-visible { outline: 2px solid #a0b5ff; outline-offset: 5px; }
.monthly-chart-svg { display: block; width: 100%; overflow: visible; user-select: none; }
.monthly-grid line { stroke: #edf0f5; stroke-width: 1; }
.monthly-grid text,.monthly-labels text { fill: #98a2b4; font-family: inherit; font-size: 11px; font-variant-numeric: tabular-nums; }
.monthly-bar { fill: #3964fe; opacity: .72; transition: opacity .16s ease; }
.monthly-bar.is-selected { opacity: 1; }
.monthly-zero { stroke: #d6def3; stroke-width: 2; stroke-linecap: round; }
.monthly-tooltip { position: absolute; z-index: 1; box-sizing: border-box; max-width: calc(100% - 16px); padding: 12px 14px; border: 1px solid #e9edf5; border-radius: 13px; background: #fffffffa; box-shadow: 0 6px 24px #27334b14; pointer-events: none; }
.monthly-tooltip > span { display: block; margin-bottom: 6px; color: #79859a; font-size: 14px; }
.monthly-tooltip--inline { display: flex; align-items: center; gap: 12px; }
.monthly-tooltip--inline > span { flex: 0 0 auto; margin-bottom: 0; }
.monthly-tooltip strong { display: block; color: #34425e; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.3; white-space: nowrap; font-size: var(--monthly-amount-size,20px); }
.monthly-chart-state { display: grid; min-height: 280px; place-items: center; color: var(--muted,#8a94a5); font-size: 14px; }
.monthly-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); }
@media(max-width:480px) { .monthly-chart { padding: 20px 16px 17px; border-radius: 18px; } .monthly-chart h2 { margin-bottom: 16px; font-size: 16px; } .monthly-chart-state { min-height: 252px; } }
@media(prefers-reduced-motion:reduce) { .monthly-bar { transition: none; } }
</style>
