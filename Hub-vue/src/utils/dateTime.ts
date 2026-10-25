import type { DateParts, DateTimeParts } from '@/types/dateTime'

export const padTime = (value: number | string) => String(value).padStart(2, '0')
const utcDate = (year: number, month: number, day: number) => {
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return date
}
export const parseDateTime = (value: unknown) => {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null
  const [year, month, day, hour, minute, second = 0] = match.slice(1).map(Number)
  const date = utcDate(year, month, day)
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null
  return { year, month, day, hour, minute }
}
export const localDateTime = (date = new Date()) => ({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() })
export const dateKey = (value: DateParts) => String(value.year).padStart(4, '0') + '-' + padTime(value.month) + '-' + padTime(value.day)
export const formatDateTime = (value: DateTimeParts) => dateKey(value) + ' ' + padTime(value.hour) + ':' + padTime(value.minute)
export const shiftDate = <T extends DateParts>(value: T, days: number) => {
  const date = utcDate(value.year, value.month, value.day + days)
  const year = date.getUTCFullYear()
  if (year < 1 || year > 9999) return { ...value }
  return { ...value, year, month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}
export const shiftMonth = (year: number, month: number, delta: number) => {
  const date = utcDate(year, month + delta, 1)
  const nextYear = date.getUTCFullYear()
  return nextYear < 1 || nextYear > 9999 ? { year, month } : { year: nextYear, month: date.getUTCMonth() + 1 }
}
export const calendarDays = (year: number, month: number) => {
  const first = utcDate(year, month, 1)
  const offset = (first.getUTCDay() + 6) % 7
  return Array.from({ length: 42 }, (_, index) => {
    const date = utcDate(year, month, 1 - offset + index)
    const value = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
    return { ...value, key: dateKey(value), currentMonth: value.month === month, disabled: value.year < 1 || value.year > 9999 }
  })
}
