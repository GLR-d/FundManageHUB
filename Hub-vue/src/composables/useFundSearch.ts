import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type UiButton from '@/components/ui/uiButton.vue'
import router from '@/router'
import { typeMap, validateAmount } from '@/utils/funds'
import { feedback } from '@/utils/feedback'
import type { useFundList } from './useFundList'
import type { useFundSelection } from './useFundSelection'

export const categoryFromQuery = (value: unknown): string | null => typeof value === 'string' && Object.hasOwn(typeMap, value) ? value : null

export const useFundSearch = ({ list, selection, initialCategory }: {
  list: ReturnType<typeof useFundList>
  selection: ReturnType<typeof useFundSelection>
  initialCategory: string | null
}) => {
  let disposed = false
  let handledRouteCategory = initialCategory
  let applyingRouteCategory = false
  const searchVisible = ref(initialCategory !== null)
  const searchShell = ref<HTMLFormElement | null>(null)
  const searchFields = ref<HTMLElement | null>(null)
  const searchToggle = ref<InstanceType<typeof UiButton> | null>(null)
  const searchText = ref<string | number | null>(initialCategory ?? '')
  const searchType = ref(initialCategory === null ? '3' : '1')
  const hasSearchText = computed(() => searchText.value !== '' && searchText.value !== null)
  const searchIdleDelay = 15_000
  let searchIdleTimer: ReturnType<typeof setTimeout> | null = null
  let searchComposing = false
  const isBlankSearch = (value: string | number | null) => value === null || value === '' || (typeof value === 'string' && !value.trim())
  const clearSearchIdle = () => {
    if (searchIdleTimer !== null) clearTimeout(searchIdleTimer)
    searchIdleTimer = null
  }
  const focusSearchValue = () => nextTick(() => {
    if (!disposed && searchVisible.value && !selection.showSelection.value) searchFields.value?.querySelector<HTMLElement>('[data-search-value]')?.focus()
  })
  const closeSearch = () => {
    clearSearchIdle()
    if (!searchVisible.value) return
    const shell = searchShell.value
    const activeElement = shell?.ownerDocument?.activeElement
    const hadFocus = Boolean(activeElement && shell?.contains(activeElement))
    searchVisible.value = false
    searchComposing = false
    // 收起只改变显示；保留文字及已应用的筛选，聚焦中的控件安全返回搜索按钮。
    if (hadFocus) nextTick(() => {
      if (!disposed && !selection.showSelection.value && !searchVisible.value) searchToggle.value?.$el?.focus()
    })
  }
  const restartSearchIdle = () => {
    clearSearchIdle()
    if (disposed || !searchVisible.value || selection.showSelection.value || searchComposing) return
    searchIdleTimer = setTimeout(() => {
      searchIdleTimer = null
      if (disposed || !searchVisible.value || selection.showSelection.value) return
      // 原生浮层仍在选择时不打断；关闭浮层或继续操作后重新开始空闲计时。
      if (searchComposing || searchShell.value?.querySelector('[role="combobox"][aria-expanded="true"]')) {
        restartSearchIdle()
        return
      }
      closeSearch()
    }, searchIdleDelay)
  }
  const startSearchComposition = () => { searchComposing = true; clearSearchIdle() }
  const endSearchComposition = () => { searchComposing = false; restartSearchIdle() }
  const clearCategoryRoute = () => {
    const route = router.currentRoute.value
    if (!Object.hasOwn(route.query ?? {}, 'type')) return
    const query = { ...route.query }
    delete query.type
    // 手动修改筛选时同步清除跳转条件，避免刷新后又恢复之前的类型。
    handledRouteCategory = null
    const reconcile = () => {
      if (!disposed && handledRouteCategory === null) handledRouteCategory = categoryFromQuery(router.currentRoute.value.query?.type)
    }
    void router.replace({ path: route.path, query, hash: route.hash }).then(reconcile, reconcile)
  }
  const resetSearch = () => {
    clearCategoryRoute()
    // 请求先重置筛选状态，避免输入监听同时发出第二次刷新。
    const request = list.loadFunds(null)
    searchText.value = ''
    return request
  }
  const clearSearch = () => {
    if (disposed) return
    let request
    if (list.getFilter()) request = resetSearch()
    else searchText.value = ''
    restartSearchIdle()
    focusSearchValue()
    return request
  }
  watch(searchType, () => {
    if (applyingRouteCategory) return
    clearCategoryRoute()
    searchText.value = ''
    restartSearchIdle()
  }, { flush: 'sync' })
  watch(searchText, value => {
    if (applyingRouteCategory) return
    clearCategoryRoute()
    restartSearchIdle()
    // 删除最后一个字、清空金额或改选搜索方式时，列表立即恢复完整账单。
    if (isBlankSearch(value) && list.getFilter()) void list.loadFunds(null)
  }, { flush: 'sync' })
  watch(() => categoryFromQuery(router.currentRoute.value.query?.type), category => {
    if (disposed || router.currentRoute.value.path !== '/fund' || category === handledRouteCategory) return
    handledRouteCategory = category
    applyingRouteCategory = true
    searchType.value = category === null ? '3' : '1'
    searchText.value = category ?? ''
    applyingRouteCategory = false
    searchVisible.value = category !== null
    restartSearchIdle()
    selection.exitSelection()
    // 路由切换类型时不保留上一类型的数据或游标。
    list.clearData()
    void list.loadFunds(category === null ? null : { searchType: '1', searchValue: category })
  }, { flush: 'post' })
  watch(selection.showSelection, selecting => { if (selecting) closeSearch() }, { flush: 'sync' })
  const toggleSearch = () => {
    if (disposed || selection.showSelection.value) return
    if (searchVisible.value) { closeSearch(); return }
    searchVisible.value = true
    restartSearchIdle()
    focusSearchValue()
  }
  const searchFunds = async () => {
    restartSearchIdle()
    const value = searchText.value
    if (isBlankSearch(value)) return resetSearch()
    if (searchType.value === '2') {
      const message = validateAmount(value)
      if (message) { feedback.error(message); return }
    }
    return list.loadFunds({ searchType: searchType.value, searchValue: value! })
  }

  onMounted(() => { if (searchVisible.value) restartSearchIdle() })
  onUnmounted(() => { disposed = true; clearSearchIdle() })
  return { searchVisible, searchShell, searchFields, searchToggle, searchText, searchType, hasSearchText, clearSearchIdle, closeSearch, restartSearchIdle, startSearchComposition, endSearchComposition, resetSearch, clearSearch, toggleSearch, searchFunds }
}
