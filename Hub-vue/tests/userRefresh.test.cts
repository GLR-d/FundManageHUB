// VM 边界模拟请求与时钟，执行真实 user/auth/API 脚本。
type TestDouble = any
const test: typeof import('node:test') = require('node:test')
const assert = require('node:assert/strict')
const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')
const vm: typeof import('node:vm') = require('node:vm')
const { transformSync } = require('esbuild')
const vue = require('vue')
const root = path.resolve(__dirname, '..')
const deferred = () => {
  let resolve!: (value: TestDouble) => void
  let reject!: (value: TestDouble) => void
  const promise = new Promise<TestDouble>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function profileFixture() {
  const storage = new Map<string, string>()
  const calls: TestDouble[] = []
  const notices: string[] = []
  let now = 1000
  let reply: () => Promise<TestDouble> = async () => ({ code: 1, data: { id: 'A', name: 'latest' } })
  const request = { get: (url: string, config: TestDouble = {}) => {
    calls.push({ url, config })
    return reply().catch(cause => {
      if (!config.silentError && cause.code !== 'ERR_CANCELED') notices.push('transport error')
      throw cause
    })
  } }
  const mocks: Record<string, TestDouble> = {
    vue,
    '@/utils/request': { __esModule: true, default: request },
    '@/utils/feedback': { feedback: { error: (message: string) => notices.push(message) }, getRequestErrorMessage: () => 'network error' }
  }
  const cache = new Map<string, TestDouble>()
  function load(file: string): TestDouble {
    const filename = path.resolve(root, file)
    if (cache.has(filename)) return cache.get(filename)
    const code = transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22', sourcefile: filename }).code
    const module = { exports: {} }
    const context = vm.createContext({
      module, exports: module.exports, console,
      Date: { now: () => now },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
      require: (name: string) => {
        if (Object.hasOwn(mocks, name)) return mocks[name]
        if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts')
        if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), name)) + '.ts')
        throw new Error('Unexpected import: ' + name)
      }
    })
    vm.runInContext(code, context, { filename })
    cache.set(filename, module.exports)
    return module.exports
  }
  const auth = load('src/stores/auth.ts')
  const user = load('src/stores/user.ts')
  const api = load('src/api/my.ts')
  const login = (id = 'A') => auth.setLoginUser({ id, token: 'token-' + id })
  return { auth, user, api, calls, notices, login, reply: (next: () => Promise<TestDouble>) => { reply = next }, now: (time: number) => { now = time } }
}

test('getUser forwards its request config and profile loads bind the captured account', async () => {
  const f = profileFixture()
  f.login()
  const config = { silentError: true, expectedSession: f.auth.captureSession() }
  await f.api.getUser(config)
  assert.equal(f.calls[0].url, '/user')
  assert.equal(f.calls[0].config, config)
  await f.user.loadCurrentUser({ silent: true })
  assert.equal(f.calls[1].config.silentError, true)
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].config.expectedSession)), { version: 1, token: 'token-A' })
})

test('silent refresh suppresses business and network failures without caching invalid results', async () => {
  const f = profileFixture()
  f.login()
  for (const invalid of [{ code: 0, msg: 'business failure' }, { code: 1, data: [] }, { code: 1, data: {} }]) {
    f.reply(async () => invalid)
    assert.equal(await f.user.loadCurrentUser({ silent: true }), null)
  }
  f.reply(async () => { throw { request: {}, code: 'NETWORK' } })
  assert.equal(await f.user.loadCurrentUser({ silent: true }), null)
  assert.equal(f.calls.length, 4)
  assert.deepEqual(f.notices, [])
  f.reply(async () => ({ code: 1, data: { id: 'A', name: 'recovered' } }))
  assert.equal((await f.user.loadCurrentUser({ silent: true })).name, 'recovered')
  assert.equal(f.calls.length, 5)
})

test('default manual loading preserves business notices and request-layer network notices', async () => {
  const f = profileFixture()
  f.login()
  f.reply(async () => ({ code: 0, msg: 'business failure' }))
  assert.equal(await f.user.loadCurrentUser(), null)
  assert.deepEqual(f.notices, ['business failure'])
  assert.equal(f.calls[0].config.silentError, false)
  f.reply(async () => { throw new Error('offline') })
  assert.equal(await f.user.loadCurrentUser(), null)
  assert.deepEqual(f.notices, ['business failure', 'transport error'])
})

test('unchanged refresh keeps the profile reference and revision but renews cache and returns fresh data', async () => {
  const f = profileFixture()
  f.login()
  const original = { id: 'A', name: 'same', email: 'a@example.test', email_verified: true }
  f.auth.currentUser.value = original
  const reference = f.auth.currentUser.value
  const revision = f.auth.userRevision.value
  let fresh = { ...original }
  f.reply(async () => ({ code: 1, data: fresh }))
  assert.equal(await f.user.loadCurrentUser(), fresh)
  f.now(31000)
  fresh = { ...original }
  assert.equal(await f.user.loadCurrentUser({ force: true, silent: true }), fresh)
  assert.equal(f.auth.currentUser.value, reference)
  assert.equal(f.auth.userRevision.value, revision)
  f.now(60000)
  assert.equal(await f.user.loadCurrentUser({ silent: true }), reference)
  assert.equal(f.calls.length, 2)
  f.now(61000)
  await f.user.loadCurrentUser({ silent: true })
  assert.equal(f.calls.length, 3)
})

test('changed profile fields replace the value once and update the shared cache', async () => {
  const f = profileFixture()
  f.login()
  f.auth.currentUser.value = { id: 'A', name: 'same', email_verified: false }
  const reference = f.auth.currentUser.value
  const revision = f.auth.userRevision.value
  const fresh = { id: 'A', name: 'same', email_verified: true }
  f.reply(async () => ({ code: 1, data: fresh }))
  assert.equal(await f.user.loadCurrentUser({ silent: true }), fresh)
  assert.notEqual(f.auth.currentUser.value, reference)
  assert.equal(f.auth.currentUser.value.email_verified, true)
  assert.equal(f.auth.userRevision.value, revision + 1)
  assert.equal((await f.user.loadCurrentUser()).email_verified, true)
  assert.equal(f.calls.length, 1)
})

test('background and manual reads share one pending request and manual joins retain failure feedback', async () => {
  for (const networkFailure of [false, true]) {
    const f = profileFixture()
    f.login()
    const pending = deferred()
    f.reply(() => pending.promise)
    const background = f.user.loadCurrentUser({ force: true, silent: true })
    const manual = f.user.loadCurrentUser({ force: true })
    assert.equal(background, manual)
    assert.equal(f.calls.length, 1)
    if (networkFailure) pending.reject({ request: {}, code: 'NETWORK' })
    else pending.resolve({ code: 0, msg: 'business failure' })
    assert.equal(await manual, null)
    assert.deepEqual(f.notices, [networkFailure ? 'network error' : 'business failure'])
  }
})

test('successful stale reads never undo local edits and preserve recent local cache', async () => {
  const f = profileFixture()
  f.login()
  const pending = deferred()
  f.reply(() => pending.promise)
  const background = f.user.loadCurrentUser({ silent: true })
  f.auth.currentUser.value = { id: 'A', name: 'edited locally' }
  const local = f.auth.currentUser.value
  pending.resolve({ code: 1, data: { id: 'A', name: 'old remote' } })
  assert.equal(await background, null)
  assert.equal(f.auth.currentUser.value, local)
  assert.equal(await f.user.loadCurrentUser(), local)
  assert.equal(f.calls.length, 1)
})

test('account changes isolate pending reads and an old completion cannot unlock a newer request', async () => {
  const f = profileFixture()
  f.login()
  const previous = deferred()
  f.reply(() => previous.promise)
  const oldRead = f.user.loadCurrentUser({ silent: true })
  f.login('B')
  const next = deferred()
  f.reply(() => next.promise)
  const newRead = f.user.loadCurrentUser({ silent: true })
  previous.resolve({ code: 1, data: { id: 'A', name: 'old account' } })
  assert.equal(await oldRead, null)
  assert.equal(f.auth.currentUser.value.id, undefined)
  assert.equal(f.user.loadCurrentUser({ force: true, silent: true }), newRead)
  next.resolve({ code: 1, data: { id: 'B', name: 'current account' } })
  assert.equal((await newRead).id, 'B')
  assert.equal(f.auth.currentUser.value.id, 'B')
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].config.expectedSession.token, 'token-B')
})

test('unsigned sessions never request profiles and shared cancellations remain silent', async () => {
  const f = profileFixture()
  assert.equal(await f.user.loadCurrentUser({ silent: true }), null)
  assert.equal(f.calls.length, 0)
  f.login()
  const pending = deferred()
  f.reply(() => pending.promise)
  const operation = f.user.loadCurrentUser({ silent: true })
  f.user.loadCurrentUser()
  pending.reject({ code: 'ERR_CANCELED', __CANCEL__: true })
  assert.equal(await operation, null)
  assert.deepEqual(f.notices, [])
})


test('shared background failures never add stale edit, old account or duplicate login-expiry notices', async () => {
  for (const change of ['revision', 'session', 'expired']) {
    const f = profileFixture()
    f.login()
    const pending = deferred()
    f.reply(() => pending.promise)
    const operation = f.user.loadCurrentUser({ silent: true })
    f.user.loadCurrentUser({ force: true })
    if (change === 'revision') f.auth.currentUser.value = { id: 'A', name: 'new edit' }
    if (change === 'session') f.login('B')
    pending.reject(change === 'expired' ? { response: { status: 401 } } : { request: {}, code: 'NETWORK' })
    assert.equal(await operation, null)
    assert.deepEqual(f.notices, [])
  }
})
