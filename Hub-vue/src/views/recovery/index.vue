<template>
  <main class="recovery">
    <section class="recovery-card">
      <h1>找回密码</h1>
      <p>请输入已绑定并验证的邮箱，收到验证码后设置新密码。</p>
      <UiForm ref="formRef" :model="formData" :rules="rules" :disabled="submitting">
        <EmailCodeFields v-model:email="formData.email" v-model:code="formData.code" :remaining="remaining" :sending="sending" :disabled="submitting" @send="sendCode" />
        <UiField label="新密码" prop="password">
          <UiInput v-model="formData.password" type="password" show-password autocomplete="new-password" maxlength="128" />
        </UiField>
        <UiField label="确认密码" prop="confirmPassword">
          <UiInput v-model="formData.confirmPassword" type="password" show-password autocomplete="new-password" maxlength="128" @keyup.enter="handleSubmit" />
        </UiField>
        <UiButton class="submit-button" type="primary" :loading="submitting" :disabled="sending" @click="handleSubmit">设置新密码</UiButton>
      </UiForm>
      <nav class="recovery-links"><router-link to="/login">返回登录</router-link></nav>
    </section>
  </main>
</template>
<script setup lang="ts">
import type { FormHandle, FormRules } from '@/types/ui'

import { nextTick, onUnmounted, ref, watch } from 'vue'
import EmailCodeFields from '@/components/emailCodeFields.vue'
import UiButton from '@/components/ui/uiButton.vue'
import UiField from '@/components/ui/uiField.vue'
import UiForm from '@/components/ui/uiForm.vue'
import UiInput from '@/components/ui/uiInput.vue'
import { requestPasswordReset, resetPassword } from '@/api/login'
import router from '@/router'
import { clearSession } from '@/stores/auth'
import { emailCodeRules, normalizeEmail, useEmailCode } from '@/composables/useEmailCode'
import { feedback } from '@/utils/feedback'
import { createSubmissionGuard } from '@/services/submission'

defineOptions({ name: 'AccountRecovery' })
const formRef = ref<FormHandle | null>(null)
const formData = ref({ email: '', code: '', password: '', confirmPassword: '' })
const rules: FormRules = {
  ...emailCodeRules,
  password: [{ required: true, message: '请输入新密码', trigger: 'blur' }, { validator: (_rule, value, callback) => {
    const password = String(value || '')
    callback(password.length >= 8 && password.length <= 128 && password.trim() ? undefined : new Error('密码需为 8 至 128 个字符，不能全部为空格'))
  }, trigger: 'blur' }],
  confirmPassword: [{ validator: (_rule, value, callback) => callback(value && value === formData.value.password ? undefined : new Error('两次输入的密码不一致')), trigger: 'blur' }]
}
const submission = createSubmissionGuard()
const submitting = submission.busy
const { remaining, sending, sendCode, cancel } = useEmailCode(formData, requestPasswordReset, '如果该邮箱已绑定并验证，验证码将发送到该邮箱，请稍后查看', () => !submitting.value)
watch(() => router.currentRoute.value.fullPath, () => {
  submission.cancel()
  cancel()
  formData.value = { email: '', code: '', password: '', confirmPassword: '' }
  nextTick(() => formRef.value?.clearValidate())
})
watch(() => normalizeEmail(formData.value.email), () => submission.cancel(), { flush: 'sync' })
onUnmounted(() => { submission.dispose(); formData.value.code = ''; formData.value.password = ''; formData.value.confirmPassword = '' })
const handleSubmit = async () => {
  if (sending.value) return
  formData.value.email = normalizeEmail(formData.value.email)
  const operation = submission.begin()
  if (!operation) return
  const data = { ...formData.value }
  try {
    const valid = await formRef.value?.validate().catch(() => false)
    if (!valid || !submission.isActive(operation)) return
    const result = await resetPassword({ email: data.email, code: data.code, password: data.password }, operation.config)
    if (!submission.isActive(operation)) return
    if (result?.code !== 1) { feedback.error(result?.msg || '密码重置失败，请重试'); return }
    formData.value.code = ''
    formData.value.password = ''
    formData.value.confirmPassword = ''
    // 只清理发起此次重置的会话，迟到响应由 submission 拦截。
    clearSession()
    feedback.success('密码已重置，请重新登录')
    await router.replace('/login')
  } catch {
    // 网络错误由请求封装提示，保留表单供重试。
  } finally { submission.finish(operation) }
}
</script>
<style scoped>
.recovery { display:flex; align-items:center; justify-content:center; min-height:100vh; min-height:100dvh; padding:24px 16px; background:linear-gradient(#eef1fb66,#eef1fb66),url('@/assets/images/login-background.webp') center/cover; }
.recovery-card { width:430px; max-width:100%; padding:32px; border-radius:20px; background:#ffffffed; box-shadow:0 16px 60px #24334b1a; }
h1 { margin:0 0 20px; font-size:24px; }
p { color:var(--muted); line-height:1.8; font-size:14px; }
.submit-button { width:100%; margin-top:12px; }
.recovery-links { display:flex; flex-wrap:wrap; gap:16px; margin-top:24px; font-size:14px; }
</style>
