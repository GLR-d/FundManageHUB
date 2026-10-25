import request from '@/utils/request'
import type { ApiResult, RequestConfig } from '@/types/api'
import type { FundForm, FundPage, FundFilter, FundImportResult } from '@/types/fund'

export const getFundapi = (config: RequestConfig = {}) => request.get<unknown, ApiResult<FundPage>>('/fund', config)
export const addFundapi = (data: FundForm, config: RequestConfig = {}) => request.post<unknown, ApiResult>('/fund', data, config)
export const updateFundapi = (data: FundForm, config: RequestConfig = {}) => request.put<unknown, ApiResult>('/fund', data, config)
export const deleteFundapi = (ids: string, config: RequestConfig = {}) => request.delete<unknown, ApiResult>(`/fund?ids=${ids}`, config)
export const searchFundsapi = (params: FundFilter & { days?: number; before?: string }, config: RequestConfig = {}) => request.get<unknown, ApiResult<FundPage>>('/fund/search', { ...config, params })
export const exportFundsapi = (config: RequestConfig = {}) => request.get<unknown, Blob>('/fund/export', { ...config, responseType: 'blob', silentError: true })
export const importFundsapi = (file: File, config: RequestConfig = {}) => {
  const data = new FormData()
  data.append('file', file)
  return request.post<unknown, ApiResult<FundImportResult>>('/fund/import', data, { ...config, silentError: true })
}
