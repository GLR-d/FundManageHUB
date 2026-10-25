// Shared chat scenario fixtures.
import type { TestDouble } from './testTypes.cts'
const { fixture } = require('./runtime.cts')

const sseResponse = (status = 200, contentType = 'text/event-stream; charset=utf-8') => ({
  status, ok: status >= 200 && status < 300, headers: { get: () => contentType }
})

const chatStreamFixture = (fetchEventSource: TestDouble) => {
  const f = fixture({ '@microsoft/fetch-event-source': { fetchEventSource } })
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  return { ...f, auth, streamChat: f.load('src/api/chat.ts').streamChat }
}

module.exports = { sseResponse, chatStreamFixture }
