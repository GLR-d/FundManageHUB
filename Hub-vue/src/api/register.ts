import request from '@/utils/request'
import type { ApiResult, RequestConfig } from '@/types/api'

export const requestRegistrationCode = (data: { email: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult<null>>('/register/email/request', data, config)
export const addUser = (data: { email: string; code: string; password: string; name?: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult>('/register', data, config)
