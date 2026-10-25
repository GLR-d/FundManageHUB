type DailyTooltipTestDouble = any
const dailyTooltipTest: typeof import('node:test') = require('node:test')
const dailyTooltipAssert: typeof import('node:assert/strict') = require('node:assert/strict')
import type { ScriptRuntimeFactory } from './helpers/scriptRuntime.cts'
const { createScriptRuntime }: { createScriptRuntime: ScriptRuntimeFactory } = require('./helpers/scriptRuntime.cts')
const dailyTooltipVue = require('vue')

function dailyTooltipFixture() {
  const props = dailyTooltipVue.reactive({ month: '2026-10', points: [{ date: '2026-10-23', amountCents: 200100 }], loading: false })
  const scope = dailyTooltipVue.effectScope()
  const mounted: (() => void)[] = []
  const unmounted: (() => void)[] = []
  const frames = new Map<number, () => void>()
  let frameId = 0
  let resizeCallback = () => {}
  let disconnected = false
  const runtime = createScriptRuntime({
    mocks: { vue: { ...dailyTooltipVue, useId: () => 'daily-tooltip-test', onMounted: (fn: () => void) => mounted.push(fn), onUnmounted: (fn: () => void) => unmounted.push(fn) } },
    globals: {
      defineProps: () => props, withDefaults: (value: DailyTooltipTestDouble) => value,
      requestAnimationFrame: (fn: () => void) => { frames.set(++frameId, fn); return frameId },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      ResizeObserver: class { constructor(fn: () => void) { resizeCallback = fn } observe() {} unobserve() {} disconnect() { disconnected = true } }
    }
  })
  const chart = scope.run(() => runtime.load('src/views/dashboard/components/expenseTrendChart.vue', [
    'chartElement', 'chartWidth', 'chartHeight', 'tooltipHeight', 'inlineTooltip', 'tooltipStyle', 'days',
    'selectedIndex', 'selectedPoint', 'selectedX', 'selectedY', 'plotTop', 'plotBottom', 'handleFocus', 'handleKeydown',
    'handlePointerDown', 'handlePointerMove', 'finishPointer', 'handlePointerLeave', 'clearSelection', 'queueWidthUpdate'
  ]))
  const element: DailyTooltipTestDouble = { clientWidth: 280, getBoundingClientRect: () => ({ left: 0, width: 280 }), ownerDocument: { activeElement: null } }
  chart.chartElement.value = element
  return {
    chart, props, element, frames,
    mount: () => mounted.forEach(fn => fn()), resize: () => resizeCallback(), disconnected: () => disconnected,
    flushFrame: () => { const [id, frame] = [...frames][0]; frames.delete(id); frame() },
    unmount: () => { unmounted.splice(0).forEach(fn => fn()); scope.stop() }
  }
}

type DailyTooltipRect = { left: number; top: number; width: number; height: number }
const dailyTooltipRect = (chart: DailyTooltipTestDouble): DailyTooltipRect => {
  const style = chart.tooltipStyle.value
  return { left: Number.parseFloat(style.left), top: Number.parseFloat(style.top), width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) }
}

function dailyTooltipAssertWithinChart(chart: DailyTooltipTestDouble, label: string) {
  const rect = dailyTooltipRect(chart)
  dailyTooltipAssert.ok(Object.values(rect).every(Number.isFinite), label)
  dailyTooltipAssert.ok(rect.width > 0 && rect.height > 0, label)
  dailyTooltipAssert.ok(rect.left >= 8 - 1e-8 && rect.left + rect.width <= chart.chartWidth.value - 8 + 1e-8, label)
  dailyTooltipAssert.ok(rect.top >= 8 - 1e-8 && rect.top + rect.height <= chart.plotBottom.value - 8 + 1e-8, label)
  dailyTooltipAssert.ok(Number.parseFloat(chart.tooltipStyle.value['--expense-amount-size']) > 0, label)
}

dailyTooltipTest('daily tooltip sits directly above its point inside the original chart height', () => {
  const f = dailyTooltipFixture()
  try {
    for (const width of [640, 1200]) {
      f.chart.chartWidth.value = width
      f.chart.selectedIndex.value = 22
      const rect = dailyTooltipRect(f.chart)
      dailyTooltipAssert.equal(f.chart.chartHeight.value, 264)
      dailyTooltipAssert.equal(f.chart.plotTop.value, 18)
      dailyTooltipAssert.equal(f.chart.plotBottom.value - f.chart.plotTop.value, 210)
      dailyTooltipAssert.ok(Math.abs(f.chart.selectedY.value - (rect.top + rect.height) - 12) < 1e-8)
      dailyTooltipAssert.ok(Math.abs(rect.left + rect.width / 2 - f.chart.selectedX.value) < 1e-8)
      dailyTooltipAssert.ok(rect.top >= f.chart.plotTop.value)
      dailyTooltipAssertWithinChart(f.chart, 'width=' + width)
    }
  } finally { f.unmount() }
})

dailyTooltipTest('daily tooltip follows the selected date and stays inside chart edges at every width', () => {
  const f = dailyTooltipFixture()
  const makePoint = (day: number, amountCents: number) => ({ date: '2026-10-' + String(day).padStart(2, '0'), amountCents })
  const profiles = [
    { name: 'zero', points: [] },
    { name: 'isolated peak', points: [makePoint(14, 8000), makePoint(15, 12000), makePoint(18, 12000), makePoint(23, 200100)] },
    { name: 'first and last peaks', points: [makePoint(1, 200100), makePoint(31, 200100)] },
    { name: 'adjacent high peaks', points: [makePoint(22, 200000), makePoint(23, 200000), makePoint(24, 100000)] },
    { name: 'flat at the top of the axis', points: Array.from({ length: 31 }, (_, index) => makePoint(index + 1, 10000)) },
    { name: 'large amount', points: [makePoint(1, Number.MAX_SAFE_INTEGER), makePoint(23, Number.MAX_SAFE_INTEGER), makePoint(31, Number.MAX_SAFE_INTEGER)] }
  ]
  try {
    for (const profile of profiles) {
      f.props.points = profile.points
      for (const width of [180, 280, 390, 480, 640, 1200]) {
        f.chart.chartWidth.value = width
        dailyTooltipAssert.equal(f.chart.chartHeight.value, width < 480 ? 238 : 264)
        dailyTooltipAssert.equal(f.chart.plotTop.value, 18)
        dailyTooltipAssert.equal(f.chart.plotBottom.value - f.chart.plotTop.value, width < 480 ? 184 : 210)
        for (let index = 0; index < f.chart.days.value.length; index++) {
          f.chart.selectedIndex.value = index
          const label = profile.name + ', width=' + width + ', day=' + (index + 1)
          dailyTooltipAssertWithinChart(f.chart, label)
          const rect = dailyTooltipRect(f.chart)
          const right = rect.left + rect.width
          const bottom = rect.top + rect.height
          dailyTooltipAssert.ok(rect.left <= f.chart.selectedX.value && right >= f.chart.selectedX.value, label)
          if (rect.left > 8 && right < width - 8) {
            dailyTooltipAssert.ok(Math.abs(rect.left + rect.width / 2 - f.chart.selectedX.value) < 1e-8, label)
          }
          if (rect.top <= 8) {
            dailyTooltipAssert.ok(f.chart.selectedY.value <= rect.height + 20 + 1e-8, label)
          } else if (bottom >= f.chart.plotBottom.value - 8) {
            dailyTooltipAssert.ok(f.chart.selectedY.value - 12 >= f.chart.plotBottom.value - 8 - 1e-8, label)
          } else {
            dailyTooltipAssert.ok(Math.abs(f.chart.selectedY.value - bottom - 12) < 1e-8, label)
          }
        }
      }
    }
  } finally { f.unmount() }
})

dailyTooltipTest('daily keyboard selection retains boundaries and clears when month or loading changes', async () => {
  const f = dailyTooltipFixture()
  try {
    f.chart.handleFocus()
    dailyTooltipAssert.equal(f.chart.selectedPoint.value.date, '2026-10-01')
    let prevented = 0
    const key = (key: string) => f.chart.handleKeydown({ key, preventDefault: () => prevented++ })
    key('ArrowLeft')
    dailyTooltipAssert.equal(f.chart.selectedIndex.value, 0)
    key('ArrowRight')
    dailyTooltipAssert.equal(f.chart.selectedIndex.value, 1)
    key('End')
    key('ArrowRight')
    dailyTooltipAssert.equal(f.chart.selectedPoint.value.date, '2026-10-31')
    key('Home')
    dailyTooltipAssert.equal(f.chart.selectedIndex.value, 0)
    key('Enter')
    dailyTooltipAssert.equal(prevented, 5)
    f.props.month = '2026-02'
    f.props.points = [{ date: '2026-02-28', amountCents: 100 }]
    await dailyTooltipVue.nextTick()
    dailyTooltipAssert.equal(f.chart.selectedIndex.value, null)
    key('End')
    dailyTooltipAssert.equal(f.chart.selectedPoint.value.date, '2026-02-28')
    f.props.loading = true
    await dailyTooltipVue.nextTick()
    dailyTooltipAssert.equal(f.chart.selectedIndex.value, null)
    f.chart.handleFocus()
    key('Home')
    dailyTooltipAssert.equal(f.chart.selectedIndex.value, null)
    dailyTooltipAssert.equal(prevented, 6)
  } finally { f.unmount() }
})

dailyTooltipTest('daily touch selection requires its active pointer and keyboard selection survives pointer leave', () => {
  const f = dailyTooltipFixture()
  try {
    f.chart.handlePointerMove({ pointerType: 'touch', pointerId: 1, clientX: 30 })
    dailyTooltipAssert.equal(f.chart.selectedIndex.value, null)
    f.chart.handlePointerDown({ pointerType: 'touch', pointerId: 1, clientX: 30, button: 0 })
    const first = f.chart.selectedIndex.value
    f.chart.handlePointerMove({ pointerType: 'touch', pointerId: 2, clientX: 280 })
    dailyTooltipAssert.equal(f.chart.selectedIndex.value, first)
    f.chart.handlePointerMove({ pointerType: 'touch', pointerId: 1, clientX: 280 })
    dailyTooltipAssert.equal(f.chart.selectedPoint.value.date, '2026-10-31')
    f.chart.finishPointer()
    f.chart.handlePointerMove({ pointerType: 'touch', pointerId: 1, clientX: 30 })
    dailyTooltipAssert.equal(f.chart.selectedIndex.value, 30)
    f.element.ownerDocument.activeElement = f.element
    f.chart.handlePointerLeave({ pointerType: 'mouse' })
    dailyTooltipAssert.equal(f.chart.selectedIndex.value, 30)
    f.element.ownerDocument.activeElement = null
    f.chart.handlePointerLeave({ pointerType: 'mouse' })
    dailyTooltipAssert.equal(f.chart.selectedIndex.value, null)
  } finally { f.unmount() }
})

dailyTooltipTest('daily chart batches resize work and cancels pending observation on unmount', async () => {
  const f = dailyTooltipFixture()
  try {
    f.mount()
    await dailyTooltipVue.nextTick()
    f.resize()
    f.resize()
    dailyTooltipAssert.equal(f.frames.size, 1)
    f.flushFrame()
    dailyTooltipAssert.equal(f.chart.chartWidth.value, 280)
    f.chart.selectedIndex.value = 22
    const narrowHeight = f.chart.chartHeight.value
    f.element.clientWidth = 640
    f.resize()
    f.resize()
    dailyTooltipAssert.equal(f.frames.size, 1)
    f.flushFrame()
    dailyTooltipAssert.equal(f.chart.chartWidth.value, 640)
    dailyTooltipAssert.equal(f.chart.inlineTooltip.value, true)
    dailyTooltipAssert.equal(narrowHeight, 238)
    dailyTooltipAssert.equal(f.chart.chartHeight.value, 264)
    const style = f.chart.tooltipStyle.value
    dailyTooltipAssert.ok(Math.abs(Number.parseFloat(style.top) + Number.parseFloat(style.height) + 12 - f.chart.selectedY.value) < 1e-8)
    dailyTooltipAssertWithinChart(f.chart, 'resized chart')
    f.resize()
    dailyTooltipAssert.equal(f.frames.size, 1)
  } finally { f.unmount() }
  dailyTooltipAssert.equal(f.frames.size, 0)
  dailyTooltipAssert.equal(f.disconnected(), true)
})
