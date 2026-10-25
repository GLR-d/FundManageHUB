import type { SessionSnapshot } from '@/types/account'

import { ref } from 'vue'
import { logoutapi } from '@/api/login'
import router from '@/router'
import { captureSession, clearSession, isCurrentSession, onSessionChange } from '@/stores/auth'
import { feedback } from '@/utils/feedback'
import { isRouteLoadError } from '@/utils/routeRecovery'

export const loggingOut = ref(false)
let pending: SessionSnapshot | null = null
onSessionChange(() => { pending = null; loggingOut.value = false })

export const logout = async () => {
  const snapshot = captureSession()
  if (loggingOut.value || !snapshot.token) return
  pending = snapshot
  loggingOut.value = true
  try {
    // 先撤销服务端会话；请求失败保留本地登录，允许再次退出。
    const result = await logoutapi({ expectedSession: snapshot }).catch(() => null)
    if (!result || !isCurrentSession(snapshot)) return
    if (result.code !== 1) { feedback.error(result.msg || '退出登录失败，请重试'); return }
    clearSession()
    await router.replace('/login').catch(error => { if (!isRouteLoadError(error)) throw error })
  } finally {
    // 旧账号的迟到结果不能影响后来账号的退出操作。
    if (pending === snapshot) { pending = null; loggingOut.value = false }
  }
}
