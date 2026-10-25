<template>
  <UiField label="邮箱" prop="email">
    <UiInput :model-value="email" type="email" autocomplete="email" maxlength="254" :readonly="emailReadonly" :disabled="disabled" @update:model-value="emit('update:email', $event)" />
  </UiField>
  <UiField label="验证码" prop="code">
    <div class="code-row">
      <UiInput :model-value="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" :disabled="disabled" @update:model-value="emit('update:code', $event)" />
      <UiButton :loading="sending" :disabled="disabled || sending || remaining > 0" @click="emit('send')">{{ remaining > 0 ? `${remaining}秒后重发` : '发送验证码' }}</UiButton>
    </div>
  </UiField>
  <p v-if="showHint" class="code-hint">验证码1分钟内有效，发送后60秒可重发。</p>
</template>
<script setup lang="ts">
import UiButton from '@/components/ui/uiButton.vue'
import UiField from '@/components/ui/uiField.vue'
import UiInput from '@/components/ui/uiInput.vue'

withDefaults(defineProps<{ email: string; code: string; remaining: number; sending: boolean; disabled: boolean; emailReadonly?: boolean; showHint?: boolean }>(), { showHint: true })
const emit = defineEmits<{ 'update:email': [value: string]; 'update:code': [value: string]; send: [] }>()
</script>
<style scoped>
.code-row { display:flex; align-items:center; gap:10px; }
.code-row .ui-input-wrap { flex:1; min-width:0; }
.code-row .ui-button { flex-shrink:0; }
.code-hint { color:var(--muted); font-size:13px; line-height:1.7; }
</style>
