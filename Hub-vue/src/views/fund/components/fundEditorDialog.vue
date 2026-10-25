<template>
  <UiDialog v-model="formVisible" :title="title" :before-close="beforeClose" :close-on-click-modal="false">
    <UiForm ref="formRef" :model="formData" :rules="formRules" :disabled="submitting">
      <UiField label="时间" prop="time">
        <div class="fund-time-controls">
          <UiDateTimePicker v-model="formData.time" aria-label="账单时间" />
          <UiSelect v-model="direction" :field-control="false" :options="[{ value: '0', label: '支出' }, { value: '1', label: '收入' }]" aria-label="收支方向" @change="updateStatus" />
        </div>
      </UiField>
      <UiField label="类型" prop="type">
        <UiTagSelect v-model="formData.type" :options="availableTypeOptions" aria-label="账单类型" />
      </UiField>
      <UiField label="金额" prop="amount">
        <UiInput v-model="formData.amount" type="number" min="0" inputmode="decimal" placeholder="0.00" />
      </UiField>
      <UiField label="图片">
        <UiUpload ref="uploadRef" v-model:file-list="fileList" :active="formVisible" :http-request="uploadImage" :disabled="submitting" :before-upload="handleBeforeUpload" :on-error="handleUploadError" :on-preview="handlePictureCardPreview" :on-remove="handleRemove" :on-success="handleSuccess" />
        <div v-for="file in failedUploads" :key="file.uid" class="upload-failure" role="status">
          <span>{{ file.name }} · 上传失败</span>
          <UiButton size="small" :disabled="submitting || hasPendingUpload" @click="retryUpload(file)">重试</UiButton>
          <UiButton size="small" :disabled="submitting" @click="discardFailure(file.uid)">移除</UiButton>
        </div>
      </UiField>
      <UiField label="备注">
        <UiInput v-model="formData.remark" type="textarea" placeholder="请输入备注内容" maxlength="50" />
      </UiField>
    </UiForm>
    <template #footer>
      <UiButton :disabled="submitting" @click="closeForm">取消</UiButton>
      <UiButton type="primary" :loading="submitting" :disabled="hasPendingUpload || hasFailedUploads" @click="submitForm">确认</UiButton>
    </template>
  </UiDialog>
  <UiDialog v-model="dialogVisible" title="账单图片">
    <UiImage v-if="dialogVisible && dialogImageUrl" :src="dialogImageUrl" alt="账单图片" style="width:100%;height:auto" />
  </UiDialog>
</template>
<script setup lang="ts">
import UiButton from '@/components/ui/uiButton.vue'
import UiInput from '@/components/ui/uiInput.vue'
import UiSelect from '@/components/ui/uiSelect.vue'
import UiTagSelect from '@/components/ui/uiTagSelect.vue'
import UiDateTimePicker from '@/components/ui/uiDateTimePicker.vue'
import UiDialog from '@/components/ui/uiDialog.vue'
import UiForm from '@/components/ui/uiForm.vue'
import UiField from '@/components/ui/uiField.vue'
import UiUpload from '@/components/ui/uiUpload.vue'
import UiImage from '@/components/ui/uiImage.vue'
import type { useFundEditor } from '@/composables/useFundEditor'
const props = defineProps<{ editor: ReturnType<typeof useFundEditor> }>()
const { formRef, formData, formVisible, title, submitting, direction, availableTypeOptions, formRules, updateStatus, beforeClose, closeForm, fileList, uploadRef, failedUploads, hasFailedUploads, discardFailure, retryUpload, dialogVisible, dialogImageUrl, hasPendingUpload, handleBeforeUpload, handlePictureCardPreview, handleRemove, handleUploadError, handleSuccess, submitForm, uploadImage } = props.editor
</script>
<style scoped>
.fund-time-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.fund-time-controls .ui-date-time {
  flex: 1;
  min-width: 185px;
}
.fund-time-controls > .ui-select {
  width: 90px;
}
</style>
