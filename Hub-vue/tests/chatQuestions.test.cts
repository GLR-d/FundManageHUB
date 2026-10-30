import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, vue, plain, deferred, fixture } = require('./helpers/runtime.cts')
const { sseResponse, chatStreamFixture } = require('./helpers/chatFixtures.cts')

const question = (changes: TestDouble = {}) => ({
  interruptId: 'interrupt-1', question: '查询哪个月份？', options: ['本月', '上月'], allowCustomAnswer: true, ...changes
})

test('a question event completes the SSE request without a done event and ignores late tokens', async () => {
  const tokens: string[] = []
  const received: TestDouble[] = []
  const payload = { conversationId: 'A', messageId: 'reply-1', questions: [question()] }
  const f = chatStreamFixture(async (_url: TestDouble, options: TestDouble) => {
    await options.onopen(sseResponse())
    options.onmessage({ event: 'token', data: JSON.stringify({ content: '请确认月份' }) })
    options.onmessage({ event: 'question', data: JSON.stringify(payload) })
    options.onmessage({ event: 'token', data: JSON.stringify({ content: 'late' }) })
    options.onclose()
  })
  const result = await f.streamChat({ conversationId: 'A', message: '统计一下', replyId: 'reply-1' }, (text: string) => tokens.push(text), undefined,
    (event: TestDouble) => received.push(event))
  assert.deepEqual(tokens, ['请确认月份'])
  assert.deepEqual(plain(received), [payload])
  assert.deepEqual(plain(result), payload)
})

test('resuming a question sends answer and interrupt id without a new message field', async () => {
  let body: TestDouble
  const f = chatStreamFixture(async (_url: TestDouble, options: TestDouble) => {
    body = JSON.parse(options.body)
    options.onmessage({ event: 'done', data: '{}' })
    options.onclose()
  })
  await f.streamChat({ conversationId: 'A', interruptId: 'interrupt-1', answer: '上月', messageId: 'answer-1', replyId: 'reply-2' }, () => {})
  assert.deepEqual(body, { conversationId: 'A', interruptId: 'interrupt-1', answer: '上月', messageId: 'answer-1', replyId: 'reply-2' })
  assert.equal('message' in body, false)
})

test('question events must belong to the current conversation and contain renderable questions', async () => {
  for (const changes of [
    { conversationId: 'B' }, { messageId: 'another-reply' }, { questions: [] },
    { questions: [question({ options: [123] })] }, { questions: [question({ interruptId: '' })] }
  ]) {
    const f = chatStreamFixture(async (_url: TestDouble, options: TestDouble) => {
      options.onmessage({ event: 'question', data: JSON.stringify({ conversationId: 'A', messageId: 'reply-1', questions: [question()], ...changes }) })
    })
    await assert.rejects(f.streamChat({ conversationId: 'A', message: '查询', replyId: 'reply-1' }, () => {}), /无效的提问信息/)
  }
})

function componentFixture(stream: TestDouble, initial: TestDouble = {}) {
  const f = fixture({ '@/api/chat': { streamChat: stream } })
  f.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' })
  const { applyChatMessage } = f.load('src/services/chatHistory.ts')
  const conversation = { id: 'A', title: '对话', messages: [], pendingQuestions: [], ...initial }
  const history = [conversation]
  const props = vue.reactive({ conversationId: 'A', messages: conversation.messages, pendingQuestions: conversation.pendingQuestions })
  const settled: string[] = []
  const chat = f.load('src/views/chat/components/chatView.vue', [
    'sendMessage', 'inputText', 'sending', 'submitQuestion', 'selectOption', 'questionDrafts', 'isQuestionPending'
  ], props, (event: string, message: TestDouble) => {
    if (event === 'send-success') {
      applyChatMessage(history, message)
      props.pendingQuestions = conversation.pendingQuestions || []
    } else if (event === 'settled') settled.push(message)
  })
  return { ...f, chat, props, history, conversation, settled }
}

for (const custom of [false, true]) {
  test(`a question bubble pauses normally and accepts ${custom ? 'a custom answer' : 'an option'} through the same stream`, async () => {
    const requests: TestDouble[] = []
    const prompt = question()
    const f = componentFixture(async (data: TestDouble, onToken: TestDouble, _signal: TestDouble, onQuestion: TestDouble) => {
      requests.push(plain(data))
      if ('message' in data) onQuestion({ conversationId: 'A', messageId: data.replyId, questions: [prompt] })
      else onToken('已按你的选择查询')
    })
    f.chat.inputText.value = '查一下收支'
    await f.chat.sendMessage()
    const bubble = f.conversation.messages[1]
    assert.equal(bubble.content, '')
    assert.equal(bubble.pending, false)
    assert.equal(bubble.failed, false)
    assert.deepEqual(plain(bubble.questions), [prompt])
    assert.equal(f.chat.isQuestionPending(prompt, bubble.id), true)
    f.chat.inputText.value = '不能绕过问题继续发送'
    await f.chat.sendMessage()
    assert.equal(requests.length, 1)
    if (custom) f.chat.questionDrafts.value[prompt.interruptId] = '  2026年8月  '
    else f.chat.selectOption(prompt, '上月')
    await f.chat.submitQuestion(prompt, bubble.id)
    assert.equal(requests.length, 2)
    assert.equal(requests[1].answer, custom ? '2026年8月' : '上月')
    assert.equal(requests[1].interruptId, prompt.interruptId)
    assert.equal('message' in requests[1], false)
    assert.equal(f.conversation.messages[3].content, '已按你的选择查询')
    assert.deepEqual(plain(f.conversation.pendingQuestions), [])
    assert.equal(f.chat.sending.value, false)
    assert.equal(f.settled.length, 2)
  })
}

test('only the latest live question can be submitted and duplicate submissions are blocked', async () => {
  const pending = deferred()
  const requests: TestDouble[] = []
  const prompt = question()
  const messages = [
    { id: 'old', role: 'ai', content: '', questions: [prompt], createdAt: 1 },
    { id: 'latest', role: 'ai', content: '', questions: [prompt], createdAt: 2 }
  ]
  const f = componentFixture(async (data: TestDouble) => { requests.push(data); await pending.promise }, { messages, pendingQuestions: [prompt] })
  f.chat.selectOption(prompt, '本月')
  await f.chat.submitQuestion(prompt, 'old')
  assert.equal(requests.length, 0)
  const operation = f.chat.submitQuestion(prompt, 'latest')
  await f.chat.submitQuestion(prompt, 'latest')
  assert.equal(requests.length, 1)
  pending.resolve()
  await operation
  await f.chat.submitQuestion(prompt, 'latest')
  assert.equal(requests.length, 1)
})

test('reload normalization retains question cards and pending questions without marking them failed', () => {
  const f = fixture()
  const chat = f.load('src/services/chatHistory.ts')
  const prompt = question()
  const restored = chat.mergeChatHistories([{ id: 'A', pendingQuestions: [prompt], messages: [
    { id: 'reply', role: 'ai', content: '', pending: false, questions: [prompt], createdAt: 1 }
  ] }])
  assert.deepEqual(plain(restored[0].pendingQuestions), [prompt])
  assert.deepEqual(plain(restored[0].messages[0].questions), [prompt])
  assert.equal(restored[0].messages[0].failed, false)
})

test('legacy migration strips question workflow fields from both messages and conversation metadata', async () => {
  const f = fixture()
  const prompt = question()
  f.storage.set('chatHistory:A', JSON.stringify([{ id: 'A', pendingQuestions: [prompt], messages: [
    { id: 'reply', role: 'ai', content: '旧消息', questions: [prompt], createdAt: 1 }
  ] }]))
  const uploaded: TestDouble[] = []
  await f.load('src/services/chatHistory.ts').migrateChatHistory('chatHistory:A', async (data: TestDouble) => uploaded.push(data), () => true)
  assert.equal(uploaded.length, 1)
  assert.equal('pendingQuestions' in uploaded[0], false)
  assert.equal('questions' in uploaded[0].messages[0], false)
})
