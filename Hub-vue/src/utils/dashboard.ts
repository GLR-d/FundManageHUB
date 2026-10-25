import type { NormalizedDashboardStatistics } from '@/types/dashboard'

import { FundDataError, toCents, expenseTypes } from '@/utils/funds'

const validMonth = (month: string) => /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)
const amountCents = (amount: unknown) => {
  const cents = toCents(amount)
  if (!Number.isSafeInteger(cents)) throw new FundDataError('统计金额异常，无法准确显示')
  return cents
}
// 一次校验整份统计，失败时保留上次成功的卡片和曲线。
export const normalizeDashboardStatistics = (value: unknown, expectedMonth: string): NormalizedDashboardStatistics => {
  if (!validMonth(expectedMonth) || !value || typeof value !== 'object' || Array.isArray(value)) throw new FundDataError('统计数据格式异常，请重新加载')
  const data = value as Record<string, unknown>
  if (data.month !== expectedMonth) throw new FundDataError('统计月份不一致，请重新加载')
  const income = amountCents(data.income)
  const expense = amountCents(data.expense)
  const previousMonthExpense = amountCents(data.previousMonthExpense)
  const [year, month] = expectedMonth.split('-').map(Number)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (!Array.isArray(data.dailyExpenses) || data.dailyExpenses.length !== days) throw new FundDataError('每日支出数据不完整，请重新加载')
  let total = 0
  const dailyExpenses = data.dailyExpenses.map((item: unknown, index) => {
    const date = expectedMonth + '-' + String(index + 1).padStart(2, '0')
    if (!item || typeof item !== 'object' || Array.isArray(item) || (item as Record<string, unknown>).date !== date) throw new FundDataError('每日支出日期异常，请重新加载')
    const cents = amountCents((item as Record<string, unknown>).amount)
    total += cents
    if (!Number.isSafeInteger(total)) throw new FundDataError('统计合计金额过大，无法准确显示')
    return { date, amountCents: cents }
  })
  if (total !== expense) throw new FundDataError('每日支出与本月统计不一致，请重新加载')
  if (!Array.isArray(data.categoryExpenses)) throw new FundDataError('消费分类数据不完整，请重新加载')
  const categories = new Set<string>()
  let categoryTotal = 0
  const categoryExpenses = data.categoryExpenses.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new FundDataError('消费分类数据异常，请重新加载')
    const category = item as Record<string, unknown>
    if (typeof category.type !== 'string' || !expenseTypes.includes(category.type) || categories.has(category.type)) throw new FundDataError('消费分类数据异常，请重新加载')
    categories.add(category.type)
    const cents = amountCents(category.amount)
    categoryTotal += cents
    if (!Number.isSafeInteger(categoryTotal)) throw new FundDataError('统计合计金额过大，无法准确显示')
    return { type: category.type, amountCents: cents }
  })
  if (categoryTotal !== expense) throw new FundDataError('消费分类与本月统计不一致，请重新加载')
  const endMonth = year * 12 + month - 1
  const firstMonth = Math.max(1000 * 12, endMonth - 11)
  const monthCount = endMonth - firstMonth + 1
  if (monthCount < 1 || !Array.isArray(data.monthlyExpenses) || data.monthlyExpenses.length !== monthCount) throw new FundDataError('月支出数据不完整，请重新加载')
  const monthlyExpenses = data.monthlyExpenses.map((item: unknown, index) => {
    const serial = firstMonth + index
    const expected = String(Math.floor(serial / 12)).padStart(4, '0') + '-' + String(serial % 12 + 1).padStart(2, '0')
    if (!item || typeof item !== 'object' || Array.isArray(item) || (item as Record<string, unknown>).month !== expected) throw new FundDataError('月支出月份异常，请重新加载')
    return { month: expected, amountCents: amountCents((item as Record<string, unknown>).amount) }
  })
  if (monthlyExpenses.at(-1)?.amountCents !== expense || (monthlyExpenses.at(-2)?.amountCents ?? 0) !== previousMonthExpense) throw new FundDataError('月支出与本月或上月统计不一致，请重新加载')
  return { income, expense, previousMonthExpense, dailyExpenses, categoryExpenses, monthlyExpenses }
}

export const compareMonthlyExpense = (current: number, previous: number) => {
  if (![current, previous].every(value => Number.isSafeInteger(value) && value >= 0)) throw new FundDataError('对比金额异常，无法准确显示')
  const differenceCents = current - previous
  const direction = differenceCents > 0 ? 'increase' : differenceCents < 0 ? 'decrease' : 'same'
  return { direction, differenceCents }
}
