<template>
  <button type="button" class="ui-button" :class="['ui-button--' + type, { 'ui-button--icon': circle, 'ui-button--small': size === 'small' }]" :disabled="disabled || loading" :aria-busy="loading || undefined">
    <span v-if="loading" class="ui-spinner" aria-hidden="true" />
    <slot />
  </button>
</template>
<script setup lang="ts">
defineProps({
  type: {
    type: String,
    default: 'default'
  },
  disabled: Boolean,
  loading: Boolean,
  circle: Boolean,
  size: String
});
</script>
