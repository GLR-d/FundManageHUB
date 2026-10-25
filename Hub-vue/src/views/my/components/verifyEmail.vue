<template>
  <UiDialog v-model="innerVisible" title="更换邮箱" width="min(500px, calc(100vw - 24px))" :before-close="handleClose">
    <UiForm :key="step" ref="formRef" :model="localData" :rules="rules" :disabled="submitting">
      <EmailCodeFields v-model:email="localData.email" v-model:code="localData.code" :remaining="remaining" :sending="sending" :disabled="submitting" :email-readonly="step === 'verify'" :show-hint="false" @send="sendCode" />
    </UiForm>
    <template #footer>
      <UiButton :disabled="submitting" @click="step === 'verify' ? innerVisible = false : resetForm()">{{ step === 'verify' ? '取消' : '返回' }}</UiButton>
      <UiButton type="primary" :loading="submitting" :disabled="sending" @click="handleSubmit">确定</UiButton>
    </template>
  </UiDialog>
</template>
<script setup lang="ts">
import type { FormHandle } from '@/types/ui'
import type { RequestConfig } from '@/types/api'
import type { UserProfile } from '@/types/account'

import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import EmailCodeFields from '@/components/emailCodeFields.vue'
import UiButton from '@/components/ui/uiButton.vue'
import UiDialog from '@/components/ui/uiDialog.vue'
import UiForm from '@/components/ui/uiForm.vue'
import { requestCurrentEmailVerification, verifyCurrentEmail, requestEmailBinding, verifyEmailBinding } from '@/api/my'
import { emailCodeRules, normalizeEmail, useEmailCode } from '@/composables/useEmailCode'
import { feedback } from '@/utils/feedback'
import { captureSession, isCurrentSession, currentUser, onSessionChange } from '@/stores/auth'
import { loadCurrentUser } from '@/stores/user'
import { errorDetails } from '@/utils/errors'
import { createSubmissionGuard } from '@/services/submission'
import router from '@/router'

defineOptions({ name: 'VerifyEmail' })
const props = withDefaults(defineProps<{ visible?: boolean; email?: string }>(), { visible: false, email: '' })
const emit = defineEmits<{ 'update:visible': [value: boolean]; verified: [profile: UserProfile] }>()
const innerVisible = computed({ get: () => props.visible, set: value => emit('update:visible', value) })
const formRef = ref<FormHandle | null>(null)
const step = ref<'verify' | 'email'>('verify')
const verificationToken = ref('')
let verificationExpiresAt = 0
let disposed = false
const localData = ref({ email: '', code: '' })
const rules = emailCodeRules
const submission = createSubmissionGuard(() => props.visible && !disposed)
const submitting = submission.busy
const hasVerification = () => Boolean(verificationToken.value && Date.now() < verificationExpiresAt)
const requestCode = async (data: { email: string }, config: RequestConfig) => {
  if (step.value === 'verify') return requestCurrentEmailVerification(data, config)
  if (!hasVerification()) { resetForm(); feedback.error('邮箱验证已失效，请重新验证'); return { code: 0, data: null } }
  const token = verificationToken.value
  const session = captureSession()
  try { return await requestEmailBinding({ ...data, verificationToken: token }, config) }
  catch (cause) {
    if (errorDetails(cause).response?.status === 428 && !config.signal?.aborted && props.visible && !disposed && step.value === 'email' && verificationToken.value === token && isCurrentSession(session)) resetForm()
    throw cause
  }
}
const { remaining, sending, sendCode, cancel } = useEmailCode(localData, requestCode,
  '验证码已发送，请查看邮箱', () => props.visible && !submitting.value && !disposed)
const resetForm = () => {
  submission.cancel()
  cancel()
  verificationToken.value = ''
  verificationExpiresAt = 0
  step.value = 'verify'
  localData.value = { email: props.visible && !disposed ? normalizeEmail(currentUser.value.email || props.email) : '', code: '' }
  if (props.visible && !disposed) nextTick(() => formRef.value?.clearValidate())
}
watch(() => props.visible, visible => {
  resetForm()
  if (visible && !localData.value.email) void loadCurrentUser()
}, { immediate: true, flush: 'sync' })
watch(() => normalizeEmail(currentUser.value.email || props.email), () => { if (props.visible) resetForm() }, { flush: 'sync' })
watch(() => normalizeEmail(localData.value.email), () => submission.cancel(), { flush: 'sync' })
watch(() => router.currentRoute.value.fullPath, resetForm, { flush: 'sync' })
const unsubscribe = onSessionChange(resetForm)
onUnmounted(() => { disposed = true; resetForm(); submission.dispose(); unsubscribe() })
const handleClose = (done: () => void) => { if (!submitting.value) done() }
const handleSubmit = async () => {
  if (sending.value) return
  if (step.value === 'email' && !hasVerification()) { resetForm(); feedback.error('邮箱验证已失效，请重新验证'); return }
  localData.value.email = normalizeEmail(localData.value.email)
  const operation = submission.begin()
  if (!operation) return
  const phase = step.value
  const data = { email: localData.value.email, code: localData.value.code }
  const token = verificationToken.value
  try {
    const valid = await formRef.value?.validate().catch(() => false)
    if (!valid || !submission.isActive(operation) || phase !== step.value) return
    if (phase === 'verify') {
      const result = await verifyCurrentEmail(data, operation.config)
      if (!submission.isActive(operation)) return
      if (result?.code !== 1) { feedback.error(result?.msg || '邮箱验证失败，请重试'); return }
      if (!result.data?.verificationToken || typeof result.data.verificationToken !== 'string' || !result.data.verificationToken.trim() || !Number.isFinite(result.data.expiresIn) || result.data.expiresIn <= 0) { feedback.error('未能完成邮箱验证，请重试'); return }
      verificationToken.value = result.data.verificationToken
      verificationExpiresAt = Date.now() + Math.min(300, result.data.expiresIn) * 1000
      step.value = 'email'
      localData.value = { email: '', code: '' }
      await nextTick()
      formRef.value?.clearValidate()
      return
    }
    const result = await verifyEmailBinding({ ...data, verificationToken: token }, operation.config)
    if (!submission.isActive(operation)) return
    if (result?.code !== 1) { feedback.error(result?.msg || '邮箱验证失败，请重试'); return }
    emit('verified', result.data)
    resetForm()
    innerVisible.value = false
    feedback.success('邮箱更换成功')
  } catch (cause) {
    if (submission.isActive(operation) && errorDetails(cause).response?.status === 428) resetForm()
    // 请求封装显示网络错误；错误目标验证码可在当前步骤重试。
  } finally { submission.finish(operation) }
}
</script>
