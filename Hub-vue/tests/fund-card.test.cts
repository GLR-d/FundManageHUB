import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, vue, fixture } = require('./helpers/runtime.cts')
const { mountSfc } = require('./helpers/mountSfc.cts')

const cardProps = () => vue.reactive({
  day: '2026-10-12', rows: [{ id: 1, type: '1', amount: '0.29', time: '2026-10-12 12:34', remark: 'Lunch' }],
  selectedRows: [], showSelection: false, deleting: false, submitting: false
})

test('daily totals stay cached across selection and editor changes and update with the bill data', async () => {
  const funds = fixture().load('src/utils/funds.ts')
  let calculations = 0
  const props = cardProps()
  const card = mountSfc('src/views/fund/components/fundDayCard.vue', props, {}, {
    '@/utils/funds': { ...funds, calculateFundTotals: (rows: TestDouble) => { calculations++; return funds.calculateFundTotals(rows) } }
  })
  try {
    assert.match(card.text(), /0\.29/)
    assert.equal(calculations, 1)
    props.showSelection = true
    props.submitting = true
    props.selectedRows = [props.rows[0]]
    await vue.nextTick()
    assert.equal(calculations, 1)
    props.rows[0].amount = '0.30'
    await vue.nextTick()
    assert.match(card.text(), /0\.30/)
    assert.equal(calculations, 2)
  } finally { card.unmount() }
})

test('bill card renders time and amounts and forwards row and checkbox events through its public contract', async () => {
  const props = cardProps()
  const edits: TestDouble[] = []
  const keys: TestDouble[] = []
  const toggles: TestDouble[] = []
  const card = mountSfc('src/views/fund/components/fundDayCard.vue', props, {
    onEdit: (row: TestDouble) => edits.push(row),
    onRowKeydown: (...args: TestDouble[]) => keys.push(args),
    onToggleRow: (...args: TestDouble[]) => toggles.push(args)
  })
  try {
    assert.match(card.text(), /12:34/)
    assert.doesNotMatch(card.findAll('td')[1].text, /2026/)
    assert.match(card.text(), /−0\.29/)
    const row = card.findAll('tr')[0]
    assert.equal(row.props.tabindex, 0)
    card.trigger(row, 'onClick', {})
    const key = { key: 'Enter' }
    card.trigger(row, 'onKeydown', key)
    assert.equal(edits[0], props.rows[0])
    assert.equal(keys[0][0], key)
    assert.equal(keys[0][1], props.rows[0])
    props.showSelection = true
    props.selectedRows = [props.rows[0]]
    await vue.nextTick()
    const checkbox = card.findAll('input')[0]
    assert.equal(checkbox.props.checked, true)
    assert.equal(checkbox.props.disabled, false)
    card.trigger(checkbox, 'onChange', { target: { checked: false } })
    assert.deepEqual(toggles, [[props.rows[0], false]])
    props.deleting = true
    await vue.nextTick()
    assert.equal(checkbox.props.disabled, true)
  } finally { card.unmount() }
})
