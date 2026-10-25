import type { Router, RouteLocationNormalized } from 'vue-router'
import type { SessionSnapshot } from '@/types/account'

import { errorDetails } from './errors'
import { ref, shallowRef } from 'vue'
import { captureSession, isCurrentSession, onSessionChange } from '@/stores/auth'
import { feedback } from './feedback'

export const isRouteLoadError = (error: unknown) => /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS for /i.test(errorDetails(error).message || '')

const reloadPage = (href: string) => {
  const current = new URL(window.location.href)
  const target = new URL(href, current)
  if (target.origin !== current.origin) throw new Error('页面地址异常')
  // 同一路径带片段时 assign 可能只做页内跳转，无法获取新版本入口。
  if (target.pathname === current.pathname && target.search === current.search) {
    if (target.hash !== current.hash) window.history.replaceState(window.history.state, '', target.href)
    window.location.reload()
  } else window.location.assign(target.href)
}

export const createRouteRecovery = (router: Router, reload = reloadPage) => {
  const failure = shallowRef<{ path: string; session: SessionSnapshot } | null>(null)
  const retrying = ref(false)
  let navigation: { to: RouteLocationNormalized; session: SessionSnapshot } | null = null
  let retryOperation: { path: string; session: SessionSnapshot } | null = null
  let disposed = false
  const reset = () => { failure.value = null; retrying.value = false; retryOperation = null; navigation = null }
  const stopSession = onSessionChange(reset)
  const stopBefore = router.beforeEach(to => {
    const session = captureSession()
    if (!retryOperation || retryOperation.path !== to.fullPath || !isCurrentSession(retryOperation.session)) {
      failure.value = null
      retrying.value = false
      retryOperation = null
    }
    navigation = { to, session }
  })
  const stopError = router.onError((error, to) => {
    const attempt = navigation
    if (!isRouteLoadError(error)) {
      if (!disposed && attempt?.to === to && isCurrentSession(attempt.session)) reset()
      console.error(error)
      return
    }
    if (disposed || !attempt || attempt.to !== to || !isCurrentSession(attempt.session)) return
    failure.value = { path: to.fullPath, session: attempt.session }
    feedback.error('页面未能加载，请重试；若刚更新版本，可刷新整个页面。')
  })
  const stopAfter = router.afterEach((to, from, navigationFailure) => {
    const attempt = navigation
    if (!navigationFailure && attempt?.to === to && isCurrentSession(attempt.session)) reset()
  })
  const getFailure = () => {
    const target = failure.value
    if (disposed || !target) return null
    if (!isCurrentSession(target.session)) { reset(); return null }
    return target
  }
  const retry = async () => {
    if (retrying.value) return
    const target = getFailure()
    if (!target) return
    const operation = { ...target }
    retryOperation = operation
    retrying.value = true
    try { return await router.push(target.path) }
    catch (error) { if (!isRouteLoadError(error)) throw error }
    finally {
      if (retryOperation === operation) { retrying.value = false; retryOperation = null }
    }
  }
  const refresh = () => {
    if (retrying.value) return
    const target = getFailure()
    if (!target) return
    retrying.value = true
    try { reload(router.resolve(target.path).href) }
    catch { retrying.value = false; feedback.error('无法刷新页面，请使用浏览器的刷新按钮。') }
  }
  const dismiss = () => { if (!retrying.value) reset() }
  const dispose = () => { disposed = true; reset(); stopSession(); stopBefore(); stopError(); stopAfter() }
  return { failure, retrying, retry, refresh, dismiss, dispose }
}
