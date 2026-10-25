// VM 边界使用替身，页面仍执行真实脚本；服务端替身保存每次请求的数据。
type TestDouble = any
const test: typeof import('node:test') = require('node:test')
const assert = require('node:assert/strict')
import type { ScriptRuntimeFactory } from './helpers/scriptRuntime.cts'
const { createScriptRuntime }: { createScriptRuntime: ScriptRuntimeFactory } = require('./helpers/scriptRuntime.cts')
const { plain, deferred } = require('./helpers/runtime.cts')
const vue = require('vue')

async function chatFixture(options: TestDouble = {}) {
  const storage = new Map<string, string>()
  const notices: TestDouble[] = []
  const calls: TestDouble[] = []
  const unmounts: (() => void)[] = []
  const sessionCallbacks = new Set<() => void>()
  let currentSession = 'A'
  const pending = { id: 'reply', role: 'ai', content: '正在生成', createdAt: Date.now(), updatedAt: 1, pending: false }
  const records = new Map<string, TestDouble>((options.history || [
    { id: 'first', title: '本月预算', createdAt: 1, messages: [pending] },
    { id: 'second', title: '其他开支', createdAt: 2, messages: [] }
  ]).map((item: TestDouble) => [item.id, plain(item)]))
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    get length() { return storage.size },
    key: (index: number) => [...storage.keys()][index] ?? null
  }
  const feedback = Object.fromEntries(['success', 'warning', 'error'].map(type => [type, (text: string) => notices.push({ type, text })]))
  const metadata = (data: TestDouble) => ({ ...plain(data), messages: [] })
  const success = (data: TestDouble = null) => ({ code: 1, msg: null, data })
  const api: TestDouble = {
    getConversations: async (config: TestDouble) => { calls.push(['list', config]); return success([...records.values()].map(metadata)) },
    getConversation: async (id: string, config: TestDouble) => { calls.push(['detail', id, config]); return success(plain(records.get(id))) },
    createConversation: async (data: TestDouble, config: TestDouble) => { calls.push(['create', plain(data), config]); records.set(data.id, { ...data, messages: [] }); return success(plain(records.get(data.id))) },
    updateConversation: async (id: string, data: TestDouble, config: TestDouble) => { calls.push(['patch', id, plain(data), config]); Object.assign(records.get(id), data); return success(metadata(records.get(id))) },
    removeConversation: async (id: string, config: TestDouble) => { calls.push(['delete', id, config]); records.delete(id); return success() },
    importConversation: async (data: TestDouble) => { calls.push(['import', plain(data)]); return success() },
    ...options.api
  }
  const mocks: Record<string, TestDouble> = {
    vue: { ...vue, useId: () => 'rename-test', onMounted: () => {}, onUnmounted: (fn: () => void) => unmounts.push(fn) },
    '@/api/chat': api,
    '@/stores/auth': {
      captureSession: () => currentSession,
      isCurrentSession: (snapshot: string) => snapshot === currentSession,
      getChatStorageKey: () => 'chatHistory:' + currentSession,
      onSessionChange: (fn: () => void) => { sessionCallbacks.add(fn); return () => sessionCallbacks.delete(fn) }
    },
    '@/stores/preferences': { preferences: vue.ref({ showChatSidebar: true }) },
    '@/utils/feedback': { feedback },
    '@/utils/errors': { errorDetails: (error: Error) => ({ message: error.message }) },
    '@/utils/confirm': { confirmDialog: { confirm: async () => true, close: () => {} } }
  }
  const runtime = createScriptRuntime({ mocks, globals: {
    console, localStorage, setInterval, clearInterval, AbortController,
    window: { matchMedia: () => ({ matches: false }), addEventListener: () => {}, removeEventListener: () => {} },
    defineOptions: () => {}, defineProps: () => ({}), withDefaults: (props: TestDouble) => props
  } })
  const load = (file: string, names: string[] = [], emit: (...args: TestDouble[]) => void = () => {}): TestDouble =>
    runtime.load(file, names, { defineEmits: () => emit })
  const page = load('src/views/chat/index.vue', [
    'historyList', 'currentId', 'currentConversation', 'currentMessages', 'renameId', 'renameTitle', 'renameVisible',
    'renameInput', 'openRename', 'closeRename', 'saveRename', 'handleRenameEnter', 'handleSendSuccess',
    'initialize', 'refreshHistory', 'switchConversation', 'createNewConversation', 'togglePin', 'deleteConversation', 'loadedIds', 'loadError', 'loading'
  ])
  if (options.initialize !== false) await page.initialize()
  return {
    page, storage, records, notices, load, mocks, api, calls,
    changeSession: () => { currentSession = 'B'; [...sessionCallbacks].forEach(fn => fn()) },
    unmount: () => unmounts.splice(0).forEach(fn => fn())
  }
}

test('cloud list loads metadata then the selected transcript without writing browser chat records', async () => {
  const f = await chatFixture()
  assert.equal(f.page.currentId.value, 'first')
  assert.equal(f.page.currentMessages.value[0].content, '正在生成')
  assert.deepEqual(f.calls.map(call => call[0]), ['list', 'detail'])
  assert.deepEqual([...f.storage.keys()], ['chatHistory:A:redis-migrated-v1'])
  for (const call of f.calls) {
    const config = call.at(-1)
    assert.equal(config.expectedSession, 'A')
    assert.equal(config.signal.aborted, false)
  }
  f.unmount()
})

test('renaming active or inactive conversations persists through API without replacing messages or IDs', async () => {
  const f = await chatFixture()
  const messages = f.page.currentMessages.value
  f.page.handleSendSuccess({ conversationId: 'first', id: 'new-reply', role: 'ai', content: '生成中', pending: true })
  await f.page.openRename('first')
  f.page.renameTitle.value = '  十月开支  '
  await f.page.saveRename()
  assert.equal(f.page.currentId.value, 'first')
  assert.equal(f.page.currentConversation.value.title, '十月开支')
  assert.equal(f.page.currentMessages.value, messages)
  assert.equal(f.page.currentMessages.value.at(-1).pending, true)
  assert.equal(f.records.get('first').title, '十月开支')
  await f.page.openRename('second')
  f.page.renameTitle.value = '旅行预算'
  await f.page.saveRename()
  assert.equal(f.page.currentId.value, 'first')
  assert.equal(f.records.get('second').title, '旅行预算')
  f.unmount()
})

test('invalid rename stays open and IME Enter does not submit', async () => {
  const f = await chatFixture()
  await f.page.openRename('first')
  for (const invalid of ['   ', '名'.repeat(51)]) {
    f.page.renameTitle.value = invalid
    await f.page.saveRename()
    assert.equal(f.page.renameId.value, 'first')
  }
  assert.equal(f.calls.filter(call => call[0] === 'patch').length, 0)
  assert.deepEqual(f.notices.map(item => item.type), ['warning', 'warning'])
  let prevented = 0
  for (const event of [{ isComposing: true }, { keyCode: 229 }, { keyCode: 13 }]) f.page.handleRenameEnter({ ...event, preventDefault: () => { prevented++ } })
  assert.equal(prevented, 2)
  f.unmount()
})

test('failed rename preserves original title and draft for retry', async () => {
  const f = await chatFixture()
  const update = f.api.updateConversation
  f.api.updateConversation = async () => { throw new Error('保存失败') }
  await f.page.openRename('first')
  f.page.renameTitle.value = '重试保存'
  await f.page.saveRename()
  assert.equal(f.page.currentConversation.value.title, '本月预算')
  assert.equal(f.page.renameTitle.value, '重试保存')
  assert.equal(f.page.renameId.value, 'first')
  f.api.updateConversation = update
  await f.page.saveRename()
  assert.equal(f.page.currentConversation.value.title, '重试保存')
  assert.equal(f.page.renameVisible.value, false)
  f.unmount()
})

test('pinning uses server metadata and deleting the last chat creates a new server conversation', async () => {
  const f = await chatFixture()
  await f.page.togglePin('second')
  assert.equal(f.records.get('second').pinned, true)
  assert.equal(f.page.currentId.value, 'first')
  await f.page.deleteConversation('first')
  assert.equal(f.page.currentId.value, 'second')
  await f.page.deleteConversation('second')
  assert.equal(f.page.historyList.value.length, 1)
  assert.ok(f.records.has(f.page.currentId.value))
  assert.equal(f.calls.filter(call => call[0] === 'delete').length, 2)
  f.page.handleSendSuccess({ conversationId: 'first', id: 'late', role: 'ai', content: '迟到的回复' })
  assert.equal(f.page.historyList.value.some((item: TestDouble) => item.id === 'first'), false)
  f.unmount()
})

test('failed server deletion retains selected history and reports the error', async () => {
  const f = await chatFixture({ api: { removeConversation: async () => { throw new Error('对话正在回复，请稍后重试') } } })
  await f.page.deleteConversation('first')
  assert.equal(f.page.currentId.value, 'first')
  assert.equal(f.page.historyList.value.length, 2)
  assert.match(f.notices.at(-1).text, /稍后重试/)
  f.unmount()
})

test('account changes abort pending requests, close dialogs and ignore late responses', async () => {
  const f = await chatFixture()
  const response = deferred()
  let config: TestDouble
  f.api.updateConversation = (_id: string, _data: TestDouble, value: TestDouble) => { config = value; return response.promise }
  await f.page.openRename('first')
  f.page.renameTitle.value = '过期编辑'
  const saving = f.page.saveRename()
  f.changeSession()
  assert.equal(config.signal.aborted, true)
  assert.equal(f.page.renameVisible.value, false)
  assert.equal(f.page.historyList.value.length, 0)
  response.resolve({ code: 1, data: { id: 'first', title: '过期编辑', createdAt: 1, messages: [] } })
  await saving
  assert.equal(f.page.historyList.value.length, 0)
  assert.equal(f.notices.length, 0)
  f.unmount()
})

test('a stale list response cannot restore a conversation deleted while it was loading', async () => {
  const f = await chatFixture()
  const response = deferred()
  f.api.getConversations = () => response.promise
  const refreshing = f.page.refreshHistory()
  await f.page.deleteConversation('first')
  response.resolve({ code: 1, data: [{ id: 'first', title: '旧副本', createdAt: 1, messages: [] }] })
  await refreshing
  assert.equal(f.page.historyList.value.some((item: TestDouble) => item.id === 'first'), false)
  assert.equal(f.page.currentId.value, 'second')
  f.unmount()
})

test('late detail responses cannot replace newer selection or optimistic streaming content', async () => {
  const f = await chatFixture()
  const response = deferred()
  f.api.getConversation = (id: string) => id === 'second' ? response.promise : Promise.resolve({ code: 1, data: plain(f.records.get(id)) })
  const switching = f.page.switchConversation('second')
  await f.page.switchConversation('first')
  f.page.handleSendSuccess({ conversationId: 'first', id: 'new', role: 'ai', content: '当前回复', pending: true })
  response.resolve({ code: 1, data: plain(f.records.get('second')) })
  await switching
  assert.equal(f.page.currentId.value, 'first')
  assert.equal(f.page.currentMessages.value.at(-1).content, '当前回复')
  const reads = f.calls.length
  await f.page.refreshHistory()
  assert.equal(f.calls.length, reads)
  f.unmount()
})

test('cloud refresh removes conversations deleted on another device and closes their rename dialog', async () => {
  const f = await chatFixture()
  await f.page.openRename('first')
  f.records.delete('first')
  await f.page.refreshHistory()
  assert.equal(f.page.renameVisible.value, false)
  assert.equal(f.page.currentId.value, 'second')
  assert.equal(f.page.historyList.value.length, 1)
  f.unmount()
})

test('the rename menu closes its popover and emits the selected action', async () => {
  const f = await chatFixture()
  const calls: TestDouble[] = []
  f.mocks['@/composables/useFloatingPanel'] = { useFloatingPanel: () => ({
    opened: vue.ref(true), panelStyle: vue.ref({}), show: async () => {}, sync: () => {},
    hide: (restoreFocus: boolean) => calls.push(['hide', restoreFocus])
  }) }
  const menu = f.load('src/views/chat/components/conversationActions.vue', ['choose'], (...args: TestDouble[]) => calls.push(args))
  menu.choose('rename')
  assert.deepEqual(calls, [['hide', true], ['rename']])
  f.unmount()
})


test('late current-conversation detail never overwrites newer optimistic messages', async () => {
  const f = await chatFixture()
  const response = deferred()
  f.api.getConversation = () => response.promise
  const reading = f.page.switchConversation('first')
  f.page.handleSendSuccess({ conversationId: 'first', id: 'new-user', role: 'user', content: '刚发送的消息' })
  f.page.handleSendSuccess({ conversationId: 'first', id: 'new-ai', role: 'ai', content: '正在回答', pending: true })
  response.resolve({ code: 1, data: plain(f.records.get('first')) })
  await reading
  assert.equal(f.page.currentMessages.value.at(-1).content, '正在回答')
  assert.equal(f.page.currentMessages.value.at(-2).content, '刚发送的消息')
  f.unmount()
})

test('session switches abort and ignore late create, delete, detail and list requests', async () => {
  for (const operation of ['create', 'delete', 'detail', 'list']) {
    const f = await chatFixture()
    const response = deferred()
    let config: TestDouble
    let pending: Promise<unknown>
    if (operation === 'create') {
      f.api.createConversation = (_data: TestDouble, value: TestDouble) => { config = value; return response.promise }
      pending = f.page.createNewConversation()
    } else if (operation === 'delete') {
      f.api.removeConversation = (_id: string, value: TestDouble) => { config = value; return response.promise }
      pending = f.page.deleteConversation('first')
      await new Promise(resolve => setImmediate(resolve))
    } else if (operation === 'detail') {
      f.api.getConversation = (_id: string, value: TestDouble) => { config = value; return response.promise }
      pending = f.page.switchConversation('second')
    } else {
      f.api.getConversations = (value: TestDouble) => { config = value; return response.promise }
      pending = f.page.refreshHistory()
    }
    f.changeSession()
    assert.equal(config.signal.aborted, true, operation)
    response.resolve({ code: 1, data: operation === 'list' ? [] : { id: 'late', title: '迟到的记录', createdAt: 1, messages: [] } })
    await pending
    assert.equal(f.page.historyList.value.length, 0, operation)
    assert.equal(f.page.currentId.value, '', operation)
    assert.equal(f.notices.length, 0, operation)
    f.unmount()
  }
})
