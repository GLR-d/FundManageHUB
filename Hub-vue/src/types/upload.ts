import type { ApiResult } from './api'

export type UploadId = string | number

export type UploadRawFile = File & { uid?: UploadId }

export interface UploadFile {
  uid: UploadId
  name: string
  raw?: UploadRawFile
  size?: number
  status: 'ready' | 'uploading' | 'success' | 'fail'
  percentage?: number
  url?: string
}

export interface UploadProgress {
  percent: number
}

export interface UploadOptions {
  file: UploadRawFile
  filename?: string
  onProgress?: (event: UploadProgress) => void
}

export type UploadResponse = ApiResult<string>

export interface UploadHandle {
  submit: () => unknown
  clearFiles: () => void
}
