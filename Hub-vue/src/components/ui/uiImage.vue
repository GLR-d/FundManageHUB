<template>
  <img v-if="active" :key="revision" :src="displaySource || undefined" @error="controller.handleError" />
</template>
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import router from '@/router'
import { createImageRefreshController } from '@/services/imageRefresh'

const props = withDefaults(defineProps<{ src?: string; active?: boolean }>(), { active: true })
const emit = defineEmits<{ error: [event: Event] }>()
const displaySource = ref('')
const revision = ref(0)
const controller = createImageRefreshController({
  onChange: (source, version) => { displaySource.value = source; revision.value = version },
  onError: event => emit('error', event)
})
watch(() => props.src, value => controller.setSource(value), { immediate: true, flush: 'sync' })
watch(() => props.active, value => controller.setActive(value), { immediate: true, flush: 'sync' })
watch(() => router.currentRoute.value.fullPath, controller.cancel, { flush: 'sync' })
onUnmounted(controller.dispose)
</script>
