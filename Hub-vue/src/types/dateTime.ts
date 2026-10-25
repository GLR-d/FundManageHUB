export interface DateParts {
  year: number
  month: number
  day: number
}

export interface DateTimeParts extends DateParts {
  hour: number
  minute: number
}
