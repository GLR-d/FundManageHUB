import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, plain, flushTasks, deferred } = require('./helpers/runtime.cts')
const { fundPage, fundDays, pageOfFunds, fundFixture } = require('./helpers/fundFixtures.cts')

test('a failed initial bill request displays an error rather than an empty list and can retry', async () => {
  let attempts = 0
  const data = { '2026-10-12': [{ id: 1, amount: 10, type: '1', time: '2026-10-12 12:00' }] }
  const f = fundFixture({ getFundapi: async () => {
    attempts++
    if (attempts === 1) throw Object.assign(new Error('Network Error'), { request: {} })
    return { code: 1, data: fundPage(data) }
  } })
  await f.fund.selectList()
  assert.equal(attempts, 1)
  assert.equal(f.fund.loading.value, false)
  assert.ok(f.fund.loadError.value)
  assert.equal(f.fund.showEmpty.value, false)
  assert.equal(f.notices.filter((item: TestDouble) => item.type === 'error').length, 1)
  await f.fund.retryLoad()
  assert.equal(attempts, 2)
  assert.equal(f.fund.loadError.value, '')
  assert.deepEqual(plain(f.fund.fundData.value), data)
})

test('a successful empty bill response displays the empty state without an error', async () => {
  const f = fundFixture()
  await f.fund.selectList()
  assert.equal(f.fund.loadError.value, '')
  assert.equal(f.fund.showEmpty.value, true)
})

test('scrolling fetches complete older days without splitting a day or clearing existing selection', async () => {
  const requests: TestDouble[] = []
  const data = {
    '2026-10-12': Array.from({ length: 25 }, (_, id) => ({ id, type: '6', amount: 1, time: '2026-10-12 12:00' })),
    '2026-10-11': Array.from({ length: 30 }, (_, id) => ({ id: id + 25, type: '0', amount: 1, time: '2026-10-11 12:00' })),
    ...Object.fromEntries([10, 9, 8, 7, 6].map(day => ['2026-10-' + String(day).padStart(2, '0'), [{ id: day + 100, type: '0', amount: 1, time: '2026-10-' + String(day).padStart(2, '0') + ' 12:00' }]]))
  }
  const f = fundFixture({ getFundapi: async (config: TestDouble) => {
    requests.push(plain(config.params))
    return { code: 1, data: pageOfFunds(data, config.params) }
  } })
  await f.fund.selectList()
  assert.deepEqual(requests, [{ days: 5 }])
  assert.equal(Object.keys(f.fund.visibleFundData.value).length, 5)
  assert.equal(f.fund.visibleFundData.value['2026-10-12'].length, 25)
  assert.equal(f.fund.visibleFundData.value['2026-10-11'].length, 30)
  f.fund.toggleRow('2026-10-12', f.fund.fundData.value['2026-10-12'][0], true)
  const selected = f.fund.selection.value[0]
  await f.fund.loadMoreDays()
  assert.deepEqual(requests, [{ days: 5 }, { days: 5, before: '2026-10-08' }])
  assert.equal(f.fund.selection.value.length, 1)
  assert.equal(f.fund.selection.value[0], selected)
  assert.equal(f.fund.selectionMap.value.get('2026-10-12')[0], selected)
  assert.equal(Object.keys(f.fund.visibleFundData.value).length, 7)
  assert.equal(new Set(Object.values(f.fund.visibleFundData.value).flat().map((item: TestDouble) => item.id)).size, 60)
  assert.equal(f.fund.hasMoreDays.value, false)
  assert.equal(f.fund.nextCursor.value, null)
  await f.fund.loadMoreDays()
  assert.equal(requests.length, 2)
  assert.equal(f.load('src/utils/funds.ts').calculateFundTotals(f.fund.visibleFundData.value['2026-10-12']).income, 2500)
})

test('a pending older-day request is mutually exclusive and cannot be duplicated by scrolling or retry', async () => {
  const response = deferred()
  const requests: TestDouble[] = []
  const data = fundDays(7)
  const f = fundFixture({ getFundapi: (config: TestDouble) => {
    requests.push(plain(config.params))
    return requests.length === 1 ? Promise.resolve({ code: 1, data: pageOfFunds(data) }) : response.promise
  } })
  await f.fund.selectList()
  const appending = f.fund.loadMoreDays()
  await f.fund.loadMoreDays()
  await f.fund.retryLoad()
  assert.equal(f.fund.loading.value, true)
  assert.equal(requests.length, 2)
  assert.equal(Object.keys(f.fund.fundData.value).length, 5)
  response.resolve({ code: 1, data: pageOfFunds(data, requests[1]) })
  await appending
  assert.equal(f.fund.loading.value, false)
  assert.equal(Object.keys(f.fund.fundData.value).length, 7)
})

test('failed older-day loading retains cards and selection and retries the same cursor', async () => {
  const requests: TestDouble[] = []
  const data = fundDays(7)
  const f = fundFixture({ getFundapi: async (config: TestDouble) => {
    requests.push(plain(config.params))
    if (requests.length === 2) return { code: 0, msg: '历史账单暂不可用' }
    return { code: 1, data: pageOfFunds(data, config.params) }
  } })
  await f.fund.selectList()
  const first = f.fund.fundData.value
  f.fund.toggleRow('2026-10-07', first['2026-10-07'][0], true)
  await f.fund.loadMoreDays()
  assert.equal(f.fund.fundData.value, first)
  assert.equal(f.fund.selection.value.length, 1)
  assert.equal(Boolean(f.fund.appendError.value), true)
  assert.equal(f.fund.nextCursor.value, '2026-10-03')
  await f.fund.loadMoreDays()
  assert.equal(requests.length, 2)
  await f.fund.retryLoad()
  assert.deepEqual(requests[2], requests[1])
  assert.equal(Boolean(f.fund.appendError.value), false)
  assert.equal(f.fund.selection.value.length, 1)
  assert.equal(Object.keys(f.fund.fundData.value).length, 7)
})

test('multi-batch refresh commits atomically and follows the previous oldest day after a newer day is added', async () => {
  let data = fundDays(12)
  let refreshing = false
  const secondPage = deferred()
  const refreshRequests: TestDouble[] = []
  const f = fundFixture({ getFundapi: (config: TestDouble) => {
    if (!refreshing) return Promise.resolve({ code: 1, data: pageOfFunds(data, config.params) })
    refreshRequests.push(plain(config.params))
    return config.params.before === '2026-10-09' ? secondPage.promise : Promise.resolve({ code: 1, data: pageOfFunds(data, config.params) })
  } })
  await f.fund.selectList()
  await f.fund.loadMoreDays()
  const previous = f.fund.fundData.value
  f.fund.toggleRow('2026-10-12', previous['2026-10-12'][0], true)
  data = fundDays(13)
  refreshing = true
  const refresh = f.fund.selectList()
  await flushTasks()
  assert.equal(f.fund.fundData.value, previous)
  assert.equal(f.fund.selection.value.length, 1)
  assert.deepEqual(refreshRequests, [{ days: 5 }, { days: 5, before: '2026-10-09' }])
  secondPage.resolve({ code: 1, data: pageOfFunds(data, refreshRequests[1]) })
  await refresh
  assert.deepEqual(refreshRequests, [{ days: 5 }, { days: 5, before: '2026-10-09' }, { days: 5, before: '2026-10-04' }])
  assert.ok(f.fund.fundData.value['2026-10-13'])
  assert.ok(f.fund.fundData.value['2026-10-03'])
  assert.equal(f.fund.selection.value.length, 0)
})

test('a later refresh-batch failure retains the entire prior range and retry restarts the same refresh', async () => {
  const data = fundDays(12)
  let refreshing = false
  let failSecond = true
  const refreshRequests: TestDouble[] = []
  const f = fundFixture({ getFundapi: async (config: TestDouble) => {
    if (refreshing) {
      refreshRequests.push(plain(config.params))
      if (config.params.before && failSecond) return { code: 0, msg: '刷新中断' }
    }
    return { code: 1, data: pageOfFunds(data, config.params) }
  } })
  await f.fund.selectList()
  await f.fund.loadMoreDays()
  const previous = f.fund.fundData.value
  const previousCursor = f.fund.nextCursor.value
  f.fund.toggleRow('2026-10-12', previous['2026-10-12'][0], true)
  refreshing = true
  await f.fund.selectList()
  assert.equal(f.fund.fundData.value, previous)
  assert.equal(f.fund.nextCursor.value, previousCursor)
  assert.equal(f.fund.selection.value.length, 1)
  assert.equal(f.fund.loadError.value, '刷新中断')
  assert.equal(f.fund.appendError.value, false)
  failSecond = false
  await f.fund.retryLoad()
  assert.deepEqual(refreshRequests, [
    { days: 5 }, { days: 5, before: '2026-10-08' },
    { days: 5 }, { days: 5, before: '2026-10-08' }
  ])
  assert.equal(Object.keys(f.fund.fundData.value).length, 10)
  assert.equal(f.fund.selection.value.length, 0)
  assert.equal(f.fund.loadError.value, '')
})

test('a disposed bill list aborts older-day loading and ignores its late failure', async () => {
  const response = deferred()
  let appendConfig: TestDouble
  const data = fundDays(7)
  const f = fundFixture({ getFundapi: (config: TestDouble) => config.params.before ? (appendConfig = config, response.promise) : Promise.resolve({ code: 1, data: pageOfFunds(data) }) })
  await f.fund.selectList()
  const previous = f.fund.fundData.value
  const append = f.fund.loadMoreDays()
  f.unmount()
  assert.equal(appendConfig.signal.aborted, true)
  response.reject(new Error('late failure'))
  await append
  assert.equal(f.fund.fundData.value, previous)
  assert.equal(f.notices.length, 0)
})

test('a bad bill payload retains the previous cards and selection and can retry successfully', async () => {
  const good = { '2026-10-12': [{ id: 1, type: '1', amount: '0.29', time: '2026-10-12 12:00' }] }
  let data: TestDouble = good
  const f = fundFixture({ getFundapi: async () => ({ code: 1, data: fundPage(data) }) })
  await f.fund.selectList()
  f.fund.selection.value = [f.fund.fundData.value['2026-10-12'][0]]
  data = { '2026-10-12': [null] }
  await f.fund.selectList()
  assert.deepEqual(plain(f.fund.fundData.value), good)
  assert.equal(f.fund.selection.value.length, 1)
  assert.equal(f.fund.showEmpty.value, false)
  assert.ok(f.fund.loadError.value)
  assert.match(f.notices.at(-1).text, /上一次成功/)
  data = good
  await f.fund.retryLoad()
  assert.equal(f.fund.loadError.value, '')
  assert.equal(f.fund.selection.value.length, 0)
})

test('bill requests abort on leaving and late success or business failure has no page effects', async () => {
  for (const code of [0, 1]) {
    const response = deferred()
    let config: TestDouble
    const f = fundFixture({ addFundapi: (data: TestDouble, options: TestDouble) => { config = options; return response.promise } })
    f.fund.addFund()
    f.fund.formData.value = { time: '2026-10-12 10:00', type: '1', amount: 1 }
    const operation = f.fund.submitForm()
    await flushTasks()
    f.unmount()
    assert.equal(config.signal.aborted, true)
    response.resolve({ code, msg: 'late failure' })
    await operation
    assert.equal(f.notices.length, 0)
    assert.equal(f.reads(), 0)
    assert.equal(f.fund.formVisible.value, true)
  }
})
