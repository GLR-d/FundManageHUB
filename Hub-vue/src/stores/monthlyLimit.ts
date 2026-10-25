import { ref } from 'vue'
import type { SessionSnapshot } from '@/types/account'

import { getMonthlyLimit, updateMonthlyLimit } from '@/api/monthlyLimit'
import { captureSession, isCurrentSession, onSessionChange } from '@/stores/auth'
import { feedback, getRequestErrorMessage } from '@/utils/feedback'
import { errorDetails } from '@/utils/errors'
import { formatCents } from '@/utils/funds'

export const monthlyLimitCents = ref<number | null>(null)
export const monthlyLimitLoaded = ref(false)
export const monthlyLimitLoading = ref(false)
export const monthlyLimitSaving = ref(false)
export const monthlyLimitError = ref('')

class MonthlyLimitDataError extends Error {}
const parseAmount = (value: string) => {
  const amount = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) throw new MonthlyLimitDataError('限额须为正数，最多两位小数')
  const [yuan, fraction = ''] = amount.split('.')
  // 用整数解析完整十进制金额，安全上限附近也不能先经过浮点数舍入。
  const compactYuan = yuan.replace(/^0+/, '') || '0'
  if (compactYuan.length > 14) throw new MonthlyLimitDataError('限额金额过大')
  const cents = BigInt(compactYuan) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (cents <= 0n) throw new MonthlyLimitDataError('限额须大于 0')
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new MonthlyLimitDataError('限额金额过大')
  return Number(cents)
}
export const normalizeMonthlyLimitAmount = (value: string | null): string | null => {
  if (value === null || value.trim() === '') return null
  return formatCents(parseAmount(value))
}
const readResponse = (value: unknown): number | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'amount')) throw new MonthlyLimitDataError('限额数据异常，请重试')
  const amount = (value as { amount: unknown }).amount
  if (amount === null) return null
  if (typeof amount !== 'string' || !amount.trim()) throw new MonthlyLimitDataError('限额数据异常，请重试')
  try { return parseAmount(amount) }
  catch { throw new MonthlyLimitDataError('限额数据异常，请重试') }
}
interface Operation { session: SessionSnapshot; controller: AbortController; promise: Promise<boolean> }
let owner: SessionSnapshot | null = null
let loading: Operation | null = null
let saving: (Operation & { amount: string | null }) | null = null
const reset = () => {
  loading?.controller.abort()
  saving?.controller.abort()
  loading = null
  saving = null
  owner = null
  monthlyLimitCents.value = null
  monthlyLimitLoaded.value = false
  monthlyLimitLoading.value = false
  monthlyLimitSaving.value = false
  monthlyLimitError.value = ''
}
const stopSession = onSessionChange(reset)
if (import.meta.hot) import.meta.hot.dispose(() => { stopSession(); reset() })
const sessionForOperation = () => {
  const session = captureSession()
  if (!owner || owner.version !== session.version || owner.token !== session.token) { reset(); owner = session }
  return session
}
const isActive = (operation: Operation, kind: 'load' | 'save') => !operation.controller.signal.aborted && isCurrentSession(operation.session) && (kind === 'load' ? loading : saving) === operation
const showFailure = (cause: unknown) => {
  const details = errorDetails(cause)
  if (details.code === 'ERR_CANCELED' || details.__CANCEL__ || details.response?.status === 401) return
  monthlyLimitError.value = cause instanceof MonthlyLimitDataError ? cause.message : getRequestErrorMessage(cause)
  feedback.error(monthlyLimitError.value)
}
export const loadMonthlyLimit = (force = false): Promise<boolean> => {
  const session = sessionForOperation()
  if (!session.token) return Promise.resolve(false)
  // 保存开始后不能用先前的读取结果覆盖新值；并发读取可直接等待保存结果。
  if (saving) return saving.promise
  if (loading && !force) return loading.promise
  if (monthlyLimitLoaded.value && !force) return Promise.resolve(true)
  loading?.controller.abort()
  const operation: Operation = { session, controller: new AbortController(), promise: Promise.resolve(false) }
  loading = operation
  monthlyLimitLoading.value = true
  monthlyLimitError.value = ''
  operation.promise = (async () => {
    try {
      const result = await getMonthlyLimit({ signal: operation.controller.signal, silentError: true, expectedSession: session })
      if (!isActive(operation, 'load')) return false
      if (result?.code !== 1) throw new MonthlyLimitDataError(result?.msg || '获取限额失败，请重试')
      monthlyLimitCents.value = readResponse(result.data)
      monthlyLimitLoaded.value = true
      return true
    } catch (cause) {
      if (isActive(operation, 'load')) showFailure(cause)
      return false
    } finally {
      if (loading === operation) { loading = null; monthlyLimitLoading.value = false }
    }
  })()
  return operation.promise
}
export const saveMonthlyLimit = (value: string | null): Promise<boolean> => {
  const session = sessionForOperation()
  if (!session.token) return Promise.resolve(false)
  let amount: string | null
  try { amount = normalizeMonthlyLimitAmount(value) }
  catch (cause) { feedback.error(cause instanceof Error ? cause.message : '请输入有效限额'); return Promise.resolve(false) }
  // 禁止并行修改同一项，避免网络完成顺序导致服务端保存旧值。
  if (saving) {
    if (saving.amount === amount) return saving.promise
    feedback.warning('限额正在保存，请稍后重试')
    return Promise.resolve(false)
  }
  loading?.controller.abort()
  loading = null
  monthlyLimitLoading.value = false
  const operation: Operation & { amount: string | null } = { session, controller: new AbortController(), promise: Promise.resolve(false), amount }
  saving = operation
  monthlyLimitSaving.value = true
  monthlyLimitError.value = ''
  operation.promise = (async () => {
    try {
      const result = await updateMonthlyLimit({ amount }, { signal: operation.controller.signal, silentError: true, expectedSession: session })
      if (!isActive(operation, 'save')) return false
      if (result?.code !== 1) throw new MonthlyLimitDataError(result?.msg || '保存限额失败，请重试')
      monthlyLimitCents.value = readResponse(result.data)
      monthlyLimitLoaded.value = true
      feedback.success(amount === null ? '限额已清除' : '限额已保存')
      return true
    } catch (cause) {
      if (isActive(operation, 'save')) showFailure(cause)
      return false
    } finally {
      if (saving === operation) { saving = null; monthlyLimitSaving.value = false }
    }
  })()
  return operation.promise
}
