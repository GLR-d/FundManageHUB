// Shared account scenario fixtures.
import type { TestDouble } from './testTypes.cts'
const { assert, path, vue, plain, fixture, form } = require('./runtime.cts')

function accountEditorFixture(view: string, apis: TestDouble) {
  const context = fixture({ '@/api/my': { verifyPasswordChange: async () => ({ code: 1, data: { verificationToken: 'verified-password-ticket', expiresIn: 300 } }), ...apis }, '@/services/imageUpload': { uploadImage: () => {}, abortImageUpload: () => {} } })
  const auth = context.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const props = vue.reactive({ visible: true, editField: 'profile', userData: { id: 'A', name: 'original', phone: '13800000000', email: 'a@example.test', avatar: 'original.jpg' } })
  const events: TestDouble[] = []
  if (view === 'updatePassword') auth.currentUser.value = { ...props.userData, email_verified: true }
  const editor = context.load('src/views/my/components/' + view + '.vue', [
    'handleSubmit', 'localData', 'formRef', 'submitting', ...(view === 'updatePassword' ? ['sendCode', 'sending', 'remaining', 'rules', 'step', 'verificationToken', 'resetForm'] : [])
  ], props, (event: TestDouble, data: TestDouble) => events.push({ event, data: plain(data) }))
  editor.formRef.value = { validate: async () => true, clearValidate: () => {} }
  return { ...context, auth, props, editor, events }
}

function emailClock() {
  let now = Date.now()
  let nextTimer = 0
  const timers = new Map<number, () => void>()
  return {
    advance: (milliseconds: number) => { now += milliseconds; [...timers.values()].forEach(tick => tick()) },
    timers,
    environment: {
      Date: class extends Date { static now() { return now } },
      setInterval: (tick: () => void) => { timers.set(++nextTimer, tick); return nextTimer },
      clearInterval: (timer: number) => timers.delete(timer)
    }
  }
}

function recoveryFixture(options: TestDouble = {}) {
  const clock = emailClock()
  const f = fixture(options.mocks, undefined, clock.environment)
  f.router.currentRoute.value = { path: '/forgot-password', fullPath: '/forgot-password', query: {} }
  const auth = f.load('src/stores/auth.ts')
  if (options.user) auth.setLoginUser(options.user)
  const request = f.load('src/utils/request.ts').request
  const sent: TestDouble[] = []
  request.defaults.adapter = async (config: TestDouble) => {
    sent.push(config)
    return { status: 200, config, data: await (options.reply?.(config) ?? { code: 1, data: null, msg: null }) }
  }
  const page = f.load('src/views/recovery/index.vue', ['handleSubmit', 'sendCode', 'formData', 'formRef', 'rules', 'remaining', 'submitting', 'sending'])
  page.formRef.value = form(page.formData, page.rules)
  return { ...f, auth, request, sent, page, clock }
}

function bindingFixture(options: TestDouble = {}) {
  const clock = emailClock()
  const f = fixture({}, undefined, clock.environment)
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'current-session' })
  auth.currentUser.value = { email: 'old@example.com', email_verified: true }
  const request = f.load('src/utils/request.ts').request
  const sent: TestDouble[] = []
  request.defaults.adapter = async (config: TestDouble) => {
    sent.push(config)
    return { status: 200, config, data: await (config.url === '/user/email/current/verify' ? options.currentVerifyReply?.(config) ?? { code: 1, data: { verificationToken: 'verified-email-ticket', expiresIn: 300 } } : options.reply?.(config) ?? { code: 1, data: null, msg: null }) }
  }
  const props = vue.reactive({ visible: true, email: 'old@example.com' })
  const events: TestDouble[] = []
  const page = f.load('src/views/my/components/verifyEmail.vue', ['handleSubmit', 'sendCode', 'formRef', 'localData', 'rules', 'remaining', 'submitting', 'sending', 'step', 'verificationToken', 'resetForm'], props, (event: TestDouble, data: TestDouble) => events.push({ event, data: plain(data) }))
  page.formRef.value = form(page.localData, page.rules)
  return { ...f, auth, request, sent, props, events, page, clock }
}

function passwordChangeFixture(options: TestDouble = {}) {
  const clock = emailClock()
  const f = fixture({}, undefined, clock.environment)
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'current-session' })
  auth.currentUser.value = options.profile ?? { id: 'A', email: 'current@example.com', email_verified: true }
  const request = f.load('src/utils/request.ts').request
  const sent: TestDouble[] = []
  request.defaults.adapter = async (config: TestDouble) => {
    sent.push(config)
    return { status: 200, config, data: await (config.url === '/user/password/verify' ? options.verifyReply?.(config) ?? { code: 1, data: { verificationToken: 'verified-password-ticket', expiresIn: 300 } } : options.reply?.(config) ?? { code: 1, data: null, msg: null }) }
  }
  const props = vue.reactive({ visible: true })
  const page = f.load('src/views/my/components/updatePassword.vue', ['handleSubmit', 'sendCode', 'formRef', 'localData', 'rules', 'remaining', 'submitting', 'sending', 'step', 'verificationToken', 'resetForm'], props)
  page.formRef.value = form(page.localData, page.rules, () => page.step.value === 'verify' ? ['email', 'code'] : ['newPassword', 'confirmPassword'])
  return { ...f, auth, request, sent, props, page, clock }
}

// Stage setup remains a real server-verification request; tests below inspect the final operation separately.
const verifyAccountStage = async (f: TestDouble) => {
  const page = f.page || f.editor
  const count = f.sent?.length
  page.localData.value.code = '123456'
  await page.handleSubmit()
  assert.notEqual(page.step.value, 'verify')
  if (count !== undefined) f.sent.splice(count)
}

const fillRecovery = (f: TestDouble, email = 'person@example.com', code = '123456') => {
  f.page.formData.value.email = email
  f.page.formData.value.code = code
  f.page.formData.value.password = f.page.formData.value.confirmPassword = 'new-password-123'
}

function registrationFixture(options: TestDouble = {}) {
  const clock = emailClock()
  const f = fixture({}, undefined, clock.environment)
  const auth = f.load('src/stores/auth.ts')
  const request = f.load('src/utils/request.ts').request
  const sent: TestDouble[] = []
  request.defaults.adapter = async (config: TestDouble) => {
    sent.push(config)
    return { status: 200, config, data: await (options.reply?.(config) ?? { code: 1, data: null, msg: null }) }
  }
  const page = f.load('src/views/register/index.vue', ['handleRegister', 'sendCode', 'registerForm', 'registerRef', 'registerRules', 'remaining', 'registerLoading', 'sending'])
  page.registerRef.value = form(page.registerForm, page.registerRules)
  return { ...f, auth, request, sent, page, clock }
}

const fillRegistration = (f: TestDouble, name = '') => {
  f.page.registerForm.value.email = ' Person@Example.com '
  f.page.registerForm.value.code = '123456'
  f.page.registerForm.value.password = f.page.registerForm.value.confirmPassword = ' example-password '
  f.page.registerForm.value.name = name
}

module.exports = { accountEditorFixture, emailClock, recoveryFixture, bindingFixture, passwordChangeFixture, verifyAccountStage, fillRecovery, registrationFixture, fillRegistration }
