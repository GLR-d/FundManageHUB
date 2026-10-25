export interface ChatMessage {
  id: string
  role: 'user' | 'ai'
  content: string
  createdAt: number
  updatedAt: number
  expiresAt?: number
  pending?: boolean
  failed?: boolean
  interrupted?: boolean
  conversationId?: string
}

export interface ChatConversation {
  id: string
  title: string
  createdAt: number
  messages: ChatMessage[]
  pinned?: boolean
  metadataUpdatedAt?: number
}

export interface ChatMessageEvent {
  conversationId: string
  id: string
  role: 'user' | 'ai'
  content: string
  pending?: boolean
  failed?: boolean
  replace?: boolean
}
