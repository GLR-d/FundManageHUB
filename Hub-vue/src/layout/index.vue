<template>
  <div class="layout" :class="{ 'layout--collapsed': !isNarrow && menuCollapsed }">
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <aside v-if="!isNarrow" id="main-navigation" class="aside" aria-label="侧栏">
      <div class="sidebar-brand">
        <button v-if="menuCollapsed && !isNarrow" ref="brandToggle" type="button" class="brand-mark brand-toggle" aria-label="点击 Logo 展开侧边栏" title="点击 Logo 展开侧边栏" aria-controls="main-navigation" :aria-expanded="!menuCollapsed" @click="toggleMenu">
          <UiIcon name="wallet" />
        </button>
        <span v-else class="brand-mark">
          <UiIcon name="wallet" />
        </span>
        <span class="brand-title" :aria-hidden="menuCollapsed && !isNarrow">花销管理</span>
        <Transition name="sidebar-control">
          <button v-if="!isNarrow && !menuCollapsed" ref="sidebarFold" class="sidebar-fold" aria-label="收起导航" aria-controls="main-navigation" :aria-expanded="!menuCollapsed" @click="toggleMenu">
            <UiIcon name="fold" />
          </button>
        </Transition>
      </div>
      <nav class="side-nav" aria-label="主导航">
        <a v-for="item in navigation" :key="item.path" :href="router.resolve(item.path).href" class="nav-item" :class="{ 'is-current': router.currentRoute.value.path === item.path }" :aria-current="router.currentRoute.value.path === item.path ? 'page' : undefined" :aria-label="item.label" :title="menuCollapsed ? item.label : undefined" @click="navigate($event, item.path)">
          <UiIcon :name="item.icon" />
          <span class="nav-label" :aria-hidden="menuCollapsed && !isNarrow">{{ item.label }}</span>
        </a>
      </nav>
      <div ref="userMenuRoot" class="sidebar-account">
        <div v-if="userMenuOpen" class="user-popup">
          <UserMenu @action="userMenuOpen = false" />
        </div>
        <button class="account-button" aria-label="个人菜单" :title="userData.name || '用户'" :aria-expanded="userMenuOpen" @click="userMenuOpen = !userMenuOpen">
          <UiAvatar :src="userData.avatar" :size="36" />
          <span class="account-name" :aria-hidden="menuCollapsed">{{ userData.name || '用户' }}</span>
        </button>
      </div>
    </aside>
    <main id="main-content" class="app-main" tabindex="-1">
      <RouteLoadRetry />
      <router-view />
    </main>
    <nav v-if="isNarrow" class="mobile-bottom-nav" aria-label="主导航">
      <template v-for="(item, index) in mobileNavigation" :key="item.path">
        <button v-if="index === 2" type="button" class="mobile-add-button" aria-label="记一笔" title="记一笔" @click="openBillEntry">
          <span class="mobile-add-icon"><UiIcon name="plus" /></span>
          <span>记一笔</span>
        </button>
        <a :href="router.resolve(item.path).href" class="mobile-nav-item" :class="{ 'is-current': isMobileNavigationCurrent(item.path) }" :aria-current="isMobileNavigationCurrent(item.path) ? 'page' : undefined" @click="navigate($event, item.path)">
          <UiIcon :name="item.icon" />
          <span>{{ item.label }}</span>
        </a>
      </template>
    </nav>
  </div>
</template>
<script setup lang="ts">
import UiIcon from '@/components/ui/uiIcon.vue';
import UiAvatar from '@/components/ui/uiAvatar.vue';
defineOptions({
  name: 'AppLayout'
});
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import router from '@/router';
import UserMenu from './components/userMenu.vue';
import RouteLoadRetry from '@/components/routeLoadRetry.vue';
import { isRouteLoadError } from '@/utils/routeRecovery';
import { currentUser as userData } from '@/stores/auth';
import { loadCurrentUser } from '@/stores/user';
const navigation = [{
  path: '/dashboard',
  label: '首页',
  icon: 'home'
}, {
  path: '/fund',
  label: '记账',
  icon: 'wallet'
}, {
  path: '/chat',
  label: '聊天',
  icon: 'chat'
}, {
  path: '/my',
  label: '我的',
  icon: 'user'
}, {
  path: '/setting',
  label: '设置',
  icon: 'settings'
}, {
  path: '/about',
  label: '关于',
  icon: 'info'
}];
const mobileNavigation = navigation.slice(0, 4);
const isMobileNavigationCurrent = (path: string) => {
  const currentPath = router.currentRoute.value.path;
  return currentPath === path || (path === '/my' && ['/setting', '/about'].includes(currentPath));
};
const media = window.matchMedia('(max-width: 760px)');
const isNarrow = ref(media.matches);
const menuCollapsed = ref(isNarrow.value);
const brandToggle = ref<HTMLElement | null>(null);
const sidebarFold = ref<HTMLElement | null>(null);
const userMenuOpen = ref(false);
const userMenuRoot = ref<HTMLElement | null>(null);
const syncMenu = (event?: MediaQueryListEvent) => {
  isNarrow.value = event?.matches ?? media.matches;
  menuCollapsed.value = isNarrow.value;
  userMenuOpen.value = false;
};
const toggleMenu = () => {
  menuCollapsed.value = !menuCollapsed.value;
  userMenuOpen.value = false;
  nextTick(() => {
    if (!isNarrow.value) (menuCollapsed.value ? brandToggle.value : sidebarFold.value)?.focus();
  });
};
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    if (userMenuOpen.value) {
      userMenuOpen.value = false;
      userMenuRoot.value?.querySelector<HTMLElement>('.account-button')?.focus();
    }
  }
};
const handleNavigationError = (error: unknown) => {
  if (!isRouteLoadError(error)) throw error;
};
const navigate = (event: MouseEvent, path: string) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  userMenuOpen.value = false;
  router.push(path).catch(handleNavigationError);
};
const openBillEntry = () => {
  router.push({ path: '/fund', query: { record: 'new' } }).catch(handleNavigationError);
};
const outsideClick = (event: MouseEvent) => {
  if (!userMenuRoot.value?.contains(event.target as Node | null)) userMenuOpen.value = false;
};
watch(() => router.currentRoute.value.path, () => {
  userMenuOpen.value = false;
});
onMounted(() => {
  loadCurrentUser();
  syncMenu();
  media.addEventListener('change', syncMenu);
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('click', outsideClick);
});
onUnmounted(() => {
  media.removeEventListener('change', syncMenu);
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('click', outsideClick);
});
</script>
<style scoped>
.layout {
  display: flex;
  position: fixed;
  inset: 0;
  height: 100vh;
  height: 100dvh;
}
.aside {
  display: flex;
  flex-direction: column;
  flex: 0 0 232px;
  width: 232px;
  padding: 28px 16px 16px;
  background: var(--sidebar);
  border-right: 1px solid #e5e7eb;
  min-height: 0;
  transition: flex-basis .28s ease, width .28s ease, padding .28s ease;
}
.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  position: relative;
  margin-bottom: 38px;
  min-height: 38px;
  padding-right: 32px;
  transition: gap .28s ease, padding .28s ease;
}
.brand-mark {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--primary);
  color: white;
  flex-shrink: 0;
  transition: margin .28s ease;
}
.brand-toggle {
  border: 0;
  padding: 0;
}
.brand-toggle:hover {
  background: var(--primary-hover);
}
.brand-title {
  font-size: 18px;
  font-weight: 650;
  white-space: nowrap;
  letter-spacing: .4px;
  max-width: 120px;
  overflow: hidden;
  transition: max-width .28s ease, opacity .18s ease, transform .28s ease;
}
.sidebar-fold {
  display: flex;
  align-items: center;
  justify-content: center;
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  padding: 5px;
  border: 0;
  background: transparent;
  color: #929baa;
  border-radius: 6px;
}
.side-nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  min-height: 0;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 13px;
  min-height: 46px;
  padding: 12px 14px;
  border-radius: 10px;
  color: #778091;
  font-size: 14px;
  transition: padding .28s ease, gap .28s ease, background .15s ease, color .15s ease;
}
.nav-label {
  max-width: 150px;
  overflow: hidden;
  white-space: nowrap;
  transition: max-width .28s ease, opacity .18s ease, transform .28s ease;
}
.nav-item:hover {
  background: #e8eaf0;
  color: #46536b;
}
.nav-item.is-current {
  color: var(--primary);
  background: #fff;
  box-shadow: 0 2px 8px #202b4304;
  font-weight: 600;
}
.sidebar-account {
  position: relative;
  margin-top: auto;
  padding-top: 16px;
}
.account-button {
  width: 100%;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  min-width: 0;
  padding: 4px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--text);
  text-align: left;
  transition: gap .28s ease, padding .28s ease, background .15s ease;
}
.account-name {
  flex: 1;
  min-width: 0;
  max-width: 150px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 14px;
  font-weight: 550;
  transition: max-width .28s ease, opacity .18s ease, transform .28s ease;
}
.account-button:hover {
  background: #eceff4;
}
.user-popup {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  width: 190px;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: #fff;
  box-shadow: 0 8px 30px #202b4318;
  z-index: 25;
}
.app-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 40px;
  overflow-y: auto;
  background: var(--canvas);
}
.layout--collapsed .aside {
  flex-basis: 80px;
  width: 80px;
  padding: 28px 12px 16px;
}
.layout--collapsed .sidebar-brand {
  gap: 0;
  padding-right: 0;
}
.layout--collapsed .brand-mark {
  margin-left: 11px;
}
.layout--collapsed .brand-title,.layout--collapsed .nav-label {
  max-width: 0;
  opacity: 0;
  transform: translateX(-8px);
}
.layout--collapsed .nav-item {
  gap: 0;
  padding: 12px 18px;
}
.layout--collapsed .account-button {
  gap: 0;
  padding-inline: 10px;
}
.layout--collapsed .account-name {
  max-width: 0;
  opacity: 0;
  transform: translateX(-8px);
}
.sidebar-control-enter-active,.sidebar-control-leave-active {
  transition: opacity .18s ease;
}
.sidebar-control-enter-from,.sidebar-control-leave-to {
  opacity: 0;
}
.mobile-bottom-nav {
  display: grid;
  grid-template-columns: repeat(5,minmax(0,1fr));
  flex: 0 0 auto;
  align-items: start;
  min-height: 78px;
  padding: 6px max(8px,env(safe-area-inset-right)) max(6px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left));
  background: var(--sidebar);
  border-top: 1px solid var(--line);
  box-shadow: 0 -4px 20px #202b4306;
  z-index: 19;
}
.mobile-nav-item,.mobile-add-button {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  min-height: 64px;
  padding: 8px 2px;
  border: 0;
  border-radius: 16px;
  color: var(--muted);
  background: transparent;
  font-size: 11px;
  line-height: 16px;
  touch-action: manipulation;
  transition: color .15s ease, background .15s ease;
}
.mobile-nav-item .ui-icon {
  width: 23px;
  height: 23px;
}
.mobile-nav-item:hover,.mobile-nav-item:active {
  background: #edf0f5;
}
.mobile-nav-item.is-current {
  color: var(--primary);
  font-weight: 600;
}
.mobile-add-button {
  padding-top: 0;
  color: var(--primary);
  font-weight: 600;
}
.mobile-add-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 54px;
  margin-top: -18px;
  border: 4px solid var(--sidebar);
  border-radius: 50%;
  color: #fff;
  background: var(--primary);
  box-shadow: 0 4px 12px var(--primary-shadow);
  transition: background .15s ease, transform .15s ease;
}
.mobile-add-icon .ui-icon {
  width: 27px;
  height: 27px;
}
.mobile-add-button:hover .mobile-add-icon {
  background: var(--primary-hover);
}
.mobile-add-button:active .mobile-add-icon {
  transform: scale(.94);
}
.skip-link {
  position: fixed;
  top: -80px;
  left: 250px;
  z-index: 30;
  background: #fff;
  padding: 10px;
}
.skip-link:focus {
  top: 10px;
}
@media(max-width:1024px) {
  .app-main {
    padding: 28px;
  }
}
@media(max-width:760px) {
  .layout {
    flex-direction: column;
  }
  .app-main {
    padding: max(28px,env(safe-area-inset-top)) 16px 24px;
    scroll-padding-bottom: 24px;
  }
  .skip-link {
    left: 16px;
  }
}
</style>
