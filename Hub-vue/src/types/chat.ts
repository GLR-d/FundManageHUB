export interface ChatQuestion {
  interruptId: string
  question: string
  options: string[]
  allowCustomAnswer: boolean
}

export interface ChatQuestionEvent {
  conversationId: string
  messageId: string
  questions: ChatQuestion[]
}

export type ChatStreamRequest = {
  conversationId: string
  messageId?: string
  replyId?: string
} & ({ message: string } | { interruptId: string; answer: string })

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
  questions?: ChatQuestion[]
}

export interface ChatConversation {
  id: string
  title: string
  createdAt: number
  messages: ChatMessage[]
  pinned?: boolean
  metadataUpdatedAt?: number
  pendingQuestions?: ChatQuestion[]
}

export interface ChatMessageEvent {
  conversationId: string
  id: string
  role: 'user' | 'ai'
  content: string
  pending?: boolean
  failed?: boolean
  replace?: boolean
  questions?: ChatQuestion[]
  pendingQuestions?: ChatQuestion[]
}
