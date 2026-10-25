<template>
  <UiDialog v-model="innerVisible" :title="dialogTitle" width="min(500px, calc(100vw - 24px))" :before-close="handleClose">
    <UiForm ref="formRef" :model="localData" :rules="rules" :disabled="submitting">
      <template v-if="editField === 'profile'">
        <UiField label="头像">
          <UiUpload ref="uploadRef" v-model:file-list="avatarFiles" class="avatar-uploader" :active="visible" :disabled="submitting || uploading" :http-request="uploadImage" :before-upload="handleBeforeUpload" :on-success="handleSuccess" :on-error="handleUploadError" :on-change="handleUploadChange" :show-file-list="false" :limit="1">
            <UiAvatar v-if="localData.avatar" :src="localData.avatar" :active="visible" :size="112" />
            <UiIcon v-else name="plus" />
          </UiUpload>
          <div v-for="file in failedUploads" :key="file.uid" class="upload-failure" role="status">
            <span>{{ file.name }} · 上传失败</span>
            <UiButton size="small" :disabled="submitting || uploading" @click="retryUpload(file)">重试</UiButton>
            <UiButton size="small" :disabled="submitting" @click="discardFailure(file.uid)">移除</UiButton>
          </div>
        </UiField>
        <UiField label="姓名" prop="name">
          <UiInput v-model="localData.name" placeholder="请输入姓名" @keyup.enter="handleSubmit" />
        </UiField>
      </template>
      <UiField v-else label="手机号" prop="phone">
        <UiInput v-model="localData.phone" placeholder="请输入手机号" @keyup.enter="handleSubmit" />
      </UiField>
    </UiForm>
    <template #footer>
      <UiButton :disabled="submitting" @click="closeDialog">取消</UiButton>
      <UiButton type="primary" :loading="submitting" :disabled="uploading || hasFailedUploads" @click="handleSubmit">确认</UiButton>
    </template>
  </UiDialog>
</template>
<script setup lang="ts">
import type { UserProfile, ProfileField } from '@/types/account'
import type { UploadFile, UploadRawFile, UploadResponse, UploadHandle } from '@/types/upload'
import type { FormHandle, FormRules } from '@/types/ui'




import UiDialog from '@/components/ui/uiDialog.vue'
import UiForm from '@/components/ui/uiForm.vue'
import UiField from '@/components/ui/uiField.vue'
import UiUpload from '@/components/ui/uiUpload.vue'
import UiAvatar from '@/components/ui/uiAvatar.vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import UiButton from '@/components/ui/uiButton.vue'
import UiInput from '@/components/ui/uiInput.vue'
defineOptions({ name: 'UpdateUserData' })
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { feedback } from '@/utils/feedback'
import { updateUser } from '@/api/my'
import { uploadImage, abortImageUpload } from '@/services/imageUpload'
import { getImageUploadError } from '@/utils/imageUpload'
import { useUploadRetry } from '@/composables/useUploadRetry'
import { createSubmissionGuard } from '@/services/submission'
const props = withDefaults(defineProps<{ visible?: boolean; userData?: UserProfile; editField?: ProfileField }>(), { visible: false, userData: () => ({}), editField: 'profile' })
const emit = defineEmits<{ 'update:visible': [value: boolean]; 'update:userData': [value: UserProfile] }>()
const innerVisible = computed({ get: () => props.visible, set: value => emit('update:visible', value) })
const dialogTitle = computed(() => ({ profile: '编辑资料', phone: '更改手机号' }[props.editField] || '编辑资料'))
const localData = ref({ avatar: '', name: '', phone: '' })
const formRef = ref<FormHandle | null>(null)
const uploadRef = ref<UploadHandle | null>(null)
const submission = createSubmissionGuard(() => props.visible)
const submitting = submission.busy
const avatarFiles = ref<UploadFile[]>([])
const uploading = computed(() => avatarFiles.value.some(file => ['ready', 'uploading'].includes(file.status)))
const { failedUploads, hasFailedUploads, rememberFailure, discardFailure, clearFailures, retryUpload } = useUploadRetry({
  files: avatarFiles, uploadRef, isActive: () => props.visible, isDisabled: () => submitting.value
})
const cancelUploads = () => { avatarFiles.value.forEach(file => abortImageUpload(file.uid)); avatarFiles.value = []; uploadRef.value?.clearFiles(); clearFailures() }
const closeDialog = () => { if (!submitting.value) { cancelUploads(); innerVisible.value = false } }
onUnmounted(() => { submission.dispose(); cancelUploads() })
const rules: FormRules = {
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  phone: [{ required: true, message: '请输入手机号', trigger: 'blur' }, { pattern: /^\+?[\d -]{7,20}$/, message: '请输入有效手机号', trigger: 'blur' }]
}
watch([() => props.visible, () => props.editField], ([visible]) => {
  submission.cancel()
  cancelUploads()
  if (visible) {
    localData.value = { avatar: props.userData.avatar || '', name: props.userData.name || '', phone: props.userData.phone || '' }
    nextTick(() => { formRef.value?.clearValidate(); uploadRef.value?.clearFiles() })
  }
}, { immediate: true, flush: 'sync' })
const handleClose = (done: () => void) => { if (!submitting.value) { cancelUploads(); done() } }
const handleBeforeUpload = (file: UploadRawFile) => {
  const error = getImageUploadError(file)
  if (error) { feedback.error(error); return false }
  clearFailures()
  return true
}
const handleUploadChange = (_file: UploadFile | undefined, files: UploadFile[]) => { avatarFiles.value = files }
const handleUploadError = (error: unknown, file: UploadFile) => { rememberFailure(file, error); uploadRef.value?.clearFiles() }
const handleSuccess = (res: UploadResponse, file: UploadFile) => {
  if (res?.code === 1 && typeof res.data === 'string' && res.data.trim()) localData.value.avatar = res.data.trim()
  else { feedback.error(res?.msg || '上传失败'); rememberFailure(file) }
  avatarFiles.value = []
  uploadRef.value?.clearFiles()
}
const handleSubmit = async () => {
  if (submitting.value || uploading.value) return
  if (hasFailedUploads.value) { feedback.warning('请重试或移除上传失败的头像'); return }
  const operation = submission.begin()
  if (!operation) return
  const data = props.editField === 'profile'
    ? { avatar: localData.value.avatar, name: localData.value.name }
    : { [props.editField]: localData.value[props.editField] }
  try {
    const valid = await formRef.value?.validate().catch(() => false)
    if (!valid || !submission.isActive(operation)) return
    const res = await updateUser(data, operation.config)
    if (!submission.isActive(operation)) return
    if (res?.code !== 1) { feedback.error(res?.msg || '更新失败'); return }
    const updated = res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : {}
    emit('update:userData', { ...props.userData, ...data, ...updated })
    innerVisible.value = false
    feedback.success('更新成功')
  } catch {
    // 请求封装已提示。
  } finally { submission.finish(operation) }
}
</script>
<style scoped>
.avatar-uploader :deep(.upload-trigger) {
  border-radius: 50%;
  overflow: hidden;
}
.avatar-uploader :deep(.upload-trigger:has(img)) {
  border: 0;
}
</style>
