<template>
  <svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'more'">
      <circle v-for="x in [5, 12, 19]" :key="x" :cx="x" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'select'">
      <rect x="4" y="4" width="16" height="16" rx="1" fill="none" stroke="currentColor" />
      <path d="m7.5 12 3 3 6-6" stroke="currentColor" stroke-width="2" />
    </template>
    <template v-else>
      <path v-for="(path, index) in paths" :key="index" :d="path" />
    </template>
  </svg>
</template>
<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps({
  name: String
});
const icons: Record<string, string[]> = {
  home: ['M3 10 12 3l9 7', 'M5 9v12h14V9', 'M9 21v-8h6v8'],
  wallet: ['M4 6h15v14H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13v2', 'M15 11h6v5h-6z'],
  chat: ['M21 11a8 8 0 0 1-8 8H8l-5 3 1-6a8 8 0 1 1 17-5Z', 'M8 11h.01M12 11h.01M16 11h.01'],
  user: ['M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z', 'M4 21v-2a8 8 0 0 1 16 0v2'],
  settings: ['M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z', 'm10 2-.5 3-2 .8L5 4 2 9l2.5 2v2L2 15l3 5 2.5-1.8 2 .8.5 3h4l.5-3 2-.8L19 20l3-5-2.5-2v-2L22 9l-3-5-2.5 1.8-2-.8L14 2Z'],
  info: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 11v6M12 7h.01'],
  pin: ['m16 3 5 5-4 1-3 6v3l-8-8h3l6-3Z', 'm9 15-6 6'],
  send: ['M12 19V5', 'm5 12 7-7 7 7'],
  stop: ['M6 6h12v12H6Z'],
  plus: ['M12 5v14M5 12h14'],
  check: ['m5 12 4 4L19 6'],
  calendar: ['M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M7 2v4M17 2v4M3 10h18M7 14h2M15 14h2M7 17h2'],
  close: ['M6 6l12 12M6 18 18 6'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  fold: ['M9 4v16M4 4h16v16H4Z'],
  search: ['M19 19 15.5 15.5', 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z'],
  edit: ['m16 3 5 5-12 12-6 1 1-6Z', 'm13 6 5 5'],
  trash: ['M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'],
  refresh: ['M20 7v5h-5M4 17v-5h5', 'M20 12a8 8 0 0 0-14-5M4 12a8 8 0 0 0 14 5'],
  logout: ['M9 4H4v16h5M9 12h12m-4-4 4 4-4 4'],
  chevron: ['m9 5 7 7-7 7'],
  eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z']
};
const paths = computed(() => icons[props.name || 'info'] || icons.info);
</script>
