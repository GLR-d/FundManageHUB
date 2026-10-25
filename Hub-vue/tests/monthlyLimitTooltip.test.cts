type LimitTooltipDouble = any
const tooltipTest: typeof import('node:test') = require('node:test')
const tooltipAssert: typeof import('node:assert/strict') = require('node:assert/strict')
import type { ScriptRuntimeFactory } from './helpers/scriptRuntime.cts'
const { createScriptRuntime }: { createScriptRuntime: ScriptRuntimeFactory } = require('./helpers/scriptRuntime.cts')
const tooltipVue = require('vue')

function limitTooltipFixture() {
  const props = tooltipVue.reactive({ expenseCents: 6000, categories: [{ type: '1', amountCents: 3000 }, { type: '2', amountCents: 2000 }, { type: '3', amountCents: 1000 }], periodLabel: '本月', statisticsLoaded: true, loading: false })
  const limit = { monthlyLimitCents: tooltipVue.ref(10000), monthlyLimitLoaded: tooltipVue.ref(true), monthlyLimitLoading: tooltipVue.ref(false), monthlyLimitError: tooltipVue.ref(null), loadMonthlyLimit: async () => true }
  const mounted: (() => void)[] = []
  const unmounted: (() => void)[] = []
  const frames = new Map<number, () => void>()
  const observed: unknown[] = []
  const unobserved: unknown[] = []
  let frameId = 0
  let resize = () => {}
  let disconnected = false
  const runtime = createScriptRuntime({
    mocks: {
      vue: { ...tooltipVue, useId: () => 'test', onMounted: (fn: () => void) => mounted.push(fn), onUnmounted: (fn: () => void) => unmounted.push(fn) },
      '@/stores/monthlyLimit': limit, 'vue-router': {}
    },
    globals: {
      defineProps: () => props, withDefaults: (value: LimitTooltipDouble) => value,
      requestAnimationFrame: (fn: () => void) => { frames.set(++frameId, fn); return frameId },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      ResizeObserver: class { constructor(fn: () => void) { resize = fn } observe(element: unknown) { observed.push(element) } unobserve(element: unknown) { unobserved.push(element) } disconnect() { disconnected = true } }
    }
  })
  const scope = tooltipVue.effectScope()
  const chart = scope.run(() => runtime.load('src/views/dashboard/components/monthlyExpenseLimit.vue', [
    'interactionElement', 'interactionWidth', 'progress', 'canInteract', 'selectedIndex', 'selectedSegment', 'tooltipStyle',
    'handleFocus', 'handleKeydown', 'handlePointerDown', 'handlePointerMove', 'handlePointerLeave', 'finishPointer', 'clearSelection', 'queueWidthUpdate'
  ]))
  const element = tooltipVue.markRaw({ clientWidth: 1000, getBoundingClientRect() { return { left: 100, width: this.clientWidth } } })
  chart.interactionElement.value = element
  return { chart, props, limit, element, frames, observed, unobserved, mount: () => mounted.forEach(fn => fn()), resize: () => resize(), disconnected: () => disconnected, unmount: () => { unmounted.splice(0).forEach(fn => fn()); scope.stop() } }
}
const limitPointer = (percentage: number, overrides: LimitTooltipDouble = {}) => ({ clientX: 100 + percentage * 10, pointerType: 'mouse', pointerId: 1, button: 0, ...overrides })
const limitKey = (key: string, overrides: LimitTooltipDouble = {}) => ({ key, preventDefault: () => {}, ...overrides })

tooltipTest('limit hover maps category boundaries and leaves unused budget without a misleading tooltip', async () => {
  const f = limitTooltipFixture()
  await tooltipVue.nextTick()
  for (const [percentage, expectedType] of [[0, '1'], [29.9, '1'], [30, '2'], [49.9, '2'], [50, '3'], [59.9, '3']] as const) {
    f.chart.handlePointerMove(limitPointer(percentage))
    tooltipAssert.equal(f.chart.selectedSegment.value.type, expectedType)
  }
  tooltipAssert.equal(f.chart.selectedSegment.value.amountCents, 1000)
  for (const percentage of [-1, 60, 100, 101]) {
    f.chart.handlePointerMove(limitPointer(percentage))
    tooltipAssert.equal(f.chart.selectedSegment.value, null)
  }
  f.chart.handlePointerDown(limitPointer(5, { button: 2 }))
  tooltipAssert.equal(f.chart.selectedSegment.value, null)
  f.chart.handlePointerMove(limitPointer(5))
  f.chart.handlePointerLeave({ pointerType: 'mouse' })
  tooltipAssert.equal(f.chart.selectedSegment.value, null)
  f.unmount()
})

tooltipTest('over-budget hover retains every category and includes the final edge', async () => {
  const f = limitTooltipFixture()
  f.limit.monthlyLimitCents.value = 3000
  await tooltipVue.nextTick()
  for (const [percentage, expectedType] of [[0, '1'], [51, '2'], [90, '3'], [100, '3']] as const) {
    f.chart.handlePointerMove(limitPointer(percentage))
    tooltipAssert.equal(f.chart.selectedSegment.value.type, expectedType)
  }
  f.unmount()
})

tooltipTest('limit tooltip stays inside narrow and wide track edges even for the maximum safe amount', async () => {
  const f = limitTooltipFixture()
  f.props.expenseCents = Number.MAX_SAFE_INTEGER
  f.props.categories = [{ type: '1', amountCents: Number.MAX_SAFE_INTEGER - 1 }, { type: '2', amountCents: 1 }]
  await tooltipVue.nextTick()
  for (const width of [180, 240, 360, 640, 1440]) {
    f.chart.interactionWidth.value = width
    for (const index of [0, 1]) {
      f.chart.selectedIndex.value = index
      const style = f.chart.tooltipStyle.value
      const left = Number.parseFloat(style.left)
      const tooltipWidth = Number.parseFloat(style.width)
      tooltipAssert.ok(left >= 8)
      tooltipAssert.ok(left + tooltipWidth <= width - 8)
      tooltipAssert.ok(Number.parseFloat(style['--limit-amount-size']) > 0)
    }
  }
  f.unmount()
})

tooltipTest('touch taps remain visible while moves from unrelated or finished touches are ignored', async () => {
  const f = limitTooltipFixture()
  await tooltipVue.nextTick()
  f.chart.handlePointerMove(limitPointer(5, { pointerType: 'touch' }))
  tooltipAssert.equal(f.chart.selectedIndex.value, null)
  f.chart.handlePointerDown(limitPointer(5, { pointerType: 'touch' }))
  f.chart.handlePointerMove(limitPointer(55, { pointerType: 'touch', pointerId: 2 }))
  tooltipAssert.equal(f.chart.selectedSegment.value.type, '1')
  f.chart.finishPointer({ pointerId: 2 })
  f.chart.handlePointerMove(limitPointer(55, { pointerType: 'touch' }))
  tooltipAssert.equal(f.chart.selectedSegment.value.type, '3')
  f.chart.finishPointer({ pointerId: 1 })
  f.chart.handlePointerLeave({ pointerType: 'touch' })
  f.chart.handlePointerMove(limitPointer(5, { pointerType: 'touch' }))
  tooltipAssert.equal(f.chart.selectedSegment.value.type, '3')
  f.chart.clearSelection()
  tooltipAssert.equal(f.chart.selectedIndex.value, null)
  f.unmount()
})

tooltipTest('keyboard selection uses one focus target and Escape dismisses without trapping Tab or shortcuts', async () => {
  const f = limitTooltipFixture()
  await tooltipVue.nextTick()
  f.chart.handleFocus()
  tooltipAssert.equal(f.chart.selectedIndex.value, 0)
  tooltipAssert.equal(f.chart.interactionWidth.value, 1000)
  for (const [key, expected] of [['ArrowLeft', 0], ['ArrowRight', 1], ['End', 2], ['ArrowRight', 2], ['Home', 0]] as const) {
    f.chart.handleKeydown(limitKey(key))
    tooltipAssert.equal(f.chart.selectedIndex.value, expected)
  }
  for (const key of [limitKey('Tab'), limitKey('End', { isComposing: true }), limitKey('End', { ctrlKey: true }), limitKey('End', { altKey: true }), limitKey('End', { metaKey: true })]) f.chart.handleKeydown(key)
  tooltipAssert.equal(f.chart.selectedIndex.value, 0)
  f.chart.handlePointerLeave({ pointerType: 'mouse' })
  tooltipAssert.equal(f.chart.selectedIndex.value, 0)
  let prevented = false
  f.chart.handleKeydown(limitKey('Escape', { preventDefault: () => { prevented = true } }))
  tooltipAssert.equal(prevented, true)
  tooltipAssert.equal(f.chart.selectedIndex.value, null)
  f.unmount()
})

tooltipTest('month, data, loading and configuration changes dismiss stale category selections', async () => {
  const f = limitTooltipFixture()
  await tooltipVue.nextTick()
  const change = async (run: () => void) => {
    f.chart.handleFocus()
    tooltipAssert.ok(f.chart.selectedSegment.value)
    run()
    await tooltipVue.nextTick()
    tooltipAssert.equal(f.chart.selectedIndex.value, null)
    tooltipAssert.equal(f.chart.selectedSegment.value, null)
  }
  await change(() => { f.props.periodLabel = '9月' })
  await change(() => { f.props.expenseCents = 1000; f.props.categories = [{ type: '2', amountCents: 1000 }] })
  await change(() => { f.props.loading = true })
  f.chart.handlePointerMove(limitPointer(5))
  f.chart.handleFocus()
  tooltipAssert.equal(f.chart.selectedSegment.value, null)
  f.props.loading = false
  await tooltipVue.nextTick()
  await change(() => { f.limit.monthlyLimitLoading.value = true })
  f.limit.monthlyLimitLoading.value = false
  await tooltipVue.nextTick()
  await change(() => { f.props.statisticsLoaded = false })
  f.props.statisticsLoaded = true
  await tooltipVue.nextTick()
  await change(() => { f.limit.monthlyLimitCents.value = null })
  tooltipAssert.equal(f.chart.canInteract.value, false)
  f.unmount()
})

tooltipTest('limit resize observation follows the conditional track and releases pending work on unmount', async () => {
  const f = limitTooltipFixture()
  f.mount()
  await tooltipVue.nextTick()
  tooltipAssert.ok(f.observed.includes(f.element))
  f.resize()
  f.resize()
  tooltipAssert.equal(f.frames.size, 1)
  const [id, frame] = [...f.frames][0]
  f.frames.delete(id)
  frame()
  tooltipAssert.equal(f.chart.interactionWidth.value, 1000)
  f.element.clientWidth = 240
  f.resize()
  const [nextId, nextFrame] = [...f.frames][0]
  f.frames.delete(nextId)
  nextFrame()
  tooltipAssert.equal(f.chart.interactionWidth.value, 240)
  f.chart.interactionElement.value = null
  await tooltipVue.nextTick()
  tooltipAssert.ok(f.unobserved.includes(f.element))
  f.resize()
  f.unmount()
  tooltipAssert.equal(f.disconnected(), true)
  tooltipAssert.equal(f.frames.size, 0)
})
