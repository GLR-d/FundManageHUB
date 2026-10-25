import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, fs, path, vue, axios, root, plain, flushTasks, deferred, fixture, form } = require('./helpers/runtime.cts')

test('network failures reject the original error and display the network message', async () => {
  const f = fixture()
  const request = f.load('src/utils/request.ts').request
  const failure = Object.assign(new Error('Network Error'), { request: {} })
  request.defaults.adapter = async () => { throw failure }
  await assert.rejects(request.get('/offline'), (error: TestDouble) => error === failure)
  assert.match(f.notices[0].text, /网络连接失败/)
})

test('401 clears the session, redirects and rejects; 500 retains the session', async () => {
  for (const status of [401, 500]) {
    const f = fixture()
    f.storage.set('loginUser', JSON.stringify({ id: 1, token: 'example-token' }))
    const request = f.load('src/utils/request.ts').request
    const failure: TestDouble = Object.assign(new Error('http failure'), { response: { status } })
    request.defaults.adapter = async (config: TestDouble) => { failure.config = config; throw failure }
    await assert.rejects(request.get('/failure'), (error: TestDouble) => error === failure)
    assert.equal(f.storage.has('loginUser'), status === 500)
    assert.equal(f.redirects.length, status === 401 ? 1 : 0)
  }
})

test('logout clears credentials and shared profile; damaged credentials do not throw', () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 1, token: 'example-token' })
  auth.currentUser.value = { name: 'person' }
  auth.clearSession()
  assert.equal(auth.readLoginUser(), null)
  assert.deepEqual(plain(auth.currentUser.value), {})
  f.storage.set('loginUser', '{damaged')
  assert.equal(auth.readLoginUser(), null)
  assert.equal(f.storage.has('loginUser'), false)
})

test('logout revokes the captured session before clearing local credentials and prevents duplicate requests', async () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  auth.currentUser.value = { name: 'person' }
  const request = f.load('src/utils/request.ts').request
  const action = f.load('src/services/logout.ts')
  const response = deferred()
  const sent: TestDouble[] = []
  request.defaults.adapter = (config: TestDouble) => {
    sent.push(config)
    return response.promise.then((data: TestDouble) => ({ status: 200, config, data }))
  }
  const snapshot = auth.captureSession()
  const first = action.logout()
  await flushTasks()
  await action.logout()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, '/login/logout')
  assert.equal(sent[0].method, 'post')
  assert.equal(sent[0].headers.token, 'example-a')
  assert.deepEqual(plain(sent[0].expectedSession), plain(snapshot))
  assert.equal(action.loggingOut.value, true)
  assert.equal(auth.readLoginUser().token, 'example-a')
  assert.equal(f.redirects.length, 0)
  response.resolve({ code: 1, msg: null, data: null })
  await first
  assert.equal(auth.readLoginUser(), null)
  assert.deepEqual(plain(auth.currentUser.value), {})
  assert.deepEqual(f.redirects, ['/login'])
  assert.equal(action.loggingOut.value, false)
})

for (const failure of ['business', 'network', 'server']) {
  test(`logout ${failure} failure preserves the current session and allows retry`, async () => {
    const f = fixture()
    const auth = f.load('src/stores/auth.ts')
    auth.setLoginUser({ id: 'A', token: 'example-a' })
    const request = f.load('src/utils/request.ts').request
    const action = f.load('src/services/logout.ts')
    let fail = true
    request.defaults.adapter = async (config: TestDouble) => {
      if (!fail) return { status: 200, config, data: { code: 1, data: null } }
      if (failure === 'business') return { status: 200, config, data: { code: 0, msg: 'logout refused', data: null } }
      const response = failure === 'server' ? { status: 503, config, data: { code: 0 } } : undefined
      throw new axios.AxiosError('unavailable', failure === 'network' ? 'ERR_NETWORK' : 'ERR_BAD_RESPONSE', config, {}, response)
    }
    await action.logout()
    assert.equal(auth.readLoginUser().token, 'example-a')
    assert.equal(action.loggingOut.value, false)
    assert.equal(f.redirects.length, 0)
    assert.equal(f.notices.filter((item: TestDouble) => item.type === 'error').length, 1)
    fail = false
    await action.logout()
    assert.equal(auth.readLoginUser(), null)
    assert.deepEqual(f.redirects, ['/login'])
  })
}

test('logout uses existing session-expired handling when its token is already invalid', async () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const request = f.load('src/utils/request.ts').request
  const action = f.load('src/services/logout.ts')
  request.defaults.adapter = async (config: TestDouble) => {
    throw new axios.AxiosError('expired', 'ERR_BAD_REQUEST', config, {}, { status: 401, config, data: { code: 0 } })
  }
  await action.logout()
  assert.equal(auth.readLoginUser(), null)
  assert.equal(action.loggingOut.value, false)
  assert.equal(f.redirects.length, 1)
  assert.equal(f.redirects[0].path, '/login')
  assert.equal(f.notices.filter((item: TestDouble) => item.type === 'error').length, 1)
})

test('a queued logout cannot revoke a newly selected account', async () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const request = f.load('src/utils/request.ts').request
  const action = f.load('src/services/logout.ts')
  let sent = 0
  request.defaults.adapter = async (config: TestDouble) => { sent++; return { status: 200, config, data: { code: 1 } } }
  const operation = action.logout()
  auth.setLoginUser({ id: 'B', token: 'example-b' })
  await operation
  assert.equal(sent, 0)
  assert.equal(auth.readLoginUser().token, 'example-b')
  assert.equal(f.redirects.length, 0)
  assert.equal(action.loggingOut.value, false)
})

test('late logout completion cannot clear another account or unlock its new logout request', async () => {
  const responses = [deferred(), deferred()]
  let sent = 0
  const f = fixture({ '@/api/login': { logoutapi: () => responses[sent++].promise } })
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const action = f.load('src/services/logout.ts')
  const first = action.logout()
  auth.setLoginUser({ id: 'B', token: 'example-b' })
  const second = action.logout()
  responses[0].resolve({ code: 1 })
  await first
  assert.equal(auth.readLoginUser().token, 'example-b')
  assert.equal(f.redirects.length, 0)
  assert.equal(action.loggingOut.value, true)
  responses[1].resolve({ code: 1 })
  await second
  assert.equal(auth.readLoginUser(), null)
  assert.deepEqual(f.redirects, ['/login'])
})

for (const view of ['src/layout/components/userMenu.vue', 'src/views/my/index.vue']) {
  test(`${view} exits through the backend logout flow`, async () => {
    const f = fixture()
    const auth = f.load('src/stores/auth.ts')
    auth.setLoginUser({ id: 'A', token: 'example-a' })
    const request = f.load('src/utils/request.ts').request
    const sent: TestDouble[] = []
    request.defaults.adapter = async (config: TestDouble) => {
      sent.push(config)
      return { status: 200, config, data: { code: 1, data: null } }
    }
    const page = f.load(view, ['logout', 'loggingOut'])
    await page.logout()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].url, '/login/logout')
    assert.equal(auth.readLoginUser(), null)
    assert.deepEqual(f.redirects, ['/login'])
    assert.equal(page.loggingOut.value, false)
    const source = fs.readFileSync(path.join(root, view), 'utf8')
    assert.match(source, /:disabled="loggingOut"/)
  })
}

test('protected routes require a session while public login and registration remain reachable', async () => {
  const VueRouter = require('vue-router')
  const f = fixture({ 'vue-router': { ...VueRouter, createWebHistory: () => VueRouter.createMemoryHistory() } })
  const router = f.load('src/router/index.ts').default
  router.getRoutes().forEach((route: TestDouble) => { if (route.components) route.components.default = { render: () => null } })
  await router.push('/fund')
  assert.equal(router.currentRoute.value.path, '/login')
  assert.equal(router.currentRoute.value.query.redirect, '/fund')
  await router.push('/register')
  assert.equal(router.currentRoute.value.path, '/register')
  for (const routePath of ['/forgot-password', '/reset-password?token=example', '/verify-email?token=example']) {
    await router.push(routePath)
    assert.equal(router.currentRoute.value.path, '/forgot-password')
    assert.deepEqual(plain(router.currentRoute.value.query), {})
  }
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 1, token: 'example-token' })
  await router.push('/fund')
  assert.equal(router.currentRoute.value.path, '/fund')
  auth.clearSession()
  await router.push('/chat')
  assert.equal(router.currentRoute.value.path, '/login')
})

test('login validates before requesting and locks while captcha verification is pending', async () => {
  const pending: TestDouble[] = []
  let loginRequests = 0
  const f = fixture({ '@/api/login': {
    getCaptcha: async () => ({ code: 1, data: { uuid: 'example', image: '' } }),
    verifyCaptcha: () => new Promise(resolve => pending.push(resolve)),
    loginapi: async () => { loginRequests++; return { code: 1, data: { token: 'example-token' } } }
  } })
  const login = f.load('src/views/login/index.vue', ['handleLogin', 'loginRef', 'loginForm', 'loginRules', 'captchaData', 'loading'])
  login.loginRef.value = form(login.loginForm, login.loginRules)
  await login.handleLogin()
  assert.equal(pending.length, 0)
  login.loginForm.value = { email: 'person@example.test', password: 'example-password', captcha: '1234' }
  login.captchaData.value.uuid = 'example'
  const first = login.handleLogin()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(login.loading.value, true)
  await login.handleLogin()
  assert.equal(pending.length, 1)
  pending[0]({ code: 1 })
  await first
  assert.equal(loginRequests, 1)
  assert.equal(login.loading.value, false)
  assert.equal(f.redirects[0], '/dashboard')
})

test('late 401 from the previous session cannot clear a new login', async () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const old = auth.captureSession()
  const request = f.load('src/utils/request.ts').request
  auth.clearSession()
  auth.setLoginUser({ id: 'B', token: 'example-b' })
  const error = Object.assign(new Error('401'), { config: { _session: old }, response: { status: 401 } })
  await assert.rejects(request.interceptors.response.handlers[0].rejected(error), axios.isCancel)
  assert.equal(auth.readLoginUser().id, 'B')
  assert.equal(f.redirects.length, 0)
  assert.equal(f.notices.length, 0)
})

test('changing a session aborts old requests and ignores their successful responses', async () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const request = f.load('src/utils/request.ts').request
  let finish: TestDouble
  let config: TestDouble
  request.defaults.adapter = (value: TestDouble) => { config = value; return new Promise(resolve => { finish = resolve }) }
  const operation = request.get('/user')
  const rejected = assert.rejects(operation, axios.isCancel)
  await new Promise(resolve => setImmediate(resolve))
  auth.setLoginUser({ id: 'B', token: 'example-b' })
  assert.equal(config.signal.aborted, true)
  finish({ status: 200, config, data: { code: 1, data: { id: 'A' } } })
  await rejected
  assert.equal(auth.readLoginUser().id, 'B')
  assert.equal(f.notices.length, 0)
})

test('an old page cannot silently send an operation using another tab new credentials', async () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  auth.currentUser.value = { id: 'A' }
  const request = f.load('src/utils/request.ts').request
  let sent = 0
  request.defaults.adapter = async (config: TestDouble) => { sent++; return { status: 200, config, data: {} } }
  f.storage.set('loginUser', JSON.stringify({ id: 'B', token: 'example-b' }))
  await assert.rejects(request.post('/fund', { amount: 1 }), axios.isCancel)
  assert.equal(sent, 0)
  assert.equal(auth.loginUser.value.id, 'B')
  assert.deepEqual(plain(auth.currentUser.value), {})
})

test('page-handled errors suppress duplicate notices while 401 still expires the session', async () => {
  for (const status of [500, 401]) {
    const f = fixture()
    f.storage.set('loginUser', JSON.stringify({ id: 1, token: 'example-token' }))
    const request = f.load('src/utils/request.ts').request
    request.defaults.adapter = async (config: TestDouble) => {
      throw Object.assign(new Error('HTTP failure'), { config, response: { status, config } })
    }
    await assert.rejects(request.get('/fund', { silentError: true }))
    assert.equal(f.notices.length, status === 401 ? 1 : 0)
    assert.equal(f.storage.has('loginUser'), status !== 401)
  }
})

test('leaving login cancels verification or login and ignores a late success', async () => {
  for (const phase of ['verify', 'login']) {
    let dispose: TestDouble
    let finish: TestDouble
    let signal: TestDouble
    let loginRequests = 0
    const f = fixture({
      vue: { ...vue, onMounted: () => {}, onUnmounted: (fn: TestDouble) => { dispose = fn } },
      '@/api/login': {
        verifyCaptcha: (data: TestDouble, config: TestDouble) => { signal = config.signal; return phase === 'verify' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ code: 1 }) },
        loginapi: (data: TestDouble, config: TestDouble) => { loginRequests++; signal = config.signal; return new Promise(resolve => { finish = resolve }) }
      }
    })
    const login = f.load('src/views/login/index.vue', ['handleLogin', 'loginRef', 'loginForm', 'captchaData'])
    login.loginRef.value = { validate: async () => true }
    login.loginForm.value = { email: ' Before@Example.test ', password: 'example-password', captcha: 'test-code' }
    login.captchaData.value = { uuid: 'test-uuid', image: 'test-image' }
    const operation = login.handleLogin()
    await new Promise(resolve => setImmediate(resolve))
    dispose()
    assert.equal(signal.aborted, true)
    finish(phase === 'verify' ? { code: 1 } : { code: 1, data: { id: 'A', token: 'example-a' } })
    await operation
    assert.equal(loginRequests, phase === 'verify' ? 0 : 1)
    assert.equal(f.storage.has('loginUser'), false)
    assert.equal(f.redirects.length, 0)
    assert.equal(f.notices.length, 0)
  }
})

test('login uses the captured account and captcha and cannot refresh while submitting', async () => {
  let finish: TestDouble
  let sent: TestDouble
  let verified: TestDouble
  let refreshes = 0
  const f = fixture({ '@/api/login': {
    getCaptcha: async () => { refreshes++; return { code: 1, data: { uuid: 'new', image: 'new-image' } } },
    verifyCaptcha: (data: TestDouble) => { verified = data; return new Promise(resolve => { finish = resolve }) },
    loginapi: async (data: TestDouble) => { sent = data; return { code: 1, data: { id: 'A', token: 'example-token', email: 'before@example.test' } } }
  } })
  const login = f.load('src/views/login/index.vue', ['handleLogin', 'updateCaptcha', 'loginRef', 'loginForm', 'captchaData'])
  login.loginRef.value = { validate: async () => true }
  login.loginForm.value = { email: ' Before@Example.test ', password: 'example-password', captcha: 'first-code' }
  login.captchaData.value = { uuid: 'first-uuid', image: 'first-image' }
  const operation = login.handleLogin()
  await new Promise(resolve => setImmediate(resolve))
  await login.updateCaptcha()
  Object.assign(login.loginForm.value, { email: 'after@example.test', captcha: 'changed-code' })
  finish({ code: 1 })
  await operation
  assert.equal(refreshes, 0)
  assert.deepEqual(plain(verified), { uuid: 'first-uuid', code: 'first-code' })
  assert.equal(sent.email, 'before@example.test')
  assert.equal(sent.captcha, 'first-code')
  assert.equal(f.load('src/stores/auth.ts').loginUser.value.id, 'A')
  assert.equal(f.load('src/stores/auth.ts').loginUser.value.email, 'before@example.test')
})

test('an old login response cannot replace a newly signed-in account', async () => {
  let finish: TestDouble
  const f = fixture({ '@/api/login': {
    verifyCaptcha: async () => ({ code: 1 }),
    loginapi: () => new Promise(resolve => { finish = resolve })
  } })
  const login = f.load('src/views/login/index.vue', ['handleLogin', 'loginRef', 'loginForm', 'captchaData'])
  login.loginRef.value = { validate: async () => true }
  login.loginForm.value = { email: 'a@example.test', password: 'example-password', captcha: 'test-code' }
  login.captchaData.value.uuid = 'test-uuid'
  const operation = login.handleLogin()
  await new Promise(resolve => setImmediate(resolve))
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'B', token: 'example-b' })
  finish({ code: 1, data: { id: 'A', token: 'example-a' } })
  await operation
  assert.equal(auth.loginUser.value.id, 'B')
  assert.equal(f.redirects.length, 0)
})

test('captcha refresh cancels older requests, ignores stale results and rejects invalid data', async () => {
  let dispose: TestDouble
  const pending: TestDouble[] = []
  const f = fixture({
    vue: { ...vue, onMounted: () => {}, onUnmounted: (fn: TestDouble) => { dispose = fn } },
    '@/api/login': { getCaptcha: (config: TestDouble) => new Promise(resolve => pending.push({ config, resolve })) }
  })
  const login = f.load('src/views/login/index.vue', ['getCap', 'captchaData', 'captchaLoading'])
  const first = login.getCap()
  const second = login.getCap()
  assert.equal(pending[0].config.signal.aborted, true)
  pending[1].resolve({ code: 1, data: { uuid: 'current', image: 'current-image' } })
  await second
  pending[0].resolve({ code: 1, data: { uuid: 'stale', image: 'stale-image' } })
  await first
  assert.equal(login.captchaData.value.uuid, 'current')
  const invalid = login.getCap()
  pending[2].resolve({ code: 0, msg: '验证码失败', data: { uuid: 'unusable', image: 'bad-image' } })
  await invalid
  assert.equal(login.captchaData.value.uuid, '')
  assert.match(f.notices.at(-1).text, /验证码失败/)
  const leaving = login.getCap()
  dispose()
  assert.equal(pending[3].config.signal.aborted, true)
  pending[3].resolve({ code: 1, data: { uuid: 'late', image: 'late-image' } })
  await leaving
  assert.equal(login.captchaData.value.uuid, '')
})

test('login, captcha and registration API helpers forward cancellation to the request layer', async () => {
  const calls: TestDouble[] = []
  const f = fixture({ '@/utils/request': { default: {
    get: (url: TestDouble, config: TestDouble) => { calls.push({ url, config }); return Promise.resolve({}) },
    post: (url: TestDouble, data: TestDouble, config: TestDouble) => { calls.push({ url, config }); return Promise.resolve({}) }
  } } })
  const signal = new AbortController().signal
  const login = f.load('src/api/login.ts')
  await login.getCaptcha({ signal })
  await login.verifyCaptcha({}, { signal })
  await login.loginapi({}, { signal })
  await f.load('src/api/register.ts').addUser({}, { signal })
  await f.load('src/api/register.ts').requestRegistrationCode({}, { signal })
  assert.equal(calls.length, 5)
  for (const call of calls) assert.equal(call.config.signal, signal)
})

test('submission ownership survives cancellation and old completion cannot unlock a newer operation', () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const guard = f.load('src/services/submission.ts').createSubmissionGuard()
  const first = guard.begin()
  assert.equal(guard.begin(), null)
  guard.cancel()
  assert.equal(first.config.signal.aborted, true)
  const second = guard.begin()
  guard.finish(first)
  assert.equal(guard.busy.value, true)
  assert.equal(guard.isActive(second), true)
  auth.setLoginUser({ id: 'B', token: 'example-b' })
  assert.equal(second.config.signal.aborted, true)
  assert.equal(guard.isActive(second), false)
  assert.equal(guard.begin(), null)
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  assert.equal(guard.begin(), null)
  guard.dispose()
  assert.equal(guard.begin(), null)
})

test('a queued mutation cannot acquire new credentials before its request interceptor runs', async () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const request = f.load('src/utils/request.ts').request
  let sends = 0
  request.defaults.adapter = async (config: TestDouble) => { sends++; return { status: 200, config, data: { code: 1 } } }
  const expectedSession = auth.captureSession()
  const operation = request.put('/user', { name: 'A draft' }, { expectedSession })
  auth.setLoginUser({ id: 'B', token: 'example-b' })
  await assert.rejects(operation, axios.isCancel)
  assert.equal(sends, 0)
  assert.equal(f.notices.length, 0)
  await request.put('/user', { name: 'B draft' }, { expectedSession: auth.captureSession() })
  assert.equal(sends, 1)
})

test('bill and account mutation APIs preserve payloads and forward cancellation and expected session', async () => {
  const calls: TestDouble[] = []
  const methods = Object.fromEntries(['post', 'put', 'delete'].map(method => [method, (...args: TestDouble[]) => { calls.push({ method, args }); return Promise.resolve({}) }]))
  const f = fixture({ '@/utils/request': { default: methods } })
  const fund = f.load('src/api/fund.ts')
  const user = f.load('src/api/my.ts')
  const config = { signal: new AbortController().signal, expectedSession: { version: 7, token: 'example-a' } }
  const bill = { amount: 1, type: '0' }
  await fund.addFundapi(bill, config)
  await fund.updateFundapi(bill, config)
  await fund.deleteFundapi('1,2', config)
  await user.requestPasswordChange({ email: 'person@example.test' }, config)
  await user.changePassword({ email: 'person@example.test', code: '123456', password: 'new-password' }, config)
  await user.updateUser({ name: 'person' }, config)
  assert.deepEqual(calls.map(call => [call.method, call.args[0]]), [['post', '/fund'], ['put', '/fund'], ['delete', '/fund?ids=1,2'], ['post', '/user/password/request'], ['put', '/user/password'], ['put', '/user']])
  calls.forEach(call => assert.equal(call.args.at(-1), config))
  assert.equal(calls[0].args[1], bill)
  assert.equal(calls[1].args[1], bill)
})

test('root recovery distinguishes an initial or public failure from a preserved authenticated page', () => {
  const route = vue.reactive({ matched: [], meta: {} })
  const recovery = { failure: vue.ref({ path: '/fund' }) }
  const f = fixture({ 'vue-router': { useRoute: () => route }, '@/router': { default: {}, routeRecovery: recovery } })
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const app = f.load('src/app.vue', ['showPageRecovery'])
  assert.equal(app.showPageRecovery.value, true)
  route.matched = [{}]
  route.meta.requiresAuth = true
  assert.equal(app.showPageRecovery.value, false)
  route.meta.requiresAuth = false
  assert.equal(app.showPageRecovery.value, true)
  recovery.failure.value = null
  assert.equal(app.showPageRecovery.value, false)
})
