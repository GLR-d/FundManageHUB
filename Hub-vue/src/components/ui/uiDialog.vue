<template>
  <Teleport to="body">
    <dialog ref="dialog" class="ui-dialog" :style="{ width }" :aria-labelledby="titleId" @cancel.prevent="requestClose" @click="backdropClose">
      <div class="ui-dialog-header">
        <h2 :id="titleId">{{ title }}</h2>
        <button class="dialog-close" type="button" data-form-action aria-label="关闭弹窗" @click="requestClose">
          <UiIcon name="close" />
        </button>
      </div>
      <div class="ui-dialog-body">
        <slot />
      </div>
      <div v-if="$slots.footer" class="ui-dialog-footer" data-form-action>
        <slot name="footer" />
      </div>
    </dialog>
  </Teleport>
</template>
<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted, useId } from 'vue';
import UiIcon from './uiIcon.vue';
const props = withDefaults(defineProps<{ modelValue?: boolean; title?: string; width?: string; closeOnClickModal?: boolean; beforeClose?: (done: () => void) => void }>(), { width: '500px', closeOnClickModal: true });
const emit = defineEmits(['update:modelValue']);
const dialog = ref<HTMLDialogElement | null>(null);
const titleId = 'dialog-' + useId();
let previousFocus: HTMLElement | null = null;
let disposed = false;
watch(() => props.modelValue, async visible => {
  await nextTick();
  if (disposed || visible !== props.modelValue || !dialog.value) return;
  if (visible && !dialog.value.open) {
    previousFocus = document.activeElement as HTMLElement | null;
    dialog.value.showModal();
    window.dispatchEvent(new Event('ui-dialog-open'));
  } else if (!visible && dialog.value.open) {
    dialog.value.close();
    if (previousFocus?.isConnected) previousFocus.focus();
  }
}, {
  immediate: true,
  flush: 'post'
});
const requestClose = () => {
  const done = () => emit('update:modelValue', false);
  if (props.beforeClose) props.beforeClose(done);else done();
};
const backdropClose = (event: MouseEvent) => {
  if (!props.closeOnClickModal || !dialog.value || event.target !== dialog.value) return;
  const box = dialog.value.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) requestClose();
};
onUnmounted(() => {
  disposed = true;
  if (dialog.value?.open) dialog.value.close();
  if (previousFocus?.isConnected) previousFocus.focus();
});
</script>
