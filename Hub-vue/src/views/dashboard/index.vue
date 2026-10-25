<template>
  <section class="dashboard" :aria-busy="loading">
    <div class="page-heading">
      <h1 class="dashboard-title">
        <DashboardMonthPicker :model-value="statisticsMonth" :current-year="currentDate.getFullYear()" @update:model-value="selectMonth" />
        <span>概览</span>
      </h1>
    </div>
    <div class="statistics-grid">
      <article class="stat-card">
        <span class="stat-label">{{ periodLabel }}支出</span>
        <strong class="expense">{{ loaded ? formatCents(expenseCents) : '—' }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">{{ periodLabel }}收入</span>
        <strong class="income">{{ loaded ? formatCents(incomeCents) : '—' }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">{{ periodLabel }}结余</span>
        <strong>{{ loaded ? formatCents(incomeCents - expenseCents) : '—' }}</strong>
      </article>
      <article class="stat-card stat-card--comparison" :class="loaded ? 'is-' + expenseComparison.direction : undefined">
        <span class="stat-label">较上月支出</span>
        <strong class="comparison-amount">{{ loaded ? (expenseComparison.differenceCents > 0 ? '+' : '') + formatCents(expenseComparison.differenceCents) : '—' }}</strong>
      </article>
    </div>
    <MonthlyExpenseLimit :expense-cents="expenseCents" :categories="categoryExpenses" :period-label="periodLabel" :statistics-loaded="loaded" :loading="loading && !loaded" />
    <div v-if="loadError" class="dashboard-retry">
      <UiButton type="primary" :loading="loading" @click="loadStatistics">
        <UiIcon name="refresh" />
        重新加载
      </UiButton>
    </div>
    <p v-else-if="loading && !loaded" class="dashboard-loading" role="status">正在加载统计…</p>
    <div v-if="loaded || loading" class="dashboard-charts">
      <ExpenseTrendChart :points="dailyExpenses" :month="statisticsMonth" :loading="loading && !loaded" />
      <ExpenseCategoryChart :categories="categoryExpenses" :loading="loading && !loaded" />
    </div>
    <MonthlyExpenseChart v-if="loaded || loading" class="dashboard-monthly" :points="monthlyExpenses" :loading="loading && !loaded" />
  </section>
</template>
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { errorDetails } from '@/utils/errors'
import UiButton from '@/components/ui/uiButton.vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import DashboardMonthPicker from './components/dashboardMonthPicker.vue'
import ExpenseTrendChart from './components/expenseTrendChart.vue'
import ExpenseCategoryChart from './components/expenseCategoryChart.vue'
import MonthlyExpenseChart from './components/monthlyExpenseChart.vue'
import MonthlyExpenseLimit from './components/monthlyExpenseLimit.vue'
import { feedback, getRequestErrorMessage } from '@/utils/feedback'
import { getDashboardStatisticsapi } from '@/api/dashboard'
import { formatCents } from '@/utils/funds'
import { normalizeDashboardStatistics, compareMonthlyExpense } from '@/utils/dashboard'
defineOptions({ name: 'Dashboard' })
const currentDate = ref(new Date())
const monthKey = (date: Date) => String(date.getFullYear()).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0')
const selectedMonth = ref(monthKey(currentDate.value))
const month = computed(() => Number(selectedMonth.value.slice(5)))
const statisticsMonth = computed(() => selectedMonth.value)
const periodLabel = computed(() => selectedMonth.value === monthKey(currentDate.value) ? '本月' : month.value + '月')
const statistics = ref<ReturnType<typeof normalizeDashboardStatistics> | null>(null)
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')
let disposed = false
let requestVersion = 0
let controller: AbortController | null = null
let monthSyncTimer: ReturnType<typeof setTimeout> | undefined
let visibilityDocument: Document | null = null
const incomeCents = computed(() => statistics.value?.income ?? 0)
const expenseCents = computed(() => statistics.value?.expense ?? 0)
const previousMonthExpenseCents = computed(() => statistics.value?.previousMonthExpense ?? 0)
const dailyExpenses = computed(() => statistics.value?.dailyExpenses ?? [])
const categoryExpenses = computed(() => statistics.value?.categoryExpenses ?? [])
const monthlyExpenses = computed(() => statistics.value?.monthlyExpenses ?? [])
const expenseComparison = computed(() => compareMonthlyExpense(expenseCents.value, previousMonthExpenseCents.value))
const fail = (text: string) => {
  loadError.value = text
  feedback.error(text + (loaded.value ? '\n当前显示的是上一次成功加载的统计。' : ''))
}
const loadStatistics = async () => {
  if (loading.value || disposed) return
  const version = ++requestVersion
  const requestedMonth = statisticsMonth.value
  const operation = new AbortController()
  controller = operation
  loading.value = true
  try {
    const res = await getDashboardStatisticsapi(requestedMonth, { signal: operation.signal, silentError: true })
    if (disposed || version !== requestVersion || operation.signal.aborted || requestedMonth !== statisticsMonth.value) return
    if (res?.code !== 1) { fail(res?.msg || '获取账单统计失败'); return }
    const summary = normalizeDashboardStatistics(res.data, requestedMonth)
    statistics.value = summary
    loaded.value = true
    loadError.value = ''
  } catch (cause) {
    const error = errorDetails(cause)
    if (disposed || version !== requestVersion || operation.signal.aborted || error?.code === 'ERR_CANCELED' || error?.__CANCEL__ || error?.response?.status === 401) return
    fail(error?.code === 'INVALID_FUND_DATA' ? (error.message || '账单数据异常，请重新加载') : getRequestErrorMessage(error))
  } finally {
    if (version === requestVersion) { loading.value = false; controller = null }
  }
}
const reloadSelectedMonth = () => {
  // 月份切换时清空旧快照，并阻止旧请求覆盖新月份。
  controller?.abort()
  requestVersion++
  controller = null
  statistics.value = null
  loading.value = false
  loaded.value = false
  loadError.value = ''
  void loadStatistics()
}
const selectMonth = (value: string) => {
  if (disposed || typeof value !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value) || value === selectedMonth.value) return
  selectedMonth.value = value
  reloadSelectedMonth()
}
const syncCurrentMonth = (now = new Date()) => {
  if (disposed || !Number.isFinite(now.getTime())) return
  const previousMonth = monthKey(currentDate.value)
  const followCurrentMonth = selectedMonth.value === previousMonth
  currentDate.value = new Date(now.getTime())
  // 浏览历史月份时保留选择；查看当前月时继续跟随自然月切换。
  if (monthKey(now) === previousMonth) return
  if (followCurrentMonth) selectMonth(monthKey(now))
  else if (selectedMonth.value === monthKey(now)) reloadSelectedMonth()
}
const scheduleMonthSync = () => {
  clearTimeout(monthSyncTimer)
  if (disposed) return
  monthSyncTimer = setTimeout(() => { syncCurrentMonth(); scheduleMonthSync() }, 60000 - Date.now() % 60000 + 25)
}
const handleVisibilityChange = () => {
  if (visibilityDocument?.visibilityState !== 'visible') return
  syncCurrentMonth()
  scheduleMonthSync()
}
onMounted(() => {
  syncCurrentMonth()
  void loadStatistics()
  visibilityDocument = document
  visibilityDocument.addEventListener('visibilitychange', handleVisibilityChange)
  scheduleMonthSync()
})
onUnmounted(() => {
  disposed = true
  requestVersion++
  controller?.abort()
  clearTimeout(monthSyncTimer)
  visibilityDocument?.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>
<style scoped>
.dashboard-title { display: flex; align-items: baseline; gap: 6px; }
.statistics-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 18px; }
.stat-card { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-width: 0; min-height: 98px; padding: 22px 24px; border: 1px solid var(--line); border-radius: 20px; background: white; box-shadow: 0 5px 22px #27334b07; }
.stat-label { flex-shrink: 0; color: #667187; font-size: 14px; white-space: nowrap; }
.stat-card strong { min-width: 0; max-width: 100%; overflow-x: auto; white-space: nowrap; scrollbar-width: thin; color: var(--text); font-size: clamp(24px,2.2vw,30px); font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.6px; }
.stat-card strong.expense { color: var(--expense-color); }
.stat-card strong.income { color: var(--income-color); }
.stat-card--comparison .comparison-amount { color: #8490a3; }
.stat-card--comparison.is-increase .comparison-amount { color: #cf4c53; }
.stat-card--comparison.is-decrease .comparison-amount { color: #419781; }
.dashboard-charts { display: grid; grid-template-columns: minmax(0,1.5fr) minmax(320px,1fr); gap: 22px; margin-top: 24px; }
.dashboard-charts > * { min-width: 0; }
.dashboard-monthly { margin-top: 22px; }
.dashboard-retry { display: flex; align-items: center; justify-content: center; min-height: 120px; }
.dashboard-loading { padding: 32px 0; color: var(--muted); text-align: center; }
@media(min-width:1500px) { .statistics-grid { grid-template-columns: repeat(4,minmax(0,1fr)); } }
@media(max-width:1200px) { .dashboard-charts { grid-template-columns: minmax(0,1fr); } }
@media(max-width:760px) {
  .dashboard-title { gap: 0; }
  .statistics-grid { grid-template-columns: minmax(0,1fr); gap: 12px; }
  .stat-card { min-height: 78px; padding: 18px 20px; border-radius: 18px; }
  .stat-card strong { font-size: 26px; }
  .dashboard-charts { gap: 18px; margin-top: 18px; }
  .dashboard-monthly { margin-top: 18px; }
}
@media(max-width:380px) { .stat-card { gap: 12px; padding: 16px; } .stat-card strong { font-size: 24px; } }
</style>
