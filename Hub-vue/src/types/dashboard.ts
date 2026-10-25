export interface DailyExpense {
  date: string
  amount: string
}

export interface MonthlyExpense {
  month: string
  amount: string
}

export interface MonthlyExpensePoint {
  month: string
  amountCents: number
}

export interface CategoryExpense {
  type: string
  amount: string
}

export interface CategoryExpensePoint {
  type: string
  amountCents: number
}

export interface DashboardStatistics {
  month: string
  income: string
  expense: string
  previousMonthExpense: string
  dailyExpenses: DailyExpense[]
  categoryExpenses: CategoryExpense[]
  monthlyExpenses: MonthlyExpense[]
}

export interface DailyExpensePoint {
  date: string
  amountCents: number
}

export interface NormalizedDashboardStatistics {
  income: number
  expense: number
  previousMonthExpense: number
  dailyExpenses: DailyExpensePoint[]
  categoryExpenses: CategoryExpensePoint[]
  monthlyExpenses: MonthlyExpensePoint[]
}
