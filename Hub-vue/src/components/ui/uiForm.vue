<template>
  <fieldset ref="root" class="ui-form" :disabled="disabled">
    <slot />
  </fieldset>
</template>
<script setup lang="ts">
import type { FormContext, FormRules } from '@/types/ui'


import { computed, ref, provide } from 'vue';
import { validateFields } from '@/utils/formValidation';
const props = withDefaults(defineProps<{ model?: Record<string, unknown>; rules?: FormRules; disabled?: boolean }>(), { model: () => ({}), rules: () => ({}) });
const root = ref<HTMLElement | null>(null);
const errors = ref<Record<string, string>>({});
const fields = new Set<string>();
let validationVersion = 0;
const clearValidate = (field?: string) => {
  validationVersion++;
  if (field) {
    const next = {
      ...errors.value
    };
    delete next[field];
    errors.value = next;
  } else errors.value = {};
};
const validate = async () => {
  const version = ++validationVersion;
  const result = await validateFields(props.model, props.rules, [...fields]);
  if (version !== validationVersion) return false;
  errors.value = result;
  const invalid = Object.keys(result)[0];
  if (invalid) root.value?.querySelector<HTMLElement>('[data-field="' + invalid + '"] input, [data-field="' + invalid + '"] select, [data-field="' + invalid + '"] textarea, [data-field="' + invalid + '"] [data-ui-control]')?.focus();
  return !invalid;
};
const validateField = async (field?: string) => {
  if (!field || props.disabled) return;
  const version = ++validationVersion;
  const result = await validateFields(props.model, props.rules, [field]);
  if (version !== validationVersion) return;
  const next = {
    ...errors.value
  };
  delete next[field];
  errors.value = {
    ...next,
    ...result
  };
};
provide<FormContext>('ui-form', {
  errors,
  disabled: computed(() => props.disabled),
  register: (field: string) => fields.add(field),
  unregister: (field: string) => {
    fields.delete(field);
    clearValidate(field);
  },
  validateField
});
defineExpose({
  validate,
  clearValidate
});
</script>
