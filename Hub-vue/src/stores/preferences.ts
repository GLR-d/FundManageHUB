import { ref } from 'vue'
const KEY = 'moneyManagePreferences'
const normalizePreferences = (input: unknown) => {
  const value = input as { showChatSidebar?: unknown } | null
  return ({
  showChatSidebar: typeof value?.showChatSidebar === 'boolean' ? value.showChatSidebar : true
})
}
const readPreferences = () => {
  try { return normalizePreferences(JSON.parse(localStorage.getItem(KEY) || 'null')) }
  catch { return normalizePreferences(null) }
}
export const preferences = ref(readPreferences())
export const savePreferences = (value: unknown) => {
  preferences.value = normalizePreferences(value)
  localStorage.setItem(KEY, JSON.stringify(preferences.value))
}
export const startPreferencesSync = (target = window) => {
  const handle = (event: StorageEvent) => { if (event.key === KEY || event.key === null) preferences.value = readPreferences() }
  target.addEventListener('storage', handle)
  return () => target.removeEventListener('storage', handle)
}
