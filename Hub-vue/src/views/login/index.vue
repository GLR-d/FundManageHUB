<template>
  <div class="login">
    <UiForm ref="loginRef" :model="loginForm" :rules="loginRules" :disabled="loading" class="login-form">
      <div class="auth-mark">
        <UiIcon name="wallet" />
      </div>
      <h1 class="title">花销管理</h1>
      <UiField prop="email">
        <UiInput v-model="loginForm.email" type="email" autocomplete="username" placeholder="邮箱" aria-label="邮箱" maxlength="254" />
      </UiField>
      <UiField prop="password">
        <UiInput v-model="loginForm.password" type="password" show-password autocomplete="current-password" placeholder="密码" aria-label="密码" @keyup.enter="handleLogin" />
      </UiField>
      <div class="captcha-row">
        <UiField prop="captcha">
          <UiInput v-model="loginForm.captcha" autocomplete="off" placeholder="验证码" aria-label="验证码" @keyup.enter="handleLogin" />
        </UiField>
        <button type="button" class="captcha-refresh" :disabled="loading || captchaLoading" :aria-busy="captchaLoading" aria-label="刷新验证码" title="点击刷新验证码" @click="updateCaptcha">
          <span v-if="captchaLoading">加载中…</span>
          <img v-else-if="captchaData.image" :src="captchaData.image" alt="验证码" />
          <img v-else :src="captchaErrorImage" alt="验证码加载失败，点击重试" />
        </button>
      </div>
      <div class="link-container">
        <router-link to="/register">立即注册</router-link>
        <router-link to="/forgot-password">忘记密码</router-link>
      </div>
      <UiButton class="auth-submit" type="primary" :loading="loading" @click="handleLogin">{{ loading ? '登录中…' : '登录' }}</UiButton>
    </UiForm>
    <div class="auth-footer">Copyright © 2025–2026 my All Rights Reserved.</div>
  </div>
</template>
<script setup lang="ts">
import type { FormHandle, FormRules } from '@/types/ui'


import { errorDetails } from '@/utils/errors'
import UiForm from '@/components/ui/uiForm.vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import UiField from '@/components/ui/uiField.vue'
import UiInput from '@/components/ui/uiInput.vue'
import UiButton from '@/components/ui/uiButton.vue'
defineOptions({ name: 'Login' })
import { ref, onMounted, onUnmounted } from 'vue'
import { loginapi, getCaptcha, verifyCaptcha } from '@/api/login'
import { feedback } from '@/utils/feedback'
import router from '@/router'
import { isRouteLoadError } from '@/utils/routeRecovery'
import { setLoginUser, captureSession, isCurrentSession } from '@/stores/auth'
import captchaErrorImage from '@/assets/images/chaptchaError.png'
import { emailCodeRules, normalizeEmail } from '@/composables/useEmailCode'

const loginRef = ref<FormHandle | null>(null)
const loading = ref(false)
const loginForm = ref({ email: '', password: '', captcha: '' })
const loginRules: FormRules = {
  email: emailCodeRules.email,
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
  captcha: [{ required: true, message: '请输入验证码', trigger: 'blur' }]
}
const captchaData = ref({ uuid: '', image: '' })
const captchaLoading = ref(false)
let captchaRequestId = 0
let captchaController: AbortController | null = null
let loginController: AbortController | null = null
let disposed = false
const getCap = async () => {
  if (disposed || loading.value) return
  const requestId = ++captchaRequestId
  captchaController?.abort()
  captchaController = new AbortController()
  captchaLoading.value = true
  captchaData.value = { uuid: '', image: '' }
  try {
    const res = await getCaptcha({ signal: captchaController.signal })
    if (disposed || requestId !== captchaRequestId) return
    if (res?.code === 1 && typeof res.data?.uuid === 'string' && res.data.uuid && typeof res.data.image === 'string' && res.data.image) captchaData.value = res.data
    else feedback.error(res?.msg || '验证码加载失败，请点击图片重试')
  } catch {
    // 请求封装已提示；旧请求和离开的页面不再更新验证码。
  } finally { if (!disposed && requestId === captchaRequestId) captchaLoading.value = false }
}
const updateCaptcha = () => {
  if (loading.value || captchaLoading.value || disposed) return
  loginForm.value.captcha = ''
  return getCap()
}
onMounted(getCap)
onUnmounted(() => { disposed = true; captchaRequestId++; captchaController?.abort(); loginController?.abort() })
const handleLogin = async () => {
  if (loading.value || disposed) return
  loginForm.value.email = normalizeEmail(loginForm.value.email)
  const data = { ...loginForm.value }
  const uuid = captchaData.value.uuid
  const snapshot = captureSession()
  loginController = new AbortController()
  loading.value = true
  let refreshCaptcha = false
  try {
    const valid = await loginRef.value?.validate().catch(() => false)
    if (!valid || disposed || !isCurrentSession(snapshot)) return
    if (!uuid || captchaLoading.value) {
      feedback.error('验证码尚未加载，请点击图片重试')
      return
    }
    const config = { signal: loginController.signal }
    const verifyRes = await verifyCaptcha({ uuid, code: data.captcha }, config)
    if (disposed || !isCurrentSession(snapshot)) return
    if (verifyRes?.code !== 1) {
      feedback.error(verifyRes?.msg || '验证码错误')
      refreshCaptcha = true
      return
    }
    const res = await loginapi(data, config)
    if (disposed || !isCurrentSession(snapshot)) return
    if (res?.code !== 1) {
      feedback.error(res?.msg || '登录失败')
      refreshCaptcha = true
      return
    }
    setLoginUser(res.data)
    const redirect = router.currentRoute.value.query.redirect
    const target = typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//')
      && !['/login', '/register'].includes(redirect.split('?')[0]) ? redirect : '/dashboard'
    await router.replace(target)
    feedback.success('登录成功')
  } catch (cause) {
    const error = errorDetails(cause)
    if (isRouteLoadError(error)) return
    if (disposed || error?.code === 'ERR_CANCELED' || error?.__CANCEL__ || !isCurrentSession(snapshot)) return
    if (!error.isAxiosError) feedback.error(error.message || '登录失败')
    refreshCaptcha = true
  } finally {
    loading.value = false
    if (refreshCaptcha && !disposed) updateCaptcha()
  }
}
</script>
<style scoped>
.login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 24px 16px 64px;
  background: linear-gradient(#eef1fb66,#eef1fb66),url('@/assets/images/login-background.webp') center/cover;
}
.login-form {
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
  margin: 0 0 28px;
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
.captcha-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 22px;
}
.captcha-row .ui-field {
  flex: 1;
  margin: 0;
  min-width: 0;
}
.captcha-refresh {
  flex: 0 0 108px;
  width: 108px;
  height: 42px;
  border: 1px solid var(--line);
  padding: 0;
  border-radius: 9px;
  background: #f7f8fb;
  overflow: hidden;
  font-size: 12px;
  color: var(--muted);
}
.captcha-refresh img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
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
  .login-form {
    padding: 30px 22px 22px;
  }
}
</style>
