import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, vue, plain, flushTasks, deferred, fixture } = require('./helpers/runtime.cts')
const { dashboardPayload, dashboardFixture, expenseTrendFixture } = require('./helpers/dashboardFixtures.cts')

test('dashboard keeps the current month synchronized and recalibrates when the page becomes visible', async () => {
  const requests: string[] = []
  const f = dashboardFixture({ api: async (_config: TestDouble, month: string) => {
    requests.push(month)
    return { code: 1, data: dashboardPayload({ month }) }
  } })
  assert.equal(f.dashboard.month.value, 10)
  assert.equal(f.dashboard.statisticsMonth.value, '2026-10')
  await f.mount()
  assert.deepEqual(requests, ['2026-10'])
  assert.equal(f.timers.timers.size, 1)
  f.setNow(new Date(2026, 9, 18, 8, 10, 0))
  f.timers.fire()
  assert.equal(f.dashboard.currentDate.value.getMinutes(), 10)
  assert.equal(f.dashboard.month.value, 10)
  assert.equal(f.timers.timers.size, 1)
  assert.deepEqual(requests, ['2026-10'])
  f.document.visibilityState = 'hidden'
  f.setNow(new Date(2026, 10, 1, 0, 3))
  f.documentEvents.get('visibilitychange')?.()
  assert.equal(f.dashboard.statisticsMonth.value, '2026-10')
  f.document.visibilityState = 'visible'
  f.documentEvents.get('visibilitychange')?.()
  await flushTasks()
  assert.equal(f.dashboard.month.value, 11)
  assert.equal(f.dashboard.statisticsMonth.value, '2026-11')
  assert.deepEqual(requests, ['2026-10', '2026-11'])
  assert.equal(f.timers.timers.size, 1)
  f.unmount()
  assert.equal(f.timers.timers.size, 0)
  assert.equal(f.documentEvents.size, 0)
  const previous = f.dashboard.currentDate.value.getTime()
  f.setNow(new Date(2027, 0, 1))
  f.dashboard.syncCurrentMonth()
  assert.equal(f.dashboard.currentDate.value.getTime(), previous)
  assert.deepEqual(requests, ['2026-10', '2026-11'])
})

test('cross-month dashboard refresh cancels the prior month and ignores its late success or failure', async () => {
  for (const previousFails of [false, true]) {
    const previous = deferred()
    const current = deferred()
    const requests: TestDouble[] = []
    const f = dashboardFixture({ now: new Date(2026, 11, 31, 23, 59), api: (config: TestDouble, month: string) => {
      requests.push({ ...config, month })
      return requests.length === 1 ? previous.promise : current.promise
    } })
    const first = f.dashboard.loadStatistics()
    assert.equal(requests.length, 1)
    f.setNow(new Date(2027, 0, 1, 0, 0))
    f.dashboard.syncCurrentMonth()
    assert.equal(f.dashboard.month.value, 1)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].signal.aborted, true)
    assert.deepEqual(requests.map(item => item.month), ['2026-12', '2027-01'])
    assert.equal(f.dashboard.loaded.value, false)
    if (previousFails) previous.reject(new Error('late old-month failure'))
    else previous.resolve({ code: 1, data: dashboardPayload({ month: '2026-12', income: '999.00', expense: '99.00', previousMonthExpense: '1.00' }) })
    await first
    assert.equal(f.dashboard.loading.value, true)
    assert.equal(f.dashboard.loaded.value, false)
    assert.equal(f.dashboard.incomeCents.value, 0)
    assert.equal(f.notices.length, 0)
    current.resolve({ code: 1, data: dashboardPayload({ month: '2027-01', income: '20.00', expense: '3.00' }) })
    await flushTasks()
    assert.equal(f.dashboard.loaded.value, true)
    assert.equal(f.dashboard.loading.value, false)
    assert.equal(f.dashboard.incomeCents.value, 2000)
    assert.equal(f.dashboard.expenseCents.value, 300)
    assert.equal(f.dashboard.statisticsMonth.value, '2027-01')
    assert.equal(f.dashboard.dailyExpenses.value[0].date, '2027-01-01')
    assert.equal(f.dashboard.dailyExpenses.value[0].amountCents, 300)
    assert.equal(f.dashboard.loadError.value, '')
    f.unmount()
  }
})

test('selecting a dashboard month clears the prior snapshot and updates every chart from the selected month', async () => {
  const previous = deferred()
  const requests: TestDouble[] = []
  const f = dashboardFixture({ api: (config: TestDouble, month: string) => {
    requests.push({ ...config, month })
    return month === '2026-10' ? Promise.resolve({ code: 1, data: dashboardPayload({ month, expense: '99.00' }) }) : previous.promise
  } })
  await f.mount()
  assert.equal(f.dashboard.expenseCents.value, 9900)
  f.dashboard.selectMonth('2024-02')
  assert.equal(f.dashboard.statisticsMonth.value, '2024-02')
  assert.equal(f.dashboard.month.value, 2)
  assert.equal(f.dashboard.periodLabel.value, '2月')
  assert.equal(f.dashboard.loaded.value, false)
  assert.equal(f.dashboard.loading.value, true)
  assert.equal(f.dashboard.expenseCents.value, 0)
  for (const name of ['dailyExpenses', 'categoryExpenses', 'monthlyExpenses']) assert.deepEqual(plain(f.dashboard[name].value), [])
  previous.resolve({ code: 1, data: dashboardPayload({ month: '2024-02', income: '20.00', expense: '12.30', previousMonthExpense: '10.00' }) })
  await flushTasks()
  assert.deepEqual(requests.map(item => item.month), ['2026-10', '2024-02'])
  assert.equal(f.dashboard.loaded.value, true)
  assert.equal(f.dashboard.incomeCents.value, 2000)
  assert.equal(f.dashboard.expenseCents.value, 1230)
  assert.equal(f.dashboard.dailyExpenses.value.length, 29)
  assert.equal(f.dashboard.dailyExpenses.value[0].date, '2024-02-01')
  assert.equal(f.dashboard.dailyExpenses.value[0].amountCents, 1230)
  assert.deepEqual(plain(f.dashboard.categoryExpenses.value), [{ type: '1', amountCents: 1230 }])
  assert.deepEqual(plain(f.dashboard.monthlyExpenses.value.at(-1)), { month: '2024-02', amountCents: 1230 })
  assert.equal(f.dashboard.expenseComparison.value.differenceCents, 230)
  f.unmount()
})

test('rapid dashboard month changes ignore stale responses even when returning to the initial month', async () => {
  for (const staleFails of [false, true]) {
    const requests: TestDouble[] = []
    const f = dashboardFixture({ api: (config: TestDouble, month: string) => {
      const pending = deferred()
      requests.push({ ...config, month, pending })
      return pending.promise
    } })
    const initial = f.dashboard.loadStatistics()
    f.dashboard.selectMonth('2026-09')
    f.dashboard.selectMonth('2026-10')
    f.dashboard.selectMonth('2026-10')
    assert.equal(requests.length, 3)
    assert.deepEqual(requests.map(item => item.month), ['2026-10', '2026-09', '2026-10'])
    assert.equal(requests[0].signal.aborted, true)
    assert.equal(requests[1].signal.aborted, true)
    requests[0].pending.resolve({ code: 1, data: dashboardPayload({ month: '2026-10', expense: '999.00' }) })
    if (staleFails) requests[1].pending.reject(new Error('late selected-month failure'))
    else requests[1].pending.resolve({ code: 1, data: dashboardPayload({ month: '2026-09', expense: '888.00' }) })
    await initial
    await flushTasks()
    assert.equal(f.dashboard.loading.value, true)
    assert.equal(f.dashboard.loaded.value, false)
    assert.equal(f.dashboard.expenseCents.value, 0)
    assert.equal(f.notices.length, 0)
    requests[2].pending.resolve({ code: 1, data: dashboardPayload({ month: '2026-10', expense: '10.00' }) })
    await flushTasks()
    assert.equal(f.dashboard.loaded.value, true)
    assert.equal(f.dashboard.loading.value, false)
    assert.equal(f.dashboard.expenseCents.value, 1000)
    assert.equal(f.dashboard.loadError.value, '')
    f.unmount()
  }
})

test('historical dashboard selection survives timer and visibility changes while returning to current month restores following', async () => {
  const requests: string[] = []
  const f = dashboardFixture({ now: new Date(2026, 11, 31, 23, 59), api: async (_config: TestDouble, month: string) => {
    requests.push(month)
    return { code: 1, data: dashboardPayload({ month }) }
  } })
  await f.mount()
  f.dashboard.selectMonth('2025-12')
  await flushTasks()
  f.setNow(new Date(2027, 0, 1))
  f.timers.fire()
  await flushTasks()
  assert.equal(f.dashboard.statisticsMonth.value, '2025-12')
  assert.equal(f.dashboard.currentDate.value.getFullYear(), 2027)
  f.setNow(new Date(2027, 1, 1))
  f.documentEvents.get('visibilitychange')?.()
  await flushTasks()
  assert.equal(f.dashboard.statisticsMonth.value, '2025-12')
  assert.deepEqual(requests, ['2026-12', '2025-12'])
  f.dashboard.selectMonth('2027-02')
  await flushTasks()
  assert.equal(f.dashboard.periodLabel.value, '本月')
  f.setNow(new Date(2027, 2, 1))
  f.timers.fire()
  await flushTasks()
  assert.equal(f.dashboard.statisticsMonth.value, '2027-03')
  assert.deepEqual(requests, ['2026-12', '2025-12', '2027-02', '2027-03'])
  f.unmount()
})

test('dashboard refreshes a previously selected future month when the real calendar reaches it', async () => {
  const requests: string[] = []
  let expense = '0.00'
  const f = dashboardFixture({ now: new Date(2026, 11, 31, 23, 59), api: async (_config: TestDouble, month: string) => {
    requests.push(month)
    return { code: 1, data: dashboardPayload({ month, expense }) }
  } })
  await f.mount()
  f.dashboard.selectMonth('2027-01')
  await flushTasks()
  assert.equal(f.dashboard.expenseCents.value, 0)
  expense = '15.00'
  f.setNow(new Date(2027, 0, 1, 0, 1))
  f.timers.fire()
  await flushTasks()
  assert.equal(f.dashboard.statisticsMonth.value, '2027-01')
  assert.equal(f.dashboard.periodLabel.value, '本月')
  assert.equal(f.dashboard.expenseCents.value, 1500)
  assert.deepEqual(requests, ['2026-12', '2027-01', '2027-01'])
  f.unmount()
})

test('failed dashboard month selection shows no previous-month data and retries the selected month', async () => {
  let failed = true
  const requests: string[] = []
  const f = dashboardFixture({ api: async (_config: TestDouble, month: string) => {
    requests.push(month)
    if (month === '2026-09' && failed) throw new Error('selected month unavailable')
    return { code: 1, data: dashboardPayload({ month, expense: month === '2026-10' ? '99.00' : '5.00' }) }
  } })
  await f.mount()
  f.dashboard.selectMonth('2026-09')
  await flushTasks()
  assert.equal(f.dashboard.loaded.value, false)
  assert.equal(f.dashboard.loading.value, false)
  assert.equal(f.dashboard.expenseCents.value, 0)
  assert.deepEqual(plain(f.dashboard.dailyExpenses.value), [])
  assert.ok(f.dashboard.loadError.value)
  assert.equal(f.notices.length, 1)
  assert.doesNotMatch(f.notices[0].text, /上一次成功/)
  failed = false
  await f.dashboard.loadStatistics()
  assert.equal(f.dashboard.statisticsMonth.value, '2026-09')
  assert.equal(f.dashboard.loaded.value, true)
  assert.equal(f.dashboard.expenseCents.value, 500)
  assert.equal(f.dashboard.loadError.value, '')
  assert.deepEqual(requests, ['2026-10', '2026-09', '2026-09'])
  f.unmount()
})

test('dashboard month selection validates supported boundaries and cannot issue requests after unmount', async () => {
  const requests: string[] = []
  const f = dashboardFixture({ api: async (_config: TestDouble, month: string) => {
    requests.push(month)
    return { code: 1, data: dashboardPayload({ month }) }
  } })
  await f.mount()
  for (const value of ['', '2026-1', '2026-00', '2026-13', '0999-12', '10000-01', '2026-10-01', '2026-10 ', null, 202610]) f.dashboard.selectMonth(value)
  assert.deepEqual(requests, ['2026-10'])
  for (const month of ['1000-01', '9999-12']) {
    f.dashboard.selectMonth(month)
    await flushTasks()
    assert.equal(f.dashboard.statisticsMonth.value, month)
    assert.equal(f.dashboard.loaded.value, true)
    assert.equal(f.dashboard.loadError.value, '')
  }
  f.unmount()
  f.dashboard.selectMonth('2026-01')
  assert.equal(f.dashboard.statisticsMonth.value, '9999-12')
  assert.deepEqual(requests, ['2026-10', '1000-01', '9999-12'])
})

test('dashboard monthly comparison uses the same successful snapshot as totals and daily expenses', async () => {
  const f = dashboardFixture({ api: async (_config: TestDouble, month: string) => ({ code: 1, data: dashboardPayload({ month, expense: '30.00', previousMonthExpense: '40.00' }) }) })
  await f.dashboard.loadStatistics()
  assert.equal(f.dashboard.expenseCents.value, 3000)
  assert.equal(f.dashboard.dailyExpenses.value[0].amountCents, 3000)
  assert.deepEqual(plain(f.dashboard.expenseComparison.value), { direction: 'decrease', differenceCents: -1000 })
  f.unmount()
})

test('dashboard refresh failures retain totals, daily expenses and comparison as one successful snapshot', async () => {
  let response: TestDouble
  const original = dashboardPayload({ month: '2026-10', income: '100.00', expense: '30.00', previousMonthExpense: '40.00' })
  original.dailyExpenses[0].amount = '10.00'
  original.dailyExpenses[1].amount = '20.00'
  response = { code: 1, data: original }
  const f = dashboardFixture({ api: async () => {
    if (response instanceof Error) throw response
    return response
  } })
  await f.dashboard.loadStatistics()
  const daily = f.dashboard.dailyExpenses.value
  const comparison = plain(f.dashboard.expenseComparison.value)
  const assertOriginal = () => {
    assert.equal(f.dashboard.loaded.value, true)
    assert.equal(f.dashboard.incomeCents.value, 10000)
    assert.equal(f.dashboard.expenseCents.value, 3000)
    assert.equal(f.dashboard.previousMonthExpenseCents.value, 4000)
    assert.equal(f.dashboard.dailyExpenses.value, daily)
    assert.equal(f.dashboard.dailyExpenses.value[0].amountCents, 1000)
    assert.equal(f.dashboard.dailyExpenses.value[1].amountCents, 2000)
    assert.deepEqual(plain(f.dashboard.expenseComparison.value), comparison)
  }
  const pending = deferred()
  response = pending.promise
  const refresh = f.dashboard.loadStatistics()
  assert.equal(f.dashboard.loading.value, true)
  assertOriginal()
  pending.resolve({ code: 1, data: dashboardPayload({ month: '2026-10', income: '200.00', expense: '5.00', previousMonthExpense: '1.00', dailyExpenses: [] }) })
  await refresh
  assertOriginal()
  for (const invalid of [
    new Error('offline'),
    { code: 0, msg: '统计暂不可用' },
    { code: 1, data: dashboardPayload({ month: '2026-11', income: '999.00' }) },
    { code: 1, data: dashboardPayload({ month: '2026-10', income: '999.00', expense: '5.00', previousMonthExpense: '-1.00' }) },
    { code: 1, data: { ...dashboardPayload({ month: '2026-10', expense: '5.00' }), expense: '5.01' } }
  ]) {
    response = invalid
    await f.dashboard.loadStatistics()
    assertOriginal()
    assert.ok(f.dashboard.loadError.value)
    assert.match(f.notices.at(-1).text, /上一次成功/)
  }
  response = { code: 1, data: dashboardPayload({ month: '2026-10', income: '12.00', expense: '5.00', previousMonthExpense: '4.00' }) }
  await f.dashboard.loadStatistics()
  assert.equal(f.dashboard.incomeCents.value, 1200)
  assert.equal(f.dashboard.expenseCents.value, 500)
  assert.equal(f.dashboard.previousMonthExpenseCents.value, 400)
  assert.notEqual(f.dashboard.dailyExpenses.value, daily)
  assert.equal(f.dashboard.dailyExpenses.value[0].amountCents, 500)
  assert.deepEqual(plain(f.dashboard.expenseComparison.value), { direction: 'increase', differenceCents: 100 })
  assert.equal(f.dashboard.loadError.value, '')
  f.unmount()
})

test('dashboard failure remains unloaded, while a successful empty response really displays zero', async () => {
  let fail = true
  let options: TestDouble
  const f = fixture({ '@/api/dashboard': { getDashboardStatisticsapi: async (_month: string, config: TestDouble) => {
    options = config
    if (fail) throw Object.assign(new Error('HTTP 500'), { response: { status: 500 } })
    return { code: 1, data: dashboardPayload() }
  } } })
  const dashboard = f.load('src/views/dashboard/index.vue', ['loadStatistics', 'loaded', 'loading', 'loadError', 'incomeCents', 'expenseCents', 'dailyExpenses'])
  await dashboard.loadStatistics()
  assert.equal(dashboard.loaded.value, false)
  assert.equal(dashboard.loading.value, false)
  assert.deepEqual(plain(dashboard.dailyExpenses.value), [])
  assert.ok(dashboard.loadError.value)
  assert.equal(options.silentError, true)
  assert.equal(f.notices.length, 1)
  fail = false
  await dashboard.loadStatistics()
  assert.equal(dashboard.loaded.value, true)
  assert.equal(dashboard.loadError.value, '')
  assert.equal(dashboard.incomeCents.value, 0)
  assert.equal(dashboard.expenseCents.value, 0)
  assert.equal(dashboard.incomeCents.value - dashboard.expenseCents.value, 0)
  assert.equal(dashboard.dailyExpenses.value.length, new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate())
  assert.ok(dashboard.dailyExpenses.value.every((item: TestDouble) => item.amountCents === 0))
})

test('dashboard retains valid totals after a bad response rather than overwriting them with zero', async () => {
  let response: TestDouble = { code: 1, data: dashboardPayload({ income: '100.00', expense: '0.30' }) }
  const f = fixture({ '@/api/dashboard': { getDashboardStatisticsapi: async () => response } })
  const dashboard = f.load('src/views/dashboard/index.vue', ['loadStatistics', 'loaded', 'loadError', 'incomeCents', 'expenseCents'])
  await dashboard.loadStatistics()
  assert.equal(dashboard.expenseCents.value, 30)
  assert.equal(dashboard.incomeCents.value - dashboard.expenseCents.value, 9970)
  for (const invalid of [{ code: 0, msg: '业务失败' }, { code: 1, data: [null] }, { code: 1, data: [{ type: '6', amount: 'bad' }] }]) {
    response = invalid
    await dashboard.loadStatistics()
    assert.equal(dashboard.loaded.value, true)
    assert.ok(dashboard.loadError.value)
    assert.equal(dashboard.incomeCents.value, 10000)
    assert.match(f.notices.at(-1).text, /上一次成功/)
  }
})

test('dashboard prevents duplicate loads, cancels on exit and ignores a late response', async () => {
  let dispose: TestDouble
  let finish: TestDouble
  let signal: TestDouble
  let requests = 0
  const f = fixture({
    vue: { ...vue, onMounted: () => {}, onUnmounted: (fn: TestDouble) => { dispose = fn } },
    '@/api/dashboard': { getDashboardStatisticsapi: (_month: string, config: TestDouble) => { requests++; signal = config.signal; return new Promise(resolve => { finish = resolve }) } }
  })
  const dashboard = f.load('src/views/dashboard/index.vue', ['loadStatistics', 'loaded'])
  const loading = dashboard.loadStatistics()
  await dashboard.loadStatistics()
  assert.equal(requests, 1)
  dispose()
  assert.equal(signal.aborted, true)
  finish({ code: 1, data: [] })
  await loading
  assert.equal(dashboard.loaded.value, false)
  assert.equal(f.notices.length, 0)
})

test('dashboard overflow keeps the previous valid statistics', async () => {
  let data: TestDouble = dashboardPayload({ income: '10.00' })
  const f = fixture({ '@/api/dashboard': { getDashboardStatisticsapi: async () => ({ code: 1, data }) } })
  const dashboard = f.load('src/views/dashboard/index.vue', ['loadStatistics', 'incomeCents', 'loaded', 'loadError'])
  await dashboard.loadStatistics()
  data = dashboardPayload({ expense: '90071992547409.91' })
  data.dailyExpenses[1].amount = '0.01'
  await dashboard.loadStatistics()
  assert.equal(dashboard.loaded.value, true)
  assert.equal(dashboard.incomeCents.value, 1000)
  assert.match(dashboard.loadError.value, /合计金额过大/)
})

test('statistics validate the complete requested calendar month and reject inconsistent totals atomically', () => {
  const { normalizeDashboardStatistics } = fixture().load('src/utils/dashboard.ts')
  const valid = dashboardPayload({ month: '2028-02', income: '12.50', expense: '0.30', previousMonthExpense: '1.00' })
  const result = normalizeDashboardStatistics(valid, '2028-02')
  assert.equal(result.dailyExpenses.length, 29)
  assert.equal(result.dailyExpenses[28].date, '2028-02-29')
  assert.equal(result.dailyExpenses[0].amountCents, 30)
  assert.equal(result.expense, 30)
  assert.equal(result.previousMonthExpense, 100)
  for (const body of [null, [], { ...valid, month: '2028-01' }, { ...valid, expense: '0.31' }, { ...valid, income: '-1.00' }, { ...valid, previousMonthExpense: 'bad' }, { ...valid, dailyExpenses: valid.dailyExpenses.slice(0, 28) }, { ...valid, dailyExpenses: [valid.dailyExpenses[1], ...valid.dailyExpenses.slice(1)] }]) {
    assert.throws(() => normalizeDashboardStatistics(body, '2028-02'), (error: TestDouble) => error.code === 'INVALID_FUND_DATA')
  }
  assert.equal(normalizeDashboardStatistics(dashboardPayload({ month: '2100-02' }), '2100-02').dailyExpenses.length, 28)
  assert.throws(() => normalizeDashboardStatistics(valid, '2028-13'))
})

test('monthly comparisons handle increases, decreases, zero baseline and large exact decimal values', () => {
  const { compareMonthlyExpense } = fixture().load('src/utils/dashboard.ts')
  assert.deepEqual(plain(compareMonthlyExpense(12500,10000)), { direction:'increase', differenceCents:2500 })
  assert.deepEqual(plain(compareMonthlyExpense(0,10000)), { direction:'decrease', differenceCents:-10000 })
  assert.deepEqual(plain(compareMonthlyExpense(0,0)), { direction:'same', differenceCents:0 })
  assert.deepEqual(plain(compareMonthlyExpense(100,0)), { direction:'increase', differenceCents:100 })
  assert.deepEqual(plain(compareMonthlyExpense(Number.MAX_SAFE_INTEGER,1)), { direction:'increase', differenceCents:Number.MAX_SAFE_INTEGER - 1 })
  assert.deepEqual(plain(compareMonthlyExpense(1001,1000)), { direction:'increase', differenceCents:1 })
  assert.throws(() => compareMonthlyExpense(-1,0))
})

test('statistics API carries the requested month, cancellation and silent error settings', async () => {
  let request: TestDouble
  const controller = new AbortController()
  const api = fixture({ '@/utils/request': { default: { get: (url: string, config: TestDouble) => { request = {url,config}; return Promise.resolve({code:1}) } } } }).load('src/api/dashboard.ts')
  await api.getDashboardStatisticsapi('2027-01', { signal:controller.signal, silentError:true, params:{month:'wrong',extra:'kept'} })
  assert.equal(request.url,'/dashboard/statistics')
  assert.equal(request.config.params.month,'2027-01')
  assert.equal(request.config.params.extra,'kept')
  assert.equal(request.config.signal,controller.signal)
  assert.equal(request.config.silentError,true)
})

test('expense chart keyboard selects complete month boundaries and resets selection for loading or a new month', async () => {
  const f = expenseTrendFixture()
  let prevented = 0
  const key = (value: string) => f.chart.handleKeydown({ key: value, preventDefault: () => { prevented++ } })
  f.chart.handleFocus()
  assert.equal(f.chart.selectedPoint.value.date, '2026-10-01')
  assert.equal(f.chart.selectedPoint.value.amountCents, 1250)
  key('ArrowLeft')
  assert.equal(f.chart.selectedIndex.value, 0)
  key('ArrowRight')
  assert.equal(f.chart.selectedPoint.value.date, '2026-10-02')
  assert.equal(f.chart.selectedPoint.value.amountCents, 0)
  key('End')
  key('ArrowRight')
  assert.equal(f.chart.selectedPoint.value.date, '2026-10-31')
  assert.equal(f.chart.selectedPoint.value.amountCents, 300)
  key('Home')
  assert.equal(f.chart.selectedIndex.value, 0)
  const before = prevented
  key('Tab')
  assert.equal(prevented, before)
  f.props.month = '2024-02'
  await vue.nextTick()
  assert.equal(f.chart.selectedPoint.value, null)
  f.chart.handleFocus()
  key('End')
  assert.equal(f.chart.selectedPoint.value.date, '2024-02-29')
  f.props.loading = true
  await vue.nextTick()
  assert.equal(f.chart.selectedPoint.value, null)
  key('ArrowRight')
  f.chart.handleFocus()
  assert.equal(f.chart.selectedPoint.value, null)
  f.props.loading = false
  await vue.nextTick()
  f.chart.handleFocus()
  assert.equal(f.chart.selectedPoint.value.date, '2024-02-01')
  f.chart.clearSelection()
  assert.equal(f.chart.selectedPoint.value, null)
})

test('expense chart touch selection follows only the active pointer and mouse hover respects keyboard focus', () => {
  const f = expenseTrendFixture()
  const pointer = (index: number, pointerId = 1, pointerType = 'touch', button = 0) => ({
    clientX: f.bounds.left + f.chart.pointX(index) / f.chart.chartWidth.value * f.bounds.width,
    pointerId, pointerType, button
  })
  f.chart.handlePointerMove(pointer(15))
  assert.equal(f.chart.selectedPoint.value, null)
  f.chart.handlePointerDown(pointer(0))
  assert.equal(f.chart.selectedPoint.value.date, '2026-10-01')
  f.chart.handlePointerMove(pointer(20, 2))
  assert.equal(f.chart.selectedIndex.value, 0)
  f.chart.handlePointerMove(pointer(15))
  assert.equal(f.chart.selectedPoint.value.date, '2026-10-16')
  f.chart.handlePointerLeave(pointer(15))
  assert.equal(f.chart.selectedIndex.value, 15)
  f.chart.finishPointer()
  f.chart.handlePointerMove(pointer(30))
  assert.equal(f.chart.selectedIndex.value, 15)
  f.chart.clearSelection()
  f.chart.handlePointerDown(pointer(30, 3, 'mouse', 2))
  assert.equal(f.chart.selectedPoint.value, null)
  f.chart.handlePointerMove(pointer(30, 3, 'mouse'))
  assert.equal(f.chart.selectedPoint.value.date, '2026-10-31')
  f.ownerDocument.activeElement = f.element
  f.chart.handlePointerLeave(pointer(30, 3, 'mouse'))
  assert.equal(f.chart.selectedPoint.value.date, '2026-10-31')
  f.ownerDocument.activeElement = null
  f.chart.handlePointerLeave(pointer(30, 3, 'mouse'))
  assert.equal(f.chart.selectedPoint.value, null)
})

test('category statistics validate expense types, duplicates, exact cents and monthly totals', () => {
  const { normalizeDashboardStatistics } = fixture().load('src/utils/dashboard.ts')
  const valid = dashboardPayload({ month: '2026-10', expense: '0.30', categoryExpenses: [{ type: '1', amount: '0.10' }, { type: '2', amount: '0.20' }] })
  assert.deepEqual(plain(normalizeDashboardStatistics(valid, '2026-10').categoryExpenses), [{ type: '1', amountCents: 10 }, { type: '2', amountCents: 20 }])
  const transport = { ...valid, categoryExpenses: [{ type: '8', amount: '0.30' }] }
  assert.deepEqual(plain(normalizeDashboardStatistics(transport, '2026-10').categoryExpenses), [{ type: '8', amountCents: 30 }])
  for (const categories of [undefined, null, {}, [], [null], [{type:'1', amount:'0.29'}], [{type:'1', amount:'0.10'}, {type:'1',amount:'0.20'}], [{type:'6',amount:'0.30'}], [{type:'7',amount:'0.30'}], [{type:'9',amount:'0.30'}], [{type:'10',amount:'0.30'}], [{type:'11',amount:'0.30'}], [{type:1,amount:'0.30'}], [{type:'1',amount:'-0.30'}], [{type:'1',amount:'0.001'}], [{type:'1',amount:'90071992547409.92'}]]) {
    assert.throws(() => normalizeDashboardStatistics({ ...valid, categoryExpenses: categories }, '2026-10'), (error: TestDouble) => error.code === 'INVALID_FUND_DATA')
  }
  assert.deepEqual(plain(normalizeDashboardStatistics(dashboardPayload({ month:'2026-10' }), '2026-10').categoryExpenses), [])
  const large = dashboardPayload({ month:'2026-10',expense:'90071992547409.91',categoryExpenses:[{type:'1',amount:'90071992547409.90'},{type:'2',amount:'0.01'}] })
  assert.equal(normalizeDashboardStatistics(large, '2026-10').categoryExpenses[0].amountCents, Number.MAX_SAFE_INTEGER - 1)
  large.categoryExpenses[1].amount = '0.02'
  assert.throws(() => normalizeDashboardStatistics(large, '2026-10'), /合计金额过大/)
})

test('category refresh shares the validated dashboard snapshot and rejects inconsistent replacements', async () => {
  let response = dashboardPayload({month:'2026-10',expense:'30.00',categoryExpenses:[{type:'1',amount:'10.00'},{type:'2',amount:'20.00'}]})
  const f = dashboardFixture({ api: async () => ({code:1,data:response}) })
  await f.dashboard.loadStatistics()
  const original = f.dashboard.categoryExpenses.value
  assert.deepEqual(plain(original), [{type:'1',amountCents:1000},{type:'2',amountCents:2000}])
  response = dashboardPayload({month:'2026-10',expense:'40.00',categoryExpenses:[{type:'1',amount:'30.00'}]})
  await f.dashboard.loadStatistics()
  assert.equal(f.dashboard.categoryExpenses.value, original)
  assert.equal(f.dashboard.expenseCents.value, 3000)
  assert.ok(f.dashboard.loadError.value)
  response = dashboardPayload({month:'2026-10',expense:'40.00',categoryExpenses:[{type:'3',amount:'40.00'}]})
  await f.dashboard.loadStatistics()
  assert.deepEqual(plain(f.dashboard.categoryExpenses.value), [{type:'3',amountCents:4000}])
  assert.equal(f.dashboard.expenseCents.value, 4000)
  assert.equal(f.dashboard.loadError.value, '')
  f.unmount()
})

test('monthly expenses validate an exact contiguous twelve-month window across years and database boundaries', () => {
  const { normalizeDashboardStatistics: normalize } = fixture().load('src/utils/dashboard.ts')
  const body = dashboardPayload({month:'2027-01',expense:'30.00',previousMonthExpense:'20.00'})
  const result = normalize(body, '2027-01')
  assert.equal(result.monthlyExpenses.length,12)
  assert.deepEqual(plain(result.monthlyExpenses[0]),{month:'2026-02',amountCents:0})
  assert.deepEqual(plain(result.monthlyExpenses.at(-2)),{month:'2026-12',amountCents:2000})
  assert.deepEqual(plain(result.monthlyExpenses.at(-1)),{month:'2027-01',amountCents:3000})
  for (const [month,count] of [['1000-01',1],['1000-03',3],['9999-12',12]] as const) {
    const normalized = normalize(dashboardPayload({month}),month)
    assert.equal(normalized.monthlyExpenses.length,count)
    assert.equal(normalized.monthlyExpenses.at(-1).month,month)
  }
})

test('monthly expense snapshots reject missing months, duplicates, future dates and inconsistent amounts', () => {
  const { normalizeDashboardStatistics: normalize } = fixture().load('src/utils/dashboard.ts')
  const valid = dashboardPayload({month:'2027-01',expense:'30.00',previousMonthExpense:'20.00'})
  const amounts = valid.monthlyExpenses
  const change = (index: number, patch: TestDouble) => amounts.map((item: TestDouble,i: number)=>i===index?{...item,...patch}:item)
  for (const monthlyExpenses of [undefined,null,[],amounts.slice(1),[...amounts].reverse(),change(0,{month:'2026-03'}),change(11,{month:'2027-02'}),change(0,{amount:'-1.00'}),change(0,{amount:'0.001'}),change(0,{amount:'90071992547409.92'}),change(11,{amount:'30.01'}),change(10,{amount:'19.99'})]) {
    assert.throws(()=>normalize({...valid,monthlyExpenses},'2027-01'),(error: TestDouble)=>error.code==='INVALID_FUND_DATA')
  }
  const large = dashboardPayload({month:'2027-01',expense:'90071992547409.91',previousMonthExpense:'90071992547409.91'})
  large.monthlyExpenses[0].amount='90071992547409.91'
  assert.equal(normalize(large,'2027-01').monthlyExpenses[0].amountCents,Number.MAX_SAFE_INTEGER)
})

test('monthly chart data refreshes atomically with the current dashboard snapshot', async () => {
  let data = dashboardPayload({month:'2026-10',expense:'30.00',previousMonthExpense:'20.00'})
  const f = dashboardFixture({api:async()=>({code:1,data})})
  await f.dashboard.loadStatistics()
  const previous = f.dashboard.monthlyExpenses.value
  data = dashboardPayload({month:'2026-10',expense:'40.00',previousMonthExpense:'20.00',monthlyExpenses:[]})
  await f.dashboard.loadStatistics()
  assert.equal(f.dashboard.monthlyExpenses.value,previous)
  assert.equal(f.dashboard.expenseCents.value,3000)
  assert.ok(f.dashboard.loadError.value)
  data = dashboardPayload({month:'2026-10',expense:'40.00',previousMonthExpense:'20.00'})
  await f.dashboard.loadStatistics()
  assert.equal(f.dashboard.monthlyExpenses.value.at(-1).amountCents,4000)
  assert.equal(f.dashboard.expenseCents.value,4000)
  assert.equal(f.dashboard.loadError.value,'')
  f.unmount()
})
