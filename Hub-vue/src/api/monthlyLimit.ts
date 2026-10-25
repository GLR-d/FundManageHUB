import request from '@/utils/request'
import type { ApiResult, RequestConfig } from '@/types/api'

export interface MonthlyLimitData { amount: string | null }
export const getMonthlyLimit = (config: RequestConfig = {}) => request.get<unknown, ApiResult<MonthlyLimitData>>('/user/monthly-limit', config)
export const updateMonthlyLimit = (data: MonthlyLimitData, config: RequestConfig = {}) => request.put<unknown, ApiResult<MonthlyLimitData>>('/user/monthly-limit', data, config)
