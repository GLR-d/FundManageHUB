import type { UserProfile } from '@/types/account'

import { getUser } from '@/api/my'
import { feedback, getRequestErrorMessage } from '@/utils/feedback'
import { errorDetails } from '@/utils/errors'
import { captureSession, isCurrentSession, currentUser, userRevision } from '@/stores/auth'
let inFlight: { version: number; promise: Promise<UserProfile | null>; silent: boolean } | null = null
let loadedVersion = -1
let loadedAt = 0
const cacheDuration = 30000
const sameProfile = (left: UserProfile, right: UserProfile) => {
  const keys = Object.keys(right) as (keyof UserProfile)[]
  return keys.length === Object.keys(left).length && keys.every(key => Object.hasOwn(left, key) && Object.is(left[key], right[key]))
}
export const loadCurrentUser = ({ force = false, silent = false } = {}) => {
  const snapshot = captureSession()
  if (!snapshot.token) return Promise.resolve(null)
  if (inFlight?.version === snapshot.version) {
    if (!silent) inFlight.silent = false
    return inFlight.promise
  }
  const cacheAge = Date.now() - loadedAt
  if (!force && loadedVersion === snapshot.version && cacheAge >= 0 && cacheAge < cacheDuration) return Promise.resolve(currentUser.value)
  const revision = userRevision.value
  const record = { version: snapshot.version, promise: Promise.resolve<UserProfile | null>(null), silent }
  record.promise = getUser({ silentError: silent, expectedSession: snapshot }).then(res => {
    if (!isCurrentSession(snapshot)) return null
    if (revision !== userRevision.value) {
      loadedVersion = snapshot.version
      loadedAt = Date.now()
      return null
    }
    if (res?.code === 1 && res.data && typeof res.data === 'object' && !Array.isArray(res.data) && Object.keys(res.data).length) {
      if (!sameProfile(currentUser.value, res.data)) currentUser.value = res.data
      loadedVersion = snapshot.version
      loadedAt = Date.now()
      return res.data
    }
    if (!record.silent) feedback.error(res?.msg || '获取用户信息失败')
    return null
  }).catch(cause => {
    // 手动刷新复用已发出的静默请求时，补上该次手动操作需要的错误提示。
    const error = errorDetails(cause)
    if (silent && !record.silent && isCurrentSession(snapshot) && revision === userRevision.value && error.code !== 'ERR_CANCELED' && !error.__CANCEL__ && error.response?.status !== 401) feedback.error(getRequestErrorMessage(error))
    return null
  }).finally(() => { if (inFlight === record) inFlight = null })
  inFlight = record
  return record.promise
}
