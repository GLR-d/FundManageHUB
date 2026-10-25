<template>
  <span class="ui-avatar" :style="{ width: size + 'px', height: size + 'px' }">
    <UiImage v-if="src && !failed" :src="src" :active="active" alt="" @error="failed = true" />
    <UiIcon v-else :name="icon" />
  </span>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import UiIcon from './uiIcon.vue';
import UiImage from './uiImage.vue';
const props = defineProps({
  src: String,
  active: { type: Boolean, default: true },
  size: {
    type: Number,
    default: 36
  },
  icon: {
    type: String,
    default: 'user'
  }
});
const failed = ref(false);
watch(() => [props.src, props.active], () => {
  failed.value = false;
});
</script>
