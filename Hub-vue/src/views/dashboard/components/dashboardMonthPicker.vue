<template>
  <span class="dashboard-month-picker">
    <button ref="trigger" type="button" class="month-trigger" :aria-label="'选择统计月份，' + selected.year + '年' + selected.month + '月'" aria-haspopup="dialog" :aria-expanded="opened" :aria-controls="panelId" @click="toggle" @keydown.down.prevent.stop="open" @keydown.up.prevent.stop="open">{{ monthLabel }}</button>
    <div :id="panelId" ref="panel" class="ui-floating-panel month-panel" popover="auto" role="dialog" aria-label="选择统计月份" :style="panelStyle" @toggle="sync" @keydown="handleKeydown" @focusout="handleFocusOut">
      <header class="month-panel-heading">
        <button type="button" class="year-nav year-nav--previous" aria-label="上一年" :disabled="viewYear <= 1000" @click="moveYear(-1)"><UiIcon name="chevron" /></button>
        <label class="year-field">
          <input v-model="yearText" class="year-input" type="text" inputmode="numeric" maxlength="4" aria-label="年份" autocomplete="off" @change="commitYear()" @keydown.enter="handleYearEnter" @keydown.up.prevent.stop="moveYear(1)" @keydown.down.prevent.stop="moveYear(-1)" />
          <span>年</span>
        </label>
        <button type="button" class="year-nav" aria-label="下一年" :disabled="viewYear >= 9999" @click="moveYear(1)"><UiIcon name="chevron" /></button>
      </header>
      <div class="month-grid" role="grid" :aria-label="viewYear + '年月份'">
        <div v-for="row in 4" :key="row" class="month-row" role="row">
          <button v-for="column in 3" :key="column" type="button" class="month-option" :class="{ 'is-selected': isSelected((row - 1) * 3 + column) }" role="gridcell" :data-month="(row - 1) * 3 + column - 1" :tabindex="activeMonth === (row - 1) * 3 + column - 1 ? 0 : -1" :aria-label="viewYear + '年' + ((row - 1) * 3 + column) + '月'" :aria-selected="isSelected((row - 1) * 3 + column)" @focus="activeMonth = (row - 1) * 3 + column - 1" @click="choose((row - 1) * 3 + column)">{{ (row - 1) * 3 + column }}月</button>
        </div>
      </div>
    </div>
  </span>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import { useFloatingPanel } from '@/composables/useFloatingPanel'

const props = defineProps<{ modelValue: string; currentYear?: number }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const selected = computed(() => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(props.modelValue)
  if (match && Number(match[1]) >= 1000) return { year: Number(match[1]), month: Number(match[2]) }
  const now = new Date()
  return { year: Math.max(1000, Math.min(9999, now.getFullYear())), month: now.getMonth() + 1 }
})
const monthLabel = computed(() => (selected.value.year === (props.currentYear ?? new Date().getFullYear()) ? '' : selected.value.year + '年') + selected.value.month + '月')
const trigger = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const panelId = 'dashboard-month-' + useId()
const viewYear = ref(selected.value.year)
const yearText = ref(String(viewYear.value))
const activeMonth = ref(selected.value.month - 1)
const { opened, panelStyle, show, hide, sync } = useFloatingPanel(trigger, panel, { width: 288, maxHeight: 320 })
const isSelected = (month: number) => selected.value.year === viewYear.value && selected.value.month === month
const focusMonth = () => nextTick(() => { if (opened.value) panel.value?.querySelectorAll<HTMLButtonElement>('[data-month]')[activeMonth.value]?.focus() })
const resetView = () => { viewYear.value = selected.value.year; yearText.value = String(viewYear.value); activeMonth.value = selected.value.month - 1 }
const open = async () => { resetView(); await show(); await focusMonth() }
const toggle = () => { if (opened.value) hide(); else void open() }
const moveYear = (step: number) => { viewYear.value = Math.max(1000, Math.min(9999, viewYear.value + step)); yearText.value = String(viewYear.value) }
const commitYear = (focus = false) => {
  const year = /^\d{4}$/.test(yearText.value) ? Number(yearText.value) : NaN
  if (year >= 1000 && year <= 9999) viewYear.value = year
  yearText.value = String(viewYear.value)
  if (focus) void focusMonth()
}
const handleYearEnter = (event: KeyboardEvent) => {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault(); event.stopPropagation(); commitYear(true)
}
const choose = (month: number) => {
  if (!Number.isInteger(month) || month < 1 || month > 12) return
  commitYear()
  const value = String(viewYear.value).padStart(4, '0') + '-' + String(month).padStart(2, '0')
  if (value !== props.modelValue) emit('update:modelValue', value)
  hide(true)
}
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(true); return }
  if (!(event.target as HTMLElement | null)?.matches('[data-month]')) return
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'PageUp' || event.key === 'PageDown') moveYear(event.key === 'PageUp' ? -1 : 1)
  else if (event.key === 'Home' || event.key === 'End') activeMonth.value = event.key === 'Home' ? 0 : 11
  else {
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -3 : 3
    const ordinal = Math.max(1000 * 12, Math.min(9999 * 12 + 11, viewYear.value * 12 + activeMonth.value + step))
    viewYear.value = Math.floor(ordinal / 12)
    yearText.value = String(viewYear.value)
    activeMonth.value = ordinal % 12
  }
  void focusMonth()
}
const handleFocusOut = (event: FocusEvent) => {
  const next = event.relatedTarget as Node | null
  if (next && next !== trigger.value && !panel.value?.contains(next)) hide()
}
watch(() => props.modelValue, () => { if (opened.value) { resetView(); void focusMonth() } })
</script>
<style scoped>
.dashboard-month-picker { display: inline; }
.month-trigger { display: inline-flex; align-items: baseline; margin: 0 3px 0 0; padding: 0; border: 0; border-radius: 8px; background: transparent; color: #3964fe; font-family: inherit; font-size: 30px; font-weight: inherit; line-height: inherit; letter-spacing: inherit; vertical-align: baseline; cursor: pointer; }
.month-trigger:hover { color: #2751e8; background: #3964fe08; }
.month-panel { padding: 14px; border-radius: 18px; box-shadow: 0 6px 12px #20283808, 0 16px 40px #20283818; }
.month-panel:popover-open { animation: month-panel-enter .16s ease-out; }
.month-panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.year-nav { display: grid; place-items: center; flex: 0 0 auto; width: 34px; height: 34px; padding: 8px; border: 0; border-radius: 11px; background: transparent; color: #77849a; }
.year-nav:hover:not(:disabled),.year-nav:focus-visible { background: #f0f2f6; color: #475269; }
.year-nav:disabled { opacity: .3; cursor: default; }
.year-nav--previous .ui-icon { transform: rotate(180deg); }
.year-nav .ui-icon { width: 17px; height: 17px; }
.year-field { display: flex; align-items: center; justify-content: center; gap: 2px; color: #475269; font-size: 16px; font-weight: 550; }
.year-input { width: 55px; min-width: 0; padding: 4px 2px; border: 0; border-radius: 7px; outline: none; background: transparent; color: inherit; font: inherit; font-variant-numeric: tabular-nums; text-align: center; }
.year-input:hover,.year-input:focus { background: #f0f2f6; }
.month-grid { display: grid; gap: 8px; }
.month-row { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px; }
.month-option { min-width: 0; min-height: 42px; padding: 10px 6px; border: 0; border-radius: 12px; background: transparent; color: #5c6980; font-family: inherit; font-size: 14px; }
.month-option:hover,.month-option:focus-visible { background: #f0f2f6; }
.month-option.is-selected { color: #3964fe; background: #eaf0ff; font-weight: 600; }
@keyframes month-panel-enter { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@media(max-width:760px) { .month-trigger { font-size: 23px; } .month-option { min-height: 44px; } .year-nav { width: 38px; height: 38px; } }
@media(prefers-reduced-motion:reduce) { .month-panel:popover-open { animation: none; } }
</style>
