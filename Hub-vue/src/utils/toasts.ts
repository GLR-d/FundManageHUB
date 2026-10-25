import { ref } from 'vue';
export type ToastType = 'error' | 'warning' | 'info' | 'success';
export interface ToastOptions { message: string; duration: number }
export const toasts = ref<{ id: number; type: ToastType; message: string }[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let sequence = 0;
const dismissToast = (id: number) => {
  clearTimeout(timers.get(id));
  timers.delete(id);
  toasts.value = toasts.value.filter(item => item.id !== id);
};
export const showToast = (type: ToastType, options: ToastOptions) => {
  const existing = toasts.value.find(item => item.type === type && item.message === options.message);
  const id = existing?.id || ++sequence;
  if (!existing) {
    if (toasts.value.length >= 4) dismissToast(toasts.value[0].id);
    toasts.value.push({
      id,
      type,
      message: options.message
    });
  }
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => dismissToast(id), options.duration));
  return {
    close: () => dismissToast(id)
  };
};
export const toastMessages = {
  error: (options: ToastOptions) => showToast('error', options),
  warning: (options: ToastOptions) => showToast('warning', options),
  info: (options: ToastOptions) => showToast('info', options),
  success: (options: ToastOptions) => showToast('success', options)
};
