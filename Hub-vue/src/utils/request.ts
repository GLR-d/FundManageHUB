import type { AxiosError } from 'axios'
import axios from 'axios'
import { feedback, getRequestErrorMessage } from './feedback'
import { captureSession, isCurrentSession, sessionVersion, onSessionChange } from '@/stores/auth'
import { expireSession } from '@/services/sessionExpiry'
export const request = axios.create({ baseURL: '/api', timeout: 30000 })
const pending = new Set<AbortController>()
const stopSession = onSessionChange(() => {
  pending.forEach(controller => controller.abort()); pending.clear()
})
request.interceptors.request.use(config => {
  const previousVersion = sessionVersion.value
  const snapshot = captureSession()
  // 存储中的账号刚被其他页面修改，当前页面的操作不能改用新账号发出。
  if (previousVersion !== snapshot.version || (config.expectedSession && (config.expectedSession.version !== snapshot.version || config.expectedSession.token !== snapshot.token))) throw new axios.CanceledError('会话已变更')
  const controller = new AbortController()
  const externalSignal = config.signal
  const abort = () => controller.abort()
  if (externalSignal?.aborted) abort()
  else externalSignal?.addEventListener?.('abort', abort, { once: true })
  config.signal = controller.signal
  config._session = snapshot
  config._releaseRequest = () => { pending.delete(controller); externalSignal?.removeEventListener?.('abort', abort) }
  pending.add(controller)
  if (snapshot.token) config.headers.token = snapshot.token
  return config
})
request.interceptors.response.use(response => {
  response.config?._releaseRequest?.()
  if (response.config?._session && !isCurrentSession(response.config._session)) throw new axios.CanceledError('旧会话响应已忽略')
  return response.data
}, (error: AxiosError) => {
  const config = error.config || error.response?.config
  config?._releaseRequest?.()
  if (axios.isCancel(error)) return Promise.reject(error)
  if (config?._session && !isCurrentSession(config._session)) return Promise.reject(new axios.CanceledError('旧会话响应已忽略'))
  const status = error.response?.status
  if (status === 401) expireSession(config?._session)
  else if (!config?.silentError) feedback.error(getRequestErrorMessage(error))
  return Promise.reject(error)
})
if (import.meta.hot) import.meta.hot.dispose(() => { stopSession(); pending.forEach(controller => controller.abort()); pending.clear() })
export default request
