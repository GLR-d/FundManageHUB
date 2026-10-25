<template>
  <div class="empty-state">
    <UiIcon name="info" />
    <h1>页面不存在</h1>
    <router-link to="/dashboard">返回首页</router-link>
  </div>
</template>
<script setup lang="ts">
import UiIcon from '@/components/ui/uiIcon.vue'
defineOptions({ name:'NotFound' })
</script>
