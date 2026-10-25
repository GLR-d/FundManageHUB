<template>
  <section class="ai-chat-layout" aria-label="AI 聊天">
    <button v-if="showSidebar" class="chat-backdrop" aria-label="关闭聊天历史" @click="toggleSidebar" />
    <aside ref="historySidebar" class="chat-sidebar" v-show="showSidebar" aria-label="聊天历史">
      <div class="sidebar-header">
        <div class="sidebar-heading"><UiIcon name="chat" /><strong>我的对话</strong></div>
        <button type="button" class="history-close" aria-label="隐藏聊天历史" title="收起对话列表" @click="toggleSidebar"><UiIcon name="fold" /></button>
      </div>
      <UiButton class="new-conversation" :disabled="loading || mutating" @click="createNewConversation"><UiIcon name="plus" />新建对话</UiButton>
      <div class="history-heading"><span>对话记录</span><span>{{ orderedHistory.length }}</span></div>
      <p v-if="loading" class="history-status" role="status">正在加载对话…</p>
      <p v-if="loadError" class="history-status" role="alert">{{ loadError }} <button type="button" @click="initialize">重试</button></p>
      <TransitionGroup name="history-list" tag="div" class="history-container" role="list" aria-label="对话列表">
        <div v-for="history in orderedHistory" :key="history.id" class="history-row" :class="{ 'is-current': history.id === currentId, 'is-pinned': history.pinned }" role="listitem">
          <button type="button" class="history-item" :data-conversation-id="history.id" :aria-pressed="history.id === currentId" :title="history.title" @click="switchConversation(history.id)">
            <UiIcon name="chat" /><span class="history-title">{{ history.title }}</span>
          </button>
          <span v-if="history.pinned" class="pin-badge" role="img" aria-label="已置顶" title="已置顶"><UiIcon name="pin" /></span>
          <ConversationActions :title="history.title" :pinned="history.pinned" @pin="togglePin(history.id)" @rename="openRename(history.id)" @delete="deleteConversation(history.id)" />
        </div>
      </TransitionGroup>
    </aside>
    <div class="chat-main">
      <ChatView :conversation-id="currentId" :conversation-title="currentConversation?.title || '新对话'" :history-hidden="!showSidebar" :messages="currentMessages" :loading="loading || detailLoading || !loadedIds.has(currentId)" @toggle-history="toggleSidebar" @send-success="handleSendSuccess" />
    </div>
    <UiDialog v-model="renameVisible" title="重命名对话" width="420px">
      <form id="chat-rename-form" class="rename-form" @submit.prevent="saveRename" @keydown.enter="handleRenameEnter">
        <label for="chat-rename-title">对话名称</label>
        <span class="ui-input-wrap">
          <input id="chat-rename-title" ref="renameInput" v-model="renameTitle" type="text" :maxlength="CHAT_CONVERSATION_TITLE_MAX_LENGTH" autocomplete="off" placeholder="输入对话名称" />
        </span>
      </form>
      <template #footer>
        <UiButton @click="closeRename">取消</UiButton>
        <button type="submit" form="chat-rename-form" class="ui-button ui-button--primary" :disabled="mutating">保存</button>
      </template>
    </UiDialog>
  </section>
</template>
<script setup lang="ts">
import type { ApiResult } from '@/types/api'
import type { ChatConversation, ChatMessageEvent } from '@/types/chat'

import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import UiButton from '@/components/ui/uiButton.vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import UiDialog from '@/components/ui/uiDialog.vue'
import { feedback } from '@/utils/feedback'
import { errorDetails } from '@/utils/errors'
import { confirmDialog } from '@/utils/confirm'
import ChatView from './components/chatView.vue'
import ConversationActions from './components/conversationActions.vue'
import { captureSession, isCurrentSession, getChatStorageKey, onSessionChange } from '@/stores/auth'
import { preferences } from '@/stores/preferences'
import { createMessageId, applyChatMessage, expirePendingMessages, sortChatConversations, migrateChatHistory, CHAT_CONVERSATION_TITLE_MAX_LENGTH } from '@/services/chatHistory'
import { getConversations, getConversation, createConversation, updateConversation, removeConversation, importConversation } from '@/api/chat'

defineOptions({ name: 'Chat' })
const snapshot = captureSession()
const storageKey = getChatStorageKey()
const controller = new AbortController()
const requestConfig = () => ({ expectedSession: snapshot, signal: controller.signal, silentError: true })
const showSidebar = ref(preferences.value.showChatSidebar)
const toggleSidebar = () => { showSidebar.value = !showSidebar.value }
const historyList = ref<ChatConversation[]>([])
const orderedHistory = computed(() => sortChatConversations(historyList.value))
const currentId = ref('')
const currentConversation = computed(() => historyList.value.find(item => item.id === currentId.value))
const currentMessages = computed(() => currentConversation.value?.messages || [])
const loadedIds = ref(new Set<string>())
const loading = ref(true)
const detailLoading = ref(false)
const mutating = ref(false)
const loadError = ref('')
const historySidebar = ref<HTMLElement | null>(null)
const confirmingId = ref('')
const renameId = ref('')
const renameTitle = ref('')
const renameInput = ref<HTMLInputElement | null>(null)
const renameVisible = computed({ get: () => Boolean(renameId.value), set: visible => { if (!visible) closeRename() } })
let disposed = false
let revision = 0
let listRequest = 0
let detailRequest = 0
const messageRevisions = new Map<string, number>()
const isActive = () => !disposed && isCurrentSession(snapshot)
const resultData = <T,>(result: ApiResult<T>) => {
  if (result.code !== 1) throw new Error(result.msg || '操作失败，请重试')
  return result.data
}
const reportError = (error: unknown, fallback: string) => { if (isActive()) feedback.error(errorDetails(error).message || fallback) }
const hasPendingReply = () => historyList.value.some(item => item.messages.some(message => message.pending))
const updateMetadata = (conversation: ChatConversation, metadata: ChatConversation) => {
  conversation.title = metadata.title
  conversation.pinned = metadata.pinned
  conversation.createdAt = metadata.createdAt
  conversation.metadataUpdatedAt = metadata.metadataUpdatedAt
}
const loadConversation = async (id: string) => {
  if (historyList.value.find(item => item.id === id)?.messages.some(message => message.pending)) return
  const version = ++detailRequest
  const before = revision
  const messageRevision = messageRevisions.get(id) || 0
  detailLoading.value = true
  try {
    const data = resultData(await getConversation(id, requestConfig()))
    if (!isActive() || version !== detailRequest || currentId.value !== id || messageRevision !== (messageRevisions.get(id) || 0)) return
    const conversation = historyList.value.find(item => item.id === id)
    if (!conversation) return
    if (before === revision) updateMetadata(conversation, data)
    conversation.messages = data.messages
    loadedIds.value.add(id)
    loadError.value = ''
  } catch (error) {
    if (isActive() && version === detailRequest) loadError.value = errorDetails(error).message || '对话加载失败，请重试'
  } finally { if (version === detailRequest) detailLoading.value = false }
}
const switchConversation = async (id: string) => {
  if (!isActive() || !historyList.value.some(item => item.id === id)) return
  currentId.value = id
  if (window.matchMedia('(max-width: 760px)').matches) showSidebar.value = false
  await loadConversation(id)
}
const createNewConversation = async () => {
  if (!isActive() || mutating.value) return
  revision++
  mutating.value = true
  try {
    const data = resultData(await createConversation({ id: createMessageId(), title: '对话' + (historyList.value.length + 1), createdAt: Date.now() }, requestConfig()))
    if (!isActive()) return
    historyList.value.push(data)
    loadedIds.value.add(data.id)
    currentId.value = data.id
    detailRequest++
    detailLoading.value = false
    loadError.value = ''
    if (window.matchMedia('(max-width: 760px)').matches) showSidebar.value = false
  } catch (error) { reportError(error, '新建对话失败，请重试') }
  finally { mutating.value = false }
}
const refreshHistory = async () => {
  if (!isActive() || mutating.value || hasPendingReply()) return
  const version = ++listRequest
  const before = revision
  try {
    const data = resultData(await getConversations(requestConfig()))
    if (!isActive() || version !== listRequest || before !== revision) return
    // 元数据刷新不替换消息数组，避免打断当前页面的流式回复。
    historyList.value = data.map(metadata => {
      const existing = historyList.value.find(item => item.id === metadata.id)
      if (existing) { updateMetadata(existing, metadata); return existing }
      return { ...metadata, messages: [] }
    })
    const visibleIds = new Set(data.map(item => item.id))
    loadedIds.value = new Set([...loadedIds.value].filter(id => visibleIds.has(id)))
    if (renameId.value && !historyList.value.some(item => item.id === renameId.value)) closeRename()
    if (!historyList.value.some(item => item.id === currentId.value)) currentId.value = orderedHistory.value[0]?.id || ''
    if (!currentId.value) await createNewConversation()
    else await loadConversation(currentId.value)
  } catch (error) { if (isActive()) loadError.value = errorDetails(error).message || '对话列表加载失败，请重试' }
}
const initialize = async () => {
  if (!isActive()) return
  loading.value = true
  loadError.value = ''
  try {
    await migrateChatHistory(storageKey, async conversation => { resultData(await importConversation(conversation, requestConfig())) }, isActive)
  } catch (error) {
    if (isActive()) feedback.warning('本地聊天记录暂未迁移，将在下次打开页面时重试：' + (errorDetails(error).message || '请检查网络'))
  }
  if (isActive()) await refreshHistory()
  if (isActive()) loading.value = false
}
const togglePin = async (id: string) => {
  const conversation = historyList.value.find(item => item.id === id)
  if (!isActive() || mutating.value || !conversation) return
  revision++
  mutating.value = true
  try {
    const metadata = resultData(await updateConversation(id, { pinned: !conversation.pinned }, requestConfig()))
    if (isActive() && historyList.value.includes(conversation)) updateMetadata(conversation, metadata)
  } catch (error) { reportError(error, '置顶状态未能保存，请重试') }
  finally { mutating.value = false }
}
const closeRename = () => { renameId.value = ''; renameTitle.value = '' }
const openRename = async (id: string) => {
  if (!isActive() || confirmingId.value || renameId.value || mutating.value) return
  const conversation = historyList.value.find(item => item.id === id)
  if (!conversation) return
  renameTitle.value = conversation.title
  renameId.value = id
  await nextTick()
  await nextTick()
  if (isActive() && renameId.value === id) { renameInput.value?.focus(); renameInput.value?.select() }
}
const handleRenameEnter = (event: KeyboardEvent) => { if (event.isComposing || event.keyCode === 229) event.preventDefault() }
const saveRename = async () => {
  if (!isActive()) { closeRename(); return }
  if (mutating.value) return
  const id = renameId.value
  const conversation = historyList.value.find(item => item.id === id)
  if (!conversation) { closeRename(); return }
  const title = renameTitle.value.trim()
  if (!title || title.length > CHAT_CONVERSATION_TITLE_MAX_LENGTH) {
    feedback.warning(title ? '对话名称最多 ' + CHAT_CONVERSATION_TITLE_MAX_LENGTH + ' 个字' : '请输入对话名称')
    renameInput.value?.focus()
    return
  }
  revision++
  mutating.value = true
  try {
    const metadata = resultData(await updateConversation(id, { title }, requestConfig()))
    if (!isActive() || renameId.value !== id || !historyList.value.includes(conversation)) return
    updateMetadata(conversation, metadata)
    closeRename()
    feedback.success('对话已重命名')
  } catch (error) { reportError(error, '对话名称未能保存，请重试') }
  finally { mutating.value = false }
}
const deleteConversation = async (id: string) => {
  if (!isActive() || confirmingId.value || renameId.value || mutating.value) return
  const conversation = historyList.value.find(item => item.id === id)
  if (!conversation) return
  confirmingId.value = id
  try {
    await confirmDialog.confirm('', '删除对话')
    if (!isActive() || confirmingId.value !== id) return
    revision++
    mutating.value = true
    resultData(await removeConversation(id, requestConfig()))
    if (!isActive()) return
    historyList.value = historyList.value.filter(item => item.id !== id)
    loadedIds.value.delete(id)
    if (currentId.value === id) {
      detailRequest++
      currentId.value = orderedHistory.value[0]?.id || ''
      detailLoading.value = false
    }
    feedback.success('对话已删除')
  } catch (error) {
    if (isActive() && confirmingId.value === id && errorDetails(error).message !== '取消操作') reportError(error, '删除失败，请重试')
    return
  } finally { mutating.value = false; if (confirmingId.value === id) confirmingId.value = '' }
  if (!currentId.value) await createNewConversation()
  else if (!loadedIds.value.has(currentId.value)) await loadConversation(currentId.value)
  nextTick(() => {
    const target = Array.from(historySidebar.value?.querySelectorAll<HTMLButtonElement>('[data-conversation-id]') || []).find(button => button.dataset.conversationId === currentId.value)
    target?.focus()
  })
}
const handleSendSuccess = (message: ChatMessageEvent) => {
  if (!isActive()) return
  revision++
  messageRevisions.set(message.conversationId, (messageRevisions.get(message.conversationId) || 0) + 1)
  applyChatMessage(historyList.value, message)
}
const cancelPendingDialogs = () => {
  if (confirmingId.value) { confirmingId.value = ''; confirmDialog.close() }
  closeRename()
}
const stopSession = onSessionChange(() => {
  controller.abort()
  cancelPendingDialogs()
  historyList.value = []
  currentId.value = ''
})
const handleFocus = () => { if (!loading.value) void refreshHistory() }
let historyTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void initialize()
  historyTimer = setInterval(() => { if (isActive()) expirePendingMessages(historyList.value) }, 3000)
  if (window.matchMedia('(max-width: 760px)').matches) showSidebar.value = false
  window.addEventListener('focus', handleFocus)
})
onUnmounted(() => { disposed = true; controller.abort(); cancelPendingDialogs(); stopSession(); clearInterval(historyTimer); window.removeEventListener('focus', handleFocus) })
</script>
<style scoped>
.ai-chat-layout { position: relative; display: flex; min-height: 0; width: 100%; height: 100%; overflow: hidden; border: 1px solid #e9edf4; border-radius: 24px; background: #fff; box-shadow: 0 4px 24px #20283804; }
.chat-sidebar { display: flex; flex-direction: column; flex: 0 0 252px; min-height: 0; width: 252px; height: 100%; padding: 8px 0 0; border-right: 1px solid #e9edf4; background: #f8f9fc; }
.sidebar-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px 18px; }
.sidebar-heading { display: flex; align-items: center; gap: 10px; color: #39445a; }
.sidebar-heading > .ui-icon { width: 21px; height: 21px; color: var(--primary); }
.sidebar-heading strong { font-size: 14px; font-weight: 650; }
.history-close { display: grid; place-items: center; width: 32px; height: 32px; padding: 7px; border: 0; border-radius: 10px; color: #8992a4; background: transparent; }
.history-close:hover { background: #e9edf5; color: #475269; }
.new-conversation { justify-content: center; min-height: 43px; margin: 0 14px 24px; border-color: #e3e8f2; border-radius: 14px; background: #fff; color: #47536b; box-shadow: 0 2px 4px #20283804; font-size: 13px; }
.new-conversation:hover { color: var(--primary); background: var(--primary-tint); border-color: var(--primary-border); }
.new-conversation .ui-icon { width: 17px; height: 17px; }
.history-heading { display: flex; justify-content: space-between; padding: 0 22px 10px; color: #969eae; font-size: 11px; }
.history-status { margin: 0 18px 12px; color: var(--muted); font-size: 12px; }
.history-status button { padding: 0; border: 0; background: transparent; color: var(--primary); }
.history-container { position: relative; flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px 16px; scrollbar-width: thin; scrollbar-color: #dce2ec transparent; }
.history-row { display: flex; align-items: center; min-width: 0; gap: 2px; padding: 3px 5px 3px 0; margin-bottom: 5px; border-radius: 13px; transition: background .16s ease; }
.history-row:hover { background: #eef1f7; }
.history-row.is-current { background: #eaf0ff; }
.history-item { display: flex; align-items: center; flex: 1; min-width: 0; gap: 9px; min-height: 42px; padding: 9px 6px 9px 11px; border: 0; border-radius: 12px; background: transparent; color: #707b90; text-align: left; font-size: 13px; }
.history-item > .ui-icon { flex: 0 0 auto; width: 16px; height: 16px; color: #9099aa; }
.history-row.is-current .history-item,.history-row.is-current .history-item > .ui-icon { color: var(--primary); }
.history-row.is-current .history-title { font-weight: 550; }
.history-title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pin-badge { display: grid; place-items: center; color: #95a1b7; }
.pin-badge > .ui-icon { width: 12px; height: 12px; }
.history-list-move { transition: transform .24s ease; }
.history-list-enter-active,.history-list-leave-active { transition: opacity .18s ease, transform .18s ease; }
.history-list-enter-from,.history-list-leave-to { opacity: 0; transform: translateX(-8px); }
.history-list-leave-active { position: absolute; left: 12px; right: 12px; }
.chat-main { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; height: 100%; overflow: hidden; }
.chat-backdrop { display: none; }
.rename-form { display: grid; gap: 10px; }
.rename-form > label { color: var(--text); font-size: 14px; font-weight: 500; }
@media(max-width:1000px) and (min-width:761px) { .chat-sidebar { flex-basis: 220px; width: 220px; } }
@media(max-width:760px) {
  .ai-chat-layout { border-radius: 20px; }
  .chat-sidebar { position: absolute; inset: 0 auto 0 0; width: min(280px,86%); z-index: 3; box-shadow: 8px 0 28px #20283812; }
  .chat-backdrop { position: absolute; display: block; inset: 0 0 0 min(280px,86%); z-index: 2; border: 0; background: #2028383b; backdrop-filter: blur(2px); }
  .history-row { min-height: 48px; }
  .history-item { min-height: 44px; }
}
</style>
