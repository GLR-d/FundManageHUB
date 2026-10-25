<template>
  <span class="ui-input-wrap">
    <textarea v-if="type === 'textarea'" :id="field?.id" v-bind="$attrs" :value="modelValue ?? ''" rows="3" :aria-invalid="Boolean(field?.error.value) || undefined" :aria-describedby="field?.error.value ? field.id + '-error' : undefined" @input="update" />
    <input v-else :id="field?.id" v-bind="$attrs" :type="showPassword && revealed ? 'text' : type || 'text'" :value="value" :step="type === 'number' ? '0.01' : type === 'datetime-local' ? '60' : undefined" :aria-invalid="Boolean(field?.error.value) || undefined" :aria-describedby="field?.error.value ? field.id + '-error' : undefined" @input="update" />
    <button v-if="showPassword" class="password-toggle" type="button" :aria-label="revealed ? '隐藏密码' : '显示密码'" @click="revealed = !revealed">
      <UiIcon name="eye" />
    </button>
  </span>
</template>
<script setup lang="ts" generic="T extends string = 'text'">
import type { FieldContext } from '@/types/ui'
import { computed, ref, inject } from 'vue';
import UiIcon from './uiIcon.vue';
defineOptions({
  inheritAttrs: false
});
const props = defineProps<{ modelValue?: T extends 'number' ? string | number | null : string; type?: T; showPassword?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: T extends 'number' ? number | null : string] }>();
const field = inject<FieldContext | null>('ui-field', null);
const revealed = ref(false);
const value = computed(() => props.type === 'datetime-local' ? String(props.modelValue || '').replace(' ', 'T') : props.modelValue ?? '');
const update = (event: Event) => {
  const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  const next = props.type === 'number' ? value === '' ? null : Number(value) : props.type === 'datetime-local' ? value.replace('T', ' ') : value;
  emit('update:modelValue', next as T extends 'number' ? number | null : string);
};
</script>
