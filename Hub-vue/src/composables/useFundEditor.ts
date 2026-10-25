import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import type { FundRecord, FundForm } from '@/types/fund'
import type { UploadFile, UploadRawFile, UploadResponse, UploadHandle } from '@/types/upload'
import type { FormHandle, FormRules } from '@/types/ui'

import { addFundapi, updateFundapi } from '@/api/fund'
import { feedback } from '@/utils/feedback'
import { uploadImage, abortImageUpload } from '@/services/imageUpload'
import { getImageUploadError, releaseImagePreview } from '@/utils/imageUpload'
import { useUploadRetry } from '@/composables/useUploadRetry'
import { createSubmissionGuard } from '@/services/submission'
import { formatDateTime, localDateTime } from '@/utils/dateTime'
import { getFundTypeColors, typeMap, incomeTypes, expenseTypes, validateAmount } from '@/utils/funds'

export const useFundEditor = (options: { isDeleting: () => boolean; onSaved: () => unknown | Promise<unknown> }) => {
  let disposed = false
  const formRef = ref<FormHandle | null>(null)
  const formData = ref<FundForm>({ time: '', type: '', amount: null, remark: '', photo: '' })
  const formVisible = ref(false)
  const title = ref('')
  const editing = ref(false)
  const submission = createSubmissionGuard(() => formVisible.value && !disposed)
  const submitting = submission.busy
  watch(formVisible, visible => { if (!visible) submission.cancel() }, { flush: 'sync' })
  const direction = ref('0')
  const availableTypeOptions = computed(() => (direction.value === '0' ? expenseTypes : incomeTypes).map(value => ({ value, label: typeMap[value]!, ...getFundTypeColors(value) })))
  const formRules: FormRules = {
    time: [{ required: true, message: '请选择时间', trigger: 'change' }],
    type: [{ validator: (rule, value, callback) => {
      const validTypes = direction.value === '1' ? incomeTypes : expenseTypes
      callback(validTypes.includes(String(value)) ? undefined : new Error('请选择正确的类型'))
    }, trigger: 'change' }],
    amount: [{ validator: (rule, value, callback) => {
      const message = validateAmount(value)
      callback(message ? new Error(message) : undefined)
    }, trigger: 'blur' }]
  }
  const updateStatus = () => { formData.value.type = ''; formRef.value?.clearValidate('type') }
  const resetValidation = () => nextTick(() => formRef.value?.clearValidate())
  const addFund = () => {
    if (disposed || submitting.value || options.isDeleting()) return
    cancelUploads()
    editing.value = false
    direction.value = '0'
    formData.value = { time: formatDateTime(localDateTime()), type: '0', amount: null, remark: '', photo: '' }
    fileList.value = []
    title.value = '记一笔'
    formVisible.value = true
    resetValidation()
  }
  const openFundEditor = (row: FundRecord) => {
    if (disposed || submitting.value || options.isDeleting() || !row) return
    cancelUploads()
    editing.value = true
    formData.value = { ...row, type: String(row.type) }
    direction.value = incomeTypes.includes(formData.value.type) ? '1' : '0'
    fileList.value = parsePhoto()
    title.value = '更新账单'
    formVisible.value = true
    resetValidation()
  }
  const beforeClose = (done: () => void) => { if (!submitting.value) { cancelUploads(); done() } }
  const closeForm = () => { if (!submitting.value) { cancelUploads(); formVisible.value = false } }

  const fileList = ref<UploadFile[]>([])
  const uploadRef = ref<UploadHandle | null>(null)
  const { failedUploads, hasFailedUploads, rememberFailure, discardFailure, clearFailures, retryUpload } = useUploadRetry({
    files: fileList, uploadRef, isActive: () => formVisible.value && !disposed, isDisabled: () => submitting.value, preview: true
  })
  const cancelUploads = () => { fileList.value.forEach(file => { abortImageUpload(file.uid); releaseImagePreview(file) }); uploadRef.value?.clearFiles(); fileList.value = []; clearFailures() }
  const dialogVisible = ref(false)
  const dialogImageUrl = ref('')
  const hasPendingUpload = computed(() => fileList.value.some(file => ['ready', 'uploading'].includes(file.status)))
  const handleBeforeUpload = (file: UploadRawFile) => {
    const error = getImageUploadError(file)
    if (error) { feedback.error(error); return false }
    return true
  }
  const handlePictureCardPreview = (file: UploadFile) => { dialogImageUrl.value = file.url || ''; dialogVisible.value = true }
  const handleRemove = (file: UploadFile) => { abortImageUpload(file.uid); dialogVisible.value = false }
  const handleUploadError = (error: unknown, file: UploadFile) => { rememberFailure(file, error) /* 请求封装已提示。 */ }
  const handleSuccess = (res: UploadResponse, file: UploadFile) => {
    if (res?.code === 1 && typeof res.data === 'string' && res.data.trim()) {
      releaseImagePreview(file)
      file.url = res.data.trim()
      file.status = 'success'
      file.raw = undefined
    } else {
      feedback.error(res?.msg || '上传失败')
      rememberFailure(file)
    }
  }
  const parsePhoto = (): UploadFile[] => typeof formData.value.photo === 'string'
    ? formData.value.photo.split(',').filter(url => url.trim()).map((url, index) => ({ name: '图片' + (index + 1), url: url.trim(), uid: Date.now() + index, status: 'success' }))
    : []
  const submitForm = async () => {
    if (disposed || submitting.value || options.isDeleting()) return
    if (hasPendingUpload.value) { feedback.warning('请等待图片上传完成'); return }
    if (hasFailedUploads.value) { feedback.warning('请重试或移除上传失败的图片'); return }
    const operation = submission.begin()
    if (!operation) return
    const data = { ...formData.value, photo: fileList.value.filter(file => file.url && file.status === 'success').map(file => file.url).join(',') }
    const wasEditing = editing.value
    try {
      const valid = await formRef.value?.validate().catch(() => false)
      if (!valid || !submission.isActive(operation)) return
      const res = await (wasEditing ? updateFundapi(data, operation.config) : addFundapi(data, operation.config))
      if (!submission.isActive(operation)) return
      if (res?.code !== 1) { feedback.error(res?.msg || '保存失败'); return }
      feedback.success(wasEditing ? '更新成功' : '记录成功')
      formVisible.value = false
      await options.onSaved()
    } catch {
      // 请求封装已提示。
    } finally {
      submission.finish(operation)
    }
  }
  onUnmounted(() => { disposed = true; submission.dispose(); cancelUploads() })
  return { formRef, formData, formVisible, title, editing, submitting, direction, availableTypeOptions, formRules, updateStatus, addFund, openFundEditor, beforeClose, closeForm, fileList, uploadRef, failedUploads, hasFailedUploads, discardFailure, retryUpload, dialogVisible, dialogImageUrl, hasPendingUpload, handleBeforeUpload, handlePictureCardPreview, handleRemove, handleUploadError, handleSuccess, submitForm, uploadImage }
}
