import type { SessionSnapshot } from '@/types/account'

import router from '@/router'
import { clearSession, isCurrentSession } from '@/stores/auth'
import { feedback } from '@/utils/feedback'
import { isRouteLoadError } from '@/utils/routeRecovery'

/** Expire only the session that issued the rejected HTTP or streaming request. */
export const expireSession = (snapshot: SessionSnapshot | undefined, { loginFailureMessage = '登录验证失败，请检查账号和密码' } = {}) => {
  if (!snapshot || !isCurrentSession(snapshot)) return false
  clearSession()
  const route = router.currentRoute.value
  if (route.path === '/login') feedback.error(loginFailureMessage)
  else {
    feedback.error('登录已过期，请重新登录')
    router.replace({ path: '/login', query: { redirect: route.fullPath } }).catch(error => { if (!isRouteLoadError(error)) throw error })
  }
  return true
}
