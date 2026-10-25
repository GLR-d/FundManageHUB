import type { LoginUser, UserProfile, SessionSnapshot } from '@/types/account'

import { ref, watch } from 'vue'
const LOGIN_KEY = 'loginUser'
export const readLoginUser = (): LoginUser | null => {
  try {
    const user = JSON.parse(localStorage.getItem(LOGIN_KEY) || 'null')
    return user && typeof user === 'object' && typeof user.token === 'string' && user.token ? user : null
  } catch {
    try { localStorage.removeItem(LOGIN_KEY) } catch { /* 存储不可用时保持未登录。 */ }
    return null
  }
}
export const loginUser = ref(readLoginUser())
export const currentUser = ref<UserProfile>({})
export const sessionVersion = ref(0)
export const userRevision = ref(0)
watch(currentUser, () => { userRevision.value++ }, { flush: 'sync' })
const listeners = new Set<(user: LoginUser | null, reason: string) => void>()
const signature = (user: LoginUser | null) => user ? JSON.stringify([user.token, user.id ?? null]) : ''
const changeSession = (user: LoginUser | null, reason: string, force = false) => {
  if (!force && signature(user) === signature(loginUser.value)) return false
  sessionVersion.value++
  loginUser.value = user
  currentUser.value = {}
  listeners.forEach(listener => listener(user, reason))
  return true
}
export const onSessionChange = (listener: (user: LoginUser | null, reason: string) => void) => { listeners.add(listener); return () => listeners.delete(listener) }
const syncSessionFromStorage = () => changeSession(readLoginUser(), 'external')
export const captureSession = () => {
  syncSessionFromStorage()
  return { version: sessionVersion.value, token: loginUser.value?.token || null }
}
export const isCurrentSession = (snapshot: SessionSnapshot | null | undefined) => {
  const current = captureSession()
  return Boolean(snapshot && snapshot.version === current.version && snapshot.token === current.token)
}
export const setLoginUser = (user: LoginUser) => {
  if (!user || typeof user.token !== 'string' || !user.token) throw new Error('登录响应缺少有效 token')
  localStorage.setItem(LOGIN_KEY, JSON.stringify(user))
  changeSession(user, 'local', true)
}
export const clearSession = () => {
  try { localStorage.removeItem(LOGIN_KEY) } catch { /* 内存会话仍需清理。 */ }
  changeSession(null, 'local', true)
}
export const startSessionSync = (onExternalChange: (user: LoginUser | null) => void, target = window) => {
  const unsubscribe = onSessionChange((user, reason) => { if (reason === 'external') onExternalChange(user) })
  const handleStorage = (event: StorageEvent) => {
    if ((!event.storageArea || event.storageArea === localStorage) && (event.key === LOGIN_KEY || event.key === null)) syncSessionFromStorage()
  }
  target.addEventListener('storage', handleStorage)
  return () => { unsubscribe(); target.removeEventListener('storage', handleStorage) }
}
export const getChatStorageKey = () => {
  const user = readLoginUser()
  return user?.id !== undefined && user.id !== null ? 'chatHistory:' + encodeURIComponent(String(user.id)) : null
}
