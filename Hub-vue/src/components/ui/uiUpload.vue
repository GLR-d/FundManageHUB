<template>
  <div class="ui-upload">
    <div v-if="showFileList" class="upload-files">
      <div v-for="file in fileList" :key="file.uid" class="upload-file">
        <button type="button" :disabled="disabled" :aria-label="'预览 ' + file.name" @click="onPreview?.(file)">
          <UiImage v-if="file.url" :src="file.url" :active="active" :alt="file.name" />
          <span v-else>{{ file.name }}</span>
        </button>
        <button class="upload-remove" type="button" :disabled="disabled" :aria-label="'移除 ' + file.name" @click="controller.remove(file)">
          <UiIcon name="close" />
        </button>
      </div>
    </div>
    <button type="button" class="upload-trigger" :disabled="disabled" :aria-label="showFileList ? '选择账单图片' : '选择头像图片'" @click="input?.click()">
      <slot>
        <UiIcon name="plus" />
        <span>添加图片</span>
      </slot>
    </button>
    <input ref="input" type="file" class="file-input" hidden tabindex="-1" title="" accept="image/jpeg,image/png" :multiple="limit !== 1" :disabled="disabled" aria-label="选择图片文件" @change="selectFiles" />
  </div>
</template>
<script setup lang="ts">
import type { UploadFile } from '@/types/upload'

import type { UploadControllerOptions } from '@/services/nativeUpload'
import { ref, watch, onUnmounted } from 'vue';
import UiIcon from './uiIcon.vue';
import UiImage from './uiImage.vue';
import { createUploadController } from '@/services/nativeUpload';
import { abortImageUpload } from '@/services/imageUpload';
const props = withDefaults(defineProps<{ fileList?: UploadFile[]; active?: boolean; disabled?: boolean; httpRequest: UploadControllerOptions['request']; beforeUpload?: UploadControllerOptions['beforeUpload']; onSuccess?: UploadControllerOptions['onSuccess']; onError?: UploadControllerOptions['onError']; onChange?: UploadControllerOptions['onChange']; onProgress?: UploadControllerOptions['onProgress']; onPreview?: (file: UploadFile) => void; onRemove?: UploadControllerOptions['onRemove']; showFileList?: boolean; limit?: number }>(), { fileList: () => [], showFileList: true, active: true, disabled: false });
const emit = defineEmits<{ 'update:fileList': [files: UploadFile[]] }>();
const input = ref<HTMLInputElement | null>(null);
const files = ref(props.fileList);
watch(() => props.fileList, value => {
  files.value = value;
}, {
  flush: 'sync'
});
const controller = createUploadController({
  getFiles: () => files.value,
  setFiles: value => {
    files.value = value;
    emit('update:fileList', files.value);
  },
  request: options => props.httpRequest(options),
  abort: abortImageUpload,
  beforeUpload: raw => props.beforeUpload?.(raw) ?? true,
  disabled: () => props.disabled,
  preview: props.showFileList,
  limit: props.limit,
  onChange: (file, list) => props.onChange?.(file, list),
  onSuccess: (response, file, list) => props.onSuccess?.(response, file, list),
  onError: (error, file, list) => props.onError?.(error, file, list),
  onProgress: (event, file) => props.onProgress?.(event, file),
  onRemove: file => props.onRemove?.(file)
});
const selectFiles = (event: Event) => {
  const target = event.target as HTMLInputElement;
  if (target.files) controller.select(target.files);
  target.value = '';
};
onUnmounted(controller.dispose);
defineExpose({
  submit: controller.submit,
  clearFiles: controller.clearFiles
});
</script>
