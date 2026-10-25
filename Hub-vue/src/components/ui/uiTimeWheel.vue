<template>
  <div class="ui-time-wheel" :class="{ 'is-disabled': disabled }">
    <div :id="id" ref="wheel" class="ui-time-wheel-list" role="listbox" :aria-label="label" :title="title" aria-orientation="vertical" :aria-disabled="disabled || undefined" :aria-activedescendant="id + '-' + modelValue" :tabindex="disabled ? -1 : 0" @scroll.passive="handleScroll" @keydown="handleKeydown">
      <button v-for="value in values" :id="id + '-' + value" :key="value" type="button" role="option" class="ui-time-wheel-option" :class="{ 'is-selected': value === modelValue }" :aria-label="padTime(value) + ' ' + label" :aria-selected="value === modelValue" tabindex="-1" :disabled="disabled" @click="choose(value)">{{ padTime(value) }}</button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { padTime } from '@/utils/dateTime'
const props = defineProps({
  modelValue: { type: Number, default: 0 },
  max: { type: Number, required: true },
  label: String,
  title: String,
  id: String,
  disabled: Boolean,
  active: Boolean
})
const emit = defineEmits<{ 'update:modelValue': [value: number]; confirm: [] }>()
const values = computed(() => Array.from({ length: props.max }, (_, index) => index))
const wheel = ref<HTMLElement | null>(null)
// 与 CSS 中每一行的高度保持一致，顶部和底部各留一行以居中首尾选项。
const rowHeight = 36
const clamp = (value: number) => Math.max(0, Math.min(props.max - 1, value))
const getValue = () => wheel.value && props.active ? clamp(Math.round(wheel.value.scrollTop / rowHeight)) : props.modelValue
let scrollTimer: ReturnType<typeof setTimeout> | undefined
let scrolling = false
let scrollValue: number | null = null
let disposed = false
const stopScrolling = () => { clearTimeout(scrollTimer); scrollTimer = undefined; scrolling = false }
const align = (value: number) => { if (wheel.value && props.active) wheel.value.scrollTop = clamp(value) * rowHeight }
const update = (value: number) => { if (value !== props.modelValue) emit('update:modelValue', value) }
const choose = (value: number) => {
  if (props.disabled || !props.active) return
  stopScrolling()
  const next = clamp(value)
  update(next)
  align(next)
  wheel.value?.focus({ preventScroll: true })
}
const handleScroll = () => {
  if (props.disabled || !props.active || !wheel.value) return
  const next = getValue()
  if (!scrolling && next === props.modelValue && Math.abs(wheel.value.scrollTop - next * rowHeight) < .5) return
  scrolling = true
  scrollValue = next
  update(next)
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => {
    if (disposed || props.disabled || !props.active) return
    const value = getValue()
    stopScrolling()
    update(value)
    align(value)
  }, 140)
}
const handleKeydown = (event: KeyboardEvent) => {
  if (props.disabled || !props.active) return
  const moves: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }
  if (Object.hasOwn(moves, event.key) || event.key === 'Home' || event.key === 'End') {
    event.preventDefault(); event.stopPropagation()
    choose(event.key === 'Home' ? 0 : event.key === 'End' ? props.max - 1 : getValue() + moves[event.key])
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault(); event.stopPropagation()
    choose(getValue())
    if (event.key === 'Enter') emit('confirm')
  }
}
watch(() => [props.modelValue, props.active], () => {
  if (!props.active) { stopScrolling(); return }
  // 不打断鼠标滚轮或手指滑动；外部“现在”等操作仍能立即定位到新值。
  if (scrolling && props.modelValue === scrollValue) return
  stopScrolling()
  nextTick(() => { if (!disposed) align(props.modelValue) })
}, { immediate: true })
watch(() => props.disabled, disabled => { if (disabled) stopScrolling() })
onUnmounted(() => { disposed = true; stopScrolling() })
defineExpose({ getValue })
</script>
