import type { EntityId } from './api'

export interface FundRecord {
  id: EntityId
  time: string
  type: string | number
  amount: string | number
  remark?: string
  photo?: string
}

export interface FundForm {
  id?: EntityId
  time: string
  type: string
  amount: string | number | null
  remark?: string
  photo?: string
}

export type FundsByDay = Record<string, FundRecord[]>

export interface FundPage {
  items: FundsByDay
  hasMore: boolean
  nextCursor: string | null
}

export interface FundImportResult {
  imported: number
}

export interface FundFilter {
  searchType: string
  searchValue: string | number | boolean
}

export interface FundRequest {
  filter: FundFilter | null
  append: boolean
  before: string | null
  resetRange?: boolean
  minimumDays?: number
  throughDay?: string | null
}
