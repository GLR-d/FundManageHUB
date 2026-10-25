import request from '@/utils/request'
import type { ApiResult, RequestConfig } from '@/types/api'
import type { LoginUser } from '@/types/account'

export const loginapi = (data: { email: string; password: string; captcha: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult<LoginUser>>('/login', data, config)
export const getCaptcha = (config: RequestConfig = {}) => request.get<unknown, ApiResult<{ uuid: string; image: string }>>('/login/captcha', config)
export const verifyCaptcha = (data: { uuid: string; code: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult>('/login/verify', data, config)
export const logoutapi = (config: RequestConfig = {}) => request.post<unknown, ApiResult<null>>('/login/logout', undefined, config)
export const requestPasswordReset = (data: { email: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult<null>>('/login/password/forgot', data, config)
export const resetPassword = (data: { email: string; code: string; password: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult<null>>('/login/password/reset', data, config)
