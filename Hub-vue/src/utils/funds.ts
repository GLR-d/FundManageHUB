import type { FundRecord, FundPage, FundsByDay } from '@/types/fund'

export const typeMap: Record<string, string> = {
  '0': '消费', '1': '餐饮', '2': '购物', '3': '住房',
  '4': '娱乐', '5': '其他', '6': '薪资', '7': '理财', '8': '交通',
  '9': '收转账', '10': '收红包'
}

export type FundTypeColors = {
  background: string
  color: string
}
const fundTypeColors: Record<string, FundTypeColors> = {
  '0': { background: '#fff3c4', color: '#946500' },
  '1': { background: '#ffe2c2', color: '#a8510f' },
  '2': { background: '#d3def7', color: '#29458f' },
  '3': { background: '#fce0e0', color: '#b83e46' },
  '4': { background: '#def5ff', color: '#16789f' },
  '5': { background: '#eef1f4', color: '#68758a' },
  '6': { background: '#fce0e0', color: '#b83e46' },
  '7': { background: '#fff3c4', color: '#946500' },
  '8': { background: '#dcecff', color: '#2868be' },
  '9': { background: '#fff3c4', color: '#946500' },
  '10': { background: '#fce0e0', color: '#b83e46' }
}
export const getFundTypeColors = (type: string | number): FundTypeColors =>
  Object.hasOwn(fundTypeColors, String(type)) ? fundTypeColors[String(type)]! : fundTypeColors['5']!

export const incomeTypes = ['6', '7', '9', '10']
export const expenseTypes = ['0', '1', '2', '3', '8', '4', '5']
export const typeOptions = [...expenseTypes, ...incomeTypes].map(value => ({ value, label: typeMap[value]! }))

export const toCents = (amount: unknown) => {
  if (!['string', 'number'].includes(typeof amount)) return NaN
  const match = String(amount).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/)
  if (!match) return NaN
  // 先拆成整数元和分，避免小数乘 100 时的二进制浮点误差。
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : NaN
}
export const formatCents = (cents: number) => {
  if (!Number.isSafeInteger(cents)) throw new FundDataError('合计金额过大，无法准确显示')
  const absolute = Math.abs(cents)
  return (cents < 0 ? '-' : '') + Math.floor(absolute / 100) + '.' + String(absolute % 100).padStart(2, '0')
}
export class FundDataError extends Error {
  code = 'INVALID_FUND_DATA'
  constructor(message: string) { super(message); this.code = 'INVALID_FUND_DATA' }
}
const addCents = (sum: number, value: number) => {
  const result = sum + value
  if (!Number.isSafeInteger(result)) throw new FundDataError('账单合计金额过大，无法准确显示')
  return result
}
export const calculateFundTotals = (items: unknown) => {
  if (!Array.isArray(items)) throw new FundDataError('账单数据格式异常，请重新加载')
  let income = 0
  let expense = 0
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.hasOwn(typeMap, String(item.type))) throw new FundDataError('账单类型或记录异常，请重新加载')
    const cents = toCents(item.amount)
    if (!Number.isSafeInteger(cents)) throw new FundDataError('账单金额异常，无法准确显示')
    if (incomeTypes.includes(String(item.type))) income = addCents(income, cents)
    else expense = addCents(expense, cents)
  }
  return { income, expense }
}
// 显式解析后端日期和时间，避免不同浏览器对空格、斜线日期的解析差异。
const parseFundTime = (value: unknown, dateOnly = false) => {
  const match = typeof value === 'string' && value.trim().match(/^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:(?:T| )(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/)
  if (!match || (dateOnly && match[5])) throw new FundDataError('账单日期或时间异常，请重新加载')
  const [, yearText, , monthText, dayText, hourText = '0', minuteText = '0', secondText = '0', fraction = '', zone = ''] = match
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, '0').slice(0, 3)))
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) throw new FundDataError('账单日期或时间异常，请重新加载')
  let stamp = date.getTime()
  if (zone && zone !== 'Z') {
    const offset = zone.match(/^([+-])(\d{2}):?(\d{2})$/)!
    if (+offset[2] > 23 || +offset[3] > 59) throw new FundDataError('账单时区异常，请重新加载')
    stamp -= (offset[1] === '+' ? 1 : -1) * (+offset[2] * 60 + +offset[3]) * 60000
  }
  return { stamp, fraction: Number(fraction.padEnd(9, '0').slice(3)) }
}
const descendingTime = (a: { stamp: number; fraction: number }, b: { stamp: number; fraction: number }) => b.stamp - a.stamp || b.fraction - a.fraction
export const normalizeFunds = (data: unknown): FundsByDay => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new FundDataError('账单数据格式异常，请重新加载')
  const days = Object.entries(data).map(([key, rows]) => {
    const time = parseFundTime(key, true)
    calculateFundTotals(rows)
    const sorted = (rows as FundRecord[]).map(row => ({ row, time: parseFundTime(row.time) }))
      .sort((a, b) => descendingTime(a.time, b.time)).map(item => item.row)
    return { key, rows: sorted, time }
  }).filter(day => day.rows.length)
  days.sort((a, b) => descendingTime(a.time, b.time))
  return Object.fromEntries(days.map(day => [day.key, day.rows]))
}

export const validateAmount = (value: unknown) => {
  if (value === '' || value === null || value === undefined) return '请输入金额'
  const text = String(value).trim()
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return '金额必须为非负数，最多两位小数'
  if (!Number.isSafeInteger(toCents(text))) return '金额过大'
  if (typeof value === 'number' && value.toFixed(2) !== formatCents(toCents(value))) return '金额过大，当前输入无法精确到分'
  return ''
}

export const fundCount = (data: FundsByDay) => Object.values(data).reduce((total, rows) => total + (Array.isArray(rows) ? rows.length : 0), 0)
// 校验整天分页协议，拒绝重叠日期或不前进的游标，避免无限追加。
export const normalizeFundPage = (value: unknown, { days = 5, before = null }: { days?: number; before?: string | null } = {}): FundPage => {
  const data = value as Partial<FundPage> | null
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.hasMore !== 'boolean') throw new FundDataError('账单分页数据异常，请重新加载')
  const items = normalizeFunds(data.items)
  const keys = Object.keys(items)
  for (const day of keys) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || (before && day >= before)) throw new FundDataError('账单分页日期异常，请重新加载')
  }
  if (keys.length > days || (data.hasMore && (!keys.length || data.nextCursor !== keys.at(-1))) || (!data.hasMore && data.nextCursor !== null)) throw new FundDataError('账单分页游标异常，请重新加载')
  return { items, hasMore: data.hasMore, nextCursor: data.nextCursor as string | null }
}
