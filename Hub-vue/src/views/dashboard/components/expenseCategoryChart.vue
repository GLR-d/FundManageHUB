<template>
  <article class="category-chart" :aria-busy="loading">
    <h2>消费占比</h2>
    <div v-if="loading" class="category-state" role="status">正在加载…</div>
    <div v-else-if="!breakdown.items.length" class="category-state">暂无支出</div>
    <div v-else class="category-layout">
      <div class="category-ring">
        <svg viewBox="0 0 210 210" aria-hidden="true">
          <circle class="ring-track" cx="105" cy="105" r="80" />
          <g transform="rotate(-90 105 105)">
            <circle v-for="item in breakdown.items" :key="item.type" class="ring-segment" :class="{ 'is-active': item.type === activeCategory?.type }" cx="105" cy="105" r="80" pathLength="100" :stroke="'color-mix(in srgb, ' + item.backgroundColor + ' 90%, ' + item.color + ')'" :stroke-dasharray="item.share * 100 + ' ' + (100 - item.share * 100)" :stroke-dashoffset="-item.offset * 100" @pointerenter="selectCategory(item.type)" @click="selectCategory(item.type)" />
          </g>
        </svg>
        <div v-if="activeCategory" class="ring-center" aria-hidden="true">
          <span class="ring-label" :title="activeCategory.label">{{ activeCategory.label }}</span>
          <strong>{{ activeCategory.percentage }}</strong>
          <span class="ring-amount">{{ formatCents(activeCategory.amountCents) }}</span>
        </div>
      </div>
      <ul class="category-list" aria-label="消费类型支出金额">
        <li v-for="item in breakdown.items" :key="item.type">
          <RouterLink :to="{ path: '/fund', query: { type: item.type } }" class="category-option" :class="{ 'is-active': item.type === activeCategory?.type }" :aria-label="'查看' + item.label + '账单，' + item.percentage + '，支出 ' + formatCents(item.amountCents) + ' 元'" :title="'查看' + item.label + '账单 · ' + formatCents(item.amountCents) + '（' + item.percentage + '）'" @pointerenter="selectCategory(item.type)" @focus="selectCategory(item.type)">
            <i :style="{ background: item.color }" aria-hidden="true" />
            <span class="category-label" :style="{ background: item.backgroundColor, color: item.color }">{{ item.label }}</span>
            <strong>{{ formatCents(item.amountCents) }}</strong>
          </RouterLink>
        </li>
      </ul>
    </div>
  </article>
</template>
<script setup lang="ts">
import type { CategoryExpensePoint } from '@/types/dashboard'

import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { buildExpenseCategories } from '@/utils/expenseCategories'
import { formatCents } from '@/utils/funds'

const props = withDefaults(defineProps<{ categories: readonly CategoryExpensePoint[]; loading?: boolean }>(), { loading: false })
const selectedType = ref('')
const breakdown = computed(() => buildExpenseCategories(props.categories))
const activeCategory = computed(() => breakdown.value.items.find(item => item.type === selectedType.value) ?? breakdown.value.items[0] ?? null)
const selectCategory = (type: string) => { selectedType.value = type }
watch(() => props.categories, () => { selectedType.value = '' })
</script>
<style scoped>
.category-chart {
  min-width: 0;
  padding: 24px;
  border: 1px solid var(--line,#e9edf3);
  border-radius: 22px;
  background: #fff;
  box-shadow: 0 5px 22px #27334b07;
  container-type: inline-size;
}
.category-chart h2 {
  margin: 0 0 20px;
  color: var(--text,#273248);
  font-size: 17px;
  font-weight: 600;
}
.category-layout {
  display: grid;
  grid-template-columns: minmax(160px,1fr) minmax(140px,1fr);
  align-items: center;
  gap: 16px;
  min-height: 264px;
}
.category-ring {
  position: relative;
  width: 210px;
  max-width: 100%;
  margin: 0 auto;
}
.category-ring svg {
  display: block;
  width: 100%;
  overflow: visible;
}
.ring-track,.ring-segment {
  fill: none;
  stroke-width: 24;
}
.ring-track { stroke: #eef1f7; }
.ring-segment {
  cursor: pointer;
  transition: stroke-width .18s ease, opacity .18s ease;
}
.ring-segment.is-active { stroke-width: 29; }
.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  pointer-events: none;
}
.ring-label {
  max-width: 124px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #657187;
  font-size: 14px;
}
.ring-center strong {
  color: var(--text,#273248);
  font-size: 29px;
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.8px;
}
.ring-amount {
  max-width: 132px;
  color: #657187;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.4px;
  white-space: nowrap;
}
.category-list {
  display: grid;
  gap: 5px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.category-list li { min-width: 0; }
.category-option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
  min-height: 39px;
  padding: 8px 10px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: #66738a;
  text-align: left;
  text-decoration: none;
  font-size: 14px;
  transition: background .18s ease;
}
.category-option:hover,.category-option.is-active { background: #f4f6fc; }
.category-option > i {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.category-label {
  flex: 0 1 auto;
  min-width: 0;
  margin-right: auto;
  padding: 4px 9px;
  border-radius: 6px;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.category-option strong {
  flex: 0 0 auto;
  color: #47536b;
  font-size: 14px;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
}
.category-state {
  display: grid;
  min-height: 264px;
  place-items: center;
  color: var(--muted,#8a94a5);
  font-size: 14px;
}
@container (max-width:430px) {
  .category-layout { grid-template-columns: minmax(0,1fr); gap: 8px; }
  .category-ring { width: 190px; }
  .category-list { grid-template-columns: minmax(0,1fr); gap: 4px 8px; }
  .category-option { padding: 9px 8px; }
}
@media(max-width:480px) {
  .category-chart { padding: 20px 16px; border-radius: 18px; }
  .category-chart h2 { margin-bottom: 12px; font-size: 16px; }
  .category-layout { grid-template-columns: minmax(0,1fr); gap: 8px; }
  .category-ring { width: 190px; }
  .category-list { grid-template-columns: minmax(0,1fr); gap: 4px 6px; }
  .category-option { min-height: 44px; padding: 10px 6px; gap: 6px; }
}
@media(prefers-reduced-motion:reduce) { .ring-segment,.category-option { transition: none; } }
</style>
