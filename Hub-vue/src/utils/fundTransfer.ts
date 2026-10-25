import { errorDetails } from './errors'
import { getRequestErrorMessage } from './feedback'

export const fundImportMaxBytes = 2 * 1024 * 1024
export const validateFundImportFile = (file: File) => {
  if (!/\.csv$/i.test(file.name)) return '请选择 CSV 文件，暂不支持 .xlsx。'
  if (!file.size) return 'CSV 文件不能为空。'
  if (file.size > fundImportMaxBytes) return 'CSV 文件不能超过 2 MB。'
  return ''
}

const resultMessage = (value: unknown) => {
  if (!value || typeof value !== 'object' || !('msg' in value)) return ''
  return typeof value.msg === 'string' && value.msg.trim() ? value.msg : ''
}
const blobMessage = async (blob: Blob) => {
  try { return resultMessage(JSON.parse(await blob.text())) } catch { return '' }
}

// 下载接口的业务错误也可能返回 200 + JSON Blob，先校验再触发浏览器下载。
export const validateFundCsv = async (blob: Blob) => {
  if (!(blob instanceof Blob)) throw new Error(resultMessage(blob) || '未能获取 CSV 文件。')
  if (blob.type.toLowerCase().includes('json')) throw new Error(await blobMessage(blob) || '未能获取 CSV 文件。')
  if (!blob.size || !/^text\/csv(?:;|$)/i.test(blob.type)) throw new Error('未能获取 CSV 文件，请稍后重试。')
}

export const getFundTransferError = async (value: unknown) => {
  const error = errorDetails(value)
  if (error.__CANCEL__ || error.code === 'ERR_CANCELED' || error.response?.status === 401) return ''
  const response = error.response as { data?: unknown } | undefined
  const message = response?.data instanceof Blob ? await blobMessage(response.data) : resultMessage(response?.data)
  return message || (!error.isAxiosError && error.message) || getRequestErrorMessage(value)
}

export const saveFundCsv = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  try {
    link.href = url
    link.download = filename
    link.hidden = true
    document.body.appendChild(link)
    link.click()
  } finally {
    link.remove()
    // 延后一轮释放，让浏览器先取得下载内容。
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
