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
const categories = load('src/utils/expenseCategories.ts', { '@/utils/funds': funds })
const { buildMonthlyLimitProgress: build } = load('src/utils/monthlyLimitProgress.ts', {
  '@/utils/funds': funds, '@/utils/expenseCategories': categories
})
const points = (amountCents: number, type = '1') => [{ type, amountCents }]
const closeTo = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * Number.EPSILON * 4, `${actual} should equal ${expected}`)

test('monthly limit is unconfigured until a limit is set, even with existing expenses', () => {
  for (const amount of [0, 1250]) {
    const result = build(null, amount, points(amount))
    assert.equal(result.configured, false)
    assert.equal(result.exceeded, false)
    assert.equal(result.percentage, '0%')
    assert.equal(result.progressValue, 0)
    assert.equal(result.remainingCents, 0)
    assert.equal(result.overCents, 0)
    assert.equal(result.segments.length, 0)
  }
})

test('monthly limit with no expense leaves the full limit available', () => {
  const result = build(10000, 0, [])
  assert.equal(result.configured, true)
  assert.equal(result.exceeded, false)
  assert.equal(result.percentage, '0%')
  assert.equal(result.progressValue, 0)
  assert.equal(result.remainingCents, 10000)
  assert.equal(result.overCents, 0)
  assert.equal(result.segments.length, 0)
})

test('category segments use the configured limit and preserve common labels and colors', () => {
  const source = [{ type: '2', amountCents: 1000 }, { type: '1', amountCents: 2000 }, { type: '2', amountCents: 500 }, { type: '3', amountCents: 0 }]
  const before = JSON.stringify(source)
  const result = build(10000, 3500, source)
  assert.equal(result.percentage, '35%')
  assert.equal(result.progressValue, 35)
  assert.equal(result.remainingCents, 6500)
  assert.equal(result.overCents, 0)
  assert.equal(result.segments.length, 2)
  assert.equal(result.segments[0].widthPercentage, 20)
  assert.equal(result.segments[1].widthPercentage, 15)
  for (const segment of result.segments) {
    const common = categories.buildExpenseCategories(source).items.find((item: TestDouble) => item.type === segment.type)
    assert.equal(segment.label, common.label)
    assert.equal(segment.color, common.color)
    assert.equal(segment.backgroundColor, common.backgroundColor)
    assert.equal(segment.amountCents, common.amountCents)
  }
  assert.equal(JSON.stringify(source), before)
})

test('percentage rounds at one decimal and omits only a trailing zero', () => {
  assert.equal(build(10000, 4994, points(4994)).percentage, '49.9%')
  assert.equal(build(10000, 4995, points(4995)).percentage, '50%')
  assert.equal(build(10000, 5015, points(5015)).percentage, '50.2%')
  assert.equal(build(3, 1, points(1)).percentage, '33.3%')
  closeTo(build(3, 1, points(1)).progressValue, 100 / 3)
})

test('an exactly exhausted limit does not count as exceeded', () => {
  const result = build(10000, 10000, [{ type: '1', amountCents: 4000 }, { type: '2', amountCents: 6000 }])
  assert.equal(result.exceeded, false)
  assert.equal(result.percentage, '100%')
  assert.equal(result.progressValue, 100)
  assert.equal(result.remainingCents, 0)
  assert.equal(result.overCents, 0)
  assert.equal(result.segments.reduce((sum: number, segment: TestDouble) => sum + segment.widthPercentage, 0), 100)
})

test('exceeding the limit fills the bar proportionally while keeping every category', () => {
  const result = build(10000, 15000, [{ type: '1', amountCents: 9000 }, { type: '2', amountCents: 4500 }, { type: '3', amountCents: 1500 }])
  assert.equal(result.exceeded, true)
  assert.equal(result.percentage, '150%')
  assert.equal(result.progressValue, 100)
  assert.equal(result.overCents, 5000)
  assert.equal(result.remainingCents, 0)
  assert.equal(result.segments.length, 3)
  assert.equal(result.segments[0].widthPercentage, 60)
  assert.equal(result.segments[1].widthPercentage, 30)
  assert.equal(result.segments[2].widthPercentage, 10)
})

test('uneven divisions fill exactly the available progress within floating point precision', () => {
  for (const limit of [3, 7, 19, 1000]) {
    const result = build(limit, 9, [{ type: '1', amountCents: 3 }, { type: '2', amountCents: 3 }, { type: '3', amountCents: 3 }])
    closeTo(result.segments.reduce((sum: number, segment: TestDouble) => sum + segment.widthPercentage, 0), Math.min(100, 900 / limit))
    for (const segment of result.segments) assert.ok(segment.widthPercentage > 0 && segment.widthPercentage <= 100)
  }
})

test('invalid monetary inputs and inconsistent categories are rejected instead of concealed', () => {
  for (const invalid of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => build(invalid, 0, []), funds.FundDataError)
    assert.throws(() => build(null, invalid, []), funds.FundDataError)
    assert.throws(() => build(100, invalid, []), funds.FundDataError)
    assert.throws(() => build(100, 0, points(invalid)), funds.FundDataError)
  }
  assert.throws(() => build(0, 0, []), funds.FundDataError)
  assert.throws(() => build(100, 20, points(10)), funds.FundDataError)
  assert.throws(() => build(null, 20, points(10)), funds.FundDataError)
  assert.throws(() => build(100, 20, points(20, '')), funds.FundDataError)
  assert.throws(() => build(100, 20, [{ type: '1', amountCents: Number.MAX_SAFE_INTEGER }, { type: '2', amountCents: 1 }]), funds.FundDataError)
})

test('large safe amounts retain exact percentages and a small category without overflow', () => {
  const max = Number.MAX_SAFE_INTEGER
  const result = build(1, max, [{ type: '1', amountCents: max - 1 }, { type: '2', amountCents: 1 }])
  assert.equal(result.percentage, '900719925474099100%')
  assert.equal(result.exceeded, true)
  assert.equal(result.progressValue, 100)
  assert.equal(result.overCents, max - 1)
  assert.equal(result.segments[1].amountCents, 1)
  assert.ok(result.segments[1].widthPercentage > 0)
  assert.ok(Number.isFinite(result.segments[0].widthPercentage))
  closeTo(result.segments[0].widthPercentage + result.segments[1].widthPercentage, 100)
  const below = build(max, max - 1, points(max - 1))
  assert.equal(below.exceeded, false)
  assert.equal(below.remainingCents, 1)
  assert.equal(below.percentage, '100%')
  assert.ok(below.progressValue <= 100)
})
