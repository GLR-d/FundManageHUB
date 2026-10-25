import type { ApiResult, RequestConfig } from '@/types/api'
import type { FormRules } from '@/types/ui'

import type { Ref } from 'vue'
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { feedback } from '@/utils/feedback'
import { createSubmissionGuard } from '@/services/submission'

export const normalizeEmail = (email: string) => email.trim().toLowerCase()
export const emailCodeRules: FormRules = {
  email: [{ required: true, message: '请输入邮箱', trigger: 'blur' }, { type: 'email', message: '请输入有效邮箱', trigger: 'blur' }],
  code: [{ required: true, message: '请输入验证码', trigger: 'blur' }, { pattern: /^\d{6}$/, message: '请输入6位数字验证码', trigger: 'blur' }]
}
// 按邮箱保留截止时间，关闭弹窗或切换邮箱不会重置冷却；服务端会再次校验。
const cooldowns = reactive(new Map<string, number>())
export const useEmailCode = (
  model: Ref<{ email: string; code: string }>,
  request: (data: { email: string }, config: RequestConfig) => Promise<ApiResult<null>>,
  successMessage: string,
  isEnabled = () => true
) => {
  const clock = ref(Date.now())
  const email = computed(() => normalizeEmail(model.value.email))
  const remaining = computed(() => Math.max(0, Math.ceil(((cooldowns.get(email.value) || 0) - clock.value) / 1000)))
  const submission = createSubmissionGuard(isEnabled)
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  const stopTimer = () => { if (timer !== undefined) clearInterval(timer); timer = undefined }
  watch(remaining, seconds => {
    if (disposed) return
    if (!seconds) stopTimer()
    else if (timer === undefined) timer = setInterval(() => { clock.value = Date.now() }, 1000)
  }, { immediate: true, flush: 'sync' })
  watch(email, () => { submission.cancel(); model.value.code = ''; clock.value = Date.now() }, { flush: 'sync' })
  watch(isEnabled, enabled => { if (!enabled) submission.cancel() }, { flush: 'sync' })
  const sendCode = async () => {
    clock.value = Date.now()
    if (remaining.value) return
    const address = email.value
    if (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { feedback.error('请输入有效邮箱'); return }
    model.value.email = address
    const operation = submission.begin()
    if (!operation) return
    const sentAt = Date.now()
    try {
      const result = await request({ email: address }, operation.config)
      if (!submission.isActive(operation) || email.value !== address) return
      if (result?.code !== 1) { feedback.error(result?.msg || '验证码发送失败，请重试'); return }
      model.value.code = ''
      clock.value = Date.now()
      cooldowns.set(address, sentAt + 60000)
      feedback.success(successMessage)
    } catch {
      // 网络错误由请求封装提示；取消后的旧响应不再改变表单。
    } finally { submission.finish(operation) }
  }
  onUnmounted(() => { disposed = true; submission.dispose(); stopTimer() })
  return { remaining, sending: submission.busy, sendCode, cancel: submission.cancel }
}
