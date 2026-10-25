import { onUnmounted, watch } from 'vue'
import type { FundRecord } from '@/types/fund'

import router from '@/router'
import { isRouteLoadError } from '@/utils/routeRecovery'
import { useFundList } from './useFundList'
import { useFundSelection } from './useFundSelection'
import { useFundEditor } from './useFundEditor'
import { useFundSearch, categoryFromQuery } from './useFundSearch'

/** Wire the bill page workflows through explicit callbacks. */
export const useFundPage = () => {
  let disposed = false
  const initialCategory = categoryFromQuery(router.currentRoute.value.query?.type)
  const list = useFundList({
    initialFilter: initialCategory === null ? null : { searchType: '1', searchValue: initialCategory },
    onReset: () => selection.clearSelection()
  })
  const selection = useFundSelection({
    fundData: list.fundData, totalFunds: list.totalFunds,
    isSubmitting: () => editor.submitting.value,
    onDeleted: list.selectList
  })
  const editor = useFundEditor({
    isDeleting: () => selection.deleting.value,
    onSaved: async () => { selection.cancelSelection(); await list.selectList() }
  })
  const search = useFundSearch({ list, selection, initialCategory })
  const editRow = (row: FundRecord) => { if (!selection.showSelection.value) editor.openFundEditor(row) }
  const handleRowKeydown = (event: KeyboardEvent, row: FundRecord) => {
    if (selection.showSelection.value || event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return
    event.preventDefault()
    editRow(row)
  }
  // 底栏入口用路由意图打开表单；消费后移除，刷新或返回不会重复弹出。
  watch(() => router.currentRoute.value.query?.record, record => {
    if (record !== 'new' || disposed) return
    if (!editor.formVisible.value) editor.addFund()
    if (!editor.formVisible.value) return
    const route = router.currentRoute.value
    const query = { ...route.query }
    delete query.record
    router.replace({ path: route.path, query, hash: route.hash }).catch(error => {
      if (!isRouteLoadError(error)) throw error
    })
  }, { immediate: true, flush: 'post' })
  onUnmounted(() => { disposed = true })
  return { list, selection, editor, search, editRow, handleRowKeydown }
}
