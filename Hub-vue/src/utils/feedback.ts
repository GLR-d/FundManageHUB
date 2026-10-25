import type { ToastType } from './toasts'
import { errorDetails } from './errors'
import { toastMessages } from './toasts'
import '../styles/feedback.css'

// 顶部居中的轻量提示，三秒后自动消失；相同提示合并显示。
export const createFeedback = (message = toastMessages) => {
  const show = (type: ToastType, value: unknown) => {
    const text = typeof value === 'string' ? value : String(errorDetails(value).message ?? value ?? '')
    if (!text.trim()) return
    return message[type]({
      message: text,
      duration: 3000
    })
  }
  return {
    error: (value: unknown) => show('error', value),
    warning: (value: unknown) => show('warning', value),
    info: (value: unknown) => show('info', value),
    success: (value: unknown) => show('success', value)
  }
}

export const feedback = createFeedback()

export const getRequestErrorMessage = (value: unknown) => {
  const error = errorDetails(value)
  const status = error.response?.status
  if (status === 403) return '没有权限访问'
  if (status === 404) return '请求的资源不存在'
  if (status && status >= 500) return '服务器暂时不可用，请稍后重试'
  if (status) return '请求失败 ' + status
  if (error.code === 'ECONNABORTED') return '请求超时，请稍后重试'
  if (error.request) return '网络连接失败，请检查网络'
  return '请求配置错误'
}
