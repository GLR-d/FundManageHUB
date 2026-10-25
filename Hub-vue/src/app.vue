<template>
  <AppFeedback />
  <RouteLoadRetry v-if="showPageRecovery" full-page />
  <div v-show="!showPageRecovery">
    <router-view v-if="!route.meta.requiresAuth || loginUser" :key="sessionVersion" />
  </div>
</template>
<script setup lang="ts">
import { useRoute } from 'vue-router'
import { computed } from 'vue'
import { routeRecovery } from '@/router'
import RouteLoadRetry from '@/components/routeLoadRetry.vue'
import AppFeedback from '@/components/appFeedback.vue'
import { loginUser, sessionVersion } from '@/stores/auth'
const route = useRoute()
const showPageRecovery = computed(() => Boolean(routeRecovery.failure.value && (!route.matched.length || !route.meta.requiresAuth || !loginUser.value)))
</script>
<style>
body {
  margin: 0;
}
</style>
