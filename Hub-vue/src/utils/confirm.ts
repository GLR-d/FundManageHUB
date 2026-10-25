import { shallowRef } from 'vue';
export const confirmation = shallowRef<{ message: string; title: string; resolve: (accepted: boolean) => void; reject: (reason: Error) => void } | null>(null);
const settle = (accepted: boolean) => {
  const current = confirmation.value;
  confirmation.value = null;
  if (!current) return;
  if (accepted) current.resolve(true);else current.reject(new Error('取消操作'));
};
export const confirmDialog = {
  confirm: (message: string, title = '确认操作', _options?: { type?: string }) => {
    settle(false);
    return new Promise<boolean>((resolve, reject) => {
      confirmation.value = {
        message,
        title,
        resolve,
        reject
      };
    });
  },
  close: () => settle(false),
  accept: () => settle(true)
};
