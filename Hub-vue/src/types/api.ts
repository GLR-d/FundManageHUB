import type { AxiosRequestConfig } from 'axios'

export type EntityId = string | number

export interface ApiResult<T = unknown> {
  code: number
  data: T
  msg?: string
}

export type RequestConfig = AxiosRequestConfig
