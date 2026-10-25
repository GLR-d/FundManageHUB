<template>
  <div class="my-window">
    <button type="button" @click="openProfile">
      <UiIcon name="user" />
      个人中心
    </button>
    <button type="button" class="logout" :disabled="loggingOut" :aria-busy="loggingOut" @click="logout">
      <UiIcon name="logout" />
      退出登录
    </button>
  </div>
</template>
<script setup lang="ts">
import UiIcon from '@/components/ui/uiIcon.vue';
import router from '@/router';
import { logout as logoutUser, loggingOut } from '@/services/logout';
import { isRouteLoadError } from '@/utils/routeRecovery';
defineOptions({
  name: 'UserMenu'
});
const emit = defineEmits<{ action: [] }>();
const handleNavigationError = (error: unknown) => {
  if (!isRouteLoadError(error)) throw error;
};
const openProfile = () => {
  emit('action');
  router.push('/my').catch(handleNavigationError);
};
const logout = () => {
  emit('action');
  return logoutUser();
};
</script>
<style scoped>
.my-window {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.my-window button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: 0;
  border-radius: 8px;
  padding: 10px;
  background: transparent;
  text-align: left;
  color: #637087;
  font-size: 13px;
}
.my-window button:hover {
  background: #f5f6fa;
}
.my-window .logout {
  color: #c35560;
}
</style>
