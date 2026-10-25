import type { DailyExpensePoint } from '@/types/dashboard'

export type ExpenseTrendPoint = DailyExpensePoint

export interface ExpenseScale {
  maximum: number
  ticks: number[]
}

/** Produce one point per calendar day without trusting dates or non-integer money. */
export const fillExpenseMonth = (points: readonly ExpenseTrendPoint[], month: string): ExpenseTrendPoint[] => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
  if (!match || Number(match[1]) < 1) return []
  const end = new Date(0)
  end.setUTCFullYear(Number(match[1]), Number(match[2]), 0)
  const days = end.getUTCDate()
  const amounts = new Map<string, number>()
  for (const point of points) {
    if (!point || !Number.isSafeInteger(point.amountCents) || point.amountCents < 0 || typeof point.date !== 'string') continue
    if (!point.date.startsWith(month + '-') || !/^\d{4}-\d{2}-\d{2}$/.test(point.date)) continue
    const day = Number(point.date.slice(-2))
    if (day < 1 || day > days) continue
    amounts.set(point.date, point.amountCents)
  }
  return Array.from({ length: days }, (_, index) => {
    const date = month + '-' + String(index + 1).padStart(2, '0')
    return { date, amountCents: amounts.get(date) ?? 0 }
  })
}

/** The axis always has a nonzero range, including a month with no expenses. */
export const createExpenseScale = (maximumCents: number): ExpenseScale => {
  const maximum = Number.isFinite(maximumCents) && maximumCents > 0 ? maximumCents : 100
  const rawStep = maximum / 4
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const fraction = rawStep / magnitude
  const multiple = [1, 2, 2.5, 5, 10].find(value => value >= fraction) ?? 10
  const step = Math.max(1, Math.ceil(multiple * magnitude))
  const count = Math.ceil(maximum / step)
  return { maximum: count * step, ticks: Array.from({ length: count + 1 }, (_, index) => index * step) }
}

/** Day indices with enough space between labels; the first and last dates stay visible. */
export const getExpenseDayLabels = (dayCount: number, availableWidth: number): number[] => {
  if (!Number.isInteger(dayCount) || dayCount < 1) return []
  if (dayCount === 1) return [0]
  const capacity = Math.max(2, Math.min(8, Math.floor(Math.max(0, availableWidth) / 52)))
  const step = Math.max(5, Math.ceil(dayCount / (capacity - 1) / 5) * 5)
  const labels = [0]
  for (let day = step; day < dayCount; day += step) labels.push(day - 1)
  const last = dayCount - 1
  if (labels.length > 1 && last - labels[labels.length - 1] < step / 2) labels.pop()
  labels.push(last)
  return labels
}

export const nearestExpenseDay = (x: number, left: number, width: number, dayCount: number): number => {
  if (!Number.isFinite(x) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0 || dayCount <= 1) return 0
  return Math.max(0, Math.min(dayCount - 1, Math.round((x - left) / width * (dayCount - 1))))
}

export const formatExpenseAxis = (cents: number): string => {
  const yuan = cents / 100
  const divisor = yuan >= 100_000_000 ? 100_000_000 : yuan >= 10_000 ? 10_000 : 1
  const suffix = divisor === 100_000_000 ? '亿' : divisor === 10_000 ? '万' : ''
  return Number((yuan / divisor).toFixed(2)).toString() + suffix
}
