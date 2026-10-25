<template>
  <div ref="root" class="ui-field" :data-field="prop" @focusout="handleFocusout" @change="form?.validateField(prop)">
    <label v-if="label" class="ui-field-label" :for="id">{{ label }}</label>
    <div class="ui-field-control">
      <slot />
      <p v-if="error" :id="id + '-error'" class="ui-field-error" role="alert">{{ error }}</p>
    </div>
  </div>
</template>
<script setup lang="ts">
import type { FieldContext } from '@/types/ui'
import type { FormContext } from '@/types/ui'
import { computed, inject, provide, ref, watch, onMounted, onUpdated, onUnmounted, useId } from 'vue';
const props = defineProps({
  label: String,
  prop: String
});
const form = inject<FormContext | null>('ui-form', null);
const id = 'field-' + useId();
const error = computed(() => (props.prop ? form?.errors.value[props.prop] : '') || '');
const root = ref<HTMLElement | null>(null);
const handleFocusout = (event: FocusEvent) => {
  if (root.value?.contains(event.relatedTarget as Node | null) || (event.relatedTarget as HTMLElement | null)?.closest?.('[data-form-action]')) return;
  form?.validateField(props.prop);
};
const syncNativeControl = () => {
  const control = root.value?.querySelector('input:not([type=file]), select, textarea, [data-ui-control], .upload-trigger');
  if (!control) return;
  if (!control.id) control.id = id;
  if (control.tagName === 'SELECT') {
    control.setAttribute('aria-invalid', String(Boolean(error.value)));
    if (error.value) control.setAttribute('aria-describedby', id + '-error');else control.removeAttribute('aria-describedby');
  }
};
onMounted(syncNativeControl);
onUpdated(syncNativeControl);
watch(() => props.prop, (field, previous) => {
  if (previous) form?.unregister(previous);
  if (field) form?.register(field);
}, {
  immediate: true
});
onUnmounted(() => {
  if (props.prop) form?.unregister(props.prop);
});
provide<FieldContext>('ui-field', {
  id,
  error,
  validate: () => form?.validateField(props.prop)
});
</script>
