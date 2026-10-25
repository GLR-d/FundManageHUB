import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, fs, path, vue, root, plain, flushTasks, deferred, form } = require('./helpers/runtime.cts')
const { accountEditorFixture, recoveryFixture, bindingFixture, passwordChangeFixture, verifyAccountStage, fillRecovery } = require('./helpers/accountFixtures.cts')

test('recovery sends a normalized email and generic acknowledgement, with no username or login changes', async () => {
  const pending = deferred()
  const f = recoveryFixture({ reply: () => pending.promise })
  f.page.formData.value.email = ' Person@Example.com '
  const operation = f.page.sendCode()
  await flushTasks()
  await f.page.sendCode()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].url, '/login/password/forgot')
  assert.deepEqual(JSON.parse(f.sent[0].data), { email: 'person@example.com' })
  assert.equal(f.page.remaining.value, 0)
  pending.resolve({ code: 1, msg: null, data: null })
  await operation
  assert.equal(f.page.remaining.value, 60)
  assert.match(f.notices.at(-1).text, /如果该邮箱已绑定并验证/)
  assert.equal(f.auth.readLoginUser(), null)
  assert.equal(f.redirects.length, 0)
  f.unmount()
  assert.equal(f.clock.timers.size, 0)
})

test('email code cooldown uses the deadline even after a background-tab pause and permits retry after 60 seconds', async () => {
  const f = recoveryFixture()
  f.page.formData.value.email = 'person@example.com'
  await f.page.sendCode()
  await f.page.sendCode()
  assert.equal(f.sent.length, 1)
  f.clock.advance(59001)
  assert.equal(f.page.remaining.value, 1)
  await f.page.sendCode()
  assert.equal(f.sent.length, 1)
  f.clock.advance(120000)
  assert.equal(f.page.remaining.value, 0)
  assert.equal(f.clock.timers.size, 0)
  await f.page.sendCode()
  assert.equal(f.sent.length, 2)
  f.unmount()
})

test('changing email clears its code without bypassing the previous email cooldown, including reopening the dialog', async () => {
  const f = bindingFixture()
  await verifyAccountStage(f)
  f.page.localData.value.email = 'first@example.com'
  await f.page.sendCode()
  f.page.localData.value.code = '123456'
  f.page.localData.value.email = 'second@example.com'
  assert.equal(f.page.localData.value.code, '')
  assert.equal(f.page.remaining.value, 0)
  await f.page.sendCode()
  f.clock.advance(10000)
  f.page.localData.value.email = 'first@example.com'
  assert.equal(f.page.remaining.value, 50)
  f.props.visible = false
  f.props.visible = true
  await verifyAccountStage(f)
  f.page.localData.value.email = ' FIRST@example.com '
  assert.equal(f.page.remaining.value, 50)
  await f.page.sendCode()
  assert.equal(f.sent.length, 2)
  f.unmount()
})

test('failed sending starts no cooldown and can retry; invalid email sends nothing', async () => {
  let failure = true
  const f = recoveryFixture({ reply: () => failure ? { code: 0, msg: '邮件发送失败' } : { code: 1 } })
  await f.page.sendCode()
  f.page.formData.value.email = 'not-an-email'
  await f.page.sendCode()
  assert.equal(f.sent.length, 0)
  f.page.formData.value.email = 'person@example.com'
  await f.page.sendCode()
  assert.equal(f.page.remaining.value, 0)
  assert.equal(f.page.sending.value, false)
  failure = false
  await f.page.sendCode()
  assert.equal(f.sent.length, 2)
  assert.equal(f.page.remaining.value, 60)
  f.unmount()
})

test('a cancelled send cannot clear a newer code or apply cooldown to another email', async () => {
  const pending = deferred()
  const f = recoveryFixture({ reply: () => pending.promise })
  f.page.formData.value.email = 'first@example.com'
  const sending = f.page.sendCode()
  await flushTasks()
  f.page.formData.value.email = 'second@example.com'
  f.page.formData.value.code = '654321'
  pending.resolve({ code: 1 })
  await sending
  assert.equal(f.page.remaining.value, 0)
  assert.equal(f.page.formData.value.code, '654321')
  assert.equal(f.notices.length, 0)
  f.unmount()
})

test('changing login email needs only the target email and code and updates profile after verification', async () => {
  const verified = { id: 'A', email: 'new@example.com', email_verified: true, name: 'person' }
  const pending = deferred()
  const f = bindingFixture({ reply: (config: TestDouble) => config.url.endsWith('/request') ? { code: 1 } : pending.promise })
  await verifyAccountStage(f)
  f.page.localData.value.email = ' New@Example.com '
  await f.page.sendCode()
  assert.equal(f.sent[0].url, '/user/email/request')
  assert.deepEqual(JSON.parse(f.sent[0].data), { email: 'new@example.com', verificationToken: 'verified-email-ticket' })
  assert.equal(f.auth.currentUser.value.email, 'old@example.com')
  assert.deepEqual(f.events, [])
  f.page.localData.value.code = '123456'
  const operation = f.page.handleSubmit()
  await flushTasks()
  await f.page.handleSubmit()
  assert.equal(f.sent.length, 2)
  assert.equal(f.sent[1].url, '/user/email/verify')
  assert.deepEqual(JSON.parse(f.sent[1].data), { email: 'new@example.com', code: '123456', verificationToken: 'verified-email-ticket' })
  assert.equal(f.auth.currentUser.value.email, 'old@example.com')
  pending.resolve({ code: 1, data: verified })
  await operation
  assert.deepEqual(f.events, [{ event: 'verified', data: verified }, { event: 'update:visible', data: false }])
  assert.equal(f.page.localData.value.code, '')
  const source = fs.readFileSync(path.join(root, 'src/views/my/index.vue'), 'utf8')
  assert.match(source, /@verified="userData = \$event"/)
  f.unmount()
})

test('incorrect or expired binding codes keep the dialog and address unchanged for a retry', async () => {
  const f = bindingFixture({ reply: () => ({ code: 0, msg: '验证码已失效，请重新发送' }) })
  await verifyAccountStage(f)
  f.page.localData.value.email = 'new@example.com'
  f.page.localData.value.code = '123456'
  await f.page.handleSubmit()
  assert.equal(f.page.submitting.value, false)
  assert.equal(f.page.localData.value.code, '123456')
  assert.equal(f.auth.currentUser.value.email, 'old@example.com')
  assert.deepEqual(f.events, [])
  assert.match(f.notices.at(-1).text, /验证码已失效/)
  f.unmount()
})

test('password change sends its code only to the current bound email and uses the shared cooldown', async () => {
  const f = passwordChangeFixture()
  assert.equal(f.page.localData.value.email, 'current@example.com')
  await f.page.sendCode()
  await f.page.sendCode()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].url, '/user/password/request')
  assert.deepEqual(JSON.parse(f.sent[0].data), { email: 'current@example.com' })
  assert.equal(f.sent[0].headers.token, 'current-session')
  assert.equal(f.page.remaining.value, 60)
  f.page.localData.value.code = '123456'
  f.page.localData.value.newPassword = f.page.localData.value.confirmPassword = 'new-password-123'
  f.props.visible = false
  f.props.visible = true
  assert.equal(f.page.localData.value.code, '')
  assert.equal(f.page.localData.value.newPassword, '')
  assert.equal(f.page.remaining.value, 60)
  await f.page.sendCode()
  assert.equal(f.sent.length, 1)
  f.clock.advance(60000)
  await f.page.sendCode()
  assert.equal(f.sent.length, 2)
  const source = fs.readFileSync(path.join(root, 'src/views/my/components/updatePassword.vue'), 'utf8')
  assert.match(source, /email-readonly/)
  assert.doesNotMatch(source, /current-password|isVerify/)
  f.unmount()
})

test('password change loads a missing profile without offering a different recipient', async () => {
  const f = passwordChangeFixture({ profile: {}, reply: (config: TestDouble) => {
    assert.equal(config.url, '/user')
    return { code: 1, data: { email: 'loaded@example.com', email_verified: true } }
  } })
  await flushTasks()
  assert.equal(f.page.localData.value.email, 'loaded@example.com')
  assert.equal(f.page.localData.value.code, '')
  f.unmount()
})

test('password change validates its email code and new password before updating', async () => {
  const f = passwordChangeFixture()
  f.page.localData.value.newPassword = f.page.localData.value.confirmPassword = 'new-password-123'
  for (const code of ['', '12345', '1234567', 'abcdef']) {
    f.page.localData.value.code = code
    await f.page.handleSubmit()
  }
  await verifyAccountStage(f)
  for (const password of ['short', '        ']) {
    f.page.localData.value.newPassword = f.page.localData.value.confirmPassword = password
    await f.page.handleSubmit()
  }
  assert.equal(f.sent.length, 0)
  f.unmount()
})

test('verified password change sends its ticket and untrimmed password atomically and permits retry after a rejected update', async () => {
  let valid = false
  const f = passwordChangeFixture({ reply: () => valid ? { code: 1 } : { code: 0, msg: '验证码已失效，请重新发送' } })
  await verifyAccountStage(f)
  f.page.localData.value.code = '123456'
  f.page.localData.value.newPassword = f.page.localData.value.confirmPassword = ' new-password-123 '
  await f.page.handleSubmit()
  assert.equal(f.sent[0].method, 'put')
  assert.equal(f.sent[0].url, '/user/password')
  assert.deepEqual(JSON.parse(f.sent[0].data), { verificationToken: 'verified-password-ticket', password: ' new-password-123 ' })
  assert.equal(f.page.localData.value.newPassword, ' new-password-123 ')
  assert.equal(f.auth.readLoginUser().token, 'current-session')
  assert.equal(f.redirects.length, 0)
  valid = true
  f.page.localData.value.code = '654321'
  await f.page.handleSubmit()
  assert.equal(f.auth.readLoginUser(), null)
  assert.deepEqual(f.redirects, ['/login'])
  f.unmount()
})

test('closing a binding dialog, changing route or login ignores a late verification result', async () => {
  for (const cancel of [(f: TestDouble) => { f.props.visible = false }, (f: TestDouble) => f.auth.setLoginUser({ id: 'B', token: 'new-session' }), (f: TestDouble) => { f.router.currentRoute.value = { path: '/about', fullPath: '/about' } }]) {
    const pending = deferred()
    const f = bindingFixture({ reply: () => pending.promise })
    await verifyAccountStage(f)
    f.page.localData.value.email = 'new@example.com'
    f.page.localData.value.code = '123456'
    const operation = f.page.handleSubmit()
    await flushTasks()
    cancel(f)
    pending.resolve({ code: 1, data: { email: 'new@example.com', email_verified: true } })
    await operation
    assert.deepEqual(f.events, [])
    assert.equal(f.notices.length, 0)
    f.unmount()
  }
})

test('password editing is gated by a real successful email verification and never sends passwords during verification', async () => {
  let response: TestDouble = { code: 0, msg: '验证码错误' }
  const f = passwordChangeFixture({ verifyReply: () => response })
  f.page.localData.value.code = '123456'
  f.page.localData.value.newPassword = f.page.localData.value.confirmPassword = 'not-submitted-yet'
  await f.page.handleSubmit()
  assert.equal(f.page.step.value, 'verify')
  assert.equal(f.page.verificationToken.value, '')
  assert.equal(f.sent[0].url, '/user/password/verify')
  assert.deepEqual(JSON.parse(f.sent[0].data), { email: 'current@example.com', code: '123456' })
  assert.equal(f.auth.readLoginUser().token, 'current-session')
  for (const data of [null, {}, { verificationToken: '', expiresIn: 300 }, { verificationToken: ' ', expiresIn: 300 }, { verificationToken: 'bad-expiry', expiresIn: 0 }]) {
    response = { code: 1, data }
    await f.page.handleSubmit()
    assert.equal(f.page.step.value, 'verify')
  }
  response = { code: 1, data: { verificationToken: 'fresh-ticket', expiresIn: 300 } }
  await f.page.handleSubmit()
  assert.equal(f.page.step.value, 'password')
  assert.equal(f.page.verificationToken.value, 'fresh-ticket')
  assert.equal(f.page.localData.value.code, '')
  assert.equal(f.page.localData.value.newPassword, '')
  assert.equal(f.page.localData.value.confirmPassword, '')
  assert.ok(f.sent.every((config: TestDouble) => config.url === '/user/password/verify'))
  f.unmount()
})

test('pending first-step password verification is deduplicated and ignores closure, route, account and email changes', async () => {
  for (const change of ['close', 'route', 'account', 'email', 'unmount']) {
    const pending = deferred()
    const f = passwordChangeFixture({ verifyReply: () => pending.promise })
    f.page.localData.value.code = '123456'
    const operation = f.page.handleSubmit()
    await flushTasks()
    await f.page.handleSubmit()
    assert.equal(f.sent.length, 1)
    if (change === 'close') { f.props.visible = false; f.props.visible = true }
    else if (change === 'route') f.router.currentRoute.value = { path: '/about', fullPath: '/about' }
    else if (change === 'account') f.auth.setLoginUser({ id: 'B', token: 'other-session' })
    else if (change === 'email') f.auth.currentUser.value.email = 'another@example.com'
    else f.unmount()
    assert.equal(f.sent[0].signal.aborted, true)
    pending.resolve({ code: 1, data: { verificationToken: 'late-ticket', expiresIn: 300 } })
    await operation
    assert.equal(f.page.step.value, 'verify')
    assert.equal(f.page.verificationToken.value, '')
    assert.equal(f.page.localData.value.newPassword, '')
    assert.equal(f.notices.length, 0)
    f.unmount()
  }
})

test('expired password authorization returns to verification without sending a new password', async () => {
  const f = passwordChangeFixture()
  await verifyAccountStage(f)
  f.page.localData.value.newPassword = f.page.localData.value.confirmPassword = 'new-password-123'
  f.clock.advance(300000)
  await f.page.handleSubmit()
  assert.equal(f.page.step.value, 'verify')
  assert.equal(f.page.verificationToken.value, '')
  assert.equal(f.page.localData.value.newPassword, '')
  assert.equal(f.sent.length, 0)
  assert.match(f.notices.at(-1).text, /重新验证/)
  assert.equal(f.auth.readLoginUser().token, 'current-session')
  f.unmount()
})

test('server-rejected password authorization clears both password fields and leaves the login intact', async () => {
  const f = passwordChangeFixture({ reply: () => Promise.reject({ response: { status: 428, data: { msg: '邮箱验证已失效，请重新验证' } } }) })
  await verifyAccountStage(f)
  f.page.localData.value.newPassword = f.page.localData.value.confirmPassword = 'new-password-123'
  await f.page.handleSubmit()
  assert.equal(f.page.step.value, 'verify')
  assert.equal(f.page.verificationToken.value, '')
  assert.equal(f.page.localData.value.newPassword, '')
  assert.equal(f.page.localData.value.confirmPassword, '')
  assert.equal(f.auth.readLoginUser().token, 'current-session')
  assert.equal(f.notices.length, 1)
  f.unmount()
})

test('changing email starts by verifying the current email and cannot advance on an incorrect code', async () => {
  const f = bindingFixture({ currentVerifyReply: () => ({ code: 0, msg: '验证码错误' }) })
  assert.equal(f.page.step.value, 'verify')
  assert.equal(f.page.localData.value.email, 'old@example.com')
  await f.page.sendCode()
  assert.equal(f.sent[0].url, '/user/email/current/request')
  assert.deepEqual(JSON.parse(f.sent[0].data), { email: 'old@example.com' })
  f.page.localData.value.code = '123456'
  await f.page.handleSubmit()
  assert.equal(f.sent[1].url, '/user/email/current/verify')
  assert.deepEqual(JSON.parse(f.sent[1].data), { email: 'old@example.com', code: '123456' })
  assert.equal(f.page.step.value, 'verify')
  assert.equal(f.page.verificationToken.value, '')
  assert.equal(f.auth.currentUser.value.email, 'old@example.com')
  assert.deepEqual(f.events, [])
  f.unmount()
})

test('new email requests and final verification carry the current-email proof and retain it for a wrong target code', async () => {
  const f = bindingFixture({ reply: () => ({ code: 0, msg: '目标邮箱验证码错误' }) })
  await verifyAccountStage(f)
  assert.equal(f.page.step.value, 'email')
  assert.equal(f.page.localData.value.email, '')
  f.page.localData.value.email = 'new@example.com'
  await f.page.sendCode()
  assert.equal(f.sent[0].url, '/user/email/request')
  assert.deepEqual(JSON.parse(f.sent[0].data), { email: 'new@example.com', verificationToken: 'verified-email-ticket' })
  f.page.localData.value.code = '123456'
  await f.page.handleSubmit()
  assert.equal(f.page.step.value, 'email')
  assert.equal(f.page.verificationToken.value, 'verified-email-ticket')
  assert.deepEqual(JSON.parse(f.sent[1].data), { email: 'new@example.com', code: '123456', verificationToken: 'verified-email-ticket' })
  assert.equal(f.auth.currentUser.value.email, 'old@example.com')
  assert.deepEqual(f.events, [])
  f.unmount()
})

test('new email send and final submission return to current-email verification when authorization expires', async () => {
  for (const action of ['send', 'submit', 'local-expiry']) {
    const f = bindingFixture({ reply: () => Promise.reject({ response: { status: 428, data: { msg: '邮箱验证已失效，请重新验证' } } }) })
    await verifyAccountStage(f)
    f.page.localData.value.email = 'new@example.com'
    f.page.localData.value.code = '123456'
    if (action === 'local-expiry') f.clock.advance(300000)
    if (action === 'send') await f.page.sendCode()
    else await f.page.handleSubmit()
    assert.equal(f.page.step.value, 'verify')
    assert.equal(f.page.verificationToken.value, '')
    assert.equal(f.page.localData.value.email, 'old@example.com')
    assert.equal(f.page.localData.value.code, '')
    assert.equal(f.notices.length, 1)
    assert.deepEqual(f.events, [])
    f.unmount()
  }
})

test('a stale target-email send failure cannot clear authorization after closing and verifying again', async () => {
  const pending = deferred()
  let ticket = 0
  const f = bindingFixture({
    currentVerifyReply: () => ({ code: 1, data: { verificationToken: 'ticket-' + ++ticket, expiresIn: 300 } }),
    reply: () => pending.promise
  })
  await verifyAccountStage(f)
  f.page.localData.value.email = 'first@example.com'
  const first = f.page.sendCode()
  await flushTasks()
  f.props.visible = false
  f.props.visible = true
  await verifyAccountStage(f)
  f.page.localData.value.email = 'second@example.com'
  f.page.localData.value.code = '654321'
  pending.reject({ response: { status: 428, data: { msg: '旧邮箱验证已失效' } } })
  await first
  assert.equal(f.page.step.value, 'email')
  assert.equal(f.page.verificationToken.value, 'ticket-2')
  assert.equal(f.page.localData.value.email, 'second@example.com')
  assert.equal(f.page.localData.value.code, '654321')
  // The request adapter rejected after cancellation; no success or step reset is allowed.
  assert.equal(f.events.length, 0)
  f.unmount()
})

test('returning to email verification clears authorization and all sensitive drafts in both editors', async () => {
  for (const create of [bindingFixture, passwordChangeFixture]) {
    const f = create()
    await verifyAccountStage(f)
    f.page.localData.value.code = '123456'
    if (Object.hasOwn(f.page.localData.value, 'newPassword')) f.page.localData.value.newPassword = 'discarded-password'
    f.page.resetForm()
    assert.equal(f.page.step.value, 'verify')
    assert.equal(f.page.verificationToken.value, '')
    assert.equal(f.page.localData.value.code, '')
    assert.equal(f.page.localData.value.newPassword || '', '')
    f.unmount()
  }
})

test('password reset submits email, code and untrimmed password atomically, clearing login only after success', async () => {
  const pending = deferred()
  const f = recoveryFixture({ user: { id: 'A', token: 'old-session' }, reply: () => pending.promise })
  fillRecovery(f, ' Person@Example.com ')
  f.page.formData.value.password = f.page.formData.value.confirmPassword = ' new-password-123 '
  const operation = f.page.handleSubmit()
  await flushTasks()
  await f.page.handleSubmit()
  assert.equal(f.sent.length, 1)
  assert.equal(f.auth.readLoginUser().token, 'old-session')
  assert.equal(f.sent[0].url, '/login/password/reset')
  assert.deepEqual(JSON.parse(f.sent[0].data), { email: 'person@example.com', code: '123456', password: ' new-password-123 ' })
  pending.resolve({ code: 1 })
  await operation
  assert.equal(f.auth.readLoginUser(), null)
  assert.deepEqual(f.redirects, ['/login'])
  assert.equal(f.page.formData.value.password, '')
  assert.equal(f.page.formData.value.code, '')
  f.unmount()
})

test('reset rejects missing or non-six-digit codes and invalid passwords before sending', async () => {
  const f = recoveryFixture()
  fillRecovery(f)
  for (const code of ['', '12345', '1234567', 'abcdef', '１２３４５６']) {
    f.page.formData.value.code = code
    await f.page.handleSubmit()
  }
  f.page.formData.value.code = '123456'
  for (const [password, confirmation] of [['        ', '        '], ['short', 'short'], ['new-password-123', 'different']]) {
    f.page.formData.value.password = password
    f.page.formData.value.confirmPassword = confirmation
    await f.page.handleSubmit()
  }
  assert.equal(f.sent.length, 0)
  f.unmount()
})

test('expired reset code preserves the form and login, then accepts a corrected code for retry', async () => {
  let valid = false
  const f = recoveryFixture({ user: { id: 'A', token: 'current-session' }, reply: () => valid ? { code: 1 } : { code: 0, msg: '验证码已失效，请重新发送' } })
  fillRecovery(f)
  await f.page.handleSubmit()
  assert.equal(f.page.submitting.value, false)
  assert.equal(f.page.formData.value.password, 'new-password-123')
  assert.equal(f.auth.readLoginUser().token, 'current-session')
  assert.equal(f.notices.filter((item: TestDouble) => item.type === 'error').length, 1)
  assert.equal(f.redirects.length, 0)
  valid = true
  f.page.formData.value.code = '654321'
  await f.page.handleSubmit()
  assert.equal(f.sent.length, 2)
  assert.deepEqual(f.redirects, ['/login'])
  f.unmount()
})

test('late password reset cannot clear a newly logged-in account', async () => {
  const response = deferred()
  const f = recoveryFixture({ user: { id: 'A', token: 'old-session' }, reply: () => response.promise })
  fillRecovery(f)
  const operation = f.page.handleSubmit()
  await flushTasks()
  f.auth.setLoginUser({ id: 'B', token: 'new-session' })
  response.resolve({ code: 1 })
  await operation
  assert.equal(f.auth.readLoginUser().token, 'new-session')
  assert.equal(f.redirects.length, 0)
  assert.equal(f.notices.length, 0)
  f.unmount()
})

test('leaving recovery or changing route cancels the pending reset without consuming another form', async () => {
  for (const leave of [(f: TestDouble) => f.unmount(), async (f: TestDouble) => { f.router.currentRoute.value = { path: '/login', fullPath: '/login', query: {} }; await vue.nextTick() }]) {
    const response = deferred()
    const f = recoveryFixture({ reply: () => response.promise })
    fillRecovery(f)
    const operation = f.page.handleSubmit()
    await flushTasks()
    await leave(f)
    response.resolve({ code: 1 })
    await operation
    assert.equal(f.redirects.length, 0)
    assert.equal(f.notices.length, 0)
    f.unmount()
  }
})

test('password mismatch is rejected before sending an email-verified update', async () => {
  let requests = 0
  const f = accountEditorFixture('updatePassword', { changePassword: async () => { requests++; return { code: 1 } } })
  await verifyAccountStage(f)
  f.editor.localData.value.code = '123456'
  f.editor.localData.value.newPassword = 'new-password-123'
  f.editor.localData.value.confirmPassword = 'different'
  f.editor.formRef.value = form(f.editor.localData, f.editor.rules, () => ['newPassword', 'confirmPassword'])
  await f.editor.handleSubmit()
  assert.equal(requests, 0)
  f.unmount()
})

test('email-verified password change fixes the clicked payload and prevents repeated submission', async () => {
  const validation = deferred()
  const response = deferred()
  const sent: TestDouble[] = []
  const f = accountEditorFixture('updatePassword', { changePassword: (data: TestDouble, config: TestDouble) => { sent.push({ data, config }); return response.promise } })
  await verifyAccountStage(f)
  f.editor.localData.value = { email: 'a@example.test', code: '123456', newPassword: ' new-secret ', confirmPassword: ' new-secret ' }
  f.editor.formRef.value.validate = () => validation.promise
  const operation = f.editor.handleSubmit()
  await f.editor.handleSubmit()
  f.editor.localData.value.code = '654321'
  f.editor.localData.value.newPassword = 'changed-new'
  f.editor.localData.value.confirmPassword = 'mismatch'
  validation.resolve(true)
  await flushTasks()
  assert.equal(sent.length, 1)
  assert.deepEqual(plain(sent[0].data), { verificationToken: 'verified-password-ticket', password: ' new-secret ' })
  response.resolve({ code: 0, msg: 'code refused' })
  await operation
  assert.equal(f.editor.submitting.value, false)
  assert.equal(f.notices.at(-1).text, 'code refused')
  assert.equal(f.auth.readLoginUser().id, 'A')
  assert.equal(f.redirects.length, 0)
  f.unmount()
})

test('password change validation cannot continue after leaving or switching account', async () => {
  for (const change of ['unmount', 'account']) {
    const validation = deferred()
    let sends = 0
    const f = accountEditorFixture('updatePassword', { changePassword: async () => { sends++; return { code: 1 } } })
    await verifyAccountStage(f)
  f.editor.localData.value = { email: 'a@example.test', code: '123456', newPassword: 'example-new', confirmPassword: 'example-new' }
    f.editor.formRef.value.validate = () => validation.promise
    const operation = f.editor.handleSubmit()
    if (change === 'unmount') f.unmount()
    else f.auth.setLoginUser({ id: 'B', token: 'example-b' })
    validation.resolve(true)
    await operation
    assert.equal(sends, 0)
    assert.equal(f.notices.length, 0)
    assert.equal(f.redirects.length, 0)
    f.unmount()
  }
})

test('late password change results cannot clear a new account or closed dialog', async () => {
  for (const change of ['unmount', 'account', 'hide', 'email', 'route']) {
    const response = deferred()
    let config: TestDouble
    const f = accountEditorFixture('updatePassword', { changePassword: (data: TestDouble, options: TestDouble) => { config = options; return response.promise } })
    await verifyAccountStage(f)
  f.editor.localData.value = { email: 'a@example.test', code: '123456', newPassword: 'example-new', confirmPassword: 'example-new' }
    const operation = f.editor.handleSubmit()
    await flushTasks()
    if (change === 'unmount') f.unmount()
    else if (change === 'account') f.auth.setLoginUser({ id: 'B', token: 'example-b' })
    else if (change === 'email') f.auth.currentUser.value = { email: 'changed@example.test', email_verified: true }
    else if (change === 'route') f.router.currentRoute.value = { path: '/about', fullPath: '/about' }
    else { f.props.visible = false; f.props.visible = true }
    assert.equal(config.signal.aborted, true)
    response.resolve({ code: 1 })
    await operation
    assert.equal(f.auth.readLoginUser().id, change === 'account' ? 'B' : 'A')
    assert.equal(f.editor.localData.value.newPassword, '')
    assert.equal(f.editor.localData.value.code, '')
    assert.equal(f.events.length, 0)
    assert.equal(f.notices.length, 0)
    assert.equal(f.redirects.length, 0)
    f.unmount()
  }
})

test('a valid email-verified password change clears its session once and returns to login', async () => {
  const f = accountEditorFixture('updatePassword', { changePassword: async () => ({ code: 1 }) })
  await verifyAccountStage(f)
  f.editor.localData.value = { email: 'a@example.test', code: '123456', newPassword: 'example-new', confirmPassword: 'example-new' }
  await f.editor.handleSubmit()
  assert.equal(f.auth.readLoginUser(), null)
  assert.deepEqual(f.redirects, ['/login'])
  assert.equal(f.events.at(-1).event, 'update:visible')
  assert.equal(f.events.at(-1).data, false)
  assert.equal(f.notices.at(-1).text, '密码已更新，请重新登录')
  assert.equal(f.editor.localData.value.newPassword, '')
  assert.equal(f.editor.localData.value.code, '')
  f.unmount()
})

test('changing the login email has no password field and clears its code when closed', async () => {
  const f = bindingFixture()
  await verifyAccountStage(f)
  assert.equal(Object.hasOwn(f.page.localData.value, 'password'), false)
  f.page.localData.value.email = 'new@example.com'
  await f.page.sendCode()
  assert.equal(f.sent.length, 1)
  assert.deepEqual(JSON.parse(f.sent[0].data), { email: 'new@example.com', verificationToken: 'verified-email-ticket' })
  f.page.localData.value.code = '123456'
  f.props.visible = false
  assert.equal(f.page.localData.value.code, '')
  const source = fs.readFileSync(path.join(root, 'src/views/my/components/verifyEmail.vue'), 'utf8')
  assert.doesNotMatch(source, /current-password|prop="password"/)
  f.unmount()
})
