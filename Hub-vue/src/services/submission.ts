import type { RequestConfig } from '@/types/api'

import { ref } from 'vue'
import { captureSession, isCurrentSession, onSessionChange } from '@/stores/auth'

// 操作绑定创建页面时的会话；取消后的旧结果不能解锁或覆盖新操作。
export const createSubmissionGuard = (isEnabled = () => true, onCancel = () => {}) => {
  const session = captureSession()
  const busy = ref(false)
  let current: { controller: AbortController; config: RequestConfig } | null = null
  let disposed = false
  const cancel = () => {
    const operation = current
    current = null
    busy.value = false
    operation?.controller.abort()
    if (operation) onCancel()
  }
  const unsubscribe = onSessionChange(cancel)
  const begin = () => {
    if (disposed || current || !isEnabled() || !isCurrentSession(session)) return null
    const controller = new AbortController()
    const operation = { controller, config: { signal: controller.signal, expectedSession: session } }
    current = operation
    busy.value = true
    return operation
  }
  const isActive = (operation: { controller: AbortController } | null) => Boolean(operation && current === operation && !disposed && !operation.controller.signal.aborted && isEnabled() && isCurrentSession(session))
  const finish = (operation: { controller: AbortController } | null) => {
    if (current !== operation) return
    current = null
    busy.value = false
  }
  const dispose = () => { disposed = true; cancel(); unsubscribe() }
  return { busy, begin, isActive, finish, cancel, dispose }
}
