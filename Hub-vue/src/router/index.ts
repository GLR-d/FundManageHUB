import type { RouteRecordRaw, RouteLocationNormalized } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'
import { captureSession } from '@/stores/auth'
import { createRouteRecovery } from '@/utils/routeRecovery'
import { createPageImport } from '@/utils/pageImport'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    component: createPageImport(() => import('../views/login/index.vue'), 'login'),
    meta: {title: '登录'}
  },
  {
    path: '/register',
    component: createPageImport(() => import('../views/register/index.vue'), 'register'),
    meta: {title: '注册'}
  },
  {
    path: '/forgot-password',
    component: createPageImport(() => import('../views/recovery/index.vue'), 'recovery'),
    meta: { title: '找回密码' }
  },
  {
    path: '/reset-password',
    redirect: () => ({ path: '/forgot-password', query: {} })
  },
  {
    path: '/verify-email',
    redirect: () => ({ path: '/forgot-password', query: {} })
  },
  {
    path: '/',
    redirect: '/dashboard',
    component: createPageImport(() => import('../layout/index.vue'), 'layout'),
    meta: {title: '', requiresAuth: true},
    children: [
      {
        path: '/about',
        component: createPageImport(() => import('../views/about/index.vue'), 'about'),
        meta: { title: '关于' }
      },
      {
        path: '/dashboard',
        component: createPageImport(() => import('../views/dashboard/index.vue'), 'dashboard'),
        meta: {title: '首页'} 
      },
      {
        path: '/fund',
        component: createPageImport(() => import('../views/fund/index.vue'), 'fund'),
        meta: {title: '记账'} 
      },
      {
        path: '/chat',
        component: createPageImport(() => import('../views/chat/index.vue'), 'chat'),
        meta: {title: '聊天'} 
      },
      {
        path: '/setting',
        component: createPageImport(() => import('../views/setting/index.vue'), 'setting'),
        meta: {title: '设置'} 
      },
      {
        path: '/my',
        component: createPageImport(() => import('../views/my/index.vue'), 'my'),
        meta: {title: '我的'} 
      },
      {
        path:'/:pathMatch(.*)*',
        component: createPageImport(() => import('../views/404.vue'), '404'),
        meta: {title: '404'}
      },
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

const requireSession = (to: RouteLocationNormalized) => {
  if (to.meta.requiresAuth && !captureSession().token) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
}
router.beforeEach(requireSession)
// 页面文件下载期间可能退出登录，展示页面前再次检查。
router.beforeResolve(requireSession)
export const routeRecovery = createRouteRecovery(router)
if (import.meta.hot) import.meta.hot.dispose(routeRecovery.dispose)

export default router
