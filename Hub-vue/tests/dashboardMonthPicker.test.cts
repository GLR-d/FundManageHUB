type PickerTestDouble = any
const pickerTest: typeof import('node:test') = require('node:test')
const pickerAssert: typeof import('node:assert/strict') = require('node:assert/strict')
import type { ScriptRuntimeFactory } from './helpers/scriptRuntime.cts'
const { createScriptRuntime }: { createScriptRuntime: ScriptRuntimeFactory } = require('./helpers/scriptRuntime.cts')
const pickerVue = require('vue')
function pickerFixture(value = '2026-10') {
  const props = pickerVue.reactive({ modelValue: value, currentYear: 2026 })
  const events: PickerTestDouble[] = []
  const focused: number[] = []
  const hides: boolean[] = []
  const opened = pickerVue.ref(false)
  const inside = {}
  const trigger = {}
  const buttons = Array.from({ length: 12 }, (_, index) => ({ focus: () => focused.push(index) }))
  const panel = { querySelectorAll: () => buttons, contains: (node: unknown) => node === inside }
  const runtime = createScriptRuntime({
    mocks: {
      vue: { ...pickerVue, useId: () => 'test' },
      '@/composables/useFloatingPanel': { useFloatingPanel: () => ({ opened, panelStyle: pickerVue.ref({}), show: async () => { opened.value = true }, hide: (restore = false) => { hides.push(restore); opened.value = false }, sync: () => {} }) }
    },
    globals: { defineProps: () => props, defineEmits: () => (...args: PickerTestDouble[]) => events.push(args) }
  })
  const picker = runtime.load('src/views/dashboard/components/dashboardMonthPicker.vue', [
    'selected', 'monthLabel', 'viewYear', 'yearText', 'activeMonth', 'trigger', 'panel', 'open', 'toggle', 'moveYear',
    'commitYear', 'handleYearEnter', 'choose', 'isSelected', 'handleKeydown', 'handleFocusOut'
  ])
  picker.panel.value = panel
  picker.trigger.value = trigger
  return { picker, props, events, focused, hides, opened, inside, trigger }
}
const pickerKey = (key: string, month = true) => ({ key, target: { matches: () => month }, preventDefault: () => {}, stopPropagation: () => {} })

pickerTest('month title abbreviates the current year and responds when the current year changes', async () => {
  const f = pickerFixture()
  pickerAssert.equal(f.picker.monthLabel.value, '10月')
  f.props.currentYear = 2027
  pickerAssert.equal(f.picker.monthLabel.value, '2026年10月')
  f.props.modelValue = '2027-02'
  pickerAssert.equal(f.picker.monthLabel.value, '2月')
  f.props.modelValue = '2025-12'
  pickerAssert.equal(f.picker.monthLabel.value, '2025年12月')
  await pickerVue.nextTick()
})

pickerTest('opening focuses the selected month and choosing another month emits one normalized value', async () => {
  const f = pickerFixture()
  await f.picker.open()
  pickerAssert.equal(f.picker.viewYear.value, 2026)
  pickerAssert.equal(f.picker.activeMonth.value, 9)
  pickerAssert.equal(f.focused.at(-1), 9)
  f.picker.moveYear(-1)
  f.picker.choose(2)
  pickerAssert.deepEqual(f.events, [['update:modelValue', '2025-02']])
  pickerAssert.equal(f.opened.value, false)
  pickerAssert.equal(f.hides.at(-1), true)
  await f.picker.open()
  pickerAssert.equal(f.picker.viewYear.value, 2026)
  f.picker.choose(10)
  pickerAssert.equal(f.events.length, 1)
})

pickerTest('year navigation and direct entry stay within 1000 through 9999', () => {
  const f = pickerFixture('1000-01')
  f.picker.moveYear(-1)
  pickerAssert.equal(f.picker.viewYear.value, 1000)
  f.picker.yearText.value = '9999'
  f.picker.commitYear()
  f.picker.moveYear(1)
  pickerAssert.equal(f.picker.viewYear.value, 9999)
  for (const invalid of ['0999', '10000', '', 'abcd']) {
    f.picker.yearText.value = invalid
    f.picker.commitYear()
    pickerAssert.equal(f.picker.viewYear.value, 9999)
    pickerAssert.equal(f.picker.yearText.value, '9999')
  }
  f.picker.yearText.value = '1000'
  f.picker.commitYear()
  pickerAssert.equal(f.picker.viewYear.value, 1000)
  pickerAssert.equal(f.events.length, 0)
})

pickerTest('grid keyboard navigation crosses year boundaries while respecting absolute limits', async () => {
  const f = pickerFixture('2026-01')
  await f.picker.open()
  f.picker.handleKeydown(pickerKey('ArrowLeft'))
  pickerAssert.equal(f.picker.viewYear.value, 2025)
  pickerAssert.equal(f.picker.activeMonth.value, 11)
  f.picker.handleKeydown(pickerKey('ArrowDown'))
  pickerAssert.equal(f.picker.viewYear.value, 2026)
  pickerAssert.equal(f.picker.activeMonth.value, 2)
  f.picker.handleKeydown(pickerKey('Home'))
  pickerAssert.equal(f.picker.activeMonth.value, 0)
  f.picker.handleKeydown(pickerKey('End'))
  pickerAssert.equal(f.picker.activeMonth.value, 11)
  f.picker.handleKeydown(pickerKey('PageDown'))
  pickerAssert.equal(f.picker.viewYear.value, 2027)
  f.picker.handleKeydown(pickerKey('PageUp'))
  pickerAssert.equal(f.picker.viewYear.value, 2026)
  f.picker.viewYear.value = 1000
  f.picker.activeMonth.value = 0
  f.picker.handleKeydown(pickerKey('ArrowLeft'))
  pickerAssert.equal(f.picker.viewYear.value, 1000)
  pickerAssert.equal(f.picker.activeMonth.value, 0)
  f.picker.viewYear.value = 9999
  f.picker.activeMonth.value = 11
  f.picker.handleKeydown(pickerKey('ArrowRight'))
  pickerAssert.equal(f.picker.viewYear.value, 9999)
  pickerAssert.equal(f.picker.activeMonth.value, 11)
  await pickerVue.nextTick()
})

pickerTest('Escape restores focus and moving focus outside closes without trapping Tab', async () => {
  const f = pickerFixture()
  await f.picker.open()
  f.picker.handleFocusOut({ relatedTarget: f.inside })
  pickerAssert.equal(f.opened.value, true)
  f.picker.handleKeydown(pickerKey('Escape'))
  pickerAssert.equal(f.opened.value, false)
  pickerAssert.equal(f.hides.at(-1), true)
  await f.picker.open()
  f.picker.handleFocusOut({ relatedTarget: {} })
  pickerAssert.equal(f.opened.value, false)
  pickerAssert.equal(f.hides.at(-1), false)
})

pickerTest('an external selected month change updates the open grid and keeps selection accurate', async () => {
  const f = pickerFixture()
  await f.picker.open()
  f.props.modelValue = '2024-03'
  await pickerVue.nextTick()
  await pickerVue.nextTick()
  pickerAssert.equal(f.picker.viewYear.value, 2024)
  pickerAssert.equal(f.picker.activeMonth.value, 2)
  pickerAssert.equal(f.picker.isSelected(3), true)
  pickerAssert.equal(f.picker.isSelected(10), false)
  pickerAssert.equal(f.focused.at(-1), 2)
})

pickerTest('year input Enter respects IME composition and invalid month choices never emit', async () => {
  const f = pickerFixture()
  await f.picker.open()
  f.picker.yearText.value = '2025'
  const key = { isComposing: true, keyCode: 13, preventDefault: () => {}, stopPropagation: () => {} }
  f.picker.handleYearEnter(key)
  pickerAssert.equal(f.picker.viewYear.value, 2026)
  f.picker.handleYearEnter({ ...key, isComposing: false, keyCode: 229 })
  pickerAssert.equal(f.picker.viewYear.value, 2026)
  f.picker.handleYearEnter({ ...key, isComposing: false })
  pickerAssert.equal(f.picker.viewYear.value, 2025)
  for (const invalid of [0, 13, 2.5, NaN]) f.picker.choose(invalid)
  pickerAssert.equal(f.events.length, 0)
  pickerAssert.equal(f.opened.value, true)
  await pickerVue.nextTick()
})

pickerTest('choosing a month commits a pending year draft before emitting', async () => {
  const f = pickerFixture()
  await f.picker.open()
  f.picker.yearText.value = '2028'
  f.picker.choose(1)
  pickerAssert.deepEqual(f.events, [['update:modelValue', '2028-01']])
  pickerAssert.equal(f.opened.value, false)
})
