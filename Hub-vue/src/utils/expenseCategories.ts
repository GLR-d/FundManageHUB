import type { CategoryExpensePoint } from '@/types/dashboard'

import { FundDataError, getFundTypeColors, typeMap } from '@/utils/funds'

export interface ExpenseCategoryShare extends CategoryExpensePoint {
  label: string
  color: string
  backgroundColor: string
  percentageTenths: number
  percentage: string
  share: number
  offset: number
}
// 金额放大计算使用 BigInt，按最大余数分配到 0.1%，使各项合计恰为 100.0%。
export const buildExpenseCategories = (points: readonly CategoryExpensePoint[]) => {
  const amounts = new Map<string, number>()
  let totalCents = 0
  for (const point of points) {
    if (typeof point.type !== 'string' || !point.type.trim() || !Number.isSafeInteger(point.amountCents) || point.amountCents < 0) throw new FundDataError('消费分类金额异常，无法准确显示')
    totalCents += point.amountCents
    if (!Number.isSafeInteger(totalCents)) throw new FundDataError('消费分类合计金额过大，无法准确显示')
    if (point.amountCents) amounts.set(point.type, (amounts.get(point.type) ?? 0) + point.amountCents)
  }
  if (!totalCents) return { totalCents: 0, items: [] as ExpenseCategoryShare[] }
  const total = BigInt(totalCents)
  const allocations = [...amounts].sort(([typeA, a], [typeB, b]) => b - a || typeA.localeCompare(typeB)).map(([type, amountCents]) => {
    const scaled = BigInt(amountCents) * 1000n
    return { type, amountCents, percentageTenths: Number(scaled / total), remainder: scaled % total }
  })
  let remaining = 1000 - allocations.reduce((sum, item) => sum + item.percentageTenths, 0)
  const byRemainder = [...allocations].sort((a, b) => a.remainder === b.remainder ? allocations.indexOf(a) - allocations.indexOf(b) : a.remainder > b.remainder ? -1 : 1)
  for (const item of byRemainder) { if (remaining-- <= 0) break; item.percentageTenths++ }
  let offset = 0
  const items: ExpenseCategoryShare[] = allocations.map(({ type, amountCents, percentageTenths }) => {
    const share = amountCents / totalCents
    const item = {
      type, amountCents, percentageTenths, share, offset,
      label: Object.hasOwn(typeMap, type) ? typeMap[type]! : '类型 ' + type,
      color: getFundTypeColors(type).color,
      backgroundColor: getFundTypeColors(type).background,
      percentage: percentageTenths ? Math.floor(percentageTenths / 10) + '.' + percentageTenths % 10 + '%' : '<0.1%'
    }
    offset += share
    return item
  })
  return { totalCents, items }
}
