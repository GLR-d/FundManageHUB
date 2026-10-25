import request from '@/utils/request'
import type { ApiResult, RequestConfig } from '@/types/api'
import type { UserProfile } from '@/types/account'

export interface AccountVerificationGrant { verificationToken: string; expiresIn: number }
export const getUser = (config: RequestConfig = {}) => request.get<unknown, ApiResult<UserProfile>>('/user', config)
export const updateUser = (data: Partial<Pick<UserProfile, 'name' | 'avatar' | 'phone'>>, config: RequestConfig = {}) => request.put<unknown, ApiResult<UserProfile>>('/user', data, config)
export const requestCurrentEmailVerification = (data: { email: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult<null>>('/user/email/current/request', data, config)
export const verifyCurrentEmail = (data: { email: string; code: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult<AccountVerificationGrant>>('/user/email/current/verify', data, config)
export const requestEmailBinding = (data: { email: string; verificationToken: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult<null>>('/user/email/request', data, config)
export const verifyEmailBinding = (data: { email: string; code: string; verificationToken: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult<UserProfile>>('/user/email/verify', data, config)
export const requestPasswordChange = (data: { email: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult<null>>('/user/password/request', data, config)
export const verifyPasswordChange = (data: { email: string; code: string }, config: RequestConfig = {}) => request.post<unknown, ApiResult<AccountVerificationGrant>>('/user/password/verify', data, config)
export const changePassword = (data: { verificationToken: string; password: string } | { email: string; code: string; password: string }, config: RequestConfig = {}) => request.put<unknown, ApiResult<null>>('/user/password', data, config)
