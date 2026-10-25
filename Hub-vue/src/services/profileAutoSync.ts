import { captureSession, isCurrentSession, onSessionChange } from '@/stores/auth'
import { loadCurrentUser } from '@/stores/user'

interface ProfileAutoSyncOptions {
  isPaused?: () => boolean
  target?: Window
  page?: Document
}

export const startProfileAutoSync = ({ isPaused = () => false, target = window, page = target.document }: ProfileAutoSyncOptions = {}) => {
  const snapshot = captureSession()
  if (!snapshot.token) return () => {}
  let stopped = false
  let running = false
  let timer: number | undefined
  let lastStarted = -Infinity
  let unsubscribe = () => {}
  const clearTimer = () => { if (timer !== undefined) { target.clearTimeout(timer); timer = undefined } }
  const visibleOnline = () => page.visibilityState === 'visible' && target.navigator.onLine !== false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimer()
    page.removeEventListener('visibilitychange', checkSoon)
    target.removeEventListener('focus', checkSoon)
    target.removeEventListener('online', checkSoon)
    target.removeEventListener('offline', checkSoon)
    unsubscribe()
  }
  const current = () => {
    if (stopped) return false
    if (!isCurrentSession(snapshot)) { stop(); return false }
    return !stopped
  }
  const schedule = (delay = 30000) => {
    clearTimer()
    if (!current() || !visibleOnline() || running) return
    timer = target.setTimeout(() => { timer = undefined; void refresh() }, delay)
  }
  const refresh = async () => {
    if (!current() || !visibleOnline() || running) return
    if (isPaused()) { schedule(); return }
    running = true
    lastStarted = Date.now()
    try { await loadCurrentUser({ force: true, silent: true }) }
    catch { /* 后台同步失败不打断使用，下一次轮询继续重试。 */ }
    finally { running = false; schedule() }
  }
  function checkSoon() {
    clearTimer()
    if (!current() || !visibleOnline() || running) return
    if (isPaused()) { schedule(); return }
    // visibilitychange、focus 和 online 常连续触发，共用一个短延迟。
    const elapsed = Date.now() - lastStarted
    schedule(Math.max(120, Number.isFinite(elapsed) && elapsed >= 0 ? 1000 - elapsed : 120))
  }
  unsubscribe = onSessionChange(stop)
  page.addEventListener('visibilitychange', checkSoon)
  target.addEventListener('focus', checkSoon)
  target.addEventListener('online', checkSoon)
  target.addEventListener('offline', checkSoon)
  void refresh()
  return stop
}
