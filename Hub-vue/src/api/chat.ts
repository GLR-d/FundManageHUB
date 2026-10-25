import { fetchEventSource } from '@microsoft/fetch-event-source'
import { captureSession, isCurrentSession, onSessionChange, sessionVersion } from '@/stores/auth'
import { expireSession } from '@/services/sessionExpiry'
import request from '@/utils/request'
import type { ApiResult, RequestConfig } from '@/types/api'
import type { ChatConversation } from '@/types/chat'

import { isAxiosError } from 'axios'

const chatRequest = async <T>(operation: Promise<T>) => {
  try { return await operation }
  catch (error) {
    if (isAxiosError<ApiResult>(error) && error.response?.data?.msg) throw new Error(error.response.data.msg, { cause: error })
    throw error
  }
}

const conversationUrl = (id: string) => '/chat/conversations/' + encodeURIComponent(id)
export const getConversations = (config: RequestConfig = {}) => chatRequest(request.get<unknown, ApiResult<ChatConversation[]>>('/chat/conversations', config))
export const getConversation = (id: string, config: RequestConfig = {}) => chatRequest(request.get<unknown, ApiResult<ChatConversation>>(conversationUrl(id), config))
export const createConversation = (data: Pick<ChatConversation, 'id' | 'title' | 'createdAt'>, config: RequestConfig = {}) => chatRequest(request.post<unknown, ApiResult<ChatConversation>>('/chat/conversations', data, config))
export const updateConversation = (id: string, data: { title?: string; pinned?: boolean }, config: RequestConfig = {}) => chatRequest(request.patch<unknown, ApiResult<ChatConversation>>(conversationUrl(id), data, config))
export const removeConversation = (id: string, config: RequestConfig = {}) => chatRequest(request.delete<unknown, ApiResult>(conversationUrl(id), config))
export const importConversation = (data: ChatConversation, config: RequestConfig = {}) => chatRequest(request.post<unknown, ApiResult>('/chat/conversations/import', data, config))

export const streamChat = async (
  data: { conversationId: string; message: string; messageId?: string; replyId?: string },
  onToken: (content: string) => void,
  signal?: AbortSignal,
) => {
  const previousVersion = sessionVersion.value
  const snapshot = captureSession()
  if (previousVersion !== snapshot.version || !snapshot.token) throw new Error('登录会话已变更，请重新登录')
  const controller = new AbortController()
  const abort = () => controller.abort()
  const unsubscribe = onSessionChange(abort)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let done = false

  try {
    if (controller.signal.aborted) throw controller.signal.reason
    await fetchEventSource('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', token: snapshot.token },
      body: JSON.stringify(data),
      signal: controller.signal,
      // 隐藏页面时也继续当前请求，避免重新发送生成请求。
      openWhenHidden: true,
      async onopen(response) {
        if (!isCurrentSession(snapshot)) throw new Error('登录会话已变更')
        if (response.status === 401) expireSession(snapshot, { loginFailureMessage: '登录已过期，请重新登录' })
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { msg?: string } | null
          throw new Error(payload?.msg || `请求失败 ${response.status}`)
        }
        if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('服务端未返回流式回复')
      },
      onmessage(event) {
        if (controller.signal.aborted || !isCurrentSession(snapshot)) { abort(); return }
        if (done) return
        if (event.event === 'token') {
          const payload = JSON.parse(event.data) as { content?: unknown }
          if (typeof payload?.content !== 'string') throw new Error('收到无效的回复片段')
          onToken(payload.content)
        } else if (event.event === 'done') {
          done = true
        } else if (event.event === 'error') {
          const payload = JSON.parse(event.data) as { message?: unknown }
          throw new Error(typeof payload?.message === 'string' ? payload.message : '回复失败，请重试')
        }
      },
      onclose() {
        if (!done) throw new Error('连接中断，回复未完成')
      },
      onerror(error) {
        throw error // 终止重试，避免重复生成和重复写入会话。
      },
    })
    if (controller.signal.aborted) throw controller.signal.reason
    if (!isCurrentSession(snapshot)) throw new Error('登录会话已变更')
    if (!done) throw new Error('回复未完成')
  } finally {
    unsubscribe()
    signal?.removeEventListener('abort', abort)
  }
}


