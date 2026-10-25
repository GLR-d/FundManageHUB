type TestDouble = any
const test: typeof import('node:test') = require('node:test')
const assert = require('node:assert/strict')
const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')
const vm: typeof import('node:vm') = require('node:vm')
const { transformSync } = require('esbuild')
const load = (file: string, mocks: Record<string, TestDouble> = {}): TestDouble => {
  const module = { exports: {} }
  const code = transformSync(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code
  vm.runInNewContext(code, { module, exports: module.exports, require: (name: string) => mocks[name] })
  return module.exports
}
const funds = load('src/utils/funds.ts')
const { buildExpenseCategories: build } = load('src/utils/expenseCategories.ts', { '@/utils/funds': funds })

test('category shares handle empty, zero and a single positive expense', () => {
  assert.equal(build([]).items.length, 0)
  assert.equal(build([{type:'1',amountCents:0}]).totalCents, 0)
  assert.equal(build([{type:'1',amountCents:10}]).items[0].percentage, '100.0%')
})

test('category rounding distributes equal shares deterministically to exactly 100 percent', () => {
  const result = build(['1','2','3'].map(type => ({type,amountCents:1})))
  assert.equal(result.items.reduce((sum: number,item: TestDouble)=>sum+item.percentageTenths,0), 1000)
  assert.equal(result.items[0].percentage, '33.4%')
  assert.equal(result.items[1].percentage, '33.3%')
})

test('category shares combine duplicates, sort by expense and leave the source untouched', () => {
  const input = [{type:'1',amountCents:5},{type:'2',amountCents:20},{type:'1',amountCents:5},{type:'3',amountCents:0}]
  const before = JSON.stringify(input)
  const result = build(input)
  assert.equal(result.totalCents,30)
  assert.equal(result.items.length,2)
  assert.equal(result.items[0].type,'2')
  assert.equal(result.items[0].percentage,'66.7%')
  assert.equal(result.items[1].amountCents,10)
  assert.equal(JSON.stringify(input),before)
})

test('category shares retain exact safe integer totals and reject invalid or overflowing amounts', () => {
  const result = build([{type:'1',amountCents:Number.MAX_SAFE_INTEGER-1},{type:'2',amountCents:1}])
  assert.equal(result.totalCents,Number.MAX_SAFE_INTEGER)
  assert.equal(result.items.reduce((sum: number,item: TestDouble)=>sum+item.percentageTenths,0),1000)
  assert.equal(result.items[1].percentage,'<0.1%')
  for (const amountCents of [-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>build([{type:'1',amountCents}]))
  assert.throws(()=>build([{type:'1',amountCents:Number.MAX_SAFE_INTEGER},{type:'2',amountCents:1}]))
})

test('category labels and colors remain stable when amounts reorder or a type is unknown', () => {
  const first = build([{type:'1',amountCents:1},{type:'2',amountCents:2},{type:'new',amountCents:3}])
  const second = build([{type:'1',amountCents:9},{type:'new',amountCents:1},{type:'2',amountCents:2}])
  assert.equal(first.items.find((item: TestDouble)=>item.type==='1').label,'餐饮')
  assert.equal(first.items.find((item: TestDouble)=>item.type==='new').label,'类型 new')
  for (const item of first.items) {
    const reordered = second.items.find((other: TestDouble)=>other.type===item.type)
    const sharedColors = funds.getFundTypeColors(item.type)
    assert.equal(item.color,reordered.color)
    assert.equal(item.backgroundColor,reordered.backgroundColor)
    assert.equal(item.color,sharedColors.color)
    assert.equal(item.backgroundColor,sharedColors.background)
  }
  assert.deepEqual(funds.getFundTypeColors(1),funds.getFundTypeColors('1'))
  for (const type of ['new','__proto__','constructor','toString']) {
    const item = build([{type,amountCents:1}]).items[0]
    const fallbackColors = funds.getFundTypeColors('5')
    assert.equal(item.label,'类型 ' + type)
    assert.equal(item.color,fallbackColors.color)
    assert.equal(item.backgroundColor,fallbackColors.background)
  }
})

test('transport expenses preserve existing type identifiers, income classification and selector order', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(funds.typeMap)), {
    '0': '消费', '1': '餐饮', '2': '购物', '3': '住房',
    '4': '娱乐', '5': '其他', '6': '薪资', '7': '理财', '8': '交通',
    '9': '收转账', '10': '收红包'
  })
  assert.deepEqual([...funds.incomeTypes], ['6', '7', '9', '10'])
  assert.deepEqual([...funds.expenseTypes], ['0', '1', '2', '3', '8', '4', '5'])
  assert.deepEqual(funds.typeOptions.map((option: TestDouble) => option.value).join(','), '0,1,2,3,8,4,5,6,7,9,10')
  const row = { id: 1, type: '8', amount: '12.50', time: '2026-10-23 12:00' }
  const normalized = funds.normalizeFunds({ '2026-10-23': [row] })
  assert.equal(normalized['2026-10-23'][0].type, '8')
  const totals = funds.calculateFundTotals([row, { type: '6', amount: '10.00' }, { type: '7', amount: '1.00' }])
  assert.equal(totals.expense, 1250)
  assert.equal(totals.income, 1100)
  const transport = build([{ type: '8', amountCents: totals.expense }]).items[0]
  assert.equal(transport.label, '交通')
  assert.equal(transport.percentage, '100.0%')
  assert.equal(transport.color, funds.getFundTypeColors(8).color)
  assert.equal(transport.backgroundColor, funds.getFundTypeColors(8).background)
})
test('incoming transfers and red packets normalize as income and share the requested red and yellow palettes', () => {
  const rows = [
    { id: 1, type: '9', amount: '12.50', time: '2026-10-23 10:15' },
    { id: 2, type: 10, amount: '8.25', time: '2026-10-23 11:15' },
    { id: 3, type: '6', amount: '100.00', time: '2026-10-23 09:15' },
    { id: 4, type: '7', amount: '1.00', time: '2026-10-23 08:15' }
  ]
  const normalized = funds.normalizeFunds({ '2026-10-23': rows })
  assert.deepEqual(Array.from(normalized['2026-10-23'], (row: TestDouble) => String(row.type)), ['10', '9', '6', '7'])
  const totals = funds.calculateFundTotals([...rows, { type: '0', amount: '2.00' }])
  assert.equal(totals.income, 12175)
  assert.equal(totals.expense, 200)
  for (const type of ['6', '9', '10', '7']) assert.equal(funds.expenseTypes.includes(type), false)
  for (const type of ['6', '10']) {
    assert.equal(funds.getFundTypeColors(type).background, '#fce0e0')
    assert.equal(funds.getFundTypeColors(type).color, '#b83e46')
  }
  for (const type of ['7', '9']) {
    assert.equal(funds.getFundTypeColors(type).background, '#fff3c4')
    assert.equal(funds.getFundTypeColors(type).color, '#946500')
  }
})
