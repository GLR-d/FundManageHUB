import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import type { FundsByDay, FundFilter, FundRequest } from '@/types/fund'

import { getFundapi, searchFundsapi } from '@/api/fund'
import { errorDetails } from '@/utils/errors'
import { feedback, getRequestErrorMessage } from '@/utils/feedback'
import { normalizeFundPage, fundCount } from '@/utils/funds'

export const useFundList = (options: { initialFilter?: FundFilter | null; onReset?: () => void } = {}) => {
  const fundData = ref<FundsByDay>({})
  const dayBatchSize = 5
  const totalFunds = computed(() => fundCount(fundData.value))
  const totalDays = computed(() => Object.keys(fundData.value).length)
  const hasMoreDays = ref(false)
  const nextCursor = ref<string | null>(null)
  const visibleFundData = computed(() => fundData.value)
  const loadMoreRef = ref<HTMLElement | null>(null)
  const loading = ref(false)
  const loadError = ref('')
  const appendError = ref(false)
  const showEmpty = computed(() => !loading.value && !loadError.value && !totalFunds.value)
  let listVersion = 0
  let listController: AbortController | null = null
  let desiredFilter: FundFilter | null = options.initialFilter ?? null
  let failedRequest: FundRequest | null = null
  let disposed = false
  let loadObserver: IntersectionObserver | null = null
  const refreshLoadObserver = () => {
    if (!loadObserver || !loadMoreRef.value || disposed) return
    loadObserver.unobserve(loadMoreRef.value)
    if (!loading.value && !loadError.value && hasMoreDays.value) loadObserver.observe(loadMoreRef.value)
  }
  const notifyLoadFailure = (text: string) => {
    loadError.value = text
    feedback.error(text + (totalFunds.value ? '\n当前显示的是上一次成功加载的账单。' : ''))
  }
  const requestFunds = async (request: FundRequest) => {
    if (disposed) return
    const version = ++listVersion
    listController?.abort()
    const controller = new AbortController()
    listController = controller
    desiredFilter = request.filter
    loading.value = true
    try {
      let items: FundsByDay = {}
      let before = request.before
      let page
      do {
        const params = { days: dayBatchSize, ...(before ? { before } : {}) }
        const config = { signal: controller.signal, silentError: true }
        const res = request.filter
          ? await searchFundsapi({ ...request.filter, ...params }, config)
          : await getFundapi({ ...config, params })
        if (disposed || version !== listVersion) return
        if (res?.code !== 1) {
          failedRequest = request
          appendError.value = request.append
          notifyLoadFailure(res?.msg || '未能获取账单，请稍后重试。')
          return
        }
        page = normalizeFundPage(res.data, { days: dayBatchSize, before })
        items = { ...items, ...page.items }
        before = page.nextCursor
        // 保存后分批刷新到原来看到的日期，避免将已加载的旧账单收回。
      } while (!request.append && page.hasMore && (
        Object.keys(items).length < (request.minimumDays ?? dayBatchSize) ||
        (request.throughDay && (Object.keys(items).at(-1) || '') > request.throughDay)
      ))
      if (disposed || version !== listVersion) return
      fundData.value = request.append ? { ...fundData.value, ...items } : items
      hasMoreDays.value = page.hasMore
      nextCursor.value = page.nextCursor
      loadError.value = ''
      appendError.value = false
      failedRequest = null
      if (!request.append) {
        options.onReset?.()
        if (request.resetRange) loadMoreRef.value?.closest('.app-main')?.scrollTo({ top: 0 })
      }
    } catch (cause) {
      const error = errorDetails(cause)
      if (disposed || version !== listVersion || error?.code === 'ERR_CANCELED' || error?.__CANCEL__ || error?.response?.status === 401) return
      failedRequest = request
      appendError.value = request.append
      notifyLoadFailure(error?.code === 'INVALID_FUND_DATA' ? (error.message || '账单数据异常，请重新加载') : getRequestErrorMessage(error))
    } finally {
      if (version === listVersion) loading.value = false
    }
  }
  const loadFunds = (filter: FundFilter | null, resetRange = true) => requestFunds({
    filter: filter ? { ...filter } : null,
    append: false,
    before: null,
    resetRange,
    minimumDays: resetRange ? dayBatchSize : Math.max(dayBatchSize, totalDays.value),
    throughDay: resetRange ? null : Object.keys(fundData.value).at(-1)
  })
  const selectList = () => loadFunds(desiredFilter, false)
  const loadMoreDays = () => {
    if (disposed || loading.value || loadError.value || !hasMoreDays.value || !nextCursor.value) return
    return requestFunds({ filter: desiredFilter ? { ...desiredFilter } : null, append: true, before: nextCursor.value })
  }
  const retryLoad = () => { if (!loading.value && failedRequest) return requestFunds(failedRequest) }
  onMounted(() => {
    loadObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreDays()
    }, { root: loadMoreRef.value?.closest('.app-main') || null, rootMargin: '0px 0px 160px 0px' })
    selectList()
  })
  // 新数据或追加卡片后重新观察；内容不足一屏时继续补齐，滚到底时追加整天。
  watch([fundData, hasMoreDays, loading, loadError], refreshLoadObserver, { flush: 'post' })
  onUnmounted(() => { disposed = true; loadObserver?.disconnect(); listVersion++; listController?.abort() })
  const clearData = () => {
    fundData.value = {}
    hasMoreDays.value = false
    nextCursor.value = null
    loadError.value = ''
    appendError.value = false
    failedRequest = null
  }
  return { fundData, totalFunds, totalDays, hasMoreDays, nextCursor, visibleFundData, loadMoreRef, loading, loadError, appendError, showEmpty, loadFunds, selectList, loadMoreDays, retryLoad, clearData, getFilter: () => desiredFilter }
}
