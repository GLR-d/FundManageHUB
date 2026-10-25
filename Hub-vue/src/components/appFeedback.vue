<template>
  <Teleport to="body">
    <div v-show="toasts.length" ref="toastLayer" popover="manual" class="toast-stack" aria-live="polite" aria-atomic="false">
      <div v-for="toast in toasts" :key="toast.id" class="app-feedback-toast" :class="'toast--' + toast.type" role="status">
        <span class="toast-mark" aria-hidden="true">{{ marks[toast.type] }}</span>
        <span>{{ toast.message }}</span>
      </div>
    </div>
  </Teleport>
  <UiDialog :model-value="Boolean(confirmation)" :title="confirmation?.title" width="400px" @update:model-value="confirmDialog.close">
    <p v-if="confirmation?.message">{{ confirmation.message }}</p>
    <template #footer>
      <UiButton @click="confirmDialog.close">取消</UiButton>
      <UiButton type="danger" @click="confirmDialog.accept">确认删除</UiButton>
    </template>
  </UiDialog>
</template>
<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { toasts } from '@/utils/toasts'
import { confirmation, confirmDialog } from '@/utils/confirm'
import UiDialog from './ui/uiDialog.vue'
import UiButton from './ui/uiButton.vue'
const marks = { success: '✓', warning: '!', error: '×', info: 'i' }
const toastLayer = ref<HTMLElement | null>(null)
const syncToastLayer = async () => {
  await nextTick()
  const layer = toastLayer.value
  if (!layer?.showPopover) return
  if (layer.matches(':popover-open')) layer.hidePopover()
  if (toasts.value.length && layer.isConnected) layer.showPopover()
}
watch(toasts, syncToastLayer, { deep: true, flush: 'post' })
onMounted(() => window.addEventListener('ui-dialog-open', syncToastLayer))
onUnmounted(() => window.removeEventListener('ui-dialog-open', syncToastLayer))
</script>
