const chartTest: typeof import('node:test') = require('node:test')
const chartAssert: typeof import('node:assert/strict') = require('node:assert/strict')
const chartFs: typeof import('node:fs') = require('node:fs')
const chartPath: typeof import('node:path') = require('node:path')
const chartVm: typeof import('node:vm') = require('node:vm')
const chartTransform: typeof import('esbuild').transformSync = require('esbuild').transformSync
const chartModule = { exports: {} }
const chartCode = chartTransform(chartFs.readFileSync(chartPath.resolve(__dirname, '../src/utils/expenseChart.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code
chartVm.runInNewContext(chartCode, { module: chartModule, exports: chartModule.exports })
// The VM boundary has its own contract; tools TS must not import the app project.
interface ChartTestPoint { date: string; amountCents: number }
interface ChartTestTools {
  fillExpenseMonth: (points: readonly ChartTestPoint[], month: string) => ChartTestPoint[]
  createExpenseScale: (maximumCents: number) => { maximum: number; ticks: number[] }
  getExpenseDayLabels: (dayCount: number, availableWidth: number) => number[]
  nearestExpenseDay: (x: number, left: number, width: number, dayCount: number) => number
  formatExpenseAxis: (cents: number) => string
}
const chartTools = chartModule.exports as ChartTestTools

chartTest('expense chart fills a leap month and excludes impossible or foreign dates', () => {
  const points = chartTools.fillExpenseMonth([
    { date: '2024-02-01', amountCents: 12345 },
    { date: '2024-02-29', amountCents: 1 },
    { date: '2024-02-30', amountCents: 900 },
    { date: '2024-03-01', amountCents: 900 }
  ], '2024-02')
  chartAssert.equal(points.length, 29)
  chartAssert.equal(points[0].amountCents, 12345)
  chartAssert.equal(points[1].amountCents, 0)
  chartAssert.equal(points[28].date, '2024-02-29')
  chartAssert.equal(points[28].amountCents, 1)
  chartAssert.equal(chartTools.fillExpenseMonth([], '2025-02').length, 28)
  chartAssert.equal(chartTools.fillExpenseMonth([], '2026-04').length, 30)
  chartAssert.equal(chartTools.fillExpenseMonth([], '2026-10').length, 31)
  chartAssert.equal(chartTools.fillExpenseMonth([], '2026-13').length, 0)
})

chartTest('expense chart accepts only nonnegative safe integer cents and does not mutate input', () => {
  const input = [
    { date: '2026-10-01', amountCents: 12.5 },
    { date: '2026-10-02', amountCents: -1 },
    { date: '2026-10-03', amountCents: Infinity },
    { date: '2026-10-04', amountCents: Number.MAX_SAFE_INTEGER + 1 },
    { date: '2026-10-05', amountCents: 0 },
    { date: '2026-10-06', amountCents: 123 }
  ]
  const before = input.map(point => ({ ...point }))
  const result = chartTools.fillExpenseMonth(input, '2026-10')
  chartAssert.ok(result.slice(0, 5).every(point => point.amountCents === 0))
  chartAssert.equal(result[5].amountCents, 123)
  chartAssert.deepEqual(input, before)
})

chartTest('expense axis has finite evenly spaced ticks covering zero, cents and large values', () => {
  for (const maximum of [0, 1, 5, 99, 100, 12345, 99999999, Number.MAX_SAFE_INTEGER]) {
    const scale = chartTools.createExpenseScale(maximum)
    chartAssert.ok(Number.isFinite(scale.maximum) && scale.maximum > 0)
    chartAssert.ok(scale.maximum >= maximum)
    chartAssert.equal(scale.ticks[0], 0)
    chartAssert.equal(scale.ticks.at(-1), scale.maximum)
    chartAssert.ok(scale.ticks.length >= 2 && scale.ticks.length <= 6)
    const step = scale.ticks[1] - scale.ticks[0]
    chartAssert.ok(scale.ticks.every((tick, index) => tick === index * step))
  }
  chartAssert.equal(chartTools.formatExpenseAxis(25), '0.25')
  chartAssert.equal(chartTools.formatExpenseAxis(1_000_000), '1万')
})

chartTest('expense labels thin out on mobile while preserving the month boundaries', () => {
  const mobile = chartTools.getExpenseDayLabels(31, 180)
  const desktop = chartTools.getExpenseDayLabels(31, 900)
  chartAssert.equal(mobile[0], 0)
  chartAssert.equal(mobile.at(-1), 30)
  chartAssert.ok(mobile.length < desktop.length)
  chartAssert.ok(mobile.every((value, index) => index === 0 || value > mobile[index - 1]))
  chartAssert.equal(new Set(mobile).size, mobile.length)
  chartAssert.equal(chartTools.getExpenseDayLabels(1, 1).length, 1)
  chartAssert.equal(chartTools.getExpenseDayLabels(0, 100).length, 0)
})

chartTest('expense pointer selection rounds to the nearest day and clamps outside the plot', () => {
  chartAssert.equal(chartTools.nearestExpenseDay(-200, 40, 300, 31), 0)
  chartAssert.equal(chartTools.nearestExpenseDay(40, 40, 300, 31), 0)
  chartAssert.equal(chartTools.nearestExpenseDay(190, 40, 300, 31), 15)
  chartAssert.equal(chartTools.nearestExpenseDay(1000, 40, 300, 31), 30)
  chartAssert.equal(chartTools.nearestExpenseDay(NaN, 40, 300, 31), 0)
  chartAssert.equal(chartTools.nearestExpenseDay(100, 40, 0, 31), 0)
})
