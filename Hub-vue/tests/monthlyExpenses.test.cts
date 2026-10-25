type MonthlyTestDouble = any
const monthlyTest: typeof import('node:test') = require('node:test')
const monthlyAssert: typeof import('node:assert/strict') = require('node:assert/strict')
const monthlyFs: typeof import('node:fs') = require('node:fs')
const monthlyPath: typeof import('node:path') = require('node:path')
const monthlyVm: typeof import('node:vm') = require('node:vm')
const monthlyTransform: typeof import('esbuild').transformSync = require('esbuild').transformSync
const monthlyVue = require('vue')
const monthlyRoot = monthlyPath.resolve(__dirname, '..')
const monthlySource = (file: string) => monthlyFs.readFileSync(monthlyPath.join(monthlyRoot, file), 'utf8')
const monthlyCompile = (source: string) => monthlyTransform(source, { loader: 'ts', format: 'cjs', target: 'node22' }).code
const monthlyModule = { exports: {} }
monthlyVm.runInNewContext(monthlyCompile(monthlySource('src/utils/monthlyExpenses.ts')), { module: monthlyModule, exports: monthlyModule.exports })
const monthlyTools = monthlyModule.exports as { getMonthlyExpenseLabels: (count: number, width: number) => number[]; nearestExpenseMonth: (x: number, left: number, width: number, count: number) => number }

monthlyTest('monthly labels adapt to narrow charts and retain both year boundaries', () => {
  const narrow = monthlyTools.getMonthlyExpenseLabels(12, 180)
  const wide = monthlyTools.getMonthlyExpenseLabels(12, 900)
  monthlyAssert.equal(narrow[0], 0)
  monthlyAssert.equal(narrow.at(-1), 11)
  monthlyAssert.ok(narrow.length < wide.length)
  monthlyAssert.equal(wide.length, 12)
  monthlyAssert.equal(new Set(narrow).size, narrow.length)
  monthlyAssert.equal(monthlyTools.getMonthlyExpenseLabels(0, 100).length, 0)
  monthlyAssert.equal(monthlyTools.getMonthlyExpenseLabels(1, 10).length, 1)
  monthlyAssert.equal(monthlyTools.getMonthlyExpenseLabels(12, NaN).length, 2)
})

monthlyTest('monthly pointer selection uses bar bins and clamps outside the chart', () => {
  const at = (x: number) => monthlyTools.nearestExpenseMonth(x, 40, 240, 12)
  monthlyAssert.equal(at(-100), 0)
  monthlyAssert.equal(at(40), 0)
  monthlyAssert.equal(at(59.9), 0)
  monthlyAssert.equal(at(60), 1)
  monthlyAssert.equal(at(279), 11)
  monthlyAssert.equal(at(900), 11)
  monthlyAssert.equal(at(NaN), 0)
  monthlyAssert.equal(monthlyTools.nearestExpenseMonth(10, 0, 0, 12), 0)
})

function monthlyFixture() {
  const props = monthlyVue.reactive({ points: [{ month: '2026-01', amountCents: 0 }, { month: '2026-02', amountCents: 1 }, { month: '2026-03', amountCents: Number.MAX_SAFE_INTEGER }], loading: false })
  const mounted: (() => void)[] = []
  const unmounted: (() => void)[] = []
  const frames = new Map<number, () => void>()
  let frameId = 0
  let resizeCallback = () => {}
  let disconnected = false
  const cache = new Map()
  const load = (file: string): MonthlyTestDouble => {
    if (cache.has(file)) return cache.get(file)
    const module = { exports: {} }
    monthlyVm.runInNewContext(monthlyCompile(monthlySource(file)), { module, exports: module.exports })
    cache.set(file, module.exports)
    return module.exports
  }
  let source = monthlySource('src/views/dashboard/components/monthlyExpenseChart.vue').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)![1]
  source += ';globalThis.exposed = {chartElement,chartWidth,chartHeight,inlineTooltip,tooltipStyle,pointX,labelIndices,barWidth,months,selectedIndex,selectedPoint,barHeight,barY,plotTop,plotBottom,handleFocus,handleKeydown,handlePointerDown,handlePointerMove,finishPointer,handlePointerLeave,clearSelection,queueWidthUpdate}'
  const module = { exports: {} }
  const context = monthlyVm.createContext({
    module, exports: module.exports,
    defineProps: () => props, withDefaults: (value: MonthlyTestDouble) => value,
    requestAnimationFrame: (fn: () => void) => { frames.set(++frameId, fn); return frameId },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class { constructor(fn: () => void) { resizeCallback = fn } observe() {} unobserve() {} disconnect() { disconnected = true } },
    require: (request: string) => {
      if (request === 'vue') return { ...monthlyVue, useId: () => 'test', onMounted: (fn: () => void) => mounted.push(fn), onUnmounted: (fn: () => void) => unmounted.push(fn) }
      if (request.startsWith('@/utils/')) return load('src/' + request.slice(2) + '.ts')
      throw new Error('Unexpected import: ' + request)
    }
  })
  monthlyVm.runInContext(monthlyCompile(source), context)
  const chart = (context as MonthlyTestDouble).exposed
  const element: MonthlyTestDouble = { clientWidth: 280, getBoundingClientRect: () => ({ left: 0, width: 280 }), ownerDocument: { activeElement: null } }
  chart.chartElement.value = element
  return { chart, props, element, frames, mount: () => mounted.forEach(fn => fn()), resize: () => resizeCallback(), disconnected: () => disconnected, unmount: () => unmounted.splice(0).forEach(fn => fn()) }
}

monthlyTest('monthly chart keyboard selects current, first and last months without changing input', async () => {
  const f = monthlyFixture()
  monthlyAssert.equal(f.chart.months.value, f.props.points)
  f.chart.handleFocus()
  monthlyAssert.equal(f.chart.selectedPoint.value.month, '2026-03')
  let prevented = 0
  for (const key of ['Home', 'ArrowLeft', 'ArrowRight', 'End', 'ArrowRight']) f.chart.handleKeydown({ key, preventDefault: () => prevented++ })
  monthlyAssert.equal(f.chart.selectedIndex.value, 2)
  monthlyAssert.equal(prevented, 5)
  f.props.loading = true
  await monthlyVue.nextTick()
  monthlyAssert.equal(f.chart.selectedIndex.value, null)
  f.chart.handleFocus()
  monthlyAssert.equal(f.chart.selectedIndex.value, null)
  f.unmount()
})

monthlyTest('monthly chart touch selection follows its active pointer and keeps keyboard selection on mouse leave', () => {
  const f = monthlyFixture()
  f.chart.handlePointerMove({ pointerType: 'touch', pointerId: 1, clientX: 80 })
  monthlyAssert.equal(f.chart.selectedIndex.value, null)
  f.chart.handlePointerDown({ pointerType: 'touch', pointerId: 1, clientX: 80, button: 0 })
  const original = f.chart.selectedIndex.value
  f.chart.handlePointerMove({ pointerType: 'touch', pointerId: 2, clientX: 270 })
  monthlyAssert.equal(f.chart.selectedIndex.value, original)
  f.chart.finishPointer({ pointerId: 2 })
  f.chart.handlePointerMove({ pointerType: 'touch', pointerId: 1, clientX: 270 })
  monthlyAssert.equal(f.chart.selectedIndex.value, 2)
  f.chart.finishPointer({ pointerId: 1 })
  f.chart.handlePointerMove({ pointerType: 'touch', pointerId: 1, clientX: 80 })
  monthlyAssert.equal(f.chart.selectedIndex.value, 2)
  f.element.ownerDocument.activeElement = f.element
  f.chart.handlePointerLeave({ pointerType: 'mouse' })
  monthlyAssert.equal(f.chart.selectedIndex.value, 2)
  f.element.ownerDocument.activeElement = null
  f.chart.handlePointerLeave({ pointerType: 'mouse' })
  monthlyAssert.equal(f.chart.selectedIndex.value, null)
  f.unmount()
})

monthlyTest('monthly chart keeps tiny amounts visible and batches resize work until unmount', async () => {
  const f = monthlyFixture()
  monthlyAssert.equal(f.chart.barHeight(0), 0)
  monthlyAssert.ok(f.chart.barHeight(1) >= 2)
  monthlyAssert.ok(Number.isFinite(f.chart.barY(Number.MAX_SAFE_INTEGER)))
  monthlyAssert.ok(f.chart.barY(Number.MAX_SAFE_INTEGER) >= 16)
  f.mount()
  await monthlyVue.nextTick()
  f.resize()
  f.resize()
  monthlyAssert.equal(f.frames.size, 1)
  const [id, frame] = [...f.frames][0]
  f.frames.delete(id)
  frame()
  monthlyAssert.equal(f.chart.chartWidth.value, 280)
  f.resize()
  monthlyAssert.equal(f.frames.size, 1)
  f.unmount()
  monthlyAssert.equal(f.frames.size, 0)
  monthlyAssert.equal(f.disconnected(), true)
})

monthlyTest('monthly tooltip stays above every bar at all widths, including the largest amount and endpoint columns', () => {
  const f = monthlyFixture()
  for (const width of [180, 280, 480, 640, 1200]) {
    f.chart.chartWidth.value = width
    for (const index of [0, 1, 2]) {
      f.chart.selectedIndex.value = index
      const style = f.chart.tooltipStyle.value
      const top = Number.parseFloat(style.top)
      const height = Number.parseFloat(style.height)
      const left = Number.parseFloat(style.left)
      const tooltipWidth = Number.parseFloat(style.width)
      monthlyAssert.ok(top >= 0)
      monthlyAssert.ok(left >= 8)
      monthlyAssert.ok(left + tooltipWidth <= width - 8)
      for (const point of f.props.points) monthlyAssert.ok(top + height + 12 <= f.chart.barY(point.amountCents))
      monthlyAssert.ok(top + height < f.chart.plotTop.value)
    }
  }
  f.unmount()
})

monthlyTest('monthly tooltip uses compact desktop space without reducing the plotted amount range', () => {
  const f = monthlyFixture()
  f.chart.chartWidth.value = 640
  f.chart.selectedIndex.value = 2
  monthlyAssert.equal(f.chart.inlineTooltip.value, true)
  monthlyAssert.equal(Number.parseFloat(f.chart.tooltipStyle.value.height), 48)
  monthlyAssert.equal(f.chart.plotBottom.value - f.chart.plotTop.value, 226)
  f.chart.chartWidth.value = 280
  monthlyAssert.equal(f.chart.inlineTooltip.value, false)
  monthlyAssert.equal(f.chart.plotBottom.value - f.chart.plotTop.value, 198)
  monthlyAssert.ok(Number.parseFloat(f.chart.tooltipStyle.value['--monthly-amount-size']) > 12)
  monthlyAssert.ok(Number.isFinite(f.chart.barY(Number.MAX_SAFE_INTEGER)))
  f.unmount()
})

monthlyTest('monthly tooltip remains in its reserved band when selected month and chart size change', async () => {
  const f = monthlyFixture()
  f.chart.selectedIndex.value = 0
  const initialTop = f.chart.tooltipStyle.value.top
  f.chart.selectedIndex.value = 2
  monthlyAssert.equal(f.chart.tooltipStyle.value.top, initialTop)
  f.props.points = [{ month: '2027-01', amountCents: 50 }, { month: '2027-02', amountCents: 100 }]
  await monthlyVue.nextTick()
  monthlyAssert.equal(f.chart.selectedIndex.value, null)
  f.chart.selectedIndex.value = 1
  monthlyAssert.ok(Number.parseFloat(f.chart.tooltipStyle.value.top) + Number.parseFloat(f.chart.tooltipStyle.value.height) < f.chart.barY(100))
  f.chart.chartWidth.value = 320
  monthlyAssert.ok(Number.parseFloat(f.chart.tooltipStyle.value.top) + Number.parseFloat(f.chart.tooltipStyle.value.height) < f.chart.barY(100))
  f.unmount()
})
