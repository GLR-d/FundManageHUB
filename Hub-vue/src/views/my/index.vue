<template>
  <div class="page-heading">
    <div>
      <h1>个人中心</h1>
      <p>管理你的资料与账号</p>
    </div>
  </div>
  <section class="profile-card surface-card">
    <div class="my-info">
      <button class="profile-avatar" type="button" aria-label="预览头像" @click="previewVisible = true">
        <UiAvatar :src="userData.avatar" :size="84" />
      </button>
      <div class="my-name">
        <strong>{{ userData.name || '用户' }}</strong>
        <div class="profile-actions">
          <UiButton @click="updateUserData">编辑资料</UiButton>
          <UiButton class="profile-refresh-button" :loading="refreshing" @click="refreshProfile">
            <UiIcon name="refresh" />
            刷新资料
          </UiButton>
        </div>
      </div>
    </div>
    <h2 class="profile-heading">基础信息</h2>
    <div class="my-info-item">
      <div class="my-info-row">
        <span class="title">手机号</span>
        <span class="value">{{ userData.phone || '未填写' }}</span>
        <UiButton size="small" @click="editContact('phone')">更改</UiButton>
      </div>
      <div class="my-info-row">
        <span class="title">邮箱</span>
        <span class="value">{{ userData.email || '未填写' }}</span>
        <UiButton size="small" @click="emailVisible = true">更改</UiButton>
      </div>
      <div class="my-info-row">
        <span class="title">密码</span>
        <span class="value">••••••••</span>
        <UiButton size="small" @click="updatePassword">更改</UiButton>
      </div>
    </div>
  </section>
  <section class="mobile-account-menu surface-card" aria-label="更多功能">
    <a :href="router.resolve('/setting').href" @click="navigate($event, '/setting')">
      <UiIcon name="settings" /><span>设置</span><UiIcon name="chevron" />
    </a>
    <a :href="router.resolve('/about').href" @click="navigate($event, '/about')">
      <UiIcon name="info" /><span>关于</span><UiIcon name="chevron" />
    </a>
    <button type="button" class="profile-logout" :disabled="loggingOut" :aria-busy="loggingOut" @click="logout">
      <UiIcon name="logout" /><span>退出登录</span>
    </button>
  </section>
  <UiDialog v-model="previewVisible" title="头像预览" width="400px">
    <UiImage v-if="previewVisible && userData.avatar" :src="userData.avatar" alt="头像" style="width:100%" />
    <div v-else-if="!userData.avatar" class="empty-state">
      <UiIcon name="user" />
      尚未设置头像
    </div>
  </UiDialog>
  <UpdateUserData v-model:visible="dialogVisible" v-model:userData="userData" :edit-field="editField" />
  <UpdatePassword v-model:visible="dVPassword" />
  <VerifyEmail v-model:visible="emailVisible" :email="userData.email" @verified="userData = $event" />
</template>
<script setup lang="ts">
import type { ProfileField } from '@/types/account'

import UiAvatar from '@/components/ui/uiAvatar.vue'
import UiImage from '@/components/ui/uiImage.vue'
import UiButton from '@/components/ui/uiButton.vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import UiDialog from '@/components/ui/uiDialog.vue'
defineOptions({
  name: 'MyView'    
})
import { ref, onMounted, onUnmounted } from 'vue'
import router from '@/router'
import { isRouteLoadError } from '@/utils/routeRecovery'
import { currentUser as userData, captureSession, isCurrentSession } from '@/stores/auth'
import { logout, loggingOut } from '@/services/logout'
import { feedback } from '@/utils/feedback'
import { loadCurrentUser } from '@/stores/user'
import { startProfileAutoSync } from '@/services/profileAutoSync'
import UpdateUserData from './components/updateUserData.vue'
import UpdatePassword from './components/updatePassword.vue'
import VerifyEmail from './components/verifyEmail.vue'

let stopProfileSync: (() => void) | undefined
onMounted(() => {
    void loadCurrentUser()
    stopProfileSync = startProfileAutoSync({ isPaused: () => dialogVisible.value || dVPassword.value || emailVisible.value })
})
const refreshing = ref(false)
let disposed = false
onUnmounted(() => { disposed = true; stopProfileSync?.() })
const refreshProfile = async () => {
    if (refreshing.value || disposed) return
    const snapshot = captureSession()
    refreshing.value = true
    try {
        const data = await loadCurrentUser({ force: true })
        if (data && !disposed && isCurrentSession(snapshot)) feedback.success('资料已刷新')
    } finally { refreshing.value = false }
}

const handleNavigationError = (error: unknown) => { if (!isRouteLoadError(error)) throw error }
const navigate = (event: MouseEvent, path: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    router.push(path).catch(handleNavigationError)
}

// 选中的tab

// 更新基础信息弹窗
const dialogVisible = ref(false)
// 更新密码弹窗
const dVPassword = ref(false)
const emailVisible = ref(false)
// 更新资料
const previewVisible = ref(false)
const editField = ref<ProfileField>('profile')
const editContact = (field: ProfileField) => { editField.value = field; dialogVisible.value = true }
const updateUserData = () => {
    editField.value = 'profile'
    // 实现更新资料逻辑
    dialogVisible.value = true
}
// 更新密码
const updatePassword = () => {
    // 实现更新密码逻辑
    dVPassword.value = true
}

</script>
<style scoped>
.profile-card {
  max-width: 860px;
}
.my-info {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 24px;
  margin-bottom: 32px;
}
.profile-avatar {
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
}
.my-name {
  min-width: 0;
  flex: 1;
}
.my-name>strong {
  display: block;
  font-size: 23px;
  font-weight: 600;
  margin-bottom: 16px;
  overflow-wrap: anywhere;
}
.profile-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.profile-heading {
  font-size: 14px;
  font-weight: 600;
  color: #556178;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 0;
}
.my-info-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  padding: 24px 0;
  border-bottom: 1px solid #f1f3f7;
  font-size: 14px;
}
.my-info-row:last-child {
  border: 0;
  padding-bottom: 0;
}
.my-info-row .title {
  flex: 0 0 90px;
  color: #8c96a8;
}
.my-info-row .value {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  color: #59657a;
}
.mobile-account-menu {
  display: none;
}
@media(min-width:761px) {
  .page-heading,.profile-card { max-width: 1100px; margin-inline: auto; }
  .page-heading p,.profile-heading,.profile-refresh-button { display: none; }
  .profile-card { max-width: 1100px; padding: 0 24px; border-radius: 24px; }
  .my-info { flex-wrap: nowrap; gap: 20px; min-height: 128px; margin: 0; padding: 22px 0; border-bottom: 1px solid var(--line); }
  .profile-avatar { flex: 0 0 auto; }
  .my-name { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
  .my-name>strong { margin: 0; color: var(--text); font-size: 18px; font-weight: 550; line-height: 1.6; }
  .profile-actions { flex: 0 0 auto; }
  .my-info-row { flex-wrap: nowrap; gap: 24px; min-height: 92px; padding: 22px 0; border-bottom: 1px solid var(--line); font-size: 16px; }
  .my-info-row:last-child { padding-bottom: 22px; }
  .my-info-row .title { flex-basis: 90px; color: var(--text); font-weight: 550; line-height: 1.6; }
  .my-info-row .value { text-align: right; color: #667187; line-height: 1.6; }
  .profile-actions .ui-button,.my-info-row .ui-button { flex-shrink: 0; min-width: 80px; min-height: 40px; padding: 9px 16px; border-color: transparent; border-radius: 14px; background: #f3f4f6; color: #394355; font-size: 15px; }
  .profile-actions .ui-button:hover:not(:disabled),.my-info-row .ui-button:hover:not(:disabled) { border-color: transparent; background: #e9ebef; }
}
@media(max-width:760px) {
  .mobile-account-menu {
    display: flex;
    flex-direction: column;
    max-width: 860px;
    margin-top: 20px;
    padding: 8px 18px;
  }
  .mobile-account-menu a,.mobile-account-menu button {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 54px;
    padding: 14px 0;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    color: #59657a;
    font-size: 14px;
    text-align: left;
  }
  .mobile-account-menu span {
    flex: 1;
  }
  .mobile-account-menu .profile-logout {
    border-bottom: 0;
    color: #c35560;
  }
}
@media(max-width:480px) {
  .my-info {
    gap: 16px;
  }
  .my-name>strong {
    font-size: 20px;
  }
  .my-info-row .title {
    flex-basis: 60px;
  }
}
</style>
