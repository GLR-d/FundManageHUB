<template>
  <section class="chat-view" aria-label="AI 聊天">
    <header class="chat-header">
      <UiButton v-if="historyHidden" circle class="history-toggle" aria-label="显示聊天历史" title="显示聊天历史" @click="emit('toggle-history')">
        <UiIcon name="menu" />
      </UiButton>
      <div class="header-copy">
        <h1 :title="conversationTitle">{{ conversationTitle }}</h1>
      </div>
      <span v-if="sending" class="generation-status" role="status"><span class="status-dot" aria-hidden="true" />正在回复</span>
    </header>

    <div ref="chatContentRef" class="chat-content" role="log" aria-label="聊天消息" aria-live="off">
      <div class="message-list" :class="{ 'is-empty': !visibleMessages.length }">
        <div v-show="hasOlderMessages" ref="olderMessagesRef" class="older-messages" role="status">{{ loadingOlder ? '正在显示更早的消息…' : '继续向上滚动，查看更早的消息' }}</div>
        <div v-if="!visibleMessages.length" class="chat-welcome">
          <div class="welcome-mark" aria-hidden="true"><UiIcon name="chat" /></div>
          <h2>聊聊你的每一笔</h2>
          <div class="welcome-prompts" aria-label="试试这些话题">
            <button v-for="prompt in promptSuggestions" :key="prompt" type="button" @click="usePrompt(prompt)">{{ prompt }}<UiIcon name="chevron" /></button>
          </div>
        </div>
        <article v-for="msg in visibleMessages" :key="msg.id" class="message-item" :class="msg.role" :aria-label="msg.role === 'ai' ? 'AI 助手的回复' : '我的消息'" :aria-busy="msg.pending || undefined">
          <div class="message-body">
            <div class="message-label">
              <span>{{ msg.role === 'ai' ? 'AI 助手' : userLabel }}</span>
              <span v-if="msg.pending && msg.content" class="message-state">生成中</span>
              <span v-else-if="msg.failed" class="message-state is-interrupted">回复未完成</span>
            </div>
            <div class="bubble" :class="{ 'is-pending': msg.pending && !msg.content }">
              <template v-if="msg.pending && !msg.content">
                <span class="typing-indicator" aria-hidden="true"><i /><i /><i /></span>
                <span class="typing-label">正在思考…</span>
              </template>
              <template v-else>{{ msg.content }}</template>
            </div>
          </div>
        </article>
      </div>
    </div>

    <footer class="chat-footer">
      <form class="chat-composer" @submit.prevent="sendMessage">
        <textarea ref="composerRef" v-model="inputText" aria-label="发送消息" placeholder="发送消息，聊聊开支或预算…" rows="2" :maxlength="messageLimit" @compositionstart="composing = true" @compositionend="composing = false" @keydown.enter="handleEnter" />
        <div class="composer-actions">
          <span v-if="inputText.length >= 9000" class="character-count" aria-label="已输入字数">{{ inputText.length }} / {{ messageLimit }}</span>
          <UiButton v-if="sending" class="send-button stop-button" circle aria-label="停止生成" title="停止生成" @click="stopGeneration"><UiIcon name="stop" /></UiButton>
          <UiButton v-else class="send-button" type="primary" circle :disabled="loading || !inputText.trim() || !conversationId || inputText.trim().length > messageLimit" aria-label="发送消息" title="发送消息" @click="sendMessage"><UiIcon name="send" /></UiButton>
        </div>
      </form>
    </footer>
  </section>
</template>
<script setup lang="ts">
import type { ChatMessage, ChatMessageEvent } from '@/types/chat'

import { errorDetails } from '@/utils/errors'
import UiIcon from '@/components/ui/uiIcon.vue'
import UiButton from '@/components/ui/uiButton.vue'
defineOptions({ name: 'ChatView' })
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { streamChat } from '@/api/chat'
import { captureSession, isCurrentSession, currentUser as userData } from '@/stores/auth'
import { createMessageId } from '@/services/chatHistory'
const props = withDefaults(defineProps<{ conversationId?: string; conversationTitle?: string; historyHidden?: boolean; loading?: boolean; messages?: ChatMessage[] }>(), { conversationTitle: '新对话', messages: () => [] })
const emit = defineEmits<{ 'send-success': [message: ChatMessageEvent]; 'toggle-history': [] }>()
const inputText = ref('')
const composerRef = ref<HTMLTextAreaElement | null>(null)
const messageLimit = 10000
const promptSuggestions = ['帮我梳理日常开支', '一起制定储蓄计划']
const userLabel = computed(() => userData.value.name || '我')
const usePrompt = (text: string) => {
  inputText.value = text
  void nextTick(() => composerRef.value?.focus())
}
const resizeComposer = () => {
  const textarea = composerRef.value
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = Math.min(textarea.scrollHeight, 144) + 'px'
}
watch(inputText, () => { void nextTick(resizeComposer) })
const composing = ref(false)
const sending = ref(false)
const snapshot = captureSession()
let activeController: AbortController | undefined
let stopReply: (() => void) | undefined
const stopGeneration = () => stopReply?.()
const chatContentRef = ref<HTMLElement | null>(null)
const olderMessagesRef = ref<HTMLElement | null>(null)
const messageBatchSize = 60
const visibleMessageCount = ref(messageBatchSize)
const visibleMessages = computed(() => props.messages.slice(-visibleMessageCount.value))
const hasOlderMessages = computed(() => visibleMessageCount.value < props.messages.length)
const loadingOlder = ref(false)
let windowVersion = 0
let historyObserver: IntersectionObserver | null = null
let disposed = false
const scrollToBottom = () => nextTick(() => {
  if (chatContentRef.value) chatContentRef.value.scrollTop = chatContentRef.value.scrollHeight
})
watch(() => props.conversationId, () => {
  stopGeneration()
  windowVersion++
  visibleMessageCount.value = messageBatchSize
  loadingOlder.value = false
  inputText.value = ''
  scrollToBottom()
}, { immediate: true, flush: 'sync' })
// 阅读历史时有新消息追加，保留已经展示的第一条，不让它滑出渲染范围。
watch(() => [props.conversationId, props.messages.length] as const, ([id, length], [oldId, oldLength]) => {
  const content = chatContentRef.value
  if (id === oldId && length > oldLength && content && content.scrollHeight - content.scrollTop - content.clientHeight > 80) {
    visibleMessageCount.value += length - oldLength
  }
}, { flush: 'pre' })
// 阅读旧消息时保留位置；接近底部时才跟随新回复。
watch(visibleMessages, () => {
  if (loadingOlder.value) return
  const content = chatContentRef.value
  if (!content || content.scrollHeight - content.scrollTop - content.clientHeight <= 80) scrollToBottom()
}, { deep: true, flush: 'pre' })
const loadOlderMessages = async () => {
  const content = chatContentRef.value
  if (disposed || loadingOlder.value || !hasOlderMessages.value || !content) return
  const version = windowVersion
  const height = content.scrollHeight
  const top = content.scrollTop
  const anchor = content.querySelector?.<HTMLElement>('.message-item')
  const anchorOffset = anchor?.offsetTop
  loadingOlder.value = true
  visibleMessageCount.value = Math.min(props.messages.length, visibleMessageCount.value + messageBatchSize)
  await nextTick()
  if (disposed || version !== windowVersion) return
  // 只补偿新增在阅读位置上方的高度，末尾回复同时变长也不会影响阅读位置。
  const shift = anchor?.isConnected ? anchor.offsetTop - (anchorOffset ?? 0) : content.scrollHeight - height
  content.scrollTop = top + shift
  loadingOlder.value = false
  if (hasOlderMessages.value && historyObserver && olderMessagesRef.value) {
    historyObserver.unobserve(olderMessagesRef.value)
    historyObserver.observe(olderMessagesRef.value)
  }
}
onMounted(async () => {
  await scrollToBottom()
  if (disposed) return
  historyObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) loadOlderMessages()
  }, { root: chatContentRef.value, rootMargin: '80px 0px 0px 0px' })
  if (olderMessagesRef.value) historyObserver.observe(olderMessagesRef.value)
})
onUnmounted(() => { stopGeneration(); disposed = true; historyObserver?.disconnect() })
const handleEnter = (event: KeyboardEvent) => {
  if (event.shiftKey || composing.value || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  sendMessage()
}
const sendMessage = async () => {
  const content = inputText.value.trim()
  const conversationId = props.conversationId
  if (!content || content.length > messageLimit || !conversationId || props.loading || sending.value || disposed || !isCurrentSession(snapshot)) return
  const controller = new AbortController()
  activeController = controller
  sending.value = true
  const userMessageId = createMessageId()
  const replyId = createMessageId()
  let answer = ''
  const updateReply = (text: string, pending: boolean, failed = false) => {
    if (isCurrentSession(snapshot)) emit('send-success', { conversationId, id: replyId, role: 'ai', content: text, pending, failed, replace: true })
  }
  const finish = (text: string, failed = false) => {
    if (activeController !== controller) return
    updateReply(text, false, failed)
    activeController = undefined
    stopReply = undefined
    sending.value = false
  }
  stopReply = () => {
    controller.abort()
    finish(answer ? answer + '\n\n（回复已停止）' : '回复已停止', true)
  }
  emit('send-success', { conversationId, id: userMessageId, role: 'user', content })
  emit('send-success', { conversationId, id: replyId, role: 'ai', content: '', pending: true })
  inputText.value = ''
  scrollToBottom()
  try {
    await streamChat({ conversationId, message: content, messageId: userMessageId, replyId }, chunk => {
      if (activeController !== controller || controller.signal.aborted) return
      answer += chunk
      updateReply(answer, true)
    }, controller.signal)
    finish(answer || '模型没有返回文字内容')
  } catch (cause) {
    const error = errorDetails(cause)
    const message = controller.signal.aborted ? '回复已停止' : (error.message || '回复失败，请重试')
    finish(answer ? answer + '\n\n（' + message + '）' : message, true)
  }
}
</script>
<style scoped>
.chat-view {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
}
.chat-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 16px 28px;
  border-bottom: 1px solid #eff1f5;
}
.history-toggle.ui-button {
  width: 36px;
  min-height: 36px;
  margin-left: -8px;
  border: 0;
  background: transparent;
  color: #69758a;
}
.history-toggle.ui-button:hover {
  background: #f2f4f8;
}
.header-copy {
  flex: 1;
  min-width: 0;
}
.header-copy h1 {
  overflow: hidden;
  margin: 0;
  color: #293246;
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.generation-status {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  color: #7c8799;
  font-size: 11px;
  white-space: nowrap;
}
.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--primary);
  animation: status-pulse 1.6s ease-in-out infinite;
}
.chat-content {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: #dce1ea transparent;
  scrollbar-width: thin;
}
.message-list {
  width: 100%;
  max-width: 880px;
  min-height: 100%;
  margin: 0 auto;
  padding: 28px 28px 32px;
}
.message-list.is-empty {
  display: flex;
  flex-direction: column;
}
.older-messages {
  padding: 4px 0 22px;
  text-align: center;
  color: #8a94a5;
  font-size: 11px;
}
.chat-welcome {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 28px 0;
  text-align: center;
}
.welcome-mark {
  display: grid;
  place-items: center;
  width: 62px;
  height: 62px;
  margin-bottom: 8px;
  border: 1px solid #e2e8ff;
  border-radius: 22px;
  background: var(--primary-tint);
  color: var(--primary);
  box-shadow: 0 8px 24px #3964fe08;
}
.welcome-mark .ui-icon {
  width: 29px;
  height: 29px;
}
.chat-welcome h2 {
  margin: 0;
  color: #293246;
  font-size: 25px;
  font-weight: 600;
  letter-spacing: -.6px;
  line-height: 1.4;
}
.welcome-prompts {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin-top: 14px;
}
.welcome-prompts button {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  border: 1px solid #e9edf4;
  border-radius: 14px;
  background: #fff;
  color: #6e7a8e;
  font-size: 12px;
  line-height: 20px;
  transition: background .16s, border-color .16s;
}
.welcome-prompts button:hover {
  border-color: var(--primary-border);
  background: var(--primary-tint);
  color: var(--primary);
}
.welcome-prompts .ui-icon {
  width: 13px;
  height: 13px;
  opacity: .6;
}
.message-item {
  display: flex;
  align-items: flex-start;
  margin-bottom: 28px;
}
.message-item:last-child {
  margin-bottom: 0;
}
.message-item.user {
  justify-content: flex-end;
}
.message-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}
.message-item.user .message-body {
  align-items: flex-end;
  max-width: 88%;
}
.message-label {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  min-height: 16px;
  padding: 0 2px;
  color: #66738a;
  font-size: 11px;
  line-height: 16px;
}
.message-label > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-state {
  flex-shrink: 0;
  color: #9ba5b4;
  font-size: 10px;
}
.message-state.is-interrupted {
  color: #aa844e;
}
.bubble {
  min-width: 0;
  max-width: 100%;
  padding: 14px 18px;
  border: 1px solid #edf0f5;
  border-radius: 4px 18px 18px 18px;
  background: #f7f8fb;
  color: #3c485d;
  font-size: 14px;
  line-height: 1.9;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.message-item.user .bubble {
  border-color: #e5eaff;
  border-radius: 18px 4px 18px 18px;
  background: var(--primary-soft);
  color: #354a85;
}
.bubble.is-pending {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 49px;
}
.typing-label {
  color: #99a2b2;
  font-size: 12px;
}
.typing-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 14px;
}
.typing-indicator i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #8e9dbb;
  animation: typing-pulse 1.2s ease-in-out infinite;
}
.typing-indicator i:nth-child(2) {
  animation-delay: .15s;
}
.typing-indicator i:nth-child(3) {
  animation-delay: .3s;
}
.chat-footer {
  flex-shrink: 0;
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: 0 28px 22px;
  background: #fff;
}
.chat-composer {
  padding: 14px 14px 10px;
  border: 1px solid #e1e6ef;
  border-radius: 22px;
  background: #fff;
  box-shadow: 0 6px 24px #293b5e06;
  transition: border-color .16s, box-shadow .16s;
}
.chat-composer:focus-within {
  border-color: var(--primary-border);
  box-shadow: 0 4px 24px var(--primary-ring);
}
.chat-composer textarea {
  display: block;
  width: 100%;
  min-height: 48px;
  max-height: 144px;
  padding: 0 4px;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: #354158;
  font-size: 14px;
  line-height: 24px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.chat-composer textarea::placeholder {
  color: #a1aabb;
}
.chat-composer textarea:focus-visible {
  outline: none;
}
.composer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-height: 38px;
  margin-top: 8px;
}
.character-count {
  color: #8b96a8;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.send-button.ui-button {
  width: 38px;
  min-height: 38px;
  padding: 8px;
  border-radius: 14px;
  transition: background .16s, transform .16s;
}
.send-button.ui-button:not(:disabled):active {
  transform: scale(.94);
}
.send-button.ui-button:disabled {
  border-color: transparent;
  background: #e9edf4;
  color: #9aa7bb;
  opacity: 1;
}
.send-button .ui-icon {
  width: 20px;
  height: 20px;
  stroke-width: 2;
}
.stop-button.ui-button {
  border-color: var(--primary-border);
  background: var(--primary-soft);
  color: var(--primary);
}
.stop-button .ui-icon {
  width: 15px;
  height: 15px;
  fill: currentColor;
  stroke: none;
}
@keyframes typing-pulse {
  0%, 70%, 100% { opacity: .4; transform: translateY(0); }
  35% { opacity: 1; transform: translateY(-3px); }
}
@keyframes status-pulse {
  0%, 100% { opacity: .45; }
  50% { opacity: 1; }
}
@media(max-width:760px) {
  .chat-header {
    min-height: 58px;
    gap: 10px;
    padding: 12px 16px;
  }
  .header-copy h1 {
    font-size: 14px;
  }
  .message-list {
    padding: 22px 14px 26px;
  }
  .chat-welcome {
    gap: 12px;
    padding: 20px 4px;
  }
  .welcome-mark {
    width: 54px;
    height: 54px;
    border-radius: 19px;
  }
  .chat-welcome h2 {
    font-size: 22px;
  }
  .welcome-prompts {
    gap: 8px;
    margin-top: 8px;
  }
  .welcome-prompts button {
    gap: 6px;
    padding: 9px 10px;
    font-size: 11px;
  }
  .message-item {
    margin-bottom: 24px;
  }
  .message-item.user .message-body {
    max-width: 94%;
  }
  .bubble {
    padding: 11px 13px;
    font-size: 13px;
    line-height: 1.85;
  }
  .chat-footer {
    padding: 0 12px 12px;
  }
  .chat-composer {
    padding: 12px 12px 9px;
    border-radius: 19px;
  }
  .chat-composer textarea {
    font-size: 16px;
    line-height: 24px;
  }
}
@media(max-width:360px) {
  .generation-status {
    font-size: 10px;
  }
  .welcome-prompts {
    flex-direction: column;
  }
}
@media(max-height:600px) {
  .chat-header {
    min-height: 52px;
    padding-top: 9px;
    padding-bottom: 9px;
  }
  .chat-footer {
    padding-bottom: 10px;
  }
  .chat-composer textarea {
    min-height: 24px;
    max-height: 72px;
  }
  .chat-welcome {
    gap: 8px;
    padding-top: 10px;
    padding-bottom: 10px;
  }
  .welcome-mark {
    width: 42px;
    height: 42px;
    margin-bottom: 0;
    border-radius: 14px;
  }
  .welcome-mark .ui-icon {
    width: 23px;
    height: 23px;
  }
  .welcome-prompts {
    display: none;
  }
}
@media(prefers-reduced-motion:reduce) {
  .typing-indicator i, .status-dot {
    animation: none;
  }
  .welcome-prompts button, .chat-composer, .send-button.ui-button {
    transition: none;
  }
}
</style>
