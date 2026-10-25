<template>
  <div class="monthly-limit-row">
    <h2 id="monthly-expense-limit-label">每月花销限额</h2>
    <div class="limit-summary">
      <span class="limit-amount" aria-live="polite">{{ summary }}</span>
      <UiButton v-if="monthlyLimitError" class="limit-action" :loading="monthlyLimitLoading" aria-label="重试加载每月花销限额" @click="loadMonthlyLimit(true)">重试</UiButton>
      <UiButton v-else class="limit-action" :disabled="!monthlyLimitLoaded || monthlyLimitLoading || monthlyLimitSaving" aria-labelledby="monthly-expense-limit-label monthly-expense-limit-action" @click="open">
        <span id="monthly-expense-limit-action">{{ monthlyLimitCents === null ? '设置' : '更改' }}</span>
      </UiButton>
    </div>
    <UiDialog v-model="visible" title="每月花销限额" width="min(460px, calc(100vw - 24px))" :close-on-click-modal="false" :before-close="beforeClose">
      <form class="limit-form" @submit.prevent="submit">
        <label :for="inputId">限额金额</label>
        <UiInput :id="inputId" v-model="draft" type="text" inputmode="decimal" autocomplete="off" maxlength="32" placeholder="未设置" :disabled="monthlyLimitSaving" @keydown.enter.prevent="submit" />
      </form>
      <template #footer>
        <UiButton :disabled="monthlyLimitSaving" @click="visible = false">取消</UiButton>
        <UiButton type="primary" :loading="monthlyLimitSaving" @click="submit">保存</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue'
import UiButton from '@/components/ui/uiButton.vue'
import UiDialog from '@/components/ui/uiDialog.vue'
import UiInput from '@/components/ui/uiInput.vue'
import { formatCents } from '@/utils/funds'
import { onSessionChange } from '@/stores/auth'
import { monthlyLimitCents, monthlyLimitLoaded, monthlyLimitLoading, monthlyLimitSaving, monthlyLimitError, loadMonthlyLimit, saveMonthlyLimit } from '@/stores/monthlyLimit'

const visible = ref(false)
const draft = ref('')
const inputId = 'monthly-limit-' + useId()
const summary = computed(() => !monthlyLimitLoaded.value ? monthlyLimitLoading.value ? '加载中…' : monthlyLimitError.value ? '加载失败' : '' : monthlyLimitCents.value === null ? '未设置' : formatCents(monthlyLimitCents.value))
const open = () => {
  if (!monthlyLimitLoaded.value || monthlyLimitLoading.value || monthlyLimitSaving.value) return
  draft.value = monthlyLimitCents.value === null ? '' : formatCents(monthlyLimitCents.value)
  visible.value = true
}
const beforeClose = (done: () => void) => { if (!monthlyLimitSaving.value) done() }
const submit = async () => {
  if (!visible.value || monthlyLimitSaving.value) return
  if (await saveMonthlyLimit(draft.value)) visible.value = false
}
const stopSession = onSessionChange(() => { visible.value = false; draft.value = '' })
onMounted(() => { void loadMonthlyLimit(true) })
onUnmounted(stopSession)
</script>
<style scoped>
.monthly-limit-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 92px; padding: 22px 0; border-bottom: 1px solid var(--line); }
.monthly-limit-row h2 { min-width: 0; margin: 0; color: var(--text); font-size: 16px; font-weight: 550; line-height: 1.6; }
.limit-summary { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 16px; min-width: 0; }
.limit-amount { overflow-wrap: anywhere; font-size: 15px; color: var(--muted); font-variant-numeric: tabular-nums; }
.limit-action { flex-shrink: 0; min-width: 80px; border-color: transparent; border-radius: 14px; background: #f3f4f6; color: #394355; font-size: 15px; }
.limit-action:hover:not(:disabled) { border-color: transparent; background: #e9ebef; }
.limit-form { display: grid; gap: 10px; }
.limit-form label { color: var(--text); font-size: 15px; }
@media(max-width:760px) {
  .monthly-limit-row { gap: 16px; }
  .monthly-limit-row h2 { flex-shrink: 0; font-size: 14px; }
  .limit-summary { gap: 8px; }
  .limit-amount { font-size: 14px; }
}
</style>
