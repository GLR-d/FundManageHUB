import request from '@/utils/request'
import type { ApiResult, RequestConfig } from '@/types/api'
import type { DashboardStatistics } from '@/types/dashboard'

export const getDashboardStatisticsapi = (month: string, config: RequestConfig = {}) => request.get<unknown, ApiResult<DashboardStatistics>>('/dashboard/statistics', { ...config, params: { ...config.params, month } })
