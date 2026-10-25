import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, path, vue, plain, flushTasks, deferred } = require('./helpers/runtime.cts')
const { fundPage, fundFixture, fundSearchFixture } = require('./helpers/fundFixtures.cts')

test('bill business failures preserve the editor and never show success', async () => {
  const f = fundFixture({ addFundapi: async () => ({ code: 0, msg: 'invalid bill' }) })
  f.fund.addFund()
  f.fund.formData.value = { time: '2026-10-12 10:00', type: '0', amount: 1, photo: '' }
  await f.fund.submitForm()
  assert.equal(f.fund.formVisible.value, true)
  assert.equal(f.notices.some((item: TestDouble) => item.type === 'success'), false)
  assert.equal(f.notices.at(-1).text, 'invalid bill')
})

test('a fresh bill defaults to consumption after editing income and saves without another category choice', async () => {
  const f = fundFixture()
  try {
    f.fund.editRow({ id: 1, time: '2026-10-12 10:00', type: '7', amount: '20.00', remark: 'old income', photo: 'old.jpg' })
    f.fund.closeForm()
    f.fund.addFund()
    assert.equal(f.fund.direction.value, '0')
    assert.equal(f.fund.formData.value.type, '0')
    assert.equal(f.fund.formData.value.amount, null)
    assert.equal(f.fund.formData.value.remark, '')
    assert.equal(f.fund.fileList.value.length, 0)
    assert.match(f.fund.formData.value.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    f.fund.formData.value.amount = '12.50'
    await f.fund.submitForm()
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0].type, '0')
    assert.equal(f.sent[0].amount, '12.50')
    assert.equal(f.fund.formVisible.value, false)
    f.fund.addFund()
    assert.equal(f.fund.formData.value.type, '0')
  } finally { f.unmount() }
})

test('editing income restores direction, serializes changed photos and refreshes the list', async () => {
  const f = fundFixture()
  f.fund.selection.value = [{ id: 1, time: '2026-10-12 10:00', type: 6, amount: 100, photo: 'old.jpg' }]
  f.fund.editRow(f.fund.selection.value[0])
  assert.equal(f.fund.direction.value, '1')
  f.fund.fileList.value = [{ url: 'new.jpg', status: 'success' }]
  await f.fund.submitForm()
  assert.equal(f.sent[0].photo, 'new.jpg')
  assert.equal(f.reads(), 1)
  assert.equal(f.fund.formVisible.value, false)
})

test('incoming transfers and red packets can be created and edited as income but reject the expense direction', async () => {
  for (const type of ['9', '10']) {
    const f = fundFixture()
    try {
      f.fund.addFund()
      f.fund.formData.value = { time: '2026-10-23 12:30', type, amount: '12.50', remark: 'income', photo: '' }
      await f.fund.submitForm()
      assert.equal(f.sent.length, 0)
      assert.equal(f.fund.formVisible.value, true)
      f.fund.direction.value = '1'
      assert.deepEqual(plain(f.fund.availableTypeOptions.value.map((option: TestDouble) => option.value)), ['6', '7', '9', '10'])
      await f.fund.submitForm()
      assert.equal(f.sent.length, 1)
      assert.equal(f.sent[0].type, type)
      assert.equal(f.sent[0].amount, '12.50')
      assert.equal(f.fund.formVisible.value, false)
      f.fund.editRow({ id: 91, time: '2026-10-23 12:30', type: Number(type), amount: '12.50', photo: '' })
      assert.equal(f.fund.direction.value, '1')
      assert.equal(f.fund.formData.value.type, type)
      f.fund.formData.value.amount = '13.50'
      await f.fund.submitForm()
      assert.equal(f.sent.length, 2)
      assert.equal(f.sent[1].id, 91)
      assert.equal(f.sent[1].type, type)
      assert.equal(f.sent[1].amount, '13.50')
    } finally { f.unmount() }
  }
})

test('clicking one bill opens a detached editor and saves the same id through the update API', async () => {
  const updates: TestDouble[] = []
  let creates = 0
  const f = fundFixture({
    updateFundapi: async (data: TestDouble, config: TestDouble) => { updates.push({ data: plain(data), config, abortedWhenSent: config.signal.aborted }); return { code: 1 } },
    addFundapi: async () => { creates++; return { code: 1 } }
  })
  const row = { id: 42, time: '2026-10-12 10:00', type: 6, amount: '90071992547409.90', photo: 'old.jpg', remark: 'original' }
  f.fund.selection.value = [{ id: 99 }]
  f.fund.editRow(row)
  assert.equal(f.fund.formVisible.value, true)
  assert.equal(f.fund.editing.value, true)
  assert.equal(f.fund.direction.value, '1')
  assert.notEqual(f.fund.formData.value, row)
  assert.equal(f.fund.formData.value.amount, '90071992547409.90')
  assert.equal(f.fund.fileList.value[0].url, 'old.jpg')
  assert.equal(f.fund.selection.value[0].id, 99)
  f.fund.formData.value.remark = 'updated'
  assert.equal(row.remark, 'original')
  await f.fund.submitForm()
  assert.equal(creates, 0)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].data.id, 42)
  assert.equal(updates[0].data.amount, '90071992547409.90')
  assert.equal(updates[0].data.remark, 'updated')
  assert.equal(updates[0].data.photo, 'old.jpg')
  assert.equal(updates[0].abortedWhenSent, false)
  assert.equal(f.fund.formVisible.value, false)
  assert.equal(f.reads(), 1)
})

test('row activation supports Enter and Space while selection and checkbox keypresses retain native behavior', () => {
  const f = fundFixture()
  const row = { id: 1, time: '2026-10-12 10:00', type: '1', amount: '0.29' }
  const rowElement = {}
  const checkbox = {}
  let prevented = 0
  const event = (key: TestDouble, target = rowElement) => ({ key, target, currentTarget: rowElement, preventDefault: () => { prevented++ } })
  f.fund.showSelection.value = true
  f.fund.editRow(row)
  f.fund.handleRowKeydown(event(' '), row)
  assert.equal(f.fund.formVisible.value, false)
  assert.equal(prevented, 0)
  f.fund.toggleRow('2026-10-12', row, true)
  assert.equal(f.fund.selection.value.length, 1)
  assert.equal(f.fund.formVisible.value, false)
  f.fund.showSelection.value = false
  f.fund.handleRowKeydown(event(' ', checkbox), row)
  f.fund.handleRowKeydown(event('Enter', checkbox), row)
  f.fund.handleRowKeydown(event('Tab'), row)
  assert.equal(f.fund.formVisible.value, false)
  assert.equal(prevented, 0)
  for (const key of ['Enter', ' ']) {
    f.fund.handleRowKeydown(event(key), row)
    assert.equal(f.fund.formVisible.value, true)
    assert.equal(f.fund.formData.value.id, row.id)
    f.fund.closeForm()
  }
  assert.equal(prevented, 2)
})

test('empty bills and bills with pending uploads are never sent', async () => {
  const f = fundFixture()
  f.fund.addFund()
  await f.fund.submitForm()
  assert.equal(f.sent.length, 0)
  f.fund.formData.value = { time: '2026-10-12 10:00', type: '0', amount: 1 }
  f.fund.fileList.value = [{ status: 'uploading', url: 'blob:example' }]
  await f.fund.submitForm()
  assert.equal(f.sent.length, 0)
})

test('failed deletion keeps selection and does not report success', async () => {
  const f = fundFixture({ deleteFundapi: async () => ({ code: 0, msg: 'delete refused' }) })
  f.fund.selection.value = [{ id: 1 }]
  f.fund.showSelection.value = true
  await f.fund.deleteFunds()
  assert.equal(f.fund.selection.value.length, 1)
  assert.equal(f.fund.showSelection.value, true)
  assert.equal(f.notices.some((item: TestDouble) => item.type === 'success'), false)
})

test('entering bill selection or leaving cancels idle folding and prevents a queued focus change', async () => {
  for (const action of ['selection', 'unmount']) {
    const f = fundSearchFixture()
    f.fund.toggleSearch()
    assert.equal(f.timers.timers.size, 1)
    if (action === 'selection') f.fund.showSelection.value = true
    else f.unmount()
    await vue.nextTick()
    assert.equal(f.timers.timers.size, 0)
    assert.equal(f.inputFocuses(), 0)
    assert.equal(f.buttonFocuses(), 0)
    if (action === 'selection') {
      assert.equal(f.fund.searchVisible.value, false)
      f.unmount()
    }
  }
})

test('a pending retry keeps the retry state and never starts a duplicate request', async () => {
  let attempts = 0
  let finish: TestDouble
  const f = fundFixture({ getFundapi: () => {
    if (++attempts === 1) return Promise.resolve({ code: 0, msg: '暂不可用' })
    return new Promise(resolve => { finish = resolve })
  } })
  await f.fund.selectList()
  const retrying = f.fund.retryLoad()
  assert.equal(f.fund.loading.value, true)
  assert.equal(f.fund.loadError.value, '暂不可用')
  f.fund.retryLoad()
  assert.equal(attempts, 2)
  finish({ code: 1, data: fundPage() })
  await retrying
  assert.equal(f.fund.loadError.value, '')
  assert.equal(f.fund.loading.value, false)
})

test('a failed bill attachment remains retryable and blocks saving until explicitly removed', async () => {
  const f = fundFixture()
  f.fund.addFund()
  Object.assign(f.fund.formData.value, { time: '2026-10-12 12:00', type: '1', amount: 12.5 })
  const raw: File & { uid?: string | number } = new File(['sample'], 'receipt.png', { type: 'image/png' })
  raw.uid = 12
  const file = { uid: 12, name: raw.name, raw, status: 'success' }
  f.fund.fileList.value = [file]
  f.fund.handleSuccess({ code: 0, msg: '模拟上传失败' }, file)
  assert.equal(f.fund.failedUploads.value[0].raw, raw)
  assert.equal(f.fund.fileList.value.length, 0)
  assert.equal(f.fund.hasFailedUploads.value, true)
  f.fund.handleSuccess({ code: 1, data: '  ' }, file)
  assert.equal(f.fund.hasFailedUploads.value, true)
  assert.equal(f.fund.fileList.value.length, 0)
  await f.fund.submitForm()
  assert.equal(f.sent.length, 0)
  assert.match(f.notices.at(-1).text, /重试或移除/)
  f.fund.discardFailure(12)
  await f.fund.submitForm()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].photo, '')
})

test('bottom bill entry is consumed once, preserves the URL context, and keeps an open draft', async () => {
  const f = fundFixture({}, { setup: (context: TestDouble) => {
    context.router.currentRoute.value = { path: '/fund', query: { record: 'new', filter: 'kept' }, hash: '#day' }
    context.router.replace = async (target: TestDouble) => {
      context.redirects.push(plain(target))
      context.router.currentRoute.value = target
    }
  } })
  await vue.nextTick()
  assert.equal(f.fund.formVisible.value, true)
  assert.equal(f.fund.editing.value, false)
  assert.deepEqual(f.redirects, [{ path: '/fund', query: { filter: 'kept' }, hash: '#day' }])
  f.fund.closeForm()
  await vue.nextTick()
  assert.equal(f.fund.formVisible.value, false)
  f.router.currentRoute.value = { path: '/fund', query: { record: 'new' }, hash: '' }
  await vue.nextTick()
  assert.equal(f.fund.formVisible.value, true)
  f.fund.formData.value.remark = '保留草稿'
  f.router.currentRoute.value = { path: '/fund', query: { record: 'new' }, hash: '' }
  await vue.nextTick()
  assert.equal(f.fund.formData.value.remark, '保留草稿')
  f.fund.closeForm()
  f.unmount()
  f.router.currentRoute.value = { path: '/fund', query: { record: 'new' } }
  await vue.nextTick()
  assert.equal(f.fund.formVisible.value, false)
})

test('bill create and edit fix their payload and mode before asynchronous validation', async () => {
  for (const editing of [false, true]) {
    const validation = deferred()
    const response = deferred()
    const sent: TestDouble[] = []
    const capture = (method: TestDouble) => (data: TestDouble, config: TestDouble) => { sent.push({ method, data, config }); return response.promise }
    const f = fundFixture({ addFundapi: capture('add'), updateFundapi: capture('edit') })
    f.fund.addFund()
    f.fund.editing.value = editing
    f.fund.formData.value = { id: 12, time: '2026-10-12 10:00', type: '1', amount: 1.25, remark: 'original' }
    f.fund.fileList.value = [{ status: 'success', url: 'original.jpg' }]
    f.fund.formRef.value = { validate: () => validation.promise, clearValidate: () => {} }
    const operation = f.fund.submitForm()
    await f.fund.submitForm()
    f.fund.formData.value.remark = 'changed during validation'
    f.fund.fileList.value = [{ status: 'success', url: 'changed.jpg' }]
    f.fund.editing.value = !editing
    validation.resolve(true)
    await flushTasks()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].method, editing ? 'edit' : 'add')
    assert.equal(sent[0].data.remark, 'original')
    assert.equal(sent[0].data.photo, 'original.jpg')
    assert.equal(f.fund.submitting.value, true)
    response.resolve({ code: 1 })
    await operation
    assert.equal(f.fund.submitting.value, false)
    assert.equal(f.reads(), 1)
    assert.equal(f.notices.at(-1).text, editing ? '更新成功' : '记录成功')
  }
})

test('leaving or switching account while bill validation waits prevents the mutation', async () => {
  for (const change of ['unmount', 'account']) {
    const validation = deferred()
    const f = fundFixture({}, { setup: (context: TestDouble) => context.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' }) })
    f.fund.addFund()
    f.fund.formData.value = { time: '2026-10-12 10:00', type: '1', amount: 1 }
    f.fund.formRef.value = { validate: () => validation.promise, clearValidate: () => {} }
    const operation = f.fund.submitForm()
    if (change === 'unmount') f.unmount()
    else f.load('src/stores/auth.ts').setLoginUser({ id: 'B', token: 'example-b' })
    validation.resolve(true)
    await operation
    assert.equal(f.sent.length, 0)
    assert.equal(f.reads(), 0)
    assert.equal(f.notices.length, 0)
  }
})

test('leaving or switching account closes a pending deletion confirmation and never sends deletion', async () => {
  for (const change of ['unmount', 'account']) {
    const confirmation = deferred()
    let closes = 0
    let sends = 0
    const f = fundFixture({ deleteFundapi: async () => { sends++; return { code: 1 } } }, {
      setup: (context: TestDouble) => context.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' }),
      mocks: { '@/utils/confirm': { confirmDialog: { confirm: () => confirmation.promise, close: () => { closes++ } } } }
    })
    f.fund.selection.value = [{ id: 1 }]
    const operation = f.fund.deleteFunds()
    await f.fund.deleteFunds()
    if (change === 'unmount') f.unmount()
    else f.load('src/stores/auth.ts').setLoginUser({ id: 'B', token: 'example-b' })
    assert.equal(closes, 1)
    confirmation.resolve('confirm')
    await operation
    await f.fund.deleteFunds()
    assert.equal(sends, 0)
    assert.equal(f.notices.length, 0)
  }
})

test('deletion keeps the confirmed IDs and ignores late response after navigation', async () => {
  const confirmation = deferred()
  const response = deferred()
  let sent: TestDouble
  const f = fundFixture({ deleteFundapi: (ids: TestDouble, config: TestDouble) => { sent = { ids, config }; return response.promise } }, {
    mocks: { '@/utils/confirm': { confirmDialog: { confirm: () => confirmation.promise, close: () => {} } } }
  })
  f.fund.selection.value = [{ id: 1 }, { id: 2 }]
  const operation = f.fund.deleteFunds()
  f.fund.selection.value = [{ id: 99 }]
  confirmation.resolve('confirm')
  await flushTasks()
  assert.equal(sent.ids, '1,2')
  f.unmount()
  assert.equal(sent.config.signal.aborted, true)
  response.resolve({ code: 1 })
  await operation
  assert.equal(f.fund.selection.value[0].id, 99)
  assert.equal(f.reads(), 0)
  assert.equal(f.notices.length, 0)
})
