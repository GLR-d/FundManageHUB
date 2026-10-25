<template>
  <section v-if="failure" class="route-load-retry" :class="{ 'route-load-retry--page': fullPage }" aria-label="页面加载重试" :aria-busy="retrying">
    <UiButton type="primary" size="large"  :loading="retrying" @click="routeRecovery.retry">
      <UiIcon name="refresh" />
      重新加载
    </UiButton>
    <UiButton :disabled="retrying" title="刷新整个页面会清除未保存的输入" @click="routeRecovery.refresh">刷新整个页面</UiButton>
    <UiButton v-if="canStay" :disabled="retrying" @click="routeRecovery.dismiss">留在当前页</UiButton>
  </section>
</template>
<script setup lang="ts">
import UiButton from '@/components/ui/uiButton.vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { routeRecovery } from '@/router'
import { loginUser } from '@/stores/auth'
defineProps({ fullPage: Boolean })
const route = useRoute()
const { failure, retrying } = routeRecovery
const canStay = computed(() => Boolean(route.matched.length && (!route.meta.requiresAuth || loginUser.value)))
</script>
<style scoped>
.route-load-retry {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  min-height: 120px;
  padding: 24px 12px;
  box-sizing: border-box;
}
.route-load-retry--page {
  min-height: 100vh;
  min-height: 100dvh;
}
</style>
