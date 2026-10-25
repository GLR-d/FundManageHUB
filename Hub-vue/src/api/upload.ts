import request from '@/utils/request'
import type { ApiResult, RequestConfig } from '@/types/api'
import type { UploadResponse } from '@/types/upload'

export const refreshImageUrl = (url: string, config: RequestConfig = {}) =>
  request.post<unknown, ApiResult<string>>('/upload/refresh', { url }, { ...config, silentError: true })

export const uploadPreparedImage = (file: Blob, filename = 'file', config: RequestConfig = {}) => {
  const data = new FormData()
  data.append(filename, file)
  return request.post<unknown, UploadResponse>('/upload', data, config)
}
