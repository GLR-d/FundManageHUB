type TransferDouble = any
const transferTest: typeof import('node:test') = require('node:test')
const transferAssert: typeof import('node:assert/strict') = require('node:assert/strict')
const transferFs: typeof import('node:fs') = require('node:fs')
const transferPath: typeof import('node:path') = require('node:path')
const transferVm: typeof import('node:vm') = require('node:vm')
const transferTransform: typeof import('esbuild').transformSync = require('esbuild').transformSync
const transferVue = require('vue')
const transferRoot = transferPath.resolve(__dirname, '..')
const transferDeferred = () => {
  let resolve!: (value: TransferDouble) => void
  let reject!: (value: TransferDouble) => void
  const promise = new Promise<TransferDouble>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function transferFixture(api: TransferDouble = {}, environment: TransferDouble = {}) {
  const cache = new Map()
  const unmounts: (() => void)[] = []
  const storage = new Map()
  const downloads: TransferDouble[] = []
  const revoked: string[] = []
  const timers: (() => void)[] = []
  const events: string[] = []
  const router = { currentRoute: transferVue.ref({ fullPath: '/setting' }) }
  const mocks: TransferDouble = {
    vue: { ...transferVue, onUnmounted: (fn: () => void) => unmounts.push(fn) },
    '@/router': { default: router },
    '@/api/fund': api,
    './feedback': { getRequestErrorMessage: () => '请求失败，请稍后重试。' }
  }
  const load = (file: string, names: string[] = []): TransferDouble => {
    const filename = transferPath.resolve(transferRoot, file)
    if (!names.length && cache.has(filename)) return cache.get(filename)
    let source = transferFs.readFileSync(filename, 'utf8')
    if (file.endsWith('.vue')) source = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)![1]
    if (names.length) source += ';globalThis.exposed = {' + names.join(',') + '}'
    const module = { exports: {} }
    const context = transferVm.createContext({
      module, exports: module.exports, Blob, File, FormData, AbortController,
      defineProps: () => ({}), defineExpose: () => {}, defineEmits: () => (event: string) => events.push(event),
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      },
      setTimeout: (fn: () => void) => { timers.push(fn); return timers.length },
      URL: { createObjectURL: () => 'blob:test', revokeObjectURL: (url: string) => revoked.push(url) },
      document: {
        createElement: () => {
          const link = { href: '', download: '', hidden: false, remove: () => {}, click: () => downloads.push({ href: link.href, filename: link.download }) }
          return link
        },
        body: { appendChild: () => {} }
      },
      ...environment,
      require: (request: string) => {
        if (Object.hasOwn(mocks, request)) {
          const value = mocks[request]
          return value.default ? { __esModule: true, ...value } : value
        }
        if (request.endsWith('.vue')) return { default: {} }
        if (request.startsWith('@/')) return load('src/' + request.slice(2) + '.ts')
        if (request.startsWith('.')) return load(transferPath.relative(transferRoot, transferPath.resolve(transferPath.dirname(filename), request)) + '.ts')
        throw new Error('Unexpected import: ' + request)
      }
    })
    transferVm.runInContext(transferTransform(source, { loader: 'ts', format: 'cjs', target: 'node22' }).code, context)
    const result = names.length ? (context as TransferDouble).exposed : module.exports
    if (!names.length) cache.set(filename, result)
    return result
  }
  const auth = load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'token-a' })
  return {
    load, mocks, auth, router, events, downloads, revoked,
    flushTimers: () => timers.splice(0).forEach(fn => fn()),
    unmount: () => unmounts.splice(0).forEach(fn => fn()),
    component: () => load('src/views/setting/components/fundTransfer.vue', ['open', 'close', 'mode', 'action', 'fileInput', 'fileSize', 'clearFile', 'chooseFile', 'visible', 'file', 'error', 'success', 'busy', 'selectFile', 'download', 'importFile'])
  }
}

const transferCsv = () => new Blob(['\ufeff时间,类型,金额,备注,图片\r\n'], { type: 'text/csv;charset=utf-8' })
const transferFile = () => new File(['时间,类型,金额\r\n2026-10-21 12:30,餐饮,10.00'], '账单.csv', { type: 'text/csv' })
const transferSelect = (component: TransferDouble, file = transferFile()) => {
  const input = { files: [file], value: 'C:\\fakepath\\' + file.name }
  component.selectFile({ target: input })
  return input
}

transferTest('fund CSV API requests blobs and sends only the selected multipart file without a manual content type', async () => {
  const calls: TransferDouble[] = []
  const f = transferFixture()
  f.mocks['@/utils/request'] = { default: {
    get: async (...args: TransferDouble[]) => { calls.push(args); return transferCsv() },
    post: async (...args: TransferDouble[]) => { calls.push(args); return { code: 1, data: { imported: 1 } } }
  } }
  const api = f.load('src/api/fund.ts')
  const controller = new AbortController()
  const config = { signal: controller.signal, expectedSession: { version: 1, token: 'a' }, params: { test: 1 } }
  await api.exportFundsapi(config)
  const file = transferFile()
  await api.importFundsapi(file, config)
  transferAssert.deepEqual(calls.map(call => call[0]), ['/fund/export', '/fund/import'])
  for (const call of calls) {
    const sent = call.at(-1)
    transferAssert.equal(sent.signal, controller.signal)
    transferAssert.equal(sent.expectedSession, config.expectedSession)
    transferAssert.equal(sent.silentError, true)
    transferAssert.equal(sent.headers, undefined)
  }
  transferAssert.equal(calls[0][1].responseType, 'blob')
  transferAssert.equal(calls[1][1].get('file'), file)
  transferAssert.deepEqual([...calls[1][1].keys()], ['file'])
})

transferTest('fund CSV file limits accept the size boundary and reject empty or non-CSV files', () => {
  const tools = transferFixture().load('src/utils/fundTransfer.ts')
  transferAssert.equal(tools.validateFundImportFile(new File(['a'], 'BILLS.CSV')), '')
  transferAssert.equal(tools.validateFundImportFile(new File([new Uint8Array(tools.fundImportMaxBytes)], 'bills.csv')), '')
  transferAssert.match(tools.validateFundImportFile(new File([new Uint8Array(tools.fundImportMaxBytes + 1)], 'bills.csv')), /2 MB/)
  transferAssert.match(tools.validateFundImportFile(new File([], 'bills.csv')), /不能为空/)
  transferAssert.match(tools.validateFundImportFile(new File(['a'], 'bills.xlsx')), /CSV/)
})

transferTest('fund CSV validation refuses 200 JSON errors, HTML and empty bodies before downloading', async () => {
  const tools = transferFixture().load('src/utils/fundTransfer.ts')
  await tools.validateFundCsv(transferCsv())
  await transferAssert.rejects(tools.validateFundCsv(new Blob(['{"code":0,"msg":"没有导出权限"}'], { type: 'application/json' })), /没有导出权限/)
  await transferAssert.rejects(tools.validateFundCsv(new Blob(['{"code":0}'], { type: 'application/json' })), /未能获取/)
  await transferAssert.rejects(tools.validateFundCsv(new Blob(['<html>Error</html>'], { type: 'text/html' })), /未能获取/)
  await transferAssert.rejects(tools.validateFundCsv(new Blob([], { type: 'text/csv' })), /未能获取/)
})

transferTest('fund transfer errors preserve server row details from JSON and Blob responses and suppress auth/cancellation duplicates', async () => {
  const tools = transferFixture().load('src/utils/fundTransfer.ts')
  transferAssert.equal(await tools.getFundTransferError({ response: { status: 422, data: { code: 0, msg: '第 4 行：金额错误' } } }), '第 4 行：金额错误')
  transferAssert.equal(await tools.getFundTransferError({ response: { status: 422, data: new Blob(['{"code":0,"msg":"第 8 行：时间错误"}'], { type: 'application/json' }) } }), '第 8 行：时间错误')
  transferAssert.equal(await tools.getFundTransferError({ response: { status: 502, data: new Blob(['gateway error']) } }), '请求失败，请稍后重试。')
  transferAssert.equal(await tools.getFundTransferError({ response: { status: 401, data: { msg: '登录失效' } } }), '')
  transferAssert.equal(await tools.getFundTransferError({ code: 'ERR_CANCELED' }), '')
  transferAssert.equal(await tools.getFundTransferError({ __CANCEL__: true }), '')
})

transferTest('fund CSV downloads use the supplied safe filename and release object URLs even if clicking fails', () => {
  const f = transferFixture()
  f.load('src/utils/fundTransfer.ts').saveFundCsv(transferCsv(), '账单_2026-10-21.csv')
  transferAssert.deepEqual(f.downloads, [{ href: 'blob:test', filename: '账单_2026-10-21.csv' }])
  transferAssert.deepEqual(f.revoked, [])
  f.flushTimers()
  transferAssert.deepEqual(f.revoked, ['blob:test'])
  let removed = false
  const failed = transferFixture({}, { document: {
    createElement: () => ({ remove: () => { removed = true }, click: () => { throw new Error('click failed') } }),
    body: { appendChild: () => {} }
  } })
  transferAssert.throws(() => failed.load('src/utils/fundTransfer.ts').saveFundCsv(transferCsv(), '账单.csv'), /click failed/)
  failed.flushTimers()
  transferAssert.equal(removed, true)
  transferAssert.deepEqual(failed.revoked, ['blob:test'])
})

transferTest('fund import blocks double submission, retains the rejected file and permits selecting the same name again', async () => {
  const pending = transferDeferred()
  const requests: TransferDouble[] = []
  const f = transferFixture({ importFundsapi: (file: File, config: TransferDouble) => { requests.push({ file, config }); return pending.promise } })
  const component = f.component()
  component.open('import')
  const input = transferSelect(component)
  transferAssert.equal(input.value, '')
  const selected = component.file.value
  const first = component.importFile()
  await component.importFile()
  transferAssert.equal(requests.length, 1)
  transferAssert.equal(component.busy.value, true)
  transferAssert.equal(requests[0].config.expectedSession.token, 'token-a')
  pending.reject({ response: { status: 422, data: { code: 0, msg: '第 3 行：金额不能为负数' } } })
  await first
  transferAssert.equal(component.file.value, selected)
  transferAssert.equal(component.error.value, '第 3 行：金额不能为负数')
  transferAssert.equal(component.busy.value, false)
  transferAssert.deepEqual(f.events, [])
  const replacement = transferFile()
  transferSelect(component, replacement)
  transferAssert.equal(component.file.value, replacement)
  transferAssert.equal(component.error.value, '')
  f.unmount()
})

transferTest('fund import reports the server count once, clears the file, and never automatically retries failures', async () => {
  let requests = 0
  const f = transferFixture({ importFundsapi: async () => { requests++; return { code: 1, data: { imported: 23 } } } })
  const component = f.component()
  component.open('import')
  transferSelect(component)
  await component.importFile()
  await component.importFile()
  transferAssert.equal(requests, 1)
  transferAssert.match(component.success.value, /23/)
  transferAssert.equal(component.file.value, null)
  transferAssert.deepEqual(f.events, ['imported'])
  f.unmount()
  const failed = transferFixture({ importFundsapi: async () => { requests++; throw { isAxiosError: true, request: {} } } })
  const failedComponent = failed.component()
  failedComponent.open('import')
  transferSelect(failedComponent)
  await failedComponent.importFile()
  await Promise.resolve()
  transferAssert.equal(requests, 2)
  transferAssert.ok(failedComponent.file.value)
  transferAssert.ok(failedComponent.error.value)
  transferAssert.deepEqual(failed.events, [])
  failed.unmount()
})

transferTest('closing, changing route/session and unmounting cancel imports and ignore late success', async () => {
  for (const kind of ['close', 'route', 'session', 'unmount']) {
    const pending = transferDeferred()
    let signal: AbortSignal | undefined
    const f = transferFixture({ importFundsapi: (_file: File, config: TransferDouble) => { signal = config.signal; return pending.promise } })
    const component = f.component()
    component.open('import')
    transferSelect(component)
    const task = component.importFile()
    if (kind === 'close') component.visible.value = false
    if (kind === 'route') f.router.currentRoute.value = { fullPath: '/dashboard' }
    if (kind === 'session') f.auth.setLoginUser({ id: 'B', token: 'token-b' })
    if (kind === 'unmount') f.unmount()
    transferAssert.equal(signal?.aborted, true, kind)
    pending.resolve({ code: 1, data: { imported: 1 } })
    await task
    transferAssert.deepEqual(f.events, [], kind)
    transferAssert.equal(component.success.value, '', kind)
    f.unmount()
  }
})

transferTest('stale CSV downloads never fire after closing/reopening and JSON errors stay in the dialog', async () => {
  const pending = transferDeferred()
  let requests = 0
  const f = transferFixture({ exportFundsapi: () => ++requests === 1 ? pending.promise : Promise.resolve(transferCsv()) })
  const component = f.component()
  component.open('export')
  const task = component.download()
  component.close()
  component.open('export')
  await component.download()
  pending.resolve(transferCsv())
  await task
  transferAssert.equal(f.downloads.length, 1)
  transferAssert.match(f.downloads[0].filename, /^账单_.*\.csv$/)
  f.mocks['@/api/fund'].exportFundsapi = async () => new Blob(['{"code":0,"msg":"导出失败"}'], { type: 'application/json' })
  component.open('export')
  await component.download()
  transferAssert.equal(f.downloads.length, 1)
  transferAssert.equal(component.error.value, '导出失败')
  f.unmount()
})

transferTest('transfer opens in the requested mode, defaults to import and clears selection when reopened', () => {
  const f = transferFixture()
  const component = f.component()
  component.open()
  transferAssert.equal(component.visible.value, true)
  transferAssert.equal(component.mode.value, 'import')
  transferSelect(component)
  transferAssert.ok(component.file.value)
  transferAssert.match(component.fileSize.value, /KB/)
  component.error.value = '旧错误'
  component.success.value = '旧提示'
  component.open('export')
  transferAssert.equal(component.mode.value, 'export')
  transferAssert.equal(component.file.value, null)
  transferAssert.equal(component.error.value, '')
  transferAssert.equal(component.success.value, '')
  component.close()
  transferAssert.equal(component.visible.value, false)
  component.open()
  transferAssert.equal(component.mode.value, 'import')
  component.open('other')
  transferAssert.equal(component.mode.value, 'import')
  f.unmount()
  component.open('export')
  transferAssert.equal(component.visible.value, false)
})

transferTest('import and export modes reject actions belonging to the other dialog', async () => {
  const calls: string[] = []
  const f = transferFixture({
    importFundsapi: async () => { calls.push('import'); return { code: 1, data: { imported: 1 } } },
    exportFundsapi: async () => { calls.push('export'); return transferCsv() }
  })
  const component = f.component()
  component.open('import')
  await component.download()
  transferSelect(component)
  component.open('export')
  const input = transferSelect(component)
  transferAssert.equal(input.value, '')
  transferAssert.equal(component.file.value, null)
  component.file.value = transferFile()
  await component.importFile()
  transferAssert.deepEqual(calls, [])
  await component.download()
  transferAssert.deepEqual(calls, ['export'])
  transferAssert.equal(f.downloads.length, 1)
  component.close()
  await component.download()
  transferAssert.deepEqual(calls, ['export'])
  f.unmount()
})

transferTest('switching from a pending import to export cancels it without unlocking the new export', async () => {
  const importing = transferDeferred()
  const exporting = transferDeferred()
  let importSignal: AbortSignal | undefined
  const f = transferFixture({
    importFundsapi: (_file: File, config: TransferDouble) => { importSignal = config.signal; return importing.promise },
    exportFundsapi: () => exporting.promise
  })
  const component = f.component()
  component.open('import')
  transferSelect(component)
  const first = component.importFile()
  component.open('export')
  transferAssert.equal(importSignal?.aborted, true)
  transferAssert.equal(component.file.value, null)
  transferAssert.equal(component.busy.value, false)
  const second = component.download()
  importing.resolve({ code: 1, data: { imported: 100 } })
  await first
  transferAssert.deepEqual(f.events, [])
  transferAssert.equal(component.mode.value, 'export')
  transferAssert.equal(component.busy.value, true)
  transferAssert.equal(component.action.value, 'export')
  transferAssert.equal(component.success.value, '')
  exporting.resolve(transferCsv())
  await second
  transferAssert.equal(component.busy.value, false)
  transferAssert.equal(f.downloads.length, 1)
  transferAssert.match(f.downloads[0].filename, /^账单_.*\.csv$/)
  f.unmount()
})

transferTest('a failed old export cannot overwrite a fresh import operation', async () => {
  const exporting = transferDeferred()
  const importing = transferDeferred()
  let exportSignal: AbortSignal | undefined
  const f = transferFixture({
    exportFundsapi: (config: TransferDouble) => { exportSignal = config.signal; return exporting.promise },
    importFundsapi: () => importing.promise
  })
  const component = f.component()
  component.open('export')
  const first = component.download()
  component.open('import')
  transferAssert.equal(exportSignal?.aborted, true)
  transferSelect(component)
  const second = component.importFile()
  exporting.reject({ response: { status: 500, data: { msg: '旧导出失败' } } })
  await first
  transferAssert.equal(component.error.value, '')
  transferAssert.equal(component.busy.value, true)
  transferAssert.equal(component.action.value, 'import')
  importing.resolve({ code: 1, data: { imported: 7 } })
  await second
  transferAssert.deepEqual(f.downloads, [])
  transferAssert.deepEqual(f.events, ['imported'])
  transferAssert.match(component.success.value, /7/)
  transferAssert.equal(component.error.value, '')
  f.unmount()
})

transferTest('file replacement, clearing and double submission are blocked while an import is pending', async () => {
  const pending = transferDeferred()
  let imports = 0
  let pickerClicks = 0
  const f = transferFixture({ importFundsapi: () => { imports++; return pending.promise } })
  const component = f.component()
  component.open()
  component.fileInput.value = { value: '', click: () => { pickerClicks++ } }
  component.chooseFile()
  transferAssert.equal(pickerClicks, 1)
  transferSelect(component)
  const selected = component.file.value
  const task = component.importFile()
  component.clearFile()
  component.chooseFile()
  transferSelect(component, new File(['a'], '新账单.csv'))
  await component.importFile()
  transferAssert.equal(imports, 1)
  transferAssert.equal(pickerClicks, 1)
  transferAssert.equal(component.file.value, selected)
  pending.reject({ response: { status: 422, data: { msg: '金额格式错误' } } })
  await task
  transferAssert.equal(component.file.value, selected)
  transferAssert.equal(component.busy.value, false)
  component.clearFile()
  transferAssert.equal(component.file.value, null)
  transferAssert.equal(component.error.value, '')
  transferAssert.equal(component.success.value, '')
  f.unmount()
})

transferTest('closing, route changes, account changes and unmount cancel exports without stale downloads', async () => {
  for (const kind of ['close', 'route', 'session', 'unmount']) {
    const pending = transferDeferred()
    let signal: AbortSignal | undefined
    let requests = 0
    const f = transferFixture({ exportFundsapi: (config: TransferDouble) => { requests++; signal = config.signal; return pending.promise } })
    const component = f.component()
    component.open('export')
    const task = component.download()
    await component.download()
    transferAssert.equal(requests, 1)
    if (kind === 'close') component.close()
    if (kind === 'route') f.router.currentRoute.value = { fullPath: '/fund' }
    if (kind === 'session') f.auth.setLoginUser({ id: 'B', token: 'token-b' })
    if (kind === 'unmount') f.unmount()
    transferAssert.equal(signal?.aborted, true, kind)
    pending.resolve(transferCsv())
    await task
    transferAssert.deepEqual(f.downloads, [], kind)
    transferAssert.equal(component.success.value, '', kind)
    transferAssert.equal(component.visible.value, false, kind)
    if (kind === 'session') { component.open('import'); transferAssert.equal(component.visible.value, false) }
    f.unmount()
  }
})
