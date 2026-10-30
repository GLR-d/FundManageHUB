import type { ChatMessage, ChatConversation, ChatMessageEvent, ChatQuestion } from '@/types/chat'

export const CHAT_CONVERSATION_TITLE_MAX_LENGTH = 50
type MessageInput = { role: 'user' | 'ai'; id?: unknown; content?: unknown; createdAt?: unknown; updatedAt?: unknown; expiresAt?: unknown; pending?: unknown; failed?: unknown; interrupted?: unknown; conversationId?: unknown; questions?: unknown }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const isMessage = (value: unknown): value is MessageInput => isRecord(value) && (value.role === 'user' || value.role === 'ai')
const questions = (value: unknown): ChatQuestion[] => Array.isArray(value) ? value.filter((item): item is ChatQuestion =>
  isRecord(item) && typeof item.interruptId === 'string' && typeof item.question === 'string' &&
  Array.isArray(item.options) && item.options.every(option => typeof option === 'string') && typeof item.allowCustomAnswer === 'boolean') : []
const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
let lastTimestamp = 0
const timestamp = () => { lastTimestamp = Math.max(Date.now(), lastTimestamp + 1); return lastTimestamp }
export const createMessageId = () => timestamp() + '_' + Math.random().toString(36).slice(2, 10)
const parse = (key: string): unknown => { try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null } }
const prefix = (key: string) => key + ':records:'
const conversationKey = (key: string, id: string) => prefix(key) + 'conversation:' + encodeURIComponent(id)
const messageKey = (key: string, conversationId: string, id: string) => prefix(key) + 'message:' + encodeURIComponent(conversationId) + ':' + encodeURIComponent(id)
const deletionKey = (key: string, id: string) => prefix(key) + 'deleted:' + encodeURIComponent(id)
const deletedConversations = new Map<string, Set<string>>()
const rememberDeletion = (key: string, id: string) => {
  let ids = deletedConversations.get(key)
  if (!ids) { ids = new Set(); deletedConversations.set(key, ids) }
  ids.add(id)
}
const isConversationDeleted = (key: string | null, id: string) => {
  if (!key) return false
  if (deletedConversations.get(key)?.has(id)) return true
  const marker = parse(deletionKey(key, id))
  const metadata = parse(conversationKey(key, id))
  const deleted = (isRecord(marker) && marker.id === id && marker.deleted === true) ||
    (isRecord(metadata) && metadata.id === id && metadata.deleted === true)
  if (deleted) rememberDeletion(key, id)
  return deleted
}
type ConversationMetadata = Omit<ChatConversation, 'messages'>
const conversationMetadata = (record: Record<string, unknown>, id: string, index: number): ConversationMetadata => ({
  id,
  title: typeof record.title === 'string' ? record.title : '对话',
  createdAt: finite(record.createdAt, index),
  ...(typeof record.pinned === 'boolean' ? { pinned: record.pinned } : {}),
  ...(Array.isArray(record.pendingQuestions) ? { pendingQuestions: questions(record.pendingQuestions) } : {}),
  ...(typeof record.metadataUpdatedAt === 'number' && Number.isFinite(record.metadataUpdatedAt) ? { metadataUpdatedAt: record.metadataUpdatedAt } : {})
})
const compareConversations = (a: ConversationMetadata, b: ConversationMetadata) =>
  Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
export const sortChatConversations = (history: ChatConversation[]) => [...history].sort(compareConversations)
const normalizeMessage = (msg: MessageInput, conversationId: string, index: number): ChatMessage => {
  const createdAt = finite(msg.createdAt, index)
  const deadline = finite(msg.expiresAt, createdAt + 125000)
  const interrupted = Boolean(msg.interrupted || (msg.pending && deadline <= Date.now()))
  return {
    id: typeof msg.id === 'string' ? msg.id : 'legacy-' + conversationId + '-' + index,
    role: msg.role,
    content: interrupted && !msg.content ? '回复未完成，请重新发送' : (typeof msg.content === 'string' ? msg.content : ''),
    createdAt,
    updatedAt: finite(msg.updatedAt, 0),
    expiresAt: deadline,
    pending: Boolean(msg.pending && !interrupted),
    failed: Boolean(msg.failed || interrupted),
    interrupted,
    ...(Array.isArray(msg.questions) ? { questions: questions(msg.questions) } : {})
  }
}
const unfinished = (message: Partial<ChatMessage> | null | undefined) => Boolean(message?.pending || message?.interrupted)
const shouldReplace = (old: Partial<ChatMessage> | null | undefined, next: Partial<ChatMessage>) => {
  if (!old) return true
  // 已完成的结果优先于占位和过期占位，不依赖其他页面的时钟先后。
  if (unfinished(old) !== unfinished(next)) return unfinished(old)
  return typeof next.updatedAt === 'number' && typeof old.updatedAt === 'number' && next.updatedAt > old.updatedAt
}
export const mergeChatHistories = (...histories: unknown[]): ChatConversation[] => {
  const conversations = new Map<string, ConversationMetadata & { messages: Map<string, ChatMessage> }>()
  const deleted = new Set<string>()
  histories.forEach(history => {
    if (!Array.isArray(history)) return
    history.forEach((item: unknown, index) => {
      if (!isRecord(item) || typeof item.id !== 'string') return
      if (item.deleted === true) { deleted.add(item.id); conversations.delete(item.id); return }
      if (deleted.has(item.id) || !Array.isArray(item.messages)) return
      const conversationId = item.id
      const metadata = conversationMetadata(item, conversationId, index)
      const existing = conversations.get(conversationId) || { ...metadata, messages: new Map<string, ChatMessage>() }
      // 置顶属于对话元数据，不能让旧消息快照覆盖更新的置顶状态。
      if ((metadata.metadataUpdatedAt ?? 0) > (existing.metadataUpdatedAt ?? 0)) Object.assign(existing, metadata)
      item.messages.forEach((msg: unknown, messageIndex) => {
        if (!isMessage(msg)) return
        const next = normalizeMessage(msg, conversationId, messageIndex)
        const old = existing.messages.get(next.id)
        if (shouldReplace(old, next)) existing.messages.set(next.id, next)
      })
      conversations.set(item.id, existing)
    })
  })
  return [...conversations.values()].sort(compareConversations)
    .map(item => ({ ...item, messages: [...item.messages.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) }))
}
export const readChatHistory = (key: string | null): ChatConversation[] => {
  if (!key) return []
  const records = new Map<string, ConversationMetadata & { messages: MessageInput[] }>()
  const messages: (MessageInput & { conversationId: string })[] = []
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index)
      if (!name?.startsWith(prefix(key))) continue
      const record = parse(name)
      if (!isRecord(record)) continue
      if (typeof record.id === 'string' && record.deleted === true &&
          (name === deletionKey(key, record.id) || name === conversationKey(key, record.id))) {
        rememberDeletion(key, record.id)
      } else if (typeof record.id === 'string' && name === conversationKey(key, record.id)) {
        records.set(record.id, { ...conversationMetadata(record, record.id, index), messages: [] })
      } else if (typeof record.conversationId === 'string' && typeof record.id === 'string' && isMessage(record) &&
          name === messageKey(key, record.conversationId, record.id)) messages.push({ ...record, conversationId: record.conversationId })
    }
  } catch { /* 存储不可用时仍尝试读取旧格式。 */ }
  messages.forEach(msg => {
    if (!records.has(msg.conversationId)) records.set(msg.conversationId, { id: msg.conversationId, title: '对话', createdAt: finite(msg.createdAt, 0), messages: [] })
    records.get(msg.conversationId)!.messages.push(msg)
  })
  // 旧的账户历史作为只读来源；删除标记同时屏蔽旧格式和延迟到达的消息。
  return mergeChatHistories(parse(key), [...records.values()]).filter(item => !isConversationDeleted(key, item.id))
}
export const expirePendingMessages = (history: ChatConversation[]) => {
  history.forEach(conversation => conversation.messages.forEach((message, index) => {
    if (message.pending && (message.expiresAt ?? message.createdAt + 125000) <= Date.now()) {
      conversation.messages[index] = normalizeMessage(message, conversation.id, index)
    }
  }))
}
export const applyChatMessage = (history: ChatConversation[], message: ChatMessageEvent) => {
  const conversation = history.find(item => item.id === message.conversationId)
  if (!conversation) return false
  const index = conversation.messages.findIndex(item => item.id === message.id)
  if (message.replace && index === -1) return false
  const old = index === -1 ? null : conversation.messages[index]
  if (old && !old.pending && message.pending) return false
  const { pendingQuestions, ...fields } = message
  if (pendingQuestions !== undefined) conversation.pendingQuestions = pendingQuestions
  const next = { ...old, ...fields, interrupted: false, createdAt: old?.createdAt ?? timestamp(), updatedAt: timestamp(), expiresAt: message.pending ? Date.now() + 125000 : undefined }
  if (index === -1) conversation.messages.push(next)
  else conversation.messages[index] = next
  return true
}

// 旧浏览器记录只作为一次性迁移来源；新记录由后端保存。
export const migrateChatHistory = async (
  key: string | null,
  upload: (conversation: ChatConversation) => Promise<unknown>,
  isActive: () => boolean,
) => {
  if (!key || localStorage.getItem(key + ':redis-migrated-v1') === '1') return
  const history = readChatHistory(key)
  for (const conversation of history) {
    // 浏览器旧记录只能迁移展示消息，不能导入服务端的待回答状态。
    const { pendingQuestions: _pendingQuestions, ...metadata } = conversation
    const messages = conversation.messages.map(({ questions: _questions, ...message }) => ({ ...message, content: message.pending && !message.content ? '回复未完成，请重新发送' : message.content, pending: false, failed: Boolean(message.failed || message.pending), interrupted: Boolean(message.interrupted || message.pending) }))
    for (let start = 0; start < Math.max(1, messages.length); start += 100) {
      if (!isActive()) throw new Error('登录会话已变更')
      await upload({ ...metadata, title: conversation.title.trim().slice(0, CHAT_CONVERSATION_TITLE_MAX_LENGTH) || '对话', messages: messages.slice(start, start + 100) })
    }
  }
  if (isActive()) localStorage.setItem(key + ':redis-migrated-v1', '1')
}
