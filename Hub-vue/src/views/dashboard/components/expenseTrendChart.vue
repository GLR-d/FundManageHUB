<template>
  <article class="expense-chart" :aria-busy="loading">
    <header class="expense-chart-heading">
      <h2>每日支出</h2>
    </header>
    <div v-if="loading" class="expense-chart-loading" :style="{ height: chartHeight + 'px' }" role="status">
      <span class="chart-loading-dot" aria-hidden="true" />
      正在加载每日支出…
    </div>
    <div v-else ref="chartElement" class="expense-chart-interaction" tabindex="0" role="group" aria-roledescription="可交互折线图" :aria-label="monthCaption + '每日支出，使用左右方向键选择日期，Home 跳到月初，End 跳到月末'" :aria-describedby="descriptionId" @pointerdown="handlePointerDown" @pointermove="handlePointerMove" @pointerup="finishPointer" @pointercancel="finishPointer" @pointerleave="handlePointerLeave" @focus="handleFocus" @blur="clearSelection" @keydown="handleKeydown">
      <svg class="expense-chart-svg" :viewBox="'0 0 ' + chartWidth + ' ' + chartHeight" :height="chartHeight" role="img" :aria-labelledby="titleId + ' ' + descriptionId">
        <title :id="titleId">{{ monthCaption }}每日支出走势图</title>
        <defs>
          <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#3964fe" stop-opacity=".16" />
            <stop offset="100%" stop-color="#3964fe" stop-opacity=".015" />
          </linearGradient>
        </defs>
        <g v-for="tick in scale.ticks" :key="tick" class="chart-grid">
          <line :x1="plotLeft" :x2="plotRight" :y1="valueY(tick)" :y2="valueY(tick)" />
          <text :x="plotLeft - 10" :y="valueY(tick) + 4" text-anchor="end">{{ formatExpenseAxis(tick) }}</text>
        </g>
        <g class="chart-dates">
          <text v-for="index in labelIndices" :key="index" :x="pointX(index)" :y="plotBottom + 26" :text-anchor="index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle'">{{ dateLabel(days[index].date) }}</text>
        </g>
        <path v-if="areaPath" :d="areaPath" :fill="'url(#' + gradientId + ')'" />
        <path v-if="linePath" class="chart-line" :d="linePath" />
        <g v-if="selectedPoint" class="chart-selected" aria-hidden="true">
          <line :x1="selectedX" :x2="selectedX" :y1="plotTop" :y2="plotBottom" />
          <circle class="chart-point-halo" :cx="selectedX" :cy="selectedY" r="8" />
          <circle class="chart-point" :cx="selectedX" :cy="selectedY" r="4" />
        </g>
      </svg>
      <div v-if="selectedPoint" class="expense-chart-tooltip" :class="{ 'expense-chart-tooltip--inline': inlineTooltip }" :style="tooltipStyle" aria-hidden="true">
        <span>{{ selectedPoint.date.replaceAll('-', '/') }}</span>
        <strong>{{ formatCents(selectedPoint.amountCents) }}<small>元</small></strong>
      </div>
      <p :id="descriptionId" class="chart-sr-only" aria-live="polite">{{ selectedPoint ? selectedPoint.date + '，支出' + formatCents(selectedPoint.amountCents) + '元' : '选择日期查看当天支出。' }}</p>
    </div>
  </article>
</template>
<script setup lang="ts">
import type { CSSProperties } from 'vue'
import type { ExpenseTrendPoint } from '@/utils/expenseChart'
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { createExpenseScale, fillExpenseMonth, formatExpenseAxis, getExpenseDayLabels, nearestExpenseDay } from '@/utils/expenseChart'
import { formatCents } from '@/utils/funds'

const props = withDefaults(defineProps<{ points: ExpenseTrendPoint[]; month: string; loading?: boolean }>(), { loading: false })
const identity = useId()
const titleId = 'expense-title-' + identity
const descriptionId = 'expense-description-' + identity
const gradientId = 'expense-fill-' + identity
const chartElement = ref<HTMLElement | null>(null)
const chartWidth = ref(640)
const selectedIndex = ref<number | null>(null)
let observer: ResizeObserver | null = null
let resizeFrame: number | undefined
let activePointer: number | null = null
const days = computed(() => fillExpenseMonth(props.points, props.month))
const monthCaption = computed(() => {
  const [year, month] = props.month.split('-')
  return year && month ? year + '年' + Number(month) + '月' : '本月'
})
const inlineTooltip = computed(() => chartWidth.value >= 480)
const tooltipHeight = computed(() => inlineTooltip.value ? 52 : 78)
const chartHeight = computed(() => chartWidth.value < 480 ? 238 : 264)
const scale = computed(() => createExpenseScale(Math.max(0, ...days.value.map(point => point.amountCents))))
const plotLeft = computed(() => Math.max(42, Math.min(74, Math.max(...scale.value.ticks.map(tick => formatExpenseAxis(tick).length)) * 7 + 14)))
const plotRight = computed(() => chartWidth.value - 14)
const plotTop = computed(() => 18)
const plotBottom = computed(() => chartHeight.value - 36)
const plotWidth = computed(() => Math.max(1, plotRight.value - plotLeft.value))
const labelIndices = computed(() => getExpenseDayLabels(days.value.length, plotWidth.value))
const pointX = (index: number) => plotLeft.value + index / Math.max(1, days.value.length - 1) * plotWidth.value
const valueY = (cents: number) => plotBottom.value - cents / scale.value.maximum * (plotBottom.value - plotTop.value)
const linePath = computed(() => days.value.map((point, index) => (index ? 'L' : 'M') + pointX(index).toFixed(2) + ',' + valueY(point.amountCents).toFixed(2)).join(' '))
const areaPath = computed(() => linePath.value ? linePath.value + ' L' + plotRight.value + ',' + plotBottom.value + ' L' + plotLeft.value + ',' + plotBottom.value + ' Z' : '')
const selectedPoint = computed(() => selectedIndex.value === null ? null : days.value[selectedIndex.value] ?? null)
const selectedX = computed(() => pointX(selectedIndex.value ?? 0))
const selectedY = computed(() => valueY(selectedPoint.value?.amountCents ?? 0))
const tooltipStyle = computed<CSSProperties>(() => {
  const amount = formatCents(selectedPoint.value?.amountCents ?? 0)
  const width = Math.min(inlineTooltip.value ? 348 : 212, Math.max(inlineTooltip.value ? 196 : 148, amount.length * 12 + (inlineTooltip.value ? 112 : 32)), chartWidth.value - 16)
  return {
    width: width + 'px',
    height: tooltipHeight.value + 'px',
    left: Math.max(8, Math.min(selectedX.value - width / 2, chartWidth.value - width - 8)) + 'px',
    top: Math.max(8, Math.min(selectedY.value - tooltipHeight.value - 12, plotBottom.value - tooltipHeight.value - 8)) + 'px',
    '--expense-amount-size': Math.min(19, (width - 28 - (inlineTooltip.value ? 96 : 16)) / (amount.length * .62)) + 'px'
  }
})
const dateLabel = (date: string) => Number(date.slice(5, 7)) + '/' + Number(date.slice(8))
const selectAt = (event: PointerEvent) => {
  if (props.loading || !days.value.length) return
  const bounds = chartElement.value?.getBoundingClientRect()
  if (!bounds?.width) return
  const x = (event.clientX - bounds.left) / bounds.width * chartWidth.value
  selectedIndex.value = nearestExpenseDay(x, plotLeft.value, plotWidth.value, days.value.length)
}
const handlePointerDown = (event: PointerEvent) => {
  if (event.button !== 0 && event.pointerType === 'mouse') return
  activePointer = event.pointerId
  selectAt(event)
}
const handlePointerMove = (event: PointerEvent) => {
  if (event.pointerType === 'touch' && activePointer !== event.pointerId) return
  selectAt(event)
}
const finishPointer = () => { activePointer = null }
const clearSelection = () => { selectedIndex.value = null; finishPointer() }
const handlePointerLeave = (event: PointerEvent) => {
  if (event.pointerType === 'touch') return
  const element = chartElement.value
  if (element?.ownerDocument.activeElement !== element) clearSelection()
}
const handleFocus = () => { if (!props.loading && days.value.length && selectedIndex.value === null) selectedIndex.value = 0 }
const handleKeydown = (event: KeyboardEvent) => {
  if (props.loading || !days.value.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = selectedIndex.value ?? 0
  selectedIndex.value = event.key === 'Home' ? 0 : event.key === 'End' ? days.value.length - 1 : Math.max(0, Math.min(days.value.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))
}
const updateWidth = () => {
  if (chartElement.value?.clientWidth) chartWidth.value = Math.max(180, chartElement.value.clientWidth)
}
// 将尺寸变化后的布局调整放到下一帧，避免宽高同时改变时触发观察器循环。
const queueWidthUpdate = () => {
  if (resizeFrame !== undefined) return
  resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; updateWidth() })
}
watch(() => [props.month, props.loading], () => { clearSelection() })
watch(chartElement, (element, previous) => {
  if (previous) observer?.unobserve(previous)
  if (element) { observer?.observe(element); queueWidthUpdate() }
}, { flush: 'post' })
onMounted(() => {
  observer = new ResizeObserver(queueWidthUpdate)
  if (chartElement.value) observer.observe(chartElement.value)
  queueWidthUpdate()
})
onUnmounted(() => { observer?.disconnect(); if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame); finishPointer() })
</script>
<style scoped>
.expense-chart {
  min-width: 0;
  padding: 24px 24px 20px;
  border: 1px solid var(--line,#e9edf3);
  border-radius: 22px;
  background: #fff;
  box-shadow: 0 5px 22px #27334b07;
}
.expense-chart-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.expense-chart-heading {
  margin-bottom: 20px;
}
.expense-chart-heading h2 {
  margin: 0;
  color: var(--text,#273248);
  font-size: 17px;
  font-weight: 600;
}
.expense-chart-interaction {
  position: relative;
  min-width: 0;
  border-radius: 12px;
  outline: none;
  touch-action: pan-y;
}
.expense-chart-interaction:focus-visible {
  outline: 2px solid #a0b5ff;
  outline-offset: 5px;
}
.expense-chart-svg {
  display: block;
  width: 100%;
  overflow: visible;
  user-select: none;
}
.chart-grid line {
  stroke: #edf0f5;
  stroke-width: 1;
}
.chart-grid text,.chart-dates text {
  fill: #a0a8b6;
  font-family: inherit;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.chart-line {
  fill: none;
  stroke: #3964fe;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.chart-selected line {
  stroke: #a0b5ff;
  stroke-width: 1;
  stroke-dasharray: 4 5;
}
.chart-point-halo {
  fill: #fff;
  stroke: #3964fe22;
  stroke-width: 5;
}
.chart-point {
  fill: #3964fe;
  stroke: #fff;
  stroke-width: 2;
}
.expense-chart-tooltip {
  position: absolute;
  z-index: 1;
  max-width: calc(100% - 16px);
  box-sizing: border-box;
  padding: 11px 13px;
  border: 1px solid #e9edf5;
  border-radius: 13px;
  background: #fffffffa;
  box-shadow: 0 6px 24px #27334b14;
  pointer-events: none;
}
.expense-chart-tooltip > span {
  display: block;
  margin-bottom: 5px;
  color: #98a0ae;
  font-size: 11px;
}
.expense-chart-tooltip strong {
  display: block;
  color: #34425e;
  font-size: var(--expense-amount-size,19px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
  white-space: nowrap;
}
.expense-chart-tooltip--inline {
  display: flex;
  align-items: center;
  gap: 12px;
}
.expense-chart-tooltip--inline > span {
  flex: 0 0 auto;
  margin-bottom: 0;
}
.expense-chart-tooltip small {
  margin-left: 5px;
  color: #929cad;
  font-size: 10px;
  font-weight: 400;
}
.expense-chart-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: #98a0ae;
  font-size: 12px;
}
.chart-loading-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #a0b5ff;
  animation: expense-chart-pulse 1.2s ease-in-out infinite alternate;
}
.chart-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0,0,0,0);
}
@keyframes expense-chart-pulse {
  from { opacity: .45; }
  to { opacity: 1; }
}
@media(max-width:480px) {
  .expense-chart {
    padding: 20px 16px 17px;
    border-radius: 18px;
  }
  .expense-chart-heading {
    margin-bottom: 16px;
  }
  .expense-chart-heading h2 {
    font-size: 16px;
  }
}
@media(prefers-reduced-motion:reduce) {
  .chart-loading-dot {
    animation: none;
  }
}
</style>
