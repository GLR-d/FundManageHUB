import type { UploadId, UploadOptions, UploadResponse } from '@/types/upload'

import axios from 'axios'
import { uploadPreparedImage } from '@/api/upload'
import { captureSession, isCurrentSession, sessionVersion, onSessionChange } from '@/stores/auth'
import { feedback } from '@/utils/feedback'
import { errorDetails } from '@/utils/errors'
import { compressUploadImage } from '@/utils/imageUpload'

const imageUploads = new Map<UploadId | undefined, AbortController>()
const cancelUploads = () => { imageUploads.forEach(controller => controller.abort()); imageUploads.clear() }
const stopSession = onSessionChange(cancelUploads)
if (import.meta.hot) import.meta.hot.dispose(() => { stopSession(); cancelUploads() })

export const abortImageUpload = (uid: UploadId | undefined) => { imageUploads.get(uid)?.abort(); imageUploads.delete(uid) }
export const uploadImage = async (options: UploadOptions): Promise<UploadResponse> => {
  const previousVersion = sessionVersion.value
  const snapshot = captureSession()
  if (previousVersion !== snapshot.version) throw new axios.CanceledError('会话已变更')
  const controller = new AbortController()
  const uid = options.file.uid
  if (uid !== undefined) abortImageUpload(uid)
  if (uid !== undefined) imageUploads.set(uid, controller)
  try {
    let file
    try { file = await compressUploadImage(options.file, controller.signal) }
    catch (error) {
      if (controller.signal.aborted || !isCurrentSession(snapshot)) throw new axios.CanceledError('图片上传已取消')
      if (!axios.isCancel(error)) feedback.error(errorDetails(error).message)
      throw error
    }
    if (controller.signal.aborted || !isCurrentSession(snapshot)) throw new axios.CanceledError('图片上传已取消')
    return await uploadPreparedImage(file, options.filename || 'file', {
      signal: controller.signal,
      onUploadProgress: event => options.onProgress?.({ percent: event.total ? Math.min(100, event.loaded / event.total * 100) : 0 })
    })
  } finally { if (imageUploads.get(uid) === controller) imageUploads.delete(uid) }
}
