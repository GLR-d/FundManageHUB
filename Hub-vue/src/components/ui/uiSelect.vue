<template>
  <span class="ui-select" :class="[$attrs.class, { 'ui-select--compact': compact, 'is-open': opened }]" :style="$attrs.style" @keydown="handleKeydown">
    <button ref="trigger" v-bind="controlAttributes()" :id="String($attrs.id || (fieldControl ? field?.id : '')) || undefined" type="button" class="ui-select-trigger" role="combobox" data-ui-control :disabled="isDisabled" aria-haspopup="listbox" :aria-expanded="opened" :aria-controls="listId" :aria-activedescendant="opened && activeIndex >= 0 ? listId + '-' + activeIndex : undefined" :aria-invalid="Boolean(fieldControl && field?.error.value) || undefined" :aria-describedby="fieldControl && field?.error.value ? field.id + '-error' : undefined" @click="toggle">
      <span class="ui-select-label" :class="{ 'is-placeholder': !selected }">{{ selected?.label || placeholder }}</span>
      <UiIcon name="chevron" class="ui-select-chevron" />
    </button>
    <div :id="listId" ref="panel" class="ui-floating-panel ui-select-panel" popover="auto" role="listbox" :aria-label="String($attrs['aria-label'] || '选项')" :style="panelStyle" @toggle="sync">
      <button v-for="(option, index) in options" :id="listId + '-' + index" :key="String(option.value)" type="button" class="ui-select-option" :class="{ 'is-selected': option.value === modelValue, 'is-active': index === activeIndex }" role="option" tabindex="-1" :aria-selected="option.value === modelValue" :disabled="option.disabled || isDisabled" @pointermove="activeIndex = index" @click="choose(index)">
        <span>{{ option.label }}</span>
        <UiIcon v-if="option.value === modelValue" name="check" />
      </button>
      <span v-if="!options.length" class="ui-select-empty">暂无选项</span>
    </div>
  </span>
</template>
<script setup lang="ts" generic="T extends string | number | boolean">
import type { SelectOption, FieldContext, FormContext } from '@/types/ui'


import { computed, inject, nextTick, ref, useAttrs, useId, watch } from 'vue'
import UiIcon from './uiIcon.vue'
import { useFloatingPanel } from '@/composables/useFloatingPanel'
defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ modelValue?: T | null; options?: SelectOption<T>[]; placeholder?: string; disabled?: boolean; compact?: boolean; fieldControl?: boolean }>(), { options: () => [], placeholder: '请选择', fieldControl: true })
const emit = defineEmits<{ 'update:modelValue': [value: T]; change: [value: T] }>()
const attrs = useAttrs()
const controlAttributes = () => Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'class' && key !== 'style'))
const field = inject<FieldContext | null>('ui-field', null)
const form = inject<FormContext | null>('ui-form', null)
const isDisabled = computed(() => props.disabled || Boolean(form?.disabled?.value))
const selected = computed(() => props.options.find(option => option.value === props.modelValue))
const trigger = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const activeIndex = ref(-1)
const listId = 'select-' + useId()
const { opened, panelStyle, show, hide, sync } = useFloatingPanel(trigger, panel)
const scrollActive = () => nextTick(() => panel.value?.querySelectorAll('[role=option]')[activeIndex.value]?.scrollIntoView({ block: 'nearest' }))
const open = async (last = false) => {
  if (isDisabled.value || trigger.value?.matches(':disabled')) return
  const selectedIndex = props.options.findIndex(option => option.value === props.modelValue && !option.disabled)
  activeIndex.value = selectedIndex >= 0 ? selectedIndex : props.options.findIndex(option => !option.disabled)
  if (last && selectedIndex < 0) activeIndex.value = props.options.findLastIndex(option => !option.disabled)
  await show()
  scrollActive()
}
const toggle = () => { if (opened.value) hide(); else open() }
const choose = (index: number) => {
  const option = props.options[index]
  if (!option || option.disabled || isDisabled.value || trigger.value?.matches(':disabled')) return
  emit('update:modelValue', option.value)
  emit('change', option.value)
  hide(true)
  if (props.fieldControl) nextTick(() => field?.validate?.())
}
const move = (step: number) => {
  const enabled = props.options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)
  if (!enabled.length) return
  const index = enabled.indexOf(activeIndex.value)
  activeIndex.value = enabled[(index + step + enabled.length) % enabled.length]
  scrollActive()
}
let typed = ''
let typedAt = 0
const handleKeydown = (event: KeyboardEvent) => {
  if (isDisabled.value) return
  if (event.key === 'Escape' && opened.value) {
    event.preventDefault(); event.stopPropagation(); hide(true)
  } else if (event.key === 'Tab') hide()
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
    event.preventDefault(); event.stopPropagation()
    if (!opened.value) { open(event.key === 'ArrowUp' || event.key === 'End'); return }
    if (event.key === 'Enter' || event.key === ' ') choose(activeIndex.value)
    else if (event.key === 'Home' || event.key === 'End') {
      activeIndex.value = event.key === 'Home' ? props.options.findIndex(option => !option.disabled) : props.options.findLastIndex(option => !option.disabled)
      scrollActive()
    } else move(event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    typed = Date.now() - typedAt < 700 ? typed + event.key : event.key
    typedAt = Date.now()
    const index = props.options.findIndex(option => !option.disabled && String(option.label).toLocaleLowerCase().startsWith(typed.toLocaleLowerCase()))
    if (index >= 0) { event.preventDefault(); open().then(() => { activeIndex.value = index; scrollActive() }) }
  }
}
watch(isDisabled, disabled => { if (disabled) hide() })
watch(() => props.options, (options, previous) => {
  if (!opened.value) return
  const value = previous[activeIndex.value]?.value
  let index = options.findIndex(option => option.value === value && !option.disabled)
  if (index < 0) index = options.findIndex(option => option.value === props.modelValue && !option.disabled)
  activeIndex.value = index >= 0 ? index : options.findIndex(option => !option.disabled)
  scrollActive()
})
defineExpose({ focus: () => trigger.value?.focus() })
</script>
