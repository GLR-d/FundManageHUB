type SyncTestDouble = any
const syncTest: typeof import('node:test') = require('node:test')
const syncAssert: typeof import('node:assert/strict') = require('node:assert/strict')
const syncFs: typeof import('node:fs') = require('node:fs')
const syncPath: typeof import('node:path') = require('node:path')
const syncVm: typeof import('node:vm') = require('node:vm')
const syncTransform: typeof import('esbuild').transformSync = require('esbuild').transformSync
const syncCode = syncTransform(syncFs.readFileSync(syncPath.resolve(__dirname, '../src/services/profileAutoSync.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code
const syncFlush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function syncEvents() {
  const events = new Map<string, Set<() => void>>()
  return {
    addEventListener: (name: string, fn: () => void) => { if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(fn) },
    removeEventListener: (name: string, fn: () => void) => events.get(name)?.delete(fn),
    emit: (name: string) => [...(events.get(name) ?? [])].forEach(fn => fn()),
    count: () => [...events.values()].reduce((sum, set) => sum + set.size, 0)
  }
}
function syncFixture() {
  let now = 10000
  let sequence = 0
  let version = 1
  let token: string | null = 'account-a'
  let paused = false
  let loader: () => Promise<unknown> = async () => ({ name: '最新资料' })
  const timers = new Map<number, { time: number; fn: () => void }>()
  const sessionListeners = new Set<() => void>()
  const calls: { time: number; options: SyncTestDouble; token: string | null }[] = []
  const page = { ...syncEvents(), visibilityState: 'visible' }
  const target: SyncTestDouble = {
    ...syncEvents(), document: page, navigator: { onLine: true },
    setTimeout: (fn: () => void, delay: number) => { timers.set(++sequence, { time: now + delay, fn }); return sequence },
    clearTimeout: (id: number) => timers.delete(id)
  }
  const module = { exports: {} }
  syncVm.runInNewContext(syncCode, {
    module, exports: module.exports, Date: { now: () => now },
    require: (request: string) => {
      if (request === '@/stores/auth') return {
        captureSession: () => ({ version, token }),
        isCurrentSession: (snapshot: SyncTestDouble) => snapshot.version === version && snapshot.token === token,
        onSessionChange: (fn: () => void) => { sessionListeners.add(fn); return () => sessionListeners.delete(fn) }
      }
      if (request === '@/stores/user') return { loadCurrentUser: (options: SyncTestDouble) => { calls.push({ time: now, options, token }); return loader() } }
      throw new Error('Unexpected import: ' + request)
    }
  })
  const tools = module.exports as { startProfileAutoSync: (options: SyncTestDouble) => () => void }
  return {
    calls, target, page, timers, sessionListeners,
    start: () => tools.startProfileAutoSync({ target, page, isPaused: () => paused }),
    pause: (value: boolean) => { paused = value },
    loadWith: (fn: () => Promise<unknown>) => { loader = fn },
    session: (value: string | null, notify = true) => { token = value; version++; if (notify) [...sessionListeners].forEach(fn => fn()) },
    advance: async (duration: number) => {
      const end = now + duration
      while (true) {
        const next = [...timers].sort(([, a], [, b]) => a.time - b.time).find(([, value]) => value.time <= end)
        if (!next) break
        now = next[1].time
        timers.delete(next[0])
        next[1].fn()
        await syncFlush()
      }
      now = end
      await syncFlush()
    }
  }
}

syncTest('profile auto sync works without media queries on mobile, starts silently and repeats after 30 seconds', async () => {
  const f = syncFixture()
  const stop = f.start()
  syncAssert.equal(f.calls.length, 1)
  syncAssert.equal(f.calls[0].options.force, true)
  syncAssert.equal(f.calls[0].options.silent, true)
  await syncFlush()
  await f.advance(29999)
  syncAssert.equal(f.calls.length, 1)
  await f.advance(1)
  syncAssert.equal(f.calls.length, 2)
  stop()
})

syncTest('hidden or offline pages do not request until the browser resumes', async () => {
  for (const condition of ['hidden', 'offline']) {
    const f = syncFixture()
    if (condition === 'hidden') f.page.visibilityState = 'hidden'
    else f.target.navigator.onLine = false
    const stop = f.start()
    await f.advance(60000)
    syncAssert.equal(f.calls.length, 0)
    syncAssert.equal(f.timers.size, 0)
    f.page.visibilityState = 'visible'
    f.target.navigator.onLine = true
    f.page.emit('visibilitychange')
    f.target.emit('online')
    f.target.emit('focus')
    await f.advance(120)
    syncAssert.equal(f.calls.length, 1)
    stop()
  }
})

syncTest('focus and visibility bursts share one refresh and a short throttle', async () => {
  const f = syncFixture()
  const stop = f.start()
  await syncFlush()
  await f.advance(5000)
  f.target.emit('focus')
  f.page.emit('visibilitychange')
  f.target.emit('online')
  syncAssert.equal(f.timers.size, 1)
  await f.advance(119)
  syncAssert.equal(f.calls.length, 1)
  await f.advance(1)
  syncAssert.equal(f.calls.length, 2)
  f.target.emit('focus')
  f.page.emit('visibilitychange')
  await f.advance(999)
  syncAssert.equal(f.calls.length, 2)
  await f.advance(1)
  syncAssert.equal(f.calls.length, 3)
  stop()
})

syncTest('profile auto sync waits for a pending request before starting its next interval', async () => {
  const f = syncFixture()
  let resolve!: () => void
  f.loadWith(() => new Promise<void>(done => { resolve = done }))
  const stop = f.start()
  f.target.emit('focus')
  f.page.emit('visibilitychange')
  await f.advance(90000)
  syncAssert.equal(f.calls.length, 1)
  syncAssert.equal(f.timers.size, 0)
  resolve()
  await syncFlush()
  await f.advance(29999)
  syncAssert.equal(f.calls.length, 1)
  await f.advance(1)
  syncAssert.equal(f.calls.length, 2)
  stop()
  resolve()
  await syncFlush()
  syncAssert.equal(f.timers.size, 0)
})

syncTest('editing pauses requests while polling remains ready after the editor closes', async () => {
  const f = syncFixture()
  f.pause(true)
  const stop = f.start()
  await f.advance(90000)
  syncAssert.equal(f.calls.length, 0)
  f.target.emit('focus')
  await f.advance(30000)
  syncAssert.equal(f.calls.length, 0)
  f.pause(false)
  await f.advance(30000)
  syncAssert.equal(f.calls.length, 1)
  stop()
})

syncTest('going hidden or offline clears polling and becoming visible or online resumes it', async () => {
  const f = syncFixture()
  const stop = f.start()
  await syncFlush()
  f.page.visibilityState = 'hidden'
  f.page.emit('visibilitychange')
  await f.advance(60000)
  syncAssert.equal(f.calls.length, 1)
  f.page.visibilityState = 'visible'
  f.page.emit('visibilitychange')
  await f.advance(120)
  syncAssert.equal(f.calls.length, 2)
  f.target.navigator.onLine = false
  f.target.emit('offline')
  await f.advance(60000)
  syncAssert.equal(f.calls.length, 2)
  f.target.navigator.onLine = true
  f.target.emit('online')
  await f.advance(120)
  syncAssert.equal(f.calls.length, 3)
  stop()
})

syncTest('stop and account changes clear listeners, timers and pending completions', async () => {
  for (const action of ['stop', 'account', 'logout']) {
    const f = syncFixture()
    let resolve!: () => void
    f.loadWith(() => new Promise<void>(done => { resolve = done }))
    const stop = f.start()
    if (action === 'stop') stop()
    else f.session(action === 'logout' ? null : 'account-b')
    syncAssert.equal(f.target.count() + f.page.count(), 0)
    syncAssert.equal(f.sessionListeners.size, 0)
    syncAssert.equal(f.timers.size, 0)
    resolve()
    await syncFlush()
    await f.advance(90000)
    f.target.emit('focus')
    syncAssert.equal(f.calls.length, 1)
    syncAssert.equal(f.calls[0].token, 'account-a')
    syncAssert.equal(f.timers.size, 0)
    stop()
  }
})

syncTest('a missed session event is rechecked before sending and anonymous pages stay inactive', async () => {
  const f = syncFixture()
  const stop = f.start()
  await syncFlush()
  f.session('account-b', false)
  await f.advance(30000)
  syncAssert.equal(f.calls.length, 1)
  syncAssert.equal(f.target.count() + f.page.count() + f.sessionListeners.size, 0)
  stop()
  const anonymous = syncFixture()
  anonymous.session(null)
  anonymous.start()
  await anonymous.advance(60000)
  syncAssert.equal(anonymous.calls.length, 0)
  syncAssert.equal(anonymous.target.count() + anonymous.page.count(), 0)
})

syncTest('a rejected or unsuccessful background refresh can be retried at the next interval', async () => {
  const f = syncFixture()
  f.loadWith(() => Promise.reject(new Error('offline')))
  const stop = f.start()
  await syncFlush()
  f.loadWith(async () => null)
  await f.advance(30000)
  syncAssert.equal(f.calls.length, 2)
  f.loadWith(async () => ({ name: '恢复' }))
  await f.advance(30000)
  syncAssert.equal(f.calls.length, 3)
  stop()
})
