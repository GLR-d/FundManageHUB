import type { Ref } from 'vue'
import type { UploadFile, UploadHandle, UploadId } from '@/types/upload'

import { errorDetails } from '@/utils/errors'
import { ref, computed, nextTick } from 'vue'
import { releaseImagePreview, getImageUploadError } from '@/utils/imageUpload'

// 失败文件单独保留，以便上传列表清理后仍可重试原始图片。
export const useUploadRetry = ({ files, uploadRef, isActive, isDisabled = () => false, preview = false }: { files: Ref<UploadFile[]>; uploadRef: Ref<UploadHandle | null>; isActive: () => boolean; isDisabled?: () => boolean; preview?: boolean }) => {
  const failedUploads = ref<UploadFile[]>([])
  const hasFailedUploads = computed(() => failedUploads.value.length > 0)
  const hasPendingUploads = () => files.value.some(file => ['ready', 'uploading'].includes(file.status))
  const rememberFailure = (file: UploadFile, cause?: unknown) => {
    const error = errorDetails(cause)
    releaseImagePreview(file)
    if (!isActive() || error?.code === 'ERR_CANCELED' || error?.__CANCEL__ || !file?.raw || getImageUploadError(file.raw)) return
    const failed: UploadFile = { uid: file.uid, name: file.name, raw: file.raw, size: file.size, status: 'fail' }
    failedUploads.value = [...failedUploads.value.filter(item => item.uid !== file.uid), failed]
    files.value = files.value.filter(item => item.uid !== file.uid)
  }
  const discardFailure = (uid: UploadId) => { failedUploads.value = failedUploads.value.filter(file => file.uid !== uid) }
  const clearFailures = () => { failedUploads.value = [] }
  const retryUpload = async (failed: UploadFile) => {
    if (!isActive() || isDisabled() || hasPendingUploads() || !uploadRef.value?.submit) return
    const retained = failedUploads.value.find(file => file.uid === failed.uid)
    if (!retained?.raw) return
    const file: UploadFile = { ...retained, status: 'ready', percentage: 0 }
    if (preview) {
      try { file.url = URL.createObjectURL(retained.raw) } catch { /* 上传仍可进行，预览可暂缺。 */ }
    }
    files.value.push(file)
    discardFailure(file.uid)
    await nextTick()
    // 等待组件接收文件列表时，用户仍可能关闭弹窗。
    if (!isActive() || !files.value.some(item => item.uid === file.uid && item.status === 'ready')) return
    uploadRef.value?.submit()
  }
  return { failedUploads, hasFailedUploads, rememberFailure, discardFailure, clearFailures, retryUpload }
}
