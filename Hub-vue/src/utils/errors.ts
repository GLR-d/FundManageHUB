// 请求、表单和浏览器可能抛出任意值；在边界处统一收窄，业务代码不依赖 any。
export interface AppError { message?: string; code?: string; __CANCEL__?: boolean; isAxiosError?: boolean; request?: unknown; response?: { status?: number } }
export const errorDetails = (value: unknown): AppError => value && typeof value === 'object' ? value as AppError : {}
