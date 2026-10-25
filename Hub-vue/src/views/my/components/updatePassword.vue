<template>
  <UiDialog v-model="innerVisible" title="更换密码" width="min(500px, calc(100vw - 24px))" :before-close="handleClose">
    <UiForm :key="step" ref="formRef" :model="localData" :rules="rules" :disabled="submitting">
      <EmailCodeFields v-if="step === 'verify'" v-model:email="localData.email" v-model:code="localData.code" :remaining="remaining" :sending="sending" :disabled="submitting" email-readonly :show-hint="false" @send="sendCode" />
      <template v-else>
        <UiField label="新密码" prop="newPassword">
          <UiInput v-model="localData.newPassword" type="password" show-password autocomplete="new-password" maxlength="128" />
        </UiField>
        <UiField label="确认密码" prop="confirmPassword">
          <UiInput v-model="localData.confirmPassword" type="password" show-password autocomplete="new-password" maxlength="128" @keyup.enter="handleSubmit" />
        </UiField>
      </template>
    </UiForm>
    <template #footer>
      <UiButton :disabled="submitting" @click="step === 'verify' ? innerVisible = false : resetForm()">{{ step === 'verify' ? '取消' : '返回' }}</UiButton>
      <UiButton type="primary" :loading="submitting" :disabled="sending" @click="handleSubmit">确定</UiButton>
    </template>
  </UiDialog>
</template>
<script setup lang="ts">
import type { FormHandle, FormRules } from '@/types/ui'

import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import EmailCodeFields from '@/components/emailCodeFields.vue'
import UiDialog from '@/components/ui/uiDialog.vue'
import UiForm from '@/components/ui/uiForm.vue'
import UiField from '@/components/ui/uiField.vue'
import UiInput from '@/components/ui/uiInput.vue'
import UiButton from '@/components/ui/uiButton.vue'
import { requestPasswordChange, verifyPasswordChange, changePassword } from '@/api/my'
import { emailCodeRules, normalizeEmail, useEmailCode } from '@/composables/useEmailCode'
import { feedback } from '@/utils/feedback'
import { clearSession, currentUser, onSessionChange } from '@/stores/auth'
import { loadCurrentUser } from '@/stores/user'
import { errorDetails } from '@/utils/errors'
import { createSubmissionGuard } from '@/services/submission'
import router from '@/router'

defineOptions({ name: 'UpdatePassword' })
const props = defineProps({ visible: Boolean })
const emit = defineEmits<{ 'update:visible': [value: boolean] }>()
const innerVisible = computed({ get: () => props.visible, set: value => emit('update:visible', value) })
const formRef = ref<FormHandle | null>(null)
const step = ref<'verify' | 'password'>('verify')
const verificationToken = ref('')
let verificationExpiresAt = 0
let disposed = false
const localData = ref({ email: '', code: '', newPassword: '', confirmPassword: '' })
const submission = createSubmissionGuard(() => props.visible && !disposed)
const submitting = submission.busy
const { remaining, sending, sendCode, cancel } = useEmailCode(localData, requestPasswordChange,
  '验证码已发送，请查看当前邮箱', () => props.visible && step.value === 'verify' && !submitting.value && !disposed)
const rules: FormRules = {
  ...emailCodeRules,
  newPassword: [{ required: true, message: '请输入新密码', trigger: 'blur' }, { validator: (_rule, value, callback) => {
    const password = String(value || '')
    callback(password.length >= 8 && password.length <= 128 && password.trim() ? undefined : new Error('密码需为8至128个字符，不能全部为空格'))
  }, trigger: 'blur' }],
  confirmPassword: [{ validator: (_rule, value, callback) => callback(value && value === localData.value.newPassword ? undefined : new Error('两次输入的密码不一致')), trigger: 'blur' }]
}
const clearVerification = () => { verificationToken.value = ''; verificationExpiresAt = 0; step.value = 'verify' }
const resetForm = () => {
  submission.cancel()
  cancel()
  clearVerification()
  localData.value = { email: props.visible && !disposed ? normalizeEmail(currentUser.value.email || '') : '', code: '', newPassword: '', confirmPassword: '' }
  if (props.visible && !disposed) nextTick(() => formRef.value?.clearValidate())
}
const hasVerification = () => Boolean(verificationToken.value && Date.now() < verificationExpiresAt)
watch(() => props.visible, visible => {
  resetForm()
  if (visible && !localData.value.email) void loadCurrentUser()
}, { immediate: true, flush: 'sync' })
watch(() => normalizeEmail(currentUser.value.email || ''), () => { if (props.visible) resetForm() }, { flush: 'sync' })
watch(() => normalizeEmail(localData.value.email), () => {
  submission.cancel()
  clearVerification()
  localData.value.code = ''
  localData.value.newPassword = ''
  localData.value.confirmPassword = ''
}, { flush: 'sync' })
watch(() => router.currentRoute.value.fullPath, resetForm, { flush: 'sync' })
const unsubscribe = onSessionChange(resetForm)
onUnmounted(() => { disposed = true; resetForm(); submission.dispose(); unsubscribe() })
const handleClose = (done: () => void) => { if (!submitting.value) done() }
const handleSubmit = async () => {
  if (sending.value) return
  if (step.value === 'password' && !hasVerification()) { resetForm(); feedback.error('邮箱验证已失效，请重新验证'); return }
  const operation = submission.begin()
  if (!operation) return
  const phase = step.value
  const data = { ...localData.value }
  const token = verificationToken.value
  try {
    const valid = await formRef.value?.validate().catch(() => false)
    if (!valid || !submission.isActive(operation) || phase !== step.value) return
    if (phase === 'verify') {
      const res = await verifyPasswordChange({ email: normalizeEmail(data.email), code: data.code }, operation.config)
      if (!submission.isActive(operation)) return
      if (res?.code !== 1) { feedback.error(res?.msg || '邮箱验证失败，请重试'); return }
      if (!res.data?.verificationToken || typeof res.data.verificationToken !== 'string' || !res.data.verificationToken.trim() || !Number.isFinite(res.data.expiresIn) || res.data.expiresIn <= 0) { feedback.error('未能完成邮箱验证，请重试'); return }
      verificationToken.value = res.data.verificationToken
      verificationExpiresAt = Date.now() + Math.min(300, res.data.expiresIn) * 1000
      localData.value.code = ''
      localData.value.newPassword = ''
      localData.value.confirmPassword = ''
      step.value = 'password'
      await nextTick()
      formRef.value?.clearValidate()
      return
    }
    if (!data.newPassword || data.newPassword !== data.confirmPassword) { feedback.error('两次输入的密码不一致'); return }
    const res = await changePassword({ verificationToken: token, password: data.newPassword }, operation.config)
    if (!submission.isActive(operation)) return
    if (res?.code !== 1) { feedback.error(res?.msg || '更改失败'); return }
    resetForm()
    feedback.success('密码已更新，请重新登录')
    innerVisible.value = false
    clearSession()
    await router.replace('/login')
  } catch (cause) {
    if (submission.isActive(operation) && errorDetails(cause).response?.status === 428) resetForm()
    // 请求封装显示网络错误；失效授权回到邮箱验证，其他错误保留当前步骤。
  } finally { submission.finish(operation) }
}
</script>
