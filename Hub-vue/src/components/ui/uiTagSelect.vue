<template>
  <div v-bind="$attrs" :id="String($attrs.id || field?.id || groupId)" ref="root" class="ui-tag-select" role="radiogroup" data-ui-control tabindex="-1" :aria-disabled="isDisabled || undefined" :aria-readonly="readonly || undefined" :aria-invalid="Boolean(field?.error.value) || undefined" :aria-describedby="field?.error.value ? field.id + '-error' : undefined" @focus.self="focusSelected">
    <button v-for="(option, index) in options" :key="String(option.value)" type="button" class="ui-tag-option" :class="{ 'is-selected': option.value === modelValue }" :style="selectedStyle(option)" role="radio" :aria-checked="option.value === modelValue" :aria-invalid="Boolean(field?.error.value) || undefined" :aria-describedby="field?.error.value ? field.id + '-error' : undefined" :disabled="isDisabled || option.disabled" :tabindex="!isDisabled && index === tabStopIndex ? 0 : -1" @click="choose(index)" @keydown="handleKeydown($event, index)">{{ option.label }}</button>
  </div>
</template>
<script setup lang="ts" generic="T extends string | number">
import type { CSSProperties } from 'vue'
import type { SelectOption, FieldContext, FormContext } from '@/types/ui'


import { computed, inject, nextTick, ref, useId } from 'vue'

type TagOption = SelectOption<T> & { background?: string; color?: string }
defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ modelValue?: T | null; options?: TagOption[]; disabled?: boolean; readonly?: boolean }>(), { options: () => [] })
const emit = defineEmits<{ 'update:modelValue': [value: T]; change: [value: T] }>()
const field = inject<FieldContext | null>('ui-field', null)
const form = inject<FormContext | null>('ui-form', null)
const root = ref<HTMLElement | null>(null)
const groupId = 'tags-' + useId()
const isDisabled = computed(() => props.disabled || Boolean(form?.disabled.value))
const enabledIndexes = computed(() => props.options.flatMap((option, index) => option.disabled ? [] : [index]))
const tabStopIndex = computed(() => {
  const selectedIndex = props.options.findIndex(option => option.value === props.modelValue && !option.disabled)
  return selectedIndex >= 0 ? selectedIndex : enabledIndexes.value[0] ?? -1
})
const selectedStyle = (option: TagOption): CSSProperties | undefined => option.value === props.modelValue ? { backgroundColor: option.background, color: option.color } : undefined
const controlAt = (index: number) => root.value?.querySelectorAll<HTMLButtonElement>('[role=radio]')[index]
const focusSelected = () => { if (!isDisabled.value) controlAt(tabStopIndex.value)?.focus() }
const choose = (index: number) => {
  const option = props.options[index]
  if (!option || option.disabled || isDisabled.value || props.readonly || controlAt(index)?.matches(':disabled')) return
  if (props.modelValue !== option.value) {
    emit('update:modelValue', option.value)
    emit('change', option.value)
  }
  nextTick(() => field?.validate())
}
const handleKeydown = (event: KeyboardEvent, index: number) => {
  if (isDisabled.value || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
  const key = event.key
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' ', 'Enter'].includes(key)) return
  event.preventDefault()
  event.stopPropagation()
  if (key === ' ' || key === 'Enter') { choose(index); return }
  const enabled = enabledIndexes.value
  if (!enabled.length) return
  let nextIndex: number
  if (key === 'Home') nextIndex = enabled[0]!
  else if (key === 'End') nextIndex = enabled[enabled.length - 1]!
  else {
    const direction = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1
    const position = enabled.indexOf(index)
    const nextPosition = position < 0 ? (direction > 0 ? 0 : enabled.length - 1) : (position + direction + enabled.length) % enabled.length
    nextIndex = enabled[nextPosition]!
  }
  choose(nextIndex)
  nextTick(() => { if (!isDisabled.value) controlAt(nextIndex)?.focus() })
}
defineExpose({ focus: focusSelected })
</script>
<style scoped>
.ui-tag-select {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  outline: none;
}
.ui-tag-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 68px;
  min-height: 38px;
  padding: 8px 16px;
  border: 0;
  border-radius: 12px;
  background: #f0f2f5;
  color: #788393;
  font: inherit;
  line-height: 1.4;
  cursor: pointer;
  transition: background-color .16s ease, color .16s ease, transform .16s ease;
  -webkit-tap-highlight-color: transparent;
}
.ui-tag-option:not(:disabled):not(.is-selected):hover { background: #e7ebf0; }
.ui-tag-option:not(:disabled):active { transform: scale(.97); }
.ui-tag-option:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.ui-tag-option:disabled { opacity: .55; cursor: not-allowed; }
.ui-tag-select[aria-readonly=true] .ui-tag-option { cursor: default; }
.ui-tag-select[aria-readonly=true] .ui-tag-option:active { transform: none; }
@media (prefers-reduced-motion: reduce) { .ui-tag-option { transition: none; } }
</style>
