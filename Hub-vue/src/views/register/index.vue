<template>
  <div class="register">
    <UiForm ref="registerRef" :model="registerForm" :rules="registerRules" :disabled="registerLoading" class="register-form">
      <div class="auth-mark"><UiIcon name="wallet" /></div>
      <h1 class="title">创建账号</h1>
      <p class="auth-subtitle">验证邮箱后设置密码，即可开始记账</p>
      <EmailCodeFields v-model:email="registerForm.email" v-model:code="registerForm.code" :remaining="remaining" :sending="sending" :disabled="registerLoading" @send="sendCode" />
      <UiField label="昵称（选填）" prop="name">
        <UiInput v-model="registerForm.name" autocomplete="nickname" maxlength="50" placeholder="昵称" aria-label="昵称" />
      </UiField>
      <UiField label="密码" prop="password">
        <UiInput v-model="registerForm.password" type="password" show-password autocomplete="new-password" maxlength="128" placeholder="密码" aria-label="密码" />
      </UiField>
      <UiField label="确认密码" prop="confirmPassword">
        <UiInput v-model="registerForm.confirmPassword" type="password" show-password autocomplete="new-password" maxlength="128" placeholder="再次输入密码" aria-label="确认密码" @keyup.enter="handleRegister" />
      </UiField>
      <div class="link-container"><router-link to="/login">返回登录</router-link></div>
      <UiButton class="auth-submit" type="primary" :loading="registerLoading" :disabled="sending" @click="handleRegister">{{ registerLoading ? '注册中…' : '注册' }}</UiButton>
    </UiForm>
    <div class="auth-footer">Copyright © 2025–2026 my All Rights Reserved.</div>
  </div>
</template>
<script setup lang="ts">
import type { FormHandle, FormRules } from '@/types/ui'

import { onUnmounted, ref } from 'vue'
import UiForm from '@/components/ui/uiForm.vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import UiField from '@/components/ui/uiField.vue'
import UiInput from '@/components/ui/uiInput.vue'
import UiButton from '@/components/ui/uiButton.vue'
import EmailCodeFields from '@/components/emailCodeFields.vue'
import { feedback } from '@/utils/feedback'
import { addUser, requestRegistrationCode } from '@/api/register'
import { emailCodeRules, normalizeEmail, useEmailCode } from '@/composables/useEmailCode'
import { createSubmissionGuard } from '@/services/submission'
import router from '@/router'

defineOptions({ name: 'Register' })
const registerRef = ref<FormHandle | null>(null)
const registerForm = ref({ name: '', email: '', code: '', password: '', confirmPassword: '' })
const submission = createSubmissionGuard()
const registerLoading = submission.busy
const { remaining, sending, sendCode } = useEmailCode(registerForm, requestRegistrationCode,
  '如果该邮箱可用于注册，验证码将发送到该邮箱，请稍后查看', () => !registerLoading.value)
const registerRules: FormRules = {
  ...emailCodeRules,
  name: [{ validator: (_rule, value, callback) => callback(String(value || '').trim().length <= 50 ? undefined : new Error('昵称最多50个字符')), trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }, { validator: (_rule, value, callback) => {
    const password = String(value || '')
    callback(password.length >= 8 && password.length <= 128 && password.trim() ? undefined : new Error('密码需为8至128个字符，不能全部为空格'))
  }, trigger: 'blur' }],
  confirmPassword: [{ validator: (_rule, value, callback) => callback(value && value === registerForm.value.password ? undefined : new Error('两次输入的密码不一致')), trigger: 'blur' }]
}
onUnmounted(() => { submission.dispose(); registerForm.value.code = ''; registerForm.value.password = ''; registerForm.value.confirmPassword = '' })
const handleRegister = async () => {
  if (sending.value) return
  registerForm.value.email = normalizeEmail(registerForm.value.email)
  const operation = submission.begin()
  if (!operation) return
  const data = { ...registerForm.value }
  try {
    const valid = await registerRef.value?.validate().catch(() => false)
    if (!valid || !submission.isActive(operation)) return
    const res = await addUser({ email: data.email, code: data.code, password: data.password, ...(data.name.trim() ? { name: data.name.trim() } : {}) }, operation.config)
    if (!submission.isActive(operation)) return
    if (res?.code !== 1) { feedback.error(res?.msg || '注册失败'); return }
    registerForm.value.code = ''
    registerForm.value.password = ''
    registerForm.value.confirmPassword = ''
    feedback.success('注册成功，请使用邮箱登录')
    await router.replace('/login')
  } catch {
    // 网络和 HTTP 错误由统一请求封装提示。
  } finally { submission.finish(operation) }
}
</script>
<style scoped>
.register {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 24px 16px 64px;
  background: linear-gradient(#eef1fb66,#eef1fb66),url('@/assets/images/login-background.webp') center/cover;
}
.register-form {
  width: 430px;
  max-width: 100%;
  padding: 38px 32px 24px;
  border-radius: 20px;
  background: #ffffffed;
  box-shadow: 0 16px 60px #24334b1a;
}
.auth-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 20px;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--primary);
  color: #fff;
}
.title {
  font-size: 23px;
  font-weight: 600;
  text-align: center;
  margin: 0 0 8px;
}
.auth-subtitle {
  font-size: 13px;
  color: var(--muted);
  text-align: center;
  margin-bottom: 28px;
}
.link-container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 0 20px;
  font-size: 13px;
}
.auth-submit {
  width: 100%;
}
.auth-footer {
  position: fixed;
  bottom: 0;
  width: 100%;
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 12px;
  color: #fff;
  font-size: 11px;
  background: #2531491a;
}
@media(max-width:480px) {
  .register-form {
    padding: 30px 22px 22px;
  }
}
</style>
