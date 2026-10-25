import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, path, vue, root, plain, fixture, form } = require('./helpers/runtime.cts')
const { fundPage, fundDays } = require('./helpers/fundFixtures.cts')

test('feedback uses top messages that disappear automatically without confirmation', () => {
  const f = fixture()
  const calls: TestDouble[] = []
  const handler = { close: () => {} }
  const methods = Object.fromEntries(['error', 'warning', 'info', 'success'].map(type => [type, (options: TestDouble) => {
    calls.push({ type, ...plain(options) })
    return handler
  }]))
  const feedback = f.load('src/utils/feedback.ts').createFeedback(methods)
  for (const type of ['error', 'warning', 'info', 'success']) assert.equal(feedback[type]('测试提示'), handler)
  feedback.error(' ')
  assert.equal(calls.length, 4)
  for (const call of calls) {
    assert.equal(call.message, '测试提示')
    assert.equal(call.duration, 3000)
  }
})

test('money totals use integer cents and invalid amounts are rejected', () => {
  const f = fixture()
  const funds = f.load('src/utils/funds.ts')
  const items = [{ type: 6, amount: '0.30' }, { type: 0, amount: '0.10' }]
  const totals = funds.calculateFundTotals(items)
  assert.equal((totals.income - totals.expense) / 100, 0.2)
  for (const value of ['', null, -1, 'abc', '1.234', Infinity]) assert.notEqual(funds.validateAmount(value), '')
  for (const value of [0, '0', '1.20', 1.2]) assert.equal(funds.validateAmount(value), '')
})

test('mobile bottom navigation opens bill entry while desktop collapse remains independent', async () => {
  const f = fixture()
  const pushes: TestDouble[] = []
  f.router.push = async (target: TestDouble) => pushes.push(plain(target))
  const layout = f.load('src/layout/index.vue', ['isNarrow', 'menuCollapsed', 'syncMenu', 'toggleMenu', 'mobileNavigation', 'openBillEntry', 'userMenuOpen', 'handleKeydown', 'isMobileNavigationCurrent'])
  layout.syncMenu({ matches: true })
  assert.equal(layout.isNarrow.value, true)
  assert.deepEqual(plain(layout.mobileNavigation.map((item: TestDouble) => item.label)), ['首页', '记账', '聊天', '我的'])
  layout.openBillEntry()
  await vue.nextTick()
  assert.deepEqual(pushes, [{ path: '/fund', query: { record: 'new' } }])
  f.router.currentRoute.value = { path: '/setting' }
  assert.equal(layout.isMobileNavigationCurrent('/my'), true)
  assert.equal(layout.isMobileNavigationCurrent('/fund'), false)
  f.router.currentRoute.value = { path: '/about' }
  assert.equal(layout.isMobileNavigationCurrent('/my'), true)
  layout.syncMenu({ matches: false })
  layout.toggleMenu()
  assert.equal(layout.menuCollapsed.value, true)
  f.router.currentRoute.value = { path: '/my' }
  await vue.nextTick()
  assert.equal(layout.menuCollapsed.value, true)
  layout.toggleMenu()
  f.router.currentRoute.value = { path: '/chat' }
  await vue.nextTick()
  assert.equal(layout.menuCollapsed.value, false)
  layout.userMenuOpen.value = true
  layout.handleKeydown({ key: 'Escape' })
  assert.equal(layout.userMenuOpen.value, false)
})

test('cent conversion and display preserve large decimal strings and reject unsafe numeric input', () => {
  const funds = fixture().load('src/utils/funds.ts')
  assert.equal(funds.toCents('90071992547409.90'), 9007199254740990)
  assert.equal(funds.formatCents(funds.toCents('90071992547409.90')), '90071992547409.90')
  assert.equal(funds.formatCents(Number.MAX_SAFE_INTEGER), '90071992547409.91')
  assert.equal(funds.formatCents(-123), '-1.23')
  assert.equal(funds.toCents('00001.20'), 120)
  assert.equal(funds.validateAmount('90071992547409.91'), '')
  assert.ok(funds.validateAmount('90071992547409.92'))
  assert.ok(funds.validateAmount(90071992547409.9))
  for (const invalid of [null, false, {}, 'bad', '1.234', Infinity]) assert.ok(Number.isNaN(funds.toCents(invalid)))
})

test('unsafe income or expense totals fail before they can be displayed', () => {
  const funds = fixture().load('src/utils/funds.ts')
  const rows = [{ type: '6', amount: '90071992547409.91' }, { type: '6', amount: '0.01' }]
  assert.throws(() => funds.calculateFundTotals(rows), (error: TestDouble) => error.code === 'INVALID_FUND_DATA')
  assert.throws(() => funds.calculateFundTotals(rows.map(row => ({ ...row, type: '0' }))), /合计金额过大/)
  assert.throws(() => funds.formatCents(Number.MAX_SAFE_INTEGER + 1), /合计金额过大/)
})

test('bill dates sort consistently without relying on browser string-date parsing', () => {
  class NoStringDate extends Date {
    constructor(...values: ConstructorParameters<typeof Date>) { if (typeof values[0] === 'string') throw new Error('string dates are unsupported'); super(...values) }
  }
  const funds = fixture({}, undefined, { Date: NoStringDate }).load('src/utils/funds.ts')
  const row = (id: TestDouble, time: TestDouble) => ({ id, time, type: '1', amount: '0.10' })
  const result = funds.normalizeFunds({
    '2026-9-30': [row(1, '2026-9-30 12:00')],
    '2026/10/12': [row(2, '2026/10/12 12:00:00.100001'), row(3, '2026-10-12T11:00:00Z'), row(4, '2026-10-12T12:00:00.100002'), row(5, '2026-10-12T12:00:00+02:00')],
    '2026-10-01': []
  })
  assert.deepEqual(Object.keys(result), ['2026/10/12', '2026-9-30'])
  assert.deepEqual(plain(result['2026/10/12'].map((item: TestDouble) => item.id)), [4, 2, 3, 5])
})

test('malformed bill responses and impossible calendar dates are rejected instead of silently emptied', () => {
  const funds = fixture().load('src/utils/funds.ts')
  const row = { id: 1, type: '1', amount: 1, time: '2026-10-12 12:00' }
  for (const data of [null, [], { '2026-10-12': null }, { '2026-10-12': [null] }, { '2026-02-30': [] },
    { '2026-10-12': [{ ...row, amount: 'bad' }] }, { '2026-10-12': [{ ...row, type: 'unknown' }] },
    { '2026-10-12': [{ ...row, time: '2026-10-12 24:00' }] }, { '2026-10-12': [{ ...row, time: '2026-02-29 12:00' }] }]) {
    assert.throws(() => funds.normalizeFunds(data), (error: TestDouble) => error.code === 'INVALID_FUND_DATA')
  }
  assert.deepEqual(plain(funds.normalizeFunds({})), {})
  assert.equal(Object.keys(funds.normalizeFunds({ '2024-02-29': [{ ...row, time: '2024-02-29 12:00' }] })).length, 1)
})

test('bill pages reject malformed envelopes, overlapping dates and non-advancing cursors', () => {
  const { normalizeFundPage } = fixture().load('src/utils/funds.ts')
  const first = fundDays(12, 8)
  const valid = fundPage(first, true)
  assert.deepEqual(plain(normalizeFundPage(valid)), valid)
  assert.deepEqual(plain(normalizeFundPage(fundPage())), fundPage())
  assert.deepEqual(plain(normalizeFundPage(fundPage(fundDays(7, 6)), { days: 5, before: '2026-10-08' })), fundPage(fundDays(7, 6)))
  const invalid = [null, [], {}, { items: first, hasMore: 'true', nextCursor: '2026-10-08' },
    { items: [], hasMore: false, nextCursor: null },
    fundPage(fundDays(12, 7)),
    { items: {}, hasMore: true, nextCursor: null },
    { ...valid, nextCursor: '2026-10-09' },
    { ...valid, nextCursor: null },
    { items: first, hasMore: false, nextCursor: '2026-10-08' },
    fundPage({ '2026/10/12': first['2026-10-12'] })
  ]
  for (const data of invalid) assert.throws(() => normalizeFundPage(data), (error: TestDouble) => error.code === 'INVALID_FUND_DATA')
  assert.throws(() => normalizeFundPage(valid, { days: 5, before: '2026-10-12' }), (error: TestDouble) => error.code === 'INVALID_FUND_DATA')
  assert.throws(() => normalizeFundPage(valid, { days: 4 }), (error: TestDouble) => error.code === 'INVALID_FUND_DATA')
})

test('bill list and search APIs forward day cursors and cancellation without changing the request shape', async () => {
  const calls: TestDouble[] = []
  const request = { get: async (...args: TestDouble[]) => { calls.push(args); return { code: 1 } } }
  const f = fixture({ '@/utils/request': { default: request } })
  const fund = f.load('src/api/fund.ts')
  const config = { signal: new AbortController().signal, silentError: true, params: { days: 5, before: '2026-10-08' } }
  await fund.getFundapi(config)
  const filter = { searchType: '3', searchValue: 'rent', days: 5, before: '2026-10-08' }
  await fund.searchFundsapi(filter, { signal: config.signal, silentError: true })
  assert.equal(calls[0][0], '/fund')
  assert.equal(calls[0][1], config)
  assert.equal(calls[1][0], '/fund/search')
  assert.equal(calls[1][1].params, filter)
  assert.equal(calls[1][1].signal, config.signal)
  assert.equal(calls[1][1].silentError, true)
})

test('native form validation checks visible fields, whitespace, contacts and custom amount rules', async () => {
  const f=fixture()
  const validate=f.load('src/utils/formValidation.ts').validateFields
  const model={ name:' ', phone:'bad', email:'bad', amount:'1.999', password:'secret', confirmPassword:'different' }
  const rules={ name:[{required:true,message:'请输入姓名'}], phone:[{pattern:/^\+?[\d -]{7,20}$/,message:'手机号无效'}], email:[{type:'email',message:'邮箱无效'}], amount:[{validator:(rule: TestDouble,value: TestDouble,callback: TestDouble)=>callback(/^\d+(?:\.\d{1,2})?$/.test(value)?undefined:new Error('金额无效'))}], confirmPassword:[{validator:(rule: TestDouble,value: TestDouble,callback: TestDouble)=>callback(value===model.password?undefined:new Error('密码不一致'))}] }
  assert.deepEqual(plain(await validate(model,rules,['name'])),{name:'请输入姓名'})
  assert.deepEqual(Object.keys(await validate(model,rules)),['name','phone','email','amount','confirmPassword'])
  Object.assign(model,{name:'测试',phone:'13800000000',email:'qa@example.test',amount:'0.10',confirmPassword:'secret'})
  assert.deepEqual(plain(await validate(model,rules)),{})
})

test('native top notifications merge duplicates, renew their three-second lifetime and can close independently', () => {
  const timers=new Map();let sequence=0
  const f=fixture({},undefined,{setTimeout:(fn: TestDouble,delay: TestDouble)=>{const id=++sequence;timers.set(id,{fn,delay});return id},clearTimeout:(id: TestDouble)=>timers.delete(id)})
  const {showToast,toasts}=f.load('src/utils/toasts.ts')
  const first=showToast('error',{message:'失败',duration:3000})
  showToast('error',{message:'失败',duration:3000})
  assert.equal(toasts.value.length,1)
  assert.equal(timers.size,1)
  assert.equal([...timers.values()][0].delay,3000)
  showToast('success',{message:'成功',duration:3000})
  first.close()
  assert.equal(toasts.value.length,1)
  assert.equal(toasts.value[0].message,'成功')
  const last=[...timers.values()][0];last.fn()
  assert.equal(toasts.value.length,0)
  assert.equal(timers.size,0)
})

test('native delete confirmation rejects cancellation and never accepts an earlier superseded dialog', async () => {
  const f=fixture()
  const {confirmDialog,confirmation}=f.load('src/utils/confirm.ts')
  const first=confirmDialog.confirm('删除一笔？','删除账单')
  const rejection=assert.rejects(first,/取消操作/)
  const second=confirmDialog.confirm('删除两笔？','删除账单')
  await rejection
  assert.equal(confirmation.value.message,'删除两笔？')
  confirmDialog.accept()
  assert.equal(await second,true)
  assert.equal(confirmation.value,null)
  const third=confirmDialog.confirm('删除三笔？')
  const canceled=assert.rejects(third,/取消操作/)
  confirmDialog.close();await canceled
  assert.equal(confirmation.value,null)
})

test('date picker preserves local wall time and rejects impossible calendar dates and clock values', () => {
  const dates = fixture().load('src/utils/dateTime.ts')
  for (const value of ['2024-02-29 00:00', '2026-10-14 23:59', '0001-01-01 01:02']) {
    assert.equal(dates.formatDateTime(dates.parseDateTime(value)), value)
  }
  for (const value of ['', '2025-02-29 12:00', '2026-04-31 12:00', '2026-01-01 24:00', '2026-01-01 12:60', '2026-01-01 12:00:60', '0000-01-01 00:00']) {
    assert.equal(dates.parseDateTime(value), null)
  }
  const local = dates.localDateTime({ getFullYear: () => 2026, getMonth: () => 9, getDate: () => 14, getHours: () => 23, getMinutes: () => 59 })
  assert.equal(dates.formatDateTime(local), '2026-10-14 23:59')
})

test('calendar starts on Monday and includes each leap-month date exactly once', () => {
  const dates = fixture().load('src/utils/dateTime.ts')
  const days = dates.calendarDays(2024, 2)
  assert.equal(days.length, 42)
  assert.equal(days[0].key, '2024-01-29')
  assert.equal(new Set(days.map((day: TestDouble) => day.key)).size, 42)
  assert.equal(days.filter((day: TestDouble) => day.currentMonth).length, 29)
  assert.equal(days.filter((day: TestDouble) => day.key === '2024-02-29').length, 1)
  assert.equal(dates.calendarDays(1, 1).filter((day: TestDouble) => day.disabled && day.year >= 1).length, 0)
  assert.ok(dates.calendarDays(9999, 12).some((day: TestDouble) => day.disabled && day.year === 10000))
})

test('calendar navigation crosses year and leap-day boundaries without changing the clock', () => {
  const dates = fixture().load('src/utils/dateTime.ts')
  assert.deepEqual(plain(dates.shiftMonth(2026, 1, -1)), { year: 2025, month: 12 })
  assert.deepEqual(plain(dates.shiftMonth(2026, 12, 1)), { year: 2027, month: 1 })
  assert.deepEqual(plain(dates.shiftMonth(1, 1, -1)), { year: 1, month: 1 })
  const leapDay = dates.parseDateTime('2024-02-29 13:45')
  assert.equal(dates.formatDateTime(dates.shiftDate(leapDay, 1)), '2024-03-01 13:45')
  assert.equal(dates.formatDateTime(dates.shiftDate(leapDay, -1)), '2024-02-28 13:45')
})

test('date picker commits current wheel positions and blocks disabled commits', async () => {
  const events: TestDouble[] = []
  const opened = vue.ref(false)
  const f = fixture({
    vue: { ...vue, useAttrs: () => ({}), useId: () => 'date-test', inject: () => null },
    '@/composables/useFloatingPanel': { useFloatingPanel: () => ({ opened, panelStyle: vue.ref({}), show: async () => { opened.value = true }, hide: () => { opened.value = false }, sync: () => {} }) }
  })
  const props = vue.reactive({ modelValue: '2026-10-14 12:30', disabled: false })
  const picker = f.load('src/components/ui/uiDateTimePicker.vue', ['resetDraft','draft','timeWheels','apply','selectDay','toggle'], props, (event: TestDouble,value: TestDouble) => events.push([event,value]))
  picker.resetDraft()
  picker.timeWheels.hour = { getValue: () => 8 }
  picker.timeWheels.minute = { getValue: () => 5 }
  picker.apply()
  assert.deepEqual(events[0], ['update:modelValue','2026-10-14 08:05'])
  picker.timeWheels.hour = { getValue: () => 23 }
  picker.timeWheels.minute = { getValue: () => 59 }
  picker.apply()
  assert.deepEqual(events[2], ['update:modelValue','2026-10-14 23:59'])
  events.length = 0
  await picker.toggle()
  picker.selectDay({ year:2026,month:10,day:15 })
  assert.equal(events.length, 0)
  props.disabled = true
  await vue.nextTick()
  picker.apply()
  assert.equal(opened.value, false)
  assert.equal(events.length, 0)
})

test('custom selects support keyboard selection, skip disabled options and never emit while disabled', async () => {
  const events: TestDouble[] = []
  const opened = vue.ref(false)
  const f = fixture({
    vue: { ...vue, useAttrs: () => ({}), useId: () => 'select-test', inject: () => null },
    '@/composables/useFloatingPanel': { useFloatingPanel: () => ({ opened, panelStyle:vue.ref({}), show:async () => { opened.value = true }, hide:() => { opened.value = false }, sync:() => {} }) }
  })
  const props = vue.reactive({ modelValue:'a', disabled:false, options:[{value:'a',label:'A'},{value:'b',label:'B',disabled:true},{value:'c',label:'C'}],fieldControl:true })
  const select = f.load('src/components/ui/uiSelect.vue',['handleKeydown','activeIndex','choose'],props,(event: TestDouble,value: TestDouble) => events.push([event,value]))
  const key = (value: TestDouble) => select.handleKeydown({ key:value,preventDefault:() => {},stopPropagation:() => {} })
  key('ArrowDown')
  await vue.nextTick()
  key('ArrowDown')
  props.options = props.options.map((option: TestDouble) => ({ ...option }))
  await vue.nextTick()
  assert.equal(opened.value,true)
  key('Enter')
  assert.deepEqual(events,[['update:modelValue','c'],['change','c']])
  assert.equal(opened.value,false)
  events.length = 0
  props.disabled = true
  await vue.nextTick()
  select.choose(0)
  assert.equal(events.length,0)
})

test('field blur validates other fields but does not interrupt popup selection or dialog action clicks', () => {
  const checked: TestDouble[] = []
  const form = { errors:vue.ref({}),register:() => {},unregister:() => {},validateField:(field: TestDouble) => checked.push(field) }
  const f = fixture({vue:{...vue,inject:() => form,provide:() => {},useId:() => 'blur-test',onMounted:() => {},onUpdated:() => {},onUnmounted:() => {}}})
  const field = f.load('src/components/ui/uiField.vue',['root','handleFocusout'],{prop:'time'})
  const popupOption = { closest:() => null }
  const dialogAction = { closest:() => ({}) }
  const otherField = { closest:() => null }
  field.root.value = { contains:(target: TestDouble) => target === popupOption }
  field.handleFocusout({relatedTarget:popupOption})
  field.handleFocusout({relatedTarget:dialogAction})
  assert.deepEqual(checked,[])
  field.handleFocusout({relatedTarget:otherField})
  assert.deepEqual(checked,['time'])
})

test('time wheels select scrolled values, stop at valid boundaries and ignore disabled interaction', async () => {
  const events = []
  const props = vue.reactive({ modelValue:12,max:24,active:true,disabled:false,id:'wheel-test',label:'小时' })
  const f = fixture({}, undefined, { setTimeout, clearTimeout })
  const control = f.load('src/components/ui/uiTimeWheel.vue',['wheel','handleScroll','handleKeydown','getValue'],props,(event: TestDouble,value: TestDouble) => {
    events.push([event,value])
    if (event === 'update:modelValue') props.modelValue = value
  })
  control.wheel.value = {scrollTop:0,focus:() => {}}
  await vue.nextTick()
  assert.equal(control.wheel.value.scrollTop,12*36)
  control.wheel.value.scrollTop = 18*36
  control.handleScroll()
  assert.equal(props.modelValue,18)
  const key = (value: TestDouble) => control.handleKeydown({key:value,preventDefault:() => {},stopPropagation:() => {}})
  key('End')
  key('ArrowDown')
  assert.equal(control.getValue(),23)
  key('Home')
  key('ArrowUp')
  assert.equal(control.getValue(),0)
  await vue.nextTick()
  props.disabled = true
  await vue.nextTick()
  const count = events.length
  control.wheel.value.scrollTop = 6*36
  control.handleScroll()
  key('ArrowDown')
  assert.equal(events.length,count)
  f.unmount()
})

test('expense chart batches observer changes into a frame and cancels queued layout work on unmount', async () => {
  const mounts: TestDouble[] = [], unmounts: TestDouble[] = []
  const frames = new Map<number, TestDouble>()
  let id = 0, resize: TestDouble, disconnected = false
  const f = fixture({ vue: { ...vue, useId: () => 'expense-resize-test', onMounted: (fn: TestDouble) => mounts.push(fn), onUnmounted: (fn: TestDouble) => unmounts.push(fn) } }, undefined, {
    requestAnimationFrame: (fn: TestDouble) => { frames.set(++id, fn); return id },
    cancelAnimationFrame: (value: number) => frames.delete(value),
    ResizeObserver: class { constructor(callback: TestDouble) { resize = callback } observe() {} unobserve() {} disconnect() { disconnected = true } }
  })
  const chart = f.load('src/views/dashboard/components/expenseTrendChart.vue', ['chartElement', 'chartWidth'], { month:'2026-10', points:[], loading:false })
  const element = vue.markRaw({clientWidth:600})
  chart.chartElement.value = element
  mounts.forEach(fn => fn())
  await vue.nextTick()
  assert.equal(frames.size, 1)
  const fire = () => { const [key, callback] = [...frames][0]; frames.delete(key); callback() }
  fire()
  assert.equal(chart.chartWidth.value, 600)
  element.clientWidth = 300
  resize()
  resize()
  assert.equal(frames.size, 1)
  assert.equal(chart.chartWidth.value, 600)
  fire()
  assert.equal(chart.chartWidth.value, 300)
  resize()
  assert.equal(frames.size, 1)
  unmounts.forEach(fn => fn())
  assert.equal(disconnected, true)
  assert.equal(frames.size, 0)
})

test('dialog ignores backdrop clicks when disabled but explicit close still runs beforeClose', () => {
  const f = fixture()
  f.mocks.vue.useId = () => 'backdrop-disabled'
  const events: TestDouble[] = []
  let beforeCloseCalls = 0
  let measurements = 0
  const editor = f.load('src/components/ui/uiDialog.vue', ['dialog', 'backdropClose', 'requestClose'], {
    closeOnClickModal: false,
    beforeClose: (done: () => void) => { beforeCloseCalls++; done() }
  }, (...args: TestDouble[]) => events.push(args))
  const element = vue.markRaw({ getBoundingClientRect: () => { measurements++; return { left: 100, right: 300, top: 100, bottom: 300 } } })
  editor.dialog.value = element
  try {
    editor.backdropClose({ target: element, clientX: 50, clientY: 50 })
    assert.equal(beforeCloseCalls, 0)
    assert.equal(measurements, 0)
    assert.deepEqual(events, [])
    editor.requestClose()
    assert.equal(beforeCloseCalls, 1)
    assert.deepEqual(events, [['update:modelValue', false]])
  } finally { f.unmount() }
})

test('dialog backdrop dismissal defaults to enabled and ignores clicks inside its bounds or children', () => {
  for (const props of [{}, { closeOnClickModal: true }]) {
    const f = fixture()
    f.mocks.vue.useId = () => 'backdrop-enabled'
    const events: TestDouble[] = []
    const editor = f.load('src/components/ui/uiDialog.vue', ['dialog', 'backdropClose'], props, (...args: TestDouble[]) => events.push(args))
    const element = vue.markRaw({ getBoundingClientRect: () => ({ left: 100, right: 300, top: 100, bottom: 300 }) })
    try {
      editor.backdropClose({ target: element, clientX: 50, clientY: 50 })
      editor.dialog.value = element
      editor.backdropClose({ target: {}, clientX: 50, clientY: 50 })
      editor.backdropClose({ target: element, clientX: 200, clientY: 200 })
      editor.backdropClose({ target: element, clientX: 100, clientY: 100 })
      editor.backdropClose({ target: element, clientX: 300, clientY: 300 })
      assert.deepEqual(events, [])
      for (const [clientX, clientY] of [[99, 200], [301, 200], [200, 99], [200, 301]]) {
        editor.backdropClose({ target: element, clientX, clientY })
      }
      assert.deepEqual(events, Array.from({ length: 4 }, () => ['update:modelValue', false]))
    } finally { f.unmount() }
  }
})

test('dialog backdrop dismissal still honors a beforeClose guard that does not accept closing', () => {
  const f = fixture()
  f.mocks.vue.useId = () => 'backdrop-guard'
  const events: TestDouble[] = []
  let guarded = 0
  const editor = f.load('src/components/ui/uiDialog.vue', ['dialog', 'backdropClose'], {
    beforeClose: () => { guarded++ }
  }, (...args: TestDouble[]) => events.push(args))
  const element = vue.markRaw({ getBoundingClientRect: () => ({ left: 100, right: 300, top: 100, bottom: 300 }) })
  editor.dialog.value = element
  try {
    editor.backdropClose({ target: element, clientX: 99, clientY: 200 })
    assert.equal(guarded, 1)
    assert.deepEqual(events, [])
  } finally { f.unmount() }
})
