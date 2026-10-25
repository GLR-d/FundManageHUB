type LimitTestDouble = any
const limitTest: typeof import('node:test') = require('node:test')
const limitAssert: typeof import('node:assert/strict') = require('node:assert/strict')
const limitFs: typeof import('node:fs') = require('node:fs')
const limitPath: typeof import('node:path') = require('node:path')
const limitVm: typeof import('node:vm') = require('node:vm')
const limitTransform: typeof import('esbuild').transformSync = require('esbuild').transformSync
const limitVue = require('vue')
const limitRoot = limitPath.resolve(__dirname, '..')
const limitPlain = (value: LimitTestDouble) => JSON.parse(JSON.stringify(value))
const limitDeferred = () => {
  let resolve!: (value: LimitTestDouble) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<LimitTestDouble>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const limitResult = (amount: string | null) => ({ code: 1, data: { amount } })
function limitFixture() {
  let session = { version: 1, token: 'user-a' as string | null }
  let saved: string | null = null
  let getHandler = async (_config: LimitTestDouble): Promise<LimitTestDouble> => limitResult(saved)
  let putHandler = async (data: LimitTestDouble, _config: LimitTestDouble): Promise<LimitTestDouble> => { saved = data.amount; return limitResult(saved) }
  const notices: { type: string; text: string }[] = []
  const reads: LimitTestDouble[] = []
  const writes: LimitTestDouble[] = []
  const listeners = new Set<() => void>()
  const mounted: (() => void)[] = []
  const unmounted: (() => void)[] = []
  const cache = new Map<string, LimitTestDouble>()
  const mocks: Record<string, LimitTestDouble> = {
    vue: { ...limitVue, useId: () => 'test', onMounted: (fn: () => void) => mounted.push(fn), onUnmounted: (fn: () => void) => unmounted.push(fn) },
    '@/api/monthlyLimit': {
      getMonthlyLimit: (config: LimitTestDouble) => { reads.push(config); return getHandler(config) },
      updateMonthlyLimit: (data: LimitTestDouble, config: LimitTestDouble) => { writes.push({ data, config }); return putHandler(data, config) }
    },
    '@/stores/auth': {
      captureSession: () => ({ ...session }),
      isCurrentSession: (snapshot: LimitTestDouble) => snapshot.version === session.version && snapshot.token === session.token,
      onSessionChange: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) }
    },
    '@/utils/feedback': {
      feedback: Object.fromEntries(['error', 'warning', 'success'].map(type => [type, (text: string) => notices.push({ type, text })])),
      getRequestErrorMessage: () => '网络连接失败，请检查网络'
    }
  }
  const load = (relative: string, expose: string[] = []): LimitTestDouble => {
    if (!expose.length && cache.has(relative)) return cache.get(relative)
    let source = limitFs.readFileSync(limitPath.join(limitRoot, relative), 'utf8')
    if (relative.endsWith('.vue')) source = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)![1]
    if (expose.length) source += ';globalThis.exposed={' + expose.join(',') + '}'
    const module = { exports: {} }
    const context = limitVm.createContext({
      module, exports: module.exports, AbortController,
      require: (name: string) => {
        if (mocks[name]) return mocks[name]
        if (name.endsWith('.vue')) return { __esModule: true, default: {} }
        if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts')
        throw new Error('Unexpected import: ' + name)
      }
    })
    limitVm.runInContext(limitTransform(source, { loader: 'ts', format: 'cjs', target: 'node22', define: { 'import.meta.hot': 'undefined' } }).code, context)
    const result = expose.length ? (context as LimitTestDouble).exposed : module.exports
    if (!expose.length) cache.set(relative, result)
    return result
  }
  const state = load('src/stores/monthlyLimit.ts')
  return {
    state, reads, writes, notices, listeners, mounted, unmounted,
    loadWith: (handler: typeof getHandler) => { getHandler = handler },
    saveWith: (handler: typeof putHandler) => { putHandler = handler },
    session: (token: string | null, notify = true) => { session = { token, version: session.version + 1 }; if (notify) [...listeners].forEach(fn => fn()) },
    editor: () => load('src/views/setting/components/monthlyExpenseLimitSetting.vue', ['visible', 'draft', 'summary', 'open', 'submit', 'beforeClose'])
  }
}

limitTest('monthly limit keeps exact decimal cents through the maximum supported amount', () => {
  const f = limitFixture()
  for (const [input, output] of [['12', '12.00'], ['12.3', '12.30'], ['000.01', '0.01'], [' 2000.00 ', '2000.00'], ['90071992547409.91', '90071992547409.91'], ['', null], ['  ', null], [null, null]]) {
    limitAssert.equal(f.state.normalizeMonthlyLimitAmount(input), output)
  }
  for (const invalid of ['0', '0.00', '-1', '+1', '1.001', '1e3', '.5', '1.', 'NaN', 'Infinity', '90071992547409.92', '90071992547410.00', '100000000000000']) {
    limitAssert.throws(() => f.state.normalizeMonthlyLimitAmount(invalid))
  }
})

limitTest('monthly limit saves normalized decimal strings and restores the persisted value', async () => {
  const f = limitFixture()
  limitAssert.equal(await f.state.loadMonthlyLimit(), true)
  limitAssert.equal(f.state.monthlyLimitLoaded.value, true)
  limitAssert.equal(f.state.monthlyLimitCents.value, null)
  limitAssert.equal(await f.state.saveMonthlyLimit('2000.1'), true)
  limitAssert.equal(f.writes[0].data.amount, '2000.10')
  limitAssert.equal(f.state.monthlyLimitCents.value, 200010)
  limitAssert.equal(await f.state.loadMonthlyLimit(true), true)
  limitAssert.equal(f.state.monthlyLimitCents.value, 200010)
  for (const config of [f.reads[0], f.writes[0].config]) {
    limitAssert.equal(config.silentError, true)
    limitAssert.deepEqual(limitPlain(config.expectedSession), { version: 1, token: 'user-a' })
    limitAssert.equal(config.signal.aborted, false)
  }
  limitAssert.equal(await f.state.saveMonthlyLimit(' '), true)
  limitAssert.equal(f.writes.at(-1).data.amount, null)
  limitAssert.equal(f.state.monthlyLimitCents.value, null)
  limitAssert.equal(f.state.monthlyLimitLoaded.value, true)
})

limitTest('monthly limit validates input before sending requests without hiding an existing value', async () => {
  const f = limitFixture()
  await f.state.saveMonthlyLimit('123.45')
  for (const invalid of ['0', '-1', '12.345', '90071992547409.92']) limitAssert.equal(await f.state.saveMonthlyLimit(invalid), false)
  limitAssert.equal(f.writes.length, 1)
  limitAssert.equal(f.state.monthlyLimitCents.value, 12345)
  limitAssert.equal(f.state.monthlyLimitError.value, '')
})

limitTest('monthly limit initial load failure remains unknown and can be retried', async () => {
  const f = limitFixture()
  f.loadWith(async () => { throw new Error('offline') })
  limitAssert.equal(await f.state.loadMonthlyLimit(), false)
  limitAssert.equal(f.state.monthlyLimitLoaded.value, false)
  limitAssert.equal(f.state.monthlyLimitCents.value, null)
  limitAssert.equal(f.state.monthlyLimitLoading.value, false)
  limitAssert.match(f.state.monthlyLimitError.value, /网络/)
  f.loadWith(async () => limitResult('90071992547409.91'))
  limitAssert.equal(await f.state.loadMonthlyLimit(true), true)
  limitAssert.equal(f.state.monthlyLimitCents.value, Number.MAX_SAFE_INTEGER)
  limitAssert.equal(f.state.monthlyLimitError.value, '')
})

limitTest('monthly limit forced refresh and failed save preserve the last server value', async () => {
  const f = limitFixture()
  await f.state.saveMonthlyLimit('3000')
  f.loadWith(async () => ({ code: 0, msg: '读取失败' }))
  limitAssert.equal(await f.state.loadMonthlyLimit(true), false)
  limitAssert.equal(f.state.monthlyLimitCents.value, 300000)
  limitAssert.equal(f.state.monthlyLimitLoaded.value, true)
  limitAssert.equal(f.state.monthlyLimitError.value, '读取失败')
  f.saveWith(async () => { throw new Error('offline') })
  limitAssert.equal(await f.state.saveMonthlyLimit(null), false)
  limitAssert.equal(f.state.monthlyLimitCents.value, 300000)
  limitAssert.equal(f.state.monthlyLimitLoaded.value, true)
  limitAssert.equal(f.state.monthlyLimitSaving.value, false)
  limitAssert.equal(f.notices.filter(item => item.type === 'success').length, 1)
})

limitTest('monthly limit rejects malformed successful responses instead of treating them as unset', async () => {
  for (const amount of [undefined, '', 2000, '0', '1.234', '-1', '90071992547409.92']) {
    const f = limitFixture()
    await f.state.saveMonthlyLimit('100')
    f.loadWith(async () => ({ code: 1, data: { amount } }))
    limitAssert.equal(await f.state.loadMonthlyLimit(true), false)
    limitAssert.equal(f.state.monthlyLimitCents.value, 10000)
    limitAssert.match(f.state.monthlyLimitError.value, /数据异常/)
  }
})

limitTest('monthly limit shares concurrent reads and ignores late responses after forced replacement', async () => {
  const f = limitFixture()
  const first = limitDeferred()
  const second = limitDeferred()
  f.loadWith(() => f.reads.length === 1 ? first.promise : second.promise)
  const oldRead = f.state.loadMonthlyLimit()
  limitAssert.equal(f.state.loadMonthlyLimit(), oldRead)
  const newRead = f.state.loadMonthlyLimit(true)
  limitAssert.equal(f.reads.length, 2)
  limitAssert.equal(f.reads[0].signal.aborted, true)
  second.resolve(limitResult('200'))
  limitAssert.equal(await newRead, true)
  first.resolve(limitResult('100'))
  limitAssert.equal(await oldRead, false)
  limitAssert.equal(f.state.monthlyLimitCents.value, 20000)
  limitAssert.equal(f.state.monthlyLimitError.value, '')
})

limitTest('monthly limit save cancels stale reads and later reads wait for the same save', async () => {
  const f = limitFixture()
  const reading = limitDeferred()
  const writing = limitDeferred()
  f.loadWith(() => reading.promise)
  f.saveWith(() => writing.promise)
  const read = f.state.loadMonthlyLimit()
  const save = f.state.saveMonthlyLimit('500')
  limitAssert.equal(f.reads[0].signal.aborted, true)
  limitAssert.equal(f.state.loadMonthlyLimit(true), save)
  limitAssert.equal(f.reads.length, 1)
  reading.resolve(limitResult('100'))
  limitAssert.equal(await read, false)
  limitAssert.equal(f.state.monthlyLimitLoading.value, false)
  limitAssert.equal(f.state.monthlyLimitSaving.value, true)
  writing.resolve(limitResult('500.00'))
  limitAssert.equal(await save, true)
  limitAssert.equal(f.state.monthlyLimitCents.value, 50000)
})

limitTest('monthly limit serializes mutations without claiming a different concurrent value was saved', async () => {
  const f = limitFixture()
  const writing = limitDeferred()
  f.saveWith(() => writing.promise)
  const save = f.state.saveMonthlyLimit('500')
  limitAssert.equal(f.state.saveMonthlyLimit('500.00'), save)
  limitAssert.equal(await f.state.saveMonthlyLimit('600'), false)
  limitAssert.equal(f.writes.length, 1)
  writing.resolve(limitResult('500.00'))
  limitAssert.equal(await save, true)
  limitAssert.equal(f.state.monthlyLimitCents.value, 50000)
})

limitTest('monthly limit aborts and clears old account state on logout and account switch', async () => {
  for (const token of [null, 'user-b']) {
    const f = limitFixture()
    await f.state.saveMonthlyLimit('100')
    const pending = limitDeferred()
    f.loadWith(() => pending.promise)
    const read = f.state.loadMonthlyLimit(true)
    f.session(token)
    limitAssert.equal(f.reads.at(-1).signal.aborted, true)
    limitAssert.equal(f.state.monthlyLimitCents.value, null)
    limitAssert.equal(f.state.monthlyLimitLoaded.value, false)
    limitAssert.equal(f.state.monthlyLimitLoading.value, false)
    pending.resolve(limitResult('999'))
    limitAssert.equal(await read, false)
    limitAssert.equal(f.state.monthlyLimitCents.value, null)
    if (token === null) {
      limitAssert.equal(await f.state.loadMonthlyLimit(), false)
      limitAssert.equal(await f.state.saveMonthlyLimit('10'), false)
      limitAssert.equal(f.writes.length, 1)
    }
  }
})

limitTest('monthly limit old save failure cannot overwrite a new account load or show stale feedback', async () => {
  const f = limitFixture()
  const old = limitDeferred()
  f.saveWith(() => old.promise)
  const oldSave = f.state.saveMonthlyLimit('100')
  f.session('user-b')
  limitAssert.equal(f.writes[0].config.signal.aborted, true)
  f.loadWith(async () => limitResult('250'))
  await f.state.loadMonthlyLimit()
  old.reject(new Error('old failure'))
  limitAssert.equal(await oldSave, false)
  limitAssert.equal(f.state.monthlyLimitCents.value, 25000)
  limitAssert.equal(f.state.monthlyLimitError.value, '')
  limitAssert.equal(f.notices.length, 0)
})

limitTest('monthly limit rejects old responses even when session change notification was delayed', async () => {
  const f = limitFixture()
  const pending = limitDeferred()
  f.loadWith(() => pending.promise)
  const read = f.state.loadMonthlyLimit()
  f.session('user-b', false)
  pending.resolve(limitResult('100'))
  limitAssert.equal(await read, false)
  limitAssert.equal(f.state.monthlyLimitCents.value, null)
  f.loadWith(async () => limitResult('300'))
  limitAssert.equal(await f.state.loadMonthlyLimit(), true)
  limitAssert.equal(f.state.monthlyLimitCents.value, 30000)
})

limitTest('monthly limit editor opens saved data, keeps failed drafts and clears only after confirmed save', async () => {
  const f = limitFixture()
  const editor = f.editor()
  editor.open()
  limitAssert.equal(editor.visible.value, false)
  await f.state.saveMonthlyLimit('2000')
  editor.open()
  limitAssert.equal(editor.visible.value, true)
  limitAssert.equal(editor.draft.value, '2000.00')
  editor.draft.value = '2500'
  f.saveWith(async () => ({ code: 0, msg: '暂时无法保存' }))
  await editor.submit()
  limitAssert.equal(editor.visible.value, true)
  limitAssert.equal(editor.draft.value, '2500')
  limitAssert.equal(f.state.monthlyLimitCents.value, 200000)
  f.saveWith(async data => limitResult(data.amount))
  editor.draft.value = ''
  await editor.submit()
  limitAssert.equal(f.writes.at(-1).data.amount, null)
  limitAssert.equal(editor.visible.value, false)
  limitAssert.equal(editor.summary.value, '未设置')
})

limitTest('monthly limit editor blocks closing during save and clears sensitive drafts on session change', async () => {
  const f = limitFixture()
  const editor = f.editor()
  await f.state.loadMonthlyLimit()
  editor.open()
  editor.draft.value = '888'
  const pending = limitDeferred()
  f.saveWith(() => pending.promise)
  const submit = editor.submit()
  let closed = false
  editor.beforeClose(() => { closed = true })
  limitAssert.equal(closed, false)
  f.session('user-b')
  limitAssert.equal(editor.visible.value, false)
  limitAssert.equal(editor.draft.value, '')
  pending.resolve(limitResult('888'))
  await submit
  limitAssert.equal(f.state.monthlyLimitCents.value, null)
  f.unmounted.forEach(fn => fn())
  limitAssert.equal(f.listeners.size, 1)
})
