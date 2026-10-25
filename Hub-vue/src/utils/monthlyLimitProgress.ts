import type { CategoryExpensePoint } from '@/types/dashboard'

import { buildExpenseCategories } from '@/utils/expenseCategories'
import { FundDataError } from '@/utils/funds'

export interface MonthlyLimitSegment {
  type: string
  label: string
  color: string
  backgroundColor: string
  amountCents: number
  widthPercentage: number
}

export interface MonthlyLimitProgress {
  configured: boolean
  exceeded: boolean
  percentage: string
  progressValue: number
  remainingCents: number
  overCents: number
  segments: MonthlyLimitSegment[]
}

// 保留足够的小数位，使安全整数范围内的一分钱分类仍能得到非零宽度。
const widthScale = 10n ** 20n
const roundedRatio = (numerator: bigint, denominator: bigint) => (numerator + denominator / 2n) / denominator
const widthAsNumber = (width: bigint) => Number(width) / Number(widthScale)

export const buildMonthlyLimitProgress = (
  limitCents: number | null,
  expenseCents: number,
  categories: readonly CategoryExpensePoint[]
): MonthlyLimitProgress => {
  if (limitCents !== null && (!Number.isSafeInteger(limitCents) || limitCents <= 0)) {
    throw new FundDataError('每月花销限额异常，无法准确显示')
  }
  if (!Number.isSafeInteger(expenseCents) || expenseCents < 0) {
    throw new FundDataError('本月支出金额异常，无法准确显示')
  }
  const { totalCents, items } = buildExpenseCategories(categories)
  if (totalCents !== expenseCents) throw new FundDataError('消费分类与本月支出不一致，无法准确显示')
  if (limitCents === null) return {
    configured: false, exceeded: false, percentage: '0%', progressValue: 0,
    remainingCents: 0, overCents: 0, segments: []
  }

  const expense = BigInt(expenseCents)
  const limit = BigInt(limitCents)
  const exceeded = expense > limit
  const percentageTenths = roundedRatio(expense * 1000n, limit)
  const percentage = `${percentageTenths / 10n}${percentageTenths % 10n ? '.' + percentageTenths % 10n : ''}%`
  // 超额时按总支出分配整条宽度，保证每一类都保留，不裁切最后的分类。
  const denominator = exceeded ? expense : limit
  const totalWidth = roundedRatio(expense * 100n * widthScale, denominator)
  const allocations = items.map(item => {
    const scaled = BigInt(item.amountCents) * 100n * widthScale
    return { item, width: scaled / denominator, remainder: scaled % denominator }
  })
  let unallocated = totalWidth - allocations.reduce((sum, item) => sum + item.width, 0n)
  const byRemainder = allocations.map((allocation, index) => ({ allocation, index })).sort((a, b) =>
    a.allocation.remainder === b.allocation.remainder ? a.index - b.index : a.allocation.remainder > b.allocation.remainder ? -1 : 1
  )
  for (const { allocation } of byRemainder) {
    if (unallocated <= 0n) break
    allocation.width++
    unallocated--
  }

  return {
    configured: true,
    exceeded,
    percentage,
    progressValue: Math.min(100, widthAsNumber(totalWidth)),
    remainingCents: exceeded ? 0 : limitCents - expenseCents,
    overCents: exceeded ? expenseCents - limitCents : 0,
    segments: allocations.map(({ item, width }) => ({
      type: item.type, label: item.label, color: item.color, backgroundColor: item.backgroundColor,
      amountCents: item.amountCents, widthPercentage: widthAsNumber(width)
    }))
  }
}
