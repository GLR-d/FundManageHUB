<template>
  <span class="ui-date-time" :class="$attrs.class" :style="$attrs.style">
    <button ref="trigger" v-bind="controlAttributes()" :id="String($attrs.id || field?.id || '') || undefined" type="button" class="ui-date-trigger" data-ui-control :disabled="isDisabled" aria-haspopup="dialog" :aria-expanded="opened" :aria-controls="panelId" :aria-invalid="Boolean(field?.error.value) || undefined" :aria-describedby="field?.error.value ? field.id + '-error' : undefined" @click="toggle">
      <UiIcon name="calendar" />
      <span :class="{ 'is-placeholder': !modelValue }">{{ displayValue }}</span>
      <UiIcon name="chevron" class="ui-select-chevron" />
    </button>
    <div :id="panelId" ref="panel" class="ui-floating-panel ui-date-panel" popover="auto" role="dialog" aria-label="选择账单日期和时间" :style="panelStyle" @toggle="sync" @keydown.esc.prevent.stop="hide(true)">
      <div class="ui-date-content">
        <div class="ui-date-calendar">
          <div class="ui-calendar-heading">
            <button type="button" class="ui-calendar-nav" aria-label="上一个月" title="上一个月" :disabled="isDisabled || (view.year === 1 && view.month === 1)" @click="changeMonth(-1)"><UiIcon name="chevron" class="ui-chevron-left" /></button>
            <strong aria-live="polite">{{ view.year }}年 {{ view.month }}月</strong>
            <button type="button" class="ui-calendar-nav" aria-label="下一个月" title="下一个月" :disabled="isDisabled || (view.year === 9999 && view.month === 12)" @click="changeMonth(1)"><UiIcon name="chevron" /></button>
          </div>
          <div class="ui-calendar-weekdays" aria-hidden="true"><span v-for="day in weekdays" :key="day">{{ day }}</span></div>
          <div class="ui-calendar-grid" role="grid" aria-label="选择日期" @keydown="navigateDays">
            <div v-for="(week, weekIndex) in weeks" :key="weekIndex" class="ui-calendar-week" role="row">
              <button v-for="day in week" :key="day.key" type="button" role="gridcell" class="ui-calendar-day" :class="{ 'is-muted': !day.currentMonth, 'is-selected': day.key === selectedDate, 'is-today': day.key === today }" :data-date="day.key" :aria-label="day.year + '年' + day.month + '月' + day.day + '日'" :aria-selected="day.key === selectedDate" :aria-current="day.key === today ? 'date' : undefined" :tabindex="day.key === focusDate ? 0 : -1" :disabled="day.disabled || isDisabled" @click="selectDay(day)">{{ day.day }}</button>
            </div>
          </div>
        </div>
        <div class="ui-time-controls">
          <div v-for="part in timeParts" :key="part.key" class="ui-time-unit">
            <span class="ui-time-label" :title="part.title">{{ part.label }}</span>
            <UiTimeWheel :id="panelId + '-' + part.key" :ref="element => { timeWheels[part.key] = element as InstanceType<typeof UiTimeWheel> | null }" v-model="draft[part.key]" :max="part.max" :label="part.label" :title="part.title" :disabled="isDisabled" :active="opened" @confirm="apply" />
          </div>
        </div>
      </div>
      <div class="ui-date-footer">
        <button type="button" class="ui-date-link" :disabled="isDisabled" @click="clear">清空</button>
        <button type="button" class="ui-date-link" :disabled="isDisabled" @click="selectNow">现在</button>
        <UiButton type="primary" size="small" :disabled="isDisabled" @click="apply">确定</UiButton>
      </div>
    </div>
  </span>
</template>
<script setup lang="ts">
import type { DateParts } from '@/types/dateTime'
import type { FieldContext, FormContext } from '@/types/ui'


import { computed, inject, nextTick, ref, useAttrs, useId, watch } from 'vue'
import UiButton from './uiButton.vue'
import UiIcon from './uiIcon.vue'
import UiTimeWheel from './uiTimeWheel.vue'
import { useFloatingPanel } from '@/composables/useFloatingPanel'
import { calendarDays, dateKey, formatDateTime, localDateTime, parseDateTime, shiftDate, shiftMonth } from '@/utils/dateTime'
defineOptions({ inheritAttrs: false })
const props = defineProps({ modelValue: String, disabled: Boolean })
const emit = defineEmits<{ 'update:modelValue': [value: string]; change: [value: string] }>()
const attrs = useAttrs()
const controlAttributes = () => Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'class' && key !== 'style'))
const field = inject<FieldContext | null>('ui-field', null)
const form = inject<FormContext | null>('ui-form', null)
const isDisabled = computed(() => props.disabled || Boolean(form?.disabled?.value))
const displayValue = computed(() => { const value = parseDateTime(props.modelValue); return value ? formatDateTime(value) : props.modelValue || '选择日期和时间' })
const draft = ref(localDateTime())
const view = ref({ year: draft.value.year, month: draft.value.month })
const selectedDate = computed(() => dateKey(draft.value))
const focusDate = ref(selectedDate.value)
const timeWheels: Partial<Record<'hour' | 'minute', { getValue: () => number } | null>> = {}
const today = dateKey(localDateTime())
const days = computed(() => calendarDays(view.value.year, view.value.month))
const weeks = computed(() => Array.from({ length: 6 }, (_, index) => days.value.slice(index * 7, index * 7 + 7)))
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const timeParts: { key: 'hour' | 'minute'; label: string; max: number; title: string }[] = [{ key: 'hour', label: '小时', max: 24, title: '选择小时（00–23）' }, { key: 'minute', label: '分钟', max: 60, title: '选择分钟（00–59）' }]
const trigger = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const panelId = 'date-time-' + useId()
const { opened, panelStyle, show, hide, sync } = useFloatingPanel(trigger, panel, { width: 460, maxHeight: 520 })
const resetDraft = () => {
  draft.value = parseDateTime(props.modelValue) || localDateTime()
  view.value = { year: draft.value.year, month: draft.value.month }
  focusDate.value = selectedDate.value
}
const focusDay = () => nextTick(() => { if (opened.value) panel.value?.querySelector<HTMLElement>('[data-date="' + focusDate.value + '"]')?.focus() })
const toggle = async () => {
  if (isDisabled.value) return
  if (opened.value) { hide(); return }
  resetDraft()
  await show()
  focusDay()
}
const selectDay = (day: DateParts & { disabled?: boolean }) => {
  if (isDisabled.value || day.disabled) return
  draft.value = { ...draft.value, year: day.year, month: day.month, day: day.day }
  view.value = { year: day.year, month: day.month }
  focusDate.value = selectedDate.value
  focusDay()
}
const changeMonth = (delta: number) => {
  view.value = shiftMonth(view.value.year, view.value.month, delta)
  focusDate.value = dateKey({ ...view.value, day: 1 })
}
const navigateDays = (event: KeyboardEvent) => {
  const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
  if (!Object.hasOwn(moves, event.key)) return
  event.preventDefault()
  const focusedDay = days.value.find(day => day.key === (event.target as HTMLElement).dataset.date) || draft.value
  selectDay(shiftDate({ ...draft.value, ...focusedDay }, moves[event.key]))
}
const selectNow = () => {
  if (isDisabled.value) return
  draft.value = localDateTime()
  view.value = { year: draft.value.year, month: draft.value.month }
  focusDate.value = selectedDate.value
  focusDay()
}
const commit = (value: string) => {
  if (isDisabled.value || trigger.value?.matches(':disabled')) return
  emit('update:modelValue', value)
  emit('change', value)
  hide(true)
  nextTick(() => field?.validate?.())
}
const apply = () => {
  if (isDisabled.value) return
  // 确认时直接读取滚轮位置，快速滚动后立即点击也会保存当前显示的时间。
  for (const part of timeParts) {
    const value = timeWheels[part.key]?.getValue()
    if (value !== undefined && Number.isInteger(value) && value >= 0 && value < part.max) draft.value[part.key] = value
  }
  commit(formatDateTime(draft.value))
}
const clear = () => commit('')
watch(isDisabled, disabled => { if (disabled) hide() })
watch(() => props.modelValue, () => { if (opened.value) resetDraft() })
defineExpose({ focus: () => trigger.value?.focus() })
</script>
