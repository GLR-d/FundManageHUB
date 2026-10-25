import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, vue, flushTasks, deferred, fixture, form } = require('./helpers/runtime.cts')
const { registrationFixture, fillRegistration } = require('./helpers/accountFixtures.cts')

test('empty registration and duplicate submissions do not send extra requests', async () => {
  const pending: TestDouble[] = []
  const f = fixture({ '@/api/register': { addUser: (data: TestDouble) => new Promise(resolve => pending.push({ data, resolve })) } })
  const register = f.load('src/views/register/index.vue', ['handleRegister', 'registerForm', 'registerRef', 'registerRules'])
  register.registerRef.value = form(register.registerForm, register.registerRules)
  await register.handleRegister()
  assert.equal(pending.length, 0)
  register.registerForm.value = { name: 'person', email: 'person@example.test', code: '', password: 'example-password', confirmPassword: 'example-password' }
  register.registerForm.value.code = '123456'
  const first = register.handleRegister()
  await new Promise(resolve => setImmediate(resolve))
  await register.handleRegister()
  assert.equal(pending.length, 1)
  pending[0].resolve({ code: 1 })
  await first
})

test('registration submits a snapshot and ignores success after leaving the page', async () => {
  let dispose: TestDouble
  let finish: TestDouble
  let sent: TestDouble
  let signal: TestDouble
  const f = fixture({
    vue: { ...vue, onMounted: () => {}, onUnmounted: (fn: TestDouble) => { dispose = fn } },
    '@/api/register': { addUser: (data: TestDouble, config: TestDouble) => { sent = data; signal = config.signal; return new Promise(resolve => { finish = resolve }) } }
  })
  const register = f.load('src/views/register/index.vue', ['handleRegister', 'registerRef', 'registerForm'])
  register.registerRef.value = { validate: async () => true }
  register.registerForm.value = { name: 'before', email: 'before@example.test', code: '', password: 'example-password', confirmPassword: 'example-password' }
  register.registerForm.value.code = '123456'
  const operation = register.handleRegister()
  await new Promise(resolve => setImmediate(resolve))
  register.registerForm.value.name = 'changed'
  dispose()
  assert.equal(signal.aborted, true)
  finish({ code: 1 })
  await operation
  assert.equal(sent.name, 'before')
  assert.equal(f.redirects.length, 0)
  assert.equal(f.notices.length, 0)
})

test('registration sends a normalized mailbox code and enforces the shared resend deadline before creating any account', async () => {
  const f = registrationFixture()
  f.page.registerForm.value.email = ' Person@Example.com '
  await f.page.sendCode()
  await f.page.sendCode()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].url, '/register/email/request')
  assert.deepEqual(JSON.parse(f.sent[0].data), { email: 'person@example.com' })
  assert.equal(f.page.remaining.value, 60)
  f.clock.advance(60000)
  await f.page.sendCode()
  assert.equal(f.sent.length, 2)
  assert.equal(f.auth.readLoginUser(), null)
  f.unmount()
})

test('registration requires a valid code and matching password and omits an empty optional nickname', async () => {
  const f = registrationFixture()
  fillRegistration(f)
  f.page.registerForm.value.code = '12345'
  await f.page.handleRegister()
  assert.equal(f.sent.length, 0)
  f.page.registerForm.value.code = '123456'
  f.page.registerForm.value.confirmPassword = 'different-password'
  await f.page.handleRegister()
  assert.equal(f.sent.length, 0)
  f.page.registerForm.value.confirmPassword = f.page.registerForm.value.password
  await f.page.handleRegister()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].url, '/register')
  assert.deepEqual(JSON.parse(f.sent[0].data), { email: 'person@example.com', code: '123456', password: ' example-password ' })
  assert.equal(f.page.registerForm.value.password, '')
  assert.equal(f.page.registerForm.value.confirmPassword, '')
  assert.equal(f.page.registerForm.value.code, '')
  assert.equal(f.auth.readLoginUser(), null)
  assert.deepEqual(f.redirects, ['/login'])
  f.unmount()
})

test('registration trims an optional nickname, preserves password whitespace and cancels email-code sends on leaving', async () => {
  const f = registrationFixture()
  fillRegistration(f, ' My name ')
  await f.page.handleRegister()
  assert.deepEqual(JSON.parse(f.sent[0].data), { email: 'person@example.com', code: '123456', password: ' example-password ', name: 'My name' })
  f.unmount()
  const response = deferred()
  const pending = registrationFixture({ reply: () => response.promise })
  pending.page.registerForm.value.email = 'person@example.com'
  const operation = pending.page.sendCode()
  await flushTasks()
  pending.unmount()
  assert.equal(pending.sent[0].signal.aborted, true)
  response.resolve({ code: 1 })
  await operation
  assert.equal(pending.page.remaining.value, 0)
  assert.equal(pending.notices.length, 0)
})
