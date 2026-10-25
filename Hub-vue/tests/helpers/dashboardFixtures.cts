// Shared dashboard scenario fixtures.
import type { TestDouble } from './testTypes.cts'
const { vue, flushTasks, fixture, controlledTimers } = require('./runtime.cts')

function dashboardPayload(options: TestDouble = {}): TestDouble {
  const now = new Date()
  const month = options.month || now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
  const [year, number] = month.split('-').map(Number)
  const expense = options.expense ?? '0.00'
  const endMonth = year * 12 + number - 1
  const firstMonth = Math.max(1000 * 12, endMonth - 11)
  const monthlyExpenses = Array.from({ length: endMonth - firstMonth + 1 }, (_, index) => {
    const serial = firstMonth + index
    return { month: String(Math.floor(serial / 12)).padStart(4, '0') + '-' + String(serial % 12 + 1).padStart(2, '0'), amount: serial === endMonth ? expense : serial === endMonth - 1 ? options.previousMonthExpense ?? '0.00' : '0.00' }
  })
  return { month, monthlyExpenses, income: options.income ?? '0.00', expense, previousMonthExpense: options.previousMonthExpense ?? '0.00', categoryExpenses: Number(expense) ? [{ type: '1', amount: expense }] : [], dailyExpenses: Array.from({ length: new Date(year, number, 0).getDate() }, (_, index) => ({ date: month + '-' + String(index + 1).padStart(2, '0'), amount: index ? '0.00' : expense })), ...options }
}

function dashboardFixture(options: TestDouble = {}) {
  let now = (options.now || new Date(2026, 9, 18, 8, 9, 30)).getTime()
  class DashboardDate extends Date {
    constructor(value?: TestDouble) { super(value === undefined ? now : value) }
    static now() { return now }
  }
  const timers = controlledTimers()
  const mounts: TestDouble[] = []
  const unmounts: TestDouble[] = []
  const documentEvents = new Map<string, TestDouble>()
  const document = {
    hidden: false, visibilityState: 'visible',
    addEventListener: (name: string, fn: TestDouble) => documentEvents.set(name, fn),
    removeEventListener: (name: string) => documentEvents.delete(name)
  }
  const f = fixture({
    vue: { ...vue, onMounted: (fn: TestDouble) => mounts.push(fn), onUnmounted: (fn: TestDouble) => unmounts.push(fn) },
    '@/api/dashboard': { getDashboardStatisticsapi: (month: string, config: TestDouble) => options.api ? options.api(config, month) : Promise.resolve({ code: 1, data: dashboardPayload({ month }) }) }
  }, undefined, { ...timers.environment, Date: DashboardDate, document })
  const dashboard = f.load('src/views/dashboard/index.vue', [
    'currentDate', 'month', 'selectedMonth', 'selectMonth', 'periodLabel', 'syncCurrentMonth', 'loadStatistics', 'loaded', 'loading', 'loadError',
    'incomeCents', 'expenseCents', 'dailyExpenses', 'expenseComparison', 'previousMonthExpenseCents', 'statisticsMonth', 'categoryExpenses', 'monthlyExpenses'
  ])
  return {
    ...f, dashboard, timers, documentEvents, document,
    setNow: (date: Date) => { now = date.getTime() },
    mount: async () => { mounts.forEach(fn => fn()); await flushTasks() },
    unmount: () => unmounts.splice(0).forEach(fn => fn())
  }
}

function expenseTrendFixture() {
  let frameId = 0
  const frames = new Map<number, TestDouble>()
  const f = fixture({ vue: { ...vue, useId: () => 'expense-interaction-test', onMounted: () => {}, onUnmounted: () => {} } }, undefined, {
    requestAnimationFrame: (callback: TestDouble) => { frames.set(++frameId, callback); return frameId },
    cancelAnimationFrame: (id: number) => frames.delete(id)
  })
  const props = vue.reactive({ month: '2026-10', loading: false, points: [{ date: '2026-10-01', amountCents: 1250 }, { date: '2026-10-31', amountCents: 300 }] })
  const chart = f.load('src/views/dashboard/components/expenseTrendChart.vue', [
    'days', 'selectedIndex', 'selectedPoint', 'handleFocus', 'handleKeydown', 'clearSelection',
    'chartElement', 'chartWidth', 'pointX', 'handlePointerDown', 'handlePointerMove', 'finishPointer', 'handlePointerLeave'
  ], props)
  const bounds = { left: 40, width: 320 }
  const ownerDocument: TestDouble = { activeElement: null }
  const element = vue.markRaw({ getBoundingClientRect: () => bounds, ownerDocument })
  chart.chartElement.value = element
  return { ...f, props, chart, bounds, element, ownerDocument }
}

module.exports = { dashboardPayload, dashboardFixture, expenseTrendFixture }
