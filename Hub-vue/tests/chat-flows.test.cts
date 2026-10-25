import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, path, vue, plain, deferred, fixture } = require('./helpers/runtime.cts')
const { sseResponse, chatStreamFixture } = require('./helpers/chatFixtures.cts')

test('chat storage is isolated by account and corrupt history is tolerated', () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  const history = f.load('src/services/chatHistory.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const keyA = auth.getChatStorageKey()
  f.storage.set(keyA, JSON.stringify([{ id: 'conversation-A', messages: [{ role: 'user', content: 'private A' }] }]))
  auth.setLoginUser({ id: 'B', token: 'example-b' })
  assert.notEqual(auth.getChatStorageKey(), keyA)
  assert.deepEqual(plain(history.readChatHistory(auth.getChatStorageKey())), [])
  f.storage.set('broken', '{')
  assert.deepEqual(plain(history.readChatHistory('broken')), [])
})

test('switching conversation cancels streaming and preserves partial text in the original conversation', async () => {
  const pending: TestDouble[] = []
  const f = fixture({ '@/api/chat': { streamChat: (data: TestDouble, onToken: TestDouble, signal: TestDouble) => new Promise(resolve => pending.push({ data, onToken, signal, resolve })) } })
  f.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' })
  const { applyChatMessage } = f.load('src/services/chatHistory.ts')
  const history: TestDouble[] = [{ id: 'A', messages: [] }, { id: 'B', messages: [{ id: 'B1', role: 'user', content: 'keep B' }] }]
  const props = vue.reactive({ conversationId: 'A', messages: [] })
  const chat = f.load('src/views/chat/components/chatView.vue', ['sendMessage', 'inputText'], props,
    (event: TestDouble, message: TestDouble) => applyChatMessage(history, message))
  chat.inputText.value = 'question A'
  const operation = chat.sendMessage()
  pending[0].onToken('partial A')
  assert.equal(history[0].messages[1].content, 'partial A')
  assert.equal(history[0].messages[1].pending, true)
  props.conversationId = 'B'
  assert.equal(pending[0].signal.aborted, true)
  pending[0].onToken('late chunk')
  pending[0].resolve()
  await operation
  assert.equal(history[0].messages[1].content, 'partial A\n\n（回复已停止）')
  assert.equal(history[0].messages[1].pending, false)
  assert.equal(history[1].messages[0].content, 'keep B')
  assert.equal(history[1].messages.length, 1)
})

test('a streaming reply prevents concurrent sends until it finishes', async () => {
  const pending: TestDouble[] = []
  const f = fixture({ '@/api/chat': { streamChat: (data: TestDouble, onToken: TestDouble) => new Promise(resolve => pending.push({ onToken, resolve })) } })
  f.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' })
  const { applyChatMessage } = f.load('src/services/chatHistory.ts')
  const history: TestDouble[] = [{ id: 'A', messages: [] }]
  const chat = f.load('src/views/chat/components/chatView.vue', ['sendMessage', 'inputText'], { conversationId: 'A', messages: [] },
    (event: TestDouble, message: TestDouble) => applyChatMessage(history, message))
  chat.inputText.value = 'first'
  const first = chat.sendMessage()
  chat.inputText.value = 'second'
  await chat.sendMessage()
  assert.equal(pending.length, 1)
  pending[0].onToken('first ')
  pending[0].onToken('answer')
  pending[0].resolve(); await first
  const second = chat.sendMessage()
  pending[1].onToken('second answer')
  pending[1].resolve(); await second
  assert.deepEqual(history[0].messages.map((item: TestDouble) => item.content), ['first', 'first answer', 'second', 'second answer'])
})

test('failed chat requests replace the pending message with a failure', async () => {
  const f = fixture({ '@/api/chat': { streamChat: async (data: TestDouble, onToken: TestDouble) => { onToken('partial'); throw new Error('offline') } } })
  f.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' })
  const { applyChatMessage } = f.load('src/services/chatHistory.ts')
  const history: TestDouble[] = [{ id: 'A', messages: [] }]
  const chat = f.load('src/views/chat/components/chatView.vue', ['sendMessage', 'inputText'], { conversationId: 'A', messages: [] },
    (event: TestDouble, message: TestDouble) => applyChatMessage(history, message))
  chat.inputText.value = 'question'
  await chat.sendMessage()
  assert.equal(history[0].messages[1].failed, true)
  assert.equal(history[0].messages[1].pending, false)
  assert.equal(history[0].messages[1].content, 'partial\n\n（offline）')
})

test('SSE chat sends the authenticated POST and requires a done event', async () => {
  const tokens: string[] = []
  let options: TestDouble
  const f = chatStreamFixture(async (url: TestDouble, value: TestDouble) => {
    options = value
    assert.equal(url, '/api/chat/stream')
    assert.equal(value.method, 'POST')
    assert.equal(value.headers.token, 'example-a')
    assert.deepEqual(JSON.parse(value.body), { conversationId: 'A', message: '你好' })
    assert.equal(value.openWhenHidden, true)
    await value.onopen(sseResponse())
    value.onmessage({ event: 'token', data: JSON.stringify({ content: '你' }) })
    value.onmessage({ event: 'token', data: JSON.stringify({ content: '好🙂' }) })
    value.onmessage({ event: 'done', data: '{}' })
    value.onclose()
  })
  await f.streamChat({ conversationId: 'A', message: '你好' }, (text: string) => tokens.push(text))
  assert.deepEqual(tokens, ['你', '好🙂'])
  const failure = new Error('offline')
  assert.throws(() => options.onerror(failure), (error: unknown) => error === failure)
  f.auth.clearSession()
  assert.equal(options.signal.aborted, false, 'the completed request removed its session listener')
})

test('SSE chat rejects missing completion, invalid content types and server errors', async () => {
  for (const scenario of ['eof', 'content-type', 'error', 'invalid-token']) {
    const f = chatStreamFixture(async (url: TestDouble, options: TestDouble) => {
      await options.onopen(sseResponse(200, scenario === 'content-type' ? 'application/json' : 'text/event-stream'))
      if (scenario === 'error') options.onmessage({ event: 'error', data: '{"message":"模型暂时不可用"}' })
      if (scenario === 'invalid-token') options.onmessage({ event: 'token', data: '{"content":42}' })
      options.onclose()
    })
    await assert.rejects(f.streamChat({ conversationId: 'A', message: '你好' }, () => {}), /未完成|未返回流式|模型暂时不可用|无效的回复片段/)
  }
})

test('SSE chat cancels on account changes or caller abort and ignores stale tokens', async () => {
  for (const changeAccount of [false, true]) {
    const external = new AbortController()
    const tokens: string[] = []
    let options: TestDouble
    const operation = deferred()
    const f = chatStreamFixture(async (url: TestDouble, value: TestDouble) => {
      options = value
      await operation.promise
      value.onmessage({ event: 'token', data: '{"content":"old private reply"}' })
    })
    const request = f.streamChat({ conversationId: 'A', message: '你好' }, (text: string) => tokens.push(text), external.signal)
    if (changeAccount) f.auth.setLoginUser({ id: 'B', token: 'example-b' })
    else external.abort()
    assert.equal(options.signal.aborted, true)
    operation.resolve()
    await assert.rejects(request, /abort/i)
    assert.deepEqual(tokens, [])
  }
})

test('SSE chat never sends an already canceled request', async () => {
  let requests = 0
  const f = chatStreamFixture(async () => { requests++ })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.streamChat({ conversationId: 'A', message: '你好' }, () => {}, controller.signal), /abort/i)
  assert.equal(requests, 0)
})

test('SSE chat expires only the current session on a 401', async () => {
  const f = chatStreamFixture(async (url: TestDouble, options: TestDouble) => { await options.onopen(sseResponse(401)) })
  await assert.rejects(f.streamChat({ conversationId: 'A', message: '你好' }, () => {}))
  assert.equal(f.auth.loginUser.value, null)
  assert.equal(f.notices.at(-1).text, '登录已过期，请重新登录')
  assert.equal(f.redirects.at(-1).path, '/login')

  const delayed = deferred()
  const stale = chatStreamFixture(async (url: TestDouble, options: TestDouble) => { await delayed.promise; await options.onopen(sseResponse(401)) })
  const request = stale.streamChat({ conversationId: 'A', message: '你好' }, () => {})
  stale.auth.setLoginUser({ id: 'B', token: 'example-b' })
  delayed.resolve()
  await assert.rejects(request)
  assert.equal(stale.auth.loginUser.value.id, 'B')
  assert.equal(stale.redirects.length, 0)
})

test('leaving a chat stops the stream and clears the pending bubble', async () => {
  const operation = deferred()
  let signal: TestDouble
  const f = fixture({ '@/api/chat': { streamChat: async (data: TestDouble, onToken: TestDouble, value: TestDouble) => { signal = value; onToken('partial'); await operation.promise } } })
  f.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' })
  const { applyChatMessage } = f.load('src/services/chatHistory.ts')
  const history: TestDouble[] = [{ id: 'A', messages: [] }]
  const chat = f.load('src/views/chat/components/chatView.vue', ['sendMessage', 'inputText'], { conversationId: 'A', messages: [] }, (event: TestDouble, message: TestDouble) => applyChatMessage(history, message))
  chat.inputText.value = 'question'
  const request = chat.sendMessage()
  f.unmount()
  assert.equal(signal.aborted, true)
  assert.equal(history[0].messages[1].pending, false)
  assert.equal(history[0].messages[1].failed, true)
  assert.match(history[0].messages[1].content, /^partial/)
  operation.resolve()
  await request
})

test('legacy browser history merges both storage formats, honors deletions and keeps stable message IDs', () => {
  const f = fixture()
  const key = 'chatHistory:A'
  f.storage.set(key, JSON.stringify([
    { id: 'old', title: '旧记录', messages: [{ role: 'user', content: '第一条' }] },
    { id: 'deleted', title: '已删除', messages: [] }
  ]))
  f.storage.set(key + ':records:conversation:old', JSON.stringify({ id: 'old', title: '新标题', metadataUpdatedAt: 10, pinned: true }))
  f.storage.set(key + ':records:message:old:reply', JSON.stringify({ id: 'reply', conversationId: 'old', role: 'ai', content: '回答', createdAt: 1 }))
  f.storage.set(key + ':records:deleted:deleted', JSON.stringify({ id: 'deleted', deleted: true }))
  const chat = f.load('src/services/chatHistory.ts')
  const first = chat.readChatHistory(key)
  const second = chat.readChatHistory(key)
  assert.equal(first.length, 1)
  assert.equal(first[0].title, '新标题')
  assert.equal(first[0].pinned, true)
  assert.equal(first[0].messages.length, 2)
  assert.deepEqual(plain(first), plain(second))
})

test('migration batches old messages without duplicate uploads after success and preserves the source', async () => {
  const f = fixture()
  const key = 'chatHistory:A'
  f.storage.set(key, JSON.stringify([{ id: 'C', title: '对话', messages: Array.from({ length: 205 }, (_, i) => ({ id: 'm' + i, role: 'user', content: '消息', createdAt: i })) }]))
  const source = f.storage.get(key)
  const chat = f.load('src/services/chatHistory.ts')
  const batches: TestDouble[] = []
  await chat.migrateChatHistory(key, async (data: TestDouble) => { batches.push(plain(data)) }, () => true)
  assert.deepEqual(batches.map(data => data.messages.length), [100, 100, 5])
  assert.equal(new Set(batches.flatMap(data => data.messages).map(message => message.id)).size, 205)
  await chat.migrateChatHistory(key, async () => { throw new Error('must not repeat') }, () => true)
  assert.equal(f.storage.get(key), source)
})

test('failed or stale-session migration never marks completion and can be retried', async () => {
  const f = fixture()
  const key = 'chatHistory:A'
  f.storage.set(key, JSON.stringify([{ id: 'C', title: '对话', messages: [{ id: 'm', role: 'ai', content: '', pending: true }] }]))
  const chat = f.load('src/services/chatHistory.ts')
  await assert.rejects(chat.migrateChatHistory(key, async () => { throw new Error('offline') }, () => true), /offline/)
  assert.equal(f.storage.has(key + ':redis-migrated-v1'), false)
  await assert.rejects(chat.migrateChatHistory(key, async () => {}, () => false), /会话已变更/)
  const imported: TestDouble[] = []
  await chat.migrateChatHistory(key, async (data: TestDouble) => { imported.push(plain(data)) }, () => true)
  assert.equal(imported[0].messages[0].pending, false)
  assert.equal(imported[0].messages[0].interrupted, true)
  assert.match(imported[0].messages[0].content, /重新发送/)
})

test('a delayed placeholder cannot revert a completed chat reply', () => {
  const f = fixture()
  const chat = f.load('src/services/chatHistory.ts')
  const history: TestDouble[] = [{ id: 'A', title: '对话', messages: [] }]
  chat.applyChatMessage(history, { conversationId: 'A', id: 'reply', role: 'ai', content: 'answer', pending: false })
  assert.equal(chat.applyChatMessage(history, { conversationId: 'A', id: 'reply', role: 'ai', content: '', pending: true }), false)
  assert.equal(history[0].messages[0].content, 'answer')
})

test('pending display messages expire in memory without enumerating browser storage', () => {
  const f = fixture()
  const history: TestDouble[] = [{ id: 'C', messages: [{ id: 'pending', role: 'ai', content: '', pending: true, createdAt: Date.now() - 130000 }] }]
  f.load('src/services/chatHistory.ts').expirePendingMessages(history)
  assert.equal(history[0].messages[0].pending, false)
  assert.equal(history[0].messages[0].failed, true)
  assert.match(history[0].messages[0].content, /重新发送/)
  assert.equal(f.storageReads.enumerations, 0)
})

test('conversation APIs retain session guards, encode IDs and expose backend error messages', async () => {
  const calls: TestDouble[] = []
  let fail = false
  const request = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, async (...args: TestDouble[]) => {
    calls.push([method, ...args])
    if (fail) throw Object.assign(new Error('Request failed with status 409'), { isAxiosError: true, response: { data: { code: 0, msg: '对话正在回复，请稍后重试' } } })
    return { code: 1, data: [] }
  }]))
  const f = fixture({ '@/utils/request': { default: request }, '@microsoft/fetch-event-source': { fetchEventSource: async () => {} } })
  const api = f.load('src/api/chat.ts')
  const config = { signal: new AbortController().signal, expectedSession: { version: 1, token: 'example' } }
  const data = { id: 'C', title: '对话', createdAt: 1, messages: [] }
  await api.getConversations(config)
  await api.getConversation('folder/id', config)
  await api.createConversation(data, config)
  await api.updateConversation('folder/id', { pinned: true }, config)
  await api.removeConversation('folder/id', config)
  await api.importConversation(data, config)
  assert.equal(calls.length, 6)
  for (const call of calls) assert.equal(call.at(-1), config)
  assert.equal(calls[1][1], '/chat/conversations/folder%2Fid')
  assert.deepEqual(plain(calls[3][2]), { pinned: true })
  fail = true
  await assert.rejects(api.removeConversation('C', config), /对话正在回复，请稍后重试/)
})

test('Shift+Enter leaves the composer text intact and does not send or prevent a newline', async () => {
  const sent: TestDouble[] = []
  const events: TestDouble[] = []
  let prevented = false
  const f = fixture({ '@/api/chat': { streamChat: async (data: TestDouble) => { sent.push(data) } } })
  f.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' })
  const chat = f.load('src/views/chat/components/chatView.vue', ['inputText', 'handleEnter'], { conversationId: 'C', messages: [] }, (...args: TestDouble[]) => events.push(args))
  chat.inputText.value = '第一行消息'
  chat.handleEnter({ shiftKey: true, preventDefault: () => { prevented = true } })
  await vue.nextTick()
  assert.equal(prevented, false)
  assert.equal(chat.inputText.value, '第一行消息')
  assert.equal(sent.length, 0)
  assert.equal(events.length, 0)
  f.unmount()
})

test('chat rejects text beyond 10000 characters and accepts a message exactly at the limit', async () => {
  const sent: TestDouble[] = []
  const events: TestDouble[] = []
  const f = fixture({ '@/api/chat': { streamChat: async (data: TestDouble, onToken: TestDouble) => { sent.push(data); onToken('收到') } } })
  f.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' })
  const chat = f.load('src/views/chat/components/chatView.vue', ['inputText', 'sendMessage', 'sending'], { conversationId: 'C', messages: [] }, (...args: TestDouble[]) => events.push(args))
  chat.inputText.value = '字'.repeat(10001)
  await chat.sendMessage()
  assert.equal(sent.length, 0)
  assert.equal(events.length, 0)
  assert.equal(chat.inputText.value.length, 10001)
  assert.equal(chat.sending.value, false)
  chat.inputText.value = '字'.repeat(10000)
  await chat.sendMessage()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].message.length, 10000)
  assert.equal(chat.inputText.value, '')
  assert.equal(chat.sending.value, false)
  f.unmount()
})

test('Chinese composition Enter does not send and normal Enter sends once', async () => {
  const sent: TestDouble[] = []
  const f = fixture({ '@/api/chat': { streamChat: async (data: TestDouble, onToken: TestDouble) => { sent.push(data); onToken('回复') } } })
  f.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' })
  const chat = f.load('src/views/chat/components/chatView.vue', ['inputText', 'composing', 'handleEnter'], { conversationId: 'C', messages: [] })
  chat.inputText.value = '中文消息'
  chat.composing.value = true
  chat.handleEnter({ preventDefault: () => {}, isComposing: false })
  chat.composing.value = false
  chat.handleEnter({ preventDefault: () => {}, keyCode: 229 })
  assert.equal(sent.length, 0)
  chat.handleEnter({ preventDefault: () => {} })
  await vue.nextTick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].message, '中文消息')
})

test('completed legacy replies win over newer pending or expired placeholders during migration merge', () => {
  const f = fixture()
  const chat = f.load('src/services/chatHistory.ts')
  const completed = { id: 'reply', role: 'ai', content: '完成回复', pending: false, createdAt: Date.now(), updatedAt: 10 }
  const wrap = (message: TestDouble) => [{ id: 'C', title: '对话', messages: [message] }]
  for (const expiresAt of [Date.now() + 125000, Date.now() - 1]) {
    const pending = { ...completed, content: '', pending: true, expiresAt, updatedAt: 99999 }
    for (const histories of [[wrap(completed), wrap(pending)], [wrap(pending), wrap(completed)]]) {
      const result = chat.mergeChatHistories(...histories)[0].messages[0]
      assert.equal(result.content, '完成回复')
      assert.equal(result.pending, false)
      assert.equal(result.interrupted, false)
    }
  }

})

test('long chats initially show the newest batch and prepend older messages without moving the reading anchor', async () => {
  const f = fixture({ '@/api/chat': {} })
  const props = vue.reactive({ conversationId: 'A', messages: Array.from({ length: 1500 }, (_, i) => ({ id: 'm' + i, role: 'user', content: '消息 ' + i })) })
  const chat = f.load('src/views/chat/components/chatView.vue', ['visibleMessages', 'hasOlderMessages', 'loadOlderMessages', 'chatContentRef', 'visibleMessageCount'], props)
  const content = { scrollTop: 0, clientHeight: 400, get scrollHeight() { return chat.visibleMessages.value.length * 20 } }
  chat.chatContentRef.value = content
  await vue.nextTick()
  assert.equal(chat.visibleMessages.value.length, 60)
  assert.equal(chat.visibleMessages.value[0].id, 'm1440')
  assert.equal(props.messages.length, 1500)
  content.scrollTop = 20
  await chat.loadOlderMessages()
  assert.equal(chat.visibleMessages.value.length, 120)
  assert.equal(chat.visibleMessages.value[0].id, 'm1380')
  assert.equal(content.scrollTop, 1220)
  const firstVisible = chat.visibleMessages.value[0].id
  props.messages.push({ id: 'remote', role: 'ai', content: '其他页面的新消息' })
  await vue.nextTick()
  assert.equal(chat.visibleMessages.value[0].id, firstVisible)
  assert.equal(content.scrollTop, 1220)
  assert.equal(props.messages.length, 1501)
})

test('switching chat during an older-message load resets the window and stops the old scroll update', async () => {
  const f = fixture({ '@/api/chat': {} })
  const props = vue.reactive({ conversationId: 'A', messages: Array.from({ length: 130 }, (_, i) => ({ id: 'm' + i, role: 'user', content: '消息 ' + i })) })
  const chat = f.load('src/views/chat/components/chatView.vue', ['loadOlderMessages', 'visibleMessages', 'visibleMessageCount', 'chatContentRef', 'loadingOlder'], props)
  const content = { scrollTop: 0, clientHeight: 400, get scrollHeight() { return chat.visibleMessages.value.length * 20 } }
  chat.chatContentRef.value = content
  await vue.nextTick()
  content.scrollTop = 20
  const load = chat.loadOlderMessages()
  props.conversationId = 'B'
  props.messages = [{ id: 'B1', role: 'user', content: '另一个对话' }]
  await load
  await vue.nextTick()
  assert.equal(chat.visibleMessageCount.value, 60)
  assert.equal(chat.loadingOlder.value, false)
  assert.equal(chat.visibleMessages.value[0].id, 'B1')
  assert.equal(content.scrollTop, 20)
})

test('a reply growing below the viewport during history prepend does not shift the reading anchor', async () => {
  const f = fixture({ '@/api/chat': {} })
  const props = vue.reactive({ conversationId: 'A', messages: Array.from({ length: 150 }, (_, i) => ({ id: 'm' + i, role: 'user', content: '消息 ' + i })) })
  const chat = f.load('src/views/chat/components/chatView.vue', ['visibleMessages', 'loadOlderMessages', 'chatContentRef'], props)
  let extraReplyHeight = 0
  const anchor = { isConnected: true, get offsetTop() { return (chat.visibleMessages.value.length - 60) * 20 } }
  const content = { scrollTop: 0, clientHeight: 400, querySelector: () => anchor, get scrollHeight() { return chat.visibleMessages.value.length * 20 + extraReplyHeight } }
  chat.chatContentRef.value = content
  await vue.nextTick()
  content.scrollTop = 20
  const load = chat.loadOlderMessages()
  extraReplyHeight = 200
  await load
  assert.equal(content.scrollTop, 1220)
})

test('chat storage identity stays on the stable user id when email or token changes', () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 17, token: 'first-token', email: 'old@example.com' })
  const key = auth.getChatStorageKey()
  auth.setLoginUser({ id: 17, token: 'second-token', email: 'new@example.com' })
  assert.equal(auth.getChatStorageKey(), key)
  auth.setLoginUser({ id: 18, token: 'second-token', email: 'new@example.com' })
  assert.notEqual(auth.getChatStorageKey(), key)
  f.storage.set('loginUser', JSON.stringify({ token: 'legacy-token', username: 'legacy' }))
  assert.equal(auth.getChatStorageKey(), null)
})
