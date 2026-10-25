import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, path, vue, plain, flushTasks, deferred } = require('./helpers/runtime.cts')
const { fundPage, fundDays, pageOfFunds, fundFixture, fundSearchFixture, categoryFundFixture } = require('./helpers/fundFixtures.cts')

test('zero is a valid amount search', async () => {
  const f = fundFixture()
  f.fund.searchType.value = '2'
  await vue.nextTick()
  f.fund.searchText.value = 0
  await f.fund.searchFunds()
  assert.equal(f.sent[0].searchValue, 0)
})

test('category bill links apply the selected type before the first batch without fetching all bills', async () => {
  for (const type of ['0', '1', '7', '8', '9', '10']) {
    const requests: TestDouble[] = []
    const f = categoryFundFixture(type, { searchFundsapi: async (params: TestDouble) => { requests.push(plain(params)); return { code: 1, data: fundPage() } } })
    assert.equal(f.fund.searchVisible.value, true)
    assert.equal(f.fund.searchType.value, '1')
    assert.equal(f.fund.searchText.value, type)
    await f.mount()
    assert.equal(f.reads(), 0)
    assert.deepEqual(requests, [{ searchType: '1', searchValue: type, days: 5 }])
    assert.equal(f.timers.timers.size, 1)
    f.unmount()
    assert.equal(f.timers.timers.size, 0)
  }
})

test('invalid category query values safely load the normal bill list', async () => {
  for (const value of [undefined, null, [], ['1'], {}, 'unknown', '01', '11', '0 OR 1=1']) {
    const f = categoryFundFixture(value)
    await f.mount()
    assert.equal(f.fund.searchType.value, '3')
    assert.equal(f.fund.searchText.value, '')
    assert.equal(f.fund.searchVisible.value, false)
    assert.equal(f.reads(), 1)
    assert.equal(f.sent.length, 0)
    f.unmount()
  }
})

test('category filters survive scrolling and retry with the selected type and day cursor', async () => {
  const data = fundDays(12)
  const requests: TestDouble[] = []
  let failed = false
  const f = categoryFundFixture('1', { searchFundsapi: async (params: TestDouble) => {
    requests.push(plain(params))
    if (params.before && !failed) { failed = true; throw new Error('offline append') }
    return { code: 1, data: pageOfFunds(data, params) }
  } })
  await f.mount()
  assert.equal(f.fund.hasMoreDays.value, true)
  await f.fund.loadMoreDays()
  assert.equal(f.fund.appendError.value, true)
  await f.fund.retryLoad()
  assert.equal(f.fund.loadError.value, '')
  assert.equal(Object.keys(f.fund.fundData.value).length, 10)
  assert.deepEqual(requests, [
    { searchType: '1', searchValue: '1', days: 5 },
    { searchType: '1', searchValue: '1', days: 5, before: '2026-10-08' },
    { searchType: '1', searchValue: '1', days: 5, before: '2026-10-08' }
  ])
  assert.equal(f.reads(), 0)
  f.unmount()
})

test('clearing a linked category removes it from the URL without duplicate requests or losing unrelated context', async () => {
  const f = categoryFundFixture('2')
  await f.mount()
  await f.fund.clearSearch()
  await flushTasks()
  assert.equal(f.fund.searchText.value, '')
  assert.equal(f.fund.searchVisible.value, true)
  assert.equal(f.reads(), 1)
  assert.equal(f.sent.length, 1)
  assert.deepEqual(plain(f.router.currentRoute.value.query), { source: 'dashboard' })
  assert.equal(f.router.currentRoute.value.hash, '#bills')
  assert.deepEqual(f.redirects, [{ path: '/fund', query: { source: 'dashboard' }, hash: '#bills' }])
  f.unmount()
})

test('same-page category navigation cancels stale results, clears old rows and keeps manual searching usable', async () => {
  const requests: TestDouble[] = []
  const f = categoryFundFixture('1', { searchFundsapi: (params: TestDouble, config: TestDouble) => {
    const pending = deferred()
    requests.push({ params: plain(params), config, pending })
    return pending.promise
  } })
  const first = f.fund.selectList()
  f.router.currentRoute.value = { path: '/fund', query: { type: '2' }, hash: '' }
  await vue.nextTick()
  assert.equal(requests[0].config.signal.aborted, true)
  assert.equal(f.fund.searchText.value, '2')
  assert.equal(f.fund.loading.value, true)
  assert.equal(f.reads(), 0)
  requests[0].pending.resolve({ code: 1, data: fundPage(fundDays(12, 12)) })
  await first
  assert.deepEqual(plain(f.fund.fundData.value), {})
  assert.equal(f.fund.loading.value, true)
  requests[1].pending.resolve({ code: 1, data: fundPage({ '2026-10-10': [{ id: 2, time: '2026-10-10 12:00', type: '2', amount: '2.00' }] }) })
  await flushTasks()
  assert.equal(f.fund.fundData.value['2026-10-10'][0].type, '2')
  f.fund.searchType.value = '3'
  await flushTasks()
  assert.equal(f.reads(), 1)
  assert.equal(f.router.currentRoute.value.query.type, undefined)
  f.fund.searchText.value = 'coffee'
  const manual = f.fund.searchFunds()
  assert.deepEqual(requests[2].params, { searchType: '3', searchValue: 'coffee', days: 5 })
  requests[2].pending.resolve({ code: 1, data: fundPage() })
  await manual
  f.unmount()
})

test('category query changes reset old snapshots and removing the query returns to normal bills', async () => {
  let response: TestDouble = { code: 1, data: fundPage(fundDays(12, 12)) }
  const f = categoryFundFixture('1', { searchFundsapi: async () => response })
  await f.mount()
  assert.equal(Object.keys(f.fund.fundData.value).length, 1)
  response = { code: 0, msg: 'selected category unavailable' }
  f.router.currentRoute.value = { path: '/fund', query: { type: '0' } }
  await flushTasks()
  assert.equal(f.fund.searchText.value, '0')
  assert.equal(f.fund.loadError.value, 'selected category unavailable')
  assert.deepEqual(plain(f.fund.fundData.value), {})
  assert.doesNotMatch(f.notices.at(-1).text, /上一次成功/)
  response = { code: 1, data: fundPage() }
  f.router.currentRoute.value = { path: '/fund', query: {} }
  await flushTasks()
  assert.equal(f.fund.searchType.value, '3')
  assert.equal(f.fund.searchText.value, '')
  assert.equal(f.fund.loadError.value, '')
  assert.equal(f.reads(), 1)
  f.unmount()
})

test('clearing search keeps it expanded and focused while restoring the complete first batch exactly once', async () => {
  const f = fundSearchFixture({ searchFundsapi: async () => ({ code: 1, data: fundPage({ '2026-10-12': [{ id: 1, type: '1', amount: 1, time: '2026-10-12 12:00' }] }) }) })
  f.fund.toggleSearch()
  await vue.nextTick()
  assert.equal(f.fund.searchVisible.value, true)
  assert.equal(f.inputFocuses(), 1)
  assert.equal(f.fund.hasSearchText.value, false)
  f.fund.searchText.value = 'rent'
  await f.fund.searchFunds()
  assert.equal(f.fund.hasSearchText.value, true)
  const reads = f.reads()
  await f.fund.clearSearch()
  await vue.nextTick()
  assert.equal(f.reads(), reads + 1)
  assert.equal(f.fund.searchVisible.value, true)
  assert.equal(f.fund.searchText.value, '')
  assert.equal(f.fund.hasSearchText.value, false)
  assert.equal(f.inputFocuses(), 2)
  assert.equal(f.fund.loadError.value, '')
  assert.deepEqual(plain(f.fund.fundData.value), {})
  await f.fund.clearSearch()
  assert.equal(f.reads(), reads + 1)
  f.unmount()
  assert.equal(f.timers.timers.size, 0)
})

test('deleting the final search character restores all bills and ignores the canceled filtered response', async () => {
  const response = deferred()
  let signal: TestDouble
  const f = fundSearchFixture({ searchFundsapi: (params: TestDouble, config: TestDouble) => { signal = config.signal; return response.promise } })
  f.fund.toggleSearch()
  f.fund.searchText.value = 'rent'
  const searching = f.fund.searchFunds()
  f.fund.searchText.value = ''
  await flushTasks()
  assert.equal(signal.aborted, true)
  assert.equal(f.reads(), 1)
  assert.equal(f.fund.searchVisible.value, true)
  response.resolve({ code: 1, data: fundPage({ '2026-10-12': [{ id: 1, type: '1', amount: 1, time: '2026-10-12 12:00' }] }) })
  await searching
  assert.deepEqual(plain(f.fund.fundData.value), {})
  assert.equal(f.fund.loadError.value, '')
  f.unmount()
})

test('a zero amount counts as search content and closing or idling preserves its applied filter', async () => {
  const requests: TestDouble[] = []
  const f = fundSearchFixture({ searchFundsapi: async (params: TestDouble) => { requests.push(plain(params)); return { code: 1, data: fundPage() } } })
  f.fund.searchType.value = '2'
  await vue.nextTick()
  f.fund.toggleSearch()
  f.fund.searchText.value = 0
  assert.equal(f.fund.hasSearchText.value, true)
  await f.fund.searchFunds()
  f.fund.closeSearch()
  await vue.nextTick()
  assert.equal(f.fund.searchVisible.value, false)
  assert.equal(f.fund.searchText.value, 0)
  assert.equal(f.reads(), 0)
  await f.fund.selectList()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].searchValue, 0)
  f.fund.toggleSearch()
  await vue.nextTick()
  f.timers.fire()
  await vue.nextTick()
  assert.equal(f.fund.searchVisible.value, false)
  assert.equal(f.fund.searchText.value, 0)
  assert.equal(f.reads(), 0)
  f.unmount()
})

test('search collapses after fifteen idle seconds even while focused and keeps its text and filter', async () => {
  const searches: TestDouble[] = []
  const f = fundSearchFixture({ searchFundsapi: async (params: TestDouble) => { searches.push(plain(params)); return { code: 1, data: fundPage() } } })
  f.fund.toggleSearch()
  await vue.nextTick()
  f.fund.searchText.value = 'coffee'
  await f.fund.searchFunds()
  assert.equal(f.ownerDocument.activeElement, f.input)
  assert.equal(f.timers.timers.size, 1)
  assert.equal([...f.timers.timers.values()][0].delay, 15000)
  f.timers.fire()
  await vue.nextTick()
  assert.equal(f.fund.searchVisible.value, false)
  assert.equal(f.fund.searchText.value, 'coffee')
  assert.equal(f.buttonFocuses(), 1)
  assert.equal(f.reads(), 0)
  assert.equal(f.timers.timers.size, 0)
  await f.fund.selectList()
  assert.equal(searches.at(-1).searchValue, 'coffee')
  f.fund.toggleSearch()
  await vue.nextTick()
  assert.equal(f.fund.searchText.value, 'coffee')
  f.unmount()
})

test('idle search folding does not steal focus from another control and empty searches also collapse', async () => {
  const f = fundSearchFixture()
  f.fund.toggleSearch()
  await vue.nextTick()
  f.ownerDocument.activeElement = { name: 'another control' }
  f.timers.fire()
  await vue.nextTick()
  assert.equal(f.fund.searchVisible.value, false)
  assert.equal(f.buttonFocuses(), 0)
  assert.equal(f.reads(), 0)
  assert.equal(f.fund.searchText.value, '')
  f.unmount()
})

test('search activity restarts the idle countdown and composing or an open dropdown postpones folding', async () => {
  const f = fundSearchFixture()
  f.fund.toggleSearch()
  const initialTimer = [...f.timers.timers.keys()][0]
  f.fund.restartSearchIdle()
  assert.equal(f.timers.timers.has(initialTimer), false)
  assert.equal(f.timers.timers.size, 1)
  f.fund.startSearchComposition()
  assert.equal(f.timers.timers.size, 0)
  f.fund.searchText.value = '拼'
  assert.equal(f.timers.timers.size, 0)
  f.fund.endSearchComposition()
  assert.equal(f.timers.timers.size, 1)
  f.setPopoverOpen(true)
  f.timers.fire()
  assert.equal(f.fund.searchVisible.value, true)
  assert.equal(f.timers.timers.size, 1)
  f.setPopoverOpen(false)
  f.timers.fire()
  assert.equal(f.fund.searchVisible.value, false)
  assert.equal(f.fund.searchText.value, '拼')
  f.unmount()
})

test('a late complete list cannot replace newer search results', async () => {
  let finish: TestDouble
  const f = fundFixture({
    getFundapi: () => new Promise(resolve => { finish = resolve }),
    searchFundsapi: async () => ({ code: 1, data: fundPage({ '2026-10-12': [{ id: 1, remark: 'rent', type: '1', amount: 1, time: '2026-10-12 12:00' }] }) })
  })
  const first = f.fund.selectList()
  f.fund.searchType.value = '3'
  await vue.nextTick()
  f.fund.searchText.value = 'rent'
  await f.fund.searchFunds()
  finish({ code: 1, data: fundPage({ '2026-10-12': [{ id: 1 }, { id: 2 }] }) })
  await first
  assert.equal(f.fund.fundData.value['2026-10-12'].length, 1)
})

test('reset restores the full list and ignores a late search response', async () => {
  let finish: TestDouble
  const f = fundFixture({
    getFundapi: async () => ({ code: 1, data: fundPage({ '2026-10-12': [1, 2].map(id => ({ id, type: '1', amount: 1, time: '2026-10-12 12:00' })) }) }),
    searchFundsapi: () => new Promise(resolve => { finish = resolve })
  })
  f.fund.searchType.value = '3'
  await vue.nextTick()
  f.fund.searchText.value = 'rent'
  const searching = f.fund.searchFunds()
  await f.fund.resetSearch()
  finish({ code: 1, data: fundPage({ '2026-10-12': [{ id: 1 }] }) })
  await searching
  assert.equal(f.fund.fundData.value['2026-10-12'].length, 2)
  assert.equal(f.fund.searchText.value, '')
})

test('a failed search retains loaded bills and selection; retry uses the failed filter', async () => {
  let attempts = 0
  const filters: TestDouble[] = []
  const f = fundFixture({ searchFundsapi: async (params: TestDouble) => {
    filters.push(plain(params))
    return ++attempts === 1 ? { code: 0, msg: '查询暂不可用' } : { code: 1, data: fundPage({ '2026-10-12': [{ id: 2, remark: 'rent', type: '1', amount: 1, time: '2026-10-12 12:00' }] }) }
  } })
  f.fund.fundData.value = { '2026-10-11': [{ id: 1 }] }
  f.fund.selection.value = [{ id: 1 }]
  f.fund.searchType.value = '3'
  await vue.nextTick()
  f.fund.searchText.value = 'rent'
  await f.fund.searchFunds()
  assert.equal(f.fund.loadError.value, '查询暂不可用')
  assert.deepEqual(plain(f.fund.fundData.value), { '2026-10-11': [{ id: 1 }] })
  assert.equal(f.fund.selection.value.length, 1)
  f.fund.searchText.value = 'unsent input'
  await f.fund.retryLoad()
  assert.deepEqual(filters, [{ searchType: '3', searchValue: 'rent', days: 5 }, { searchType: '3', searchValue: 'rent', days: 5 }])
  assert.equal(f.fund.loadError.value, '')
  assert.equal(f.fund.selection.value.length, 0)
})

test('a late failed search cannot replace the successful reset with an error', async () => {
  let fail: TestDouble
  const f = fundFixture({ searchFundsapi: () => new Promise((resolve, reject) => { fail = reject }) })
  f.fund.searchType.value = '3'
  await vue.nextTick()
  f.fund.searchText.value = 'rent'
  const searching = f.fund.searchFunds()
  await f.fund.resetSearch()
  fail(new Error('Network Error'))
  await searching
  assert.equal(f.fund.loadError.value, '')
  assert.equal(f.fund.showEmpty.value, true)
  assert.equal(f.notices.length, 0)
})

test('search and reset request the first batch while save refreshes retain the loaded date range', async () => {
  const data = fundDays(12)
  const requests: TestDouble[] = []
  const f = fundFixture({
    getFundapi: async (config: TestDouble) => { requests.push(['list', plain(config.params)]); return { code: 1, data: pageOfFunds(data, config.params) } },
    searchFundsapi: async (params: TestDouble) => { requests.push(['search', plain(params)]); return { code: 1, data: pageOfFunds(data, params) } }
  })
  await f.fund.selectList()
  await f.fund.loadMoreDays()
  assert.equal(Object.keys(f.fund.visibleFundData.value).length, 10)
  await f.fund.selectList()
  assert.equal(Object.keys(f.fund.visibleFundData.value).length, 10)
  assert.deepEqual(requests.slice(2), [['list', { days: 5 }], ['list', { days: 5, before: '2026-10-08' }]])
  f.fund.searchType.value = '3'
  await vue.nextTick()
  f.fund.searchText.value = 'rent'
  await f.fund.searchFunds()
  assert.equal(Object.keys(f.fund.visibleFundData.value).length, 5)
  assert.deepEqual(requests.at(-1), ['search', { searchType: '3', searchValue: 'rent', days: 5 }])
  await f.fund.loadMoreDays()
  assert.equal(Object.keys(f.fund.visibleFundData.value).length, 10)
  assert.deepEqual(requests.at(-1), ['search', { searchType: '3', searchValue: 'rent', days: 5, before: '2026-10-08' }])
  await f.fund.resetSearch()
  assert.equal(Object.keys(f.fund.visibleFundData.value).length, 5)
  assert.deepEqual(requests.at(-1), ['list', { days: 5 }])
})

test('an aborted older-day response cannot append to newer search results', async () => {
  const older = deferred()
  const data = fundDays(7)
  let appendConfig: TestDouble
  const f = fundFixture({
    getFundapi: (config: TestDouble) => config.params.before ? (appendConfig = config, older.promise) : Promise.resolve({ code: 1, data: pageOfFunds(data) }),
    searchFundsapi: async (params: TestDouble) => ({ code: 1, data: fundPage({ '2026-10-07': [{ ...data['2026-10-07'][0], remark: params.searchValue }] }) })
  })
  await f.fund.selectList()
  const appending = f.fund.loadMoreDays()
  f.fund.searchText.value = 'new result'
  await f.fund.searchFunds()
  assert.equal(appendConfig.signal.aborted, true)
  older.resolve({ code: 1, data: pageOfFunds(data, appendConfig.params) })
  await appending
  assert.deepEqual(Object.keys(f.fund.fundData.value), ['2026-10-07'])
  assert.equal(f.fund.fundData.value['2026-10-07'][0].remark, 'new result')
  assert.equal(f.fund.hasMoreDays.value, false)
  assert.equal(f.fund.loading.value, false)
  assert.equal(f.fund.loadError.value, '')
})

test('global selection is limited to current search results and deletion locks all selection changes', async () => {
  const confirmation = deferred()
  const deletion = deferred()
  const sent: string[] = []
  const complete = fundDays(3)
  const results = { '2026-10-02': complete['2026-10-02'], '2026-10-01': complete['2026-10-01'] }
  const f = fundFixture({
    getFundapi: async () => ({ code: 1, data: fundPage(complete) }),
    searchFundsapi: async () => ({ code: 1, data: fundPage(results) }),
    deleteFundapi: (ids: string) => { sent.push(ids); return deletion.promise }
  }, {
    setup: (context: TestDouble) => context.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' }),
    mocks: { '@/utils/confirm': { confirmDialog: { confirm: () => confirmation.promise, close: () => {} } } }
  })
  await f.fund.selectList()
  f.fund.searchText.value = 'target'
  await f.fund.searchFunds()
  f.fund.selectFunds()
  f.fund.toggleAllLoaded()
  assert.deepEqual(plain(f.fund.selection.value.map((row: TestDouble) => row.id)), [2, 1])
  assert.equal(f.fund.selection.value.some((row: TestDouble) => row.id === 3), false)
  const assertLocked = () => {
    f.fund.toggleAllLoaded()
    f.fund.cancelSelection()
    f.fund.toggleRow('2026-10-02', f.fund.fundData.value['2026-10-02'][0], false)
    assert.equal(f.fund.showSelection.value, true)
    assert.equal(f.fund.allLoadedSelected.value, true)
    assert.deepEqual(plain(f.fund.selection.value.map((row: TestDouble) => row.id)), [2, 1])
  }
  const operation = f.fund.deleteFunds()
  assert.equal(f.fund.deleting.value, true)
  assertLocked()
  confirmation.resolve(true)
  await flushTasks()
  assert.deepEqual(sent, ['2,1'])
  assertLocked()
  deletion.resolve({ code: 0, msg: '删除暂不可用' })
  await operation
  assert.equal(f.fund.deleting.value, false)
  assert.equal(f.fund.selection.value.length, 2)
  f.fund.cancelSelection()
  assert.equal(f.fund.showSelection.value, false)
  assert.equal(f.fund.selection.value.length, 0)
  assert.equal(f.fund.selectionMap.value.size, 0)
  f.unmount()
})
