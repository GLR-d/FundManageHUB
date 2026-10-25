import { ref, computed, onUnmounted } from 'vue'
import type { Ref } from 'vue'
import type { FundRecord, FundsByDay } from '@/types/fund'

import type UiButton from '@/components/ui/uiButton.vue'
import { deleteFundapi } from '@/api/fund'
import { createSubmissionGuard } from '@/services/submission'
import { confirmDialog } from '@/utils/confirm'
import { feedback } from '@/utils/feedback'

export const useFundSelection = (options: {
  fundData: Ref<FundsByDay>
  totalFunds: Readonly<Ref<number>>
  isSubmitting: () => boolean
  onDeleted: () => unknown | Promise<unknown>
}) => {
  let disposed = false
  const selection = ref<FundRecord[]>([])
  const selectionMap = ref(new Map<string, FundRecord[]>())
  const showSelection = ref(false)
  const allLoadedSelected = computed(() => options.totalFunds.value > 0 && Object.entries(options.fundData.value).every(([day, rows]) => {
    const selected = selectionMap.value.get(day)
    return rows.every(row => selected?.includes(row))
  }))
  const partiallyLoadedSelected = computed(() => selection.value.length > 0 && !allLoadedSelected.value)
  const selectionToggle = ref<InstanceType<typeof UiButton> | null>(null)
  const cancelSelectionButton = ref<InstanceType<typeof UiButton> | null>(null)
  const focusSelectionAction = () => {
    const target = showSelection.value ? cancelSelectionButton.value : selectionToggle.value
    target?.$el?.focus()
  }
  let confirmingDelete = false
  const deletion = createSubmissionGuard(() => !disposed, () => {
    if (confirmingDelete) { confirmingDelete = false; confirmDialog.close() }
  })
  const deleting = deletion.busy
  const clearSelection = () => {
    selection.value = []
    selectionMap.value.clear()
  }
  const handleSelectionChange = (rows: FundRecord[], key: string) => {
    if (rows.length) selectionMap.value.set(key, rows)
    else selectionMap.value.delete(key)
    selection.value = [...selectionMap.value.values()].flat()
  }
  const toggleRow = (day: string, row: FundRecord, checked: boolean) => {
    if (disposed || deleting.value) return
    const rows = selectionMap.value.get(day) || []
    handleSelectionChange(checked ? rows.includes(row) ? rows : [...rows, row] : rows.filter(item => item !== row), day)
  }
  const toggleAllLoaded = () => {
    if (disposed || deleting.value || !showSelection.value || !options.totalFunds.value) return
    if (allLoadedSelected.value) { clearSelection(); return }
    // 只取点击当下已加载的记录，后续追加的日期保持未选中。
    selectionMap.value = new Map(Object.entries(options.fundData.value).filter(([, rows]) => rows.length).map(([day, rows]) => [day, [...rows]]))
    selection.value = [...selectionMap.value.values()].flat()
  }
  const selectFunds = () => {
    if (disposed || deleting.value) return
    clearSelection()
    showSelection.value = true
  }
  const exitSelection = () => { showSelection.value = false; clearSelection() }
  const cancelSelection = () => { if (!disposed && !deleting.value) exitSelection() }

  const deleteFunds = async () => {
    if (disposed || options.isSubmitting() || deleting.value || !selection.value.length) return
    const ids = selection.value.map(item => item.id).join(',')
    const count = selection.value.length
    const operation = deletion.begin()
    if (!operation) return
    try {
      confirmingDelete = true
      try { await confirmDialog.confirm('确认删除选中的 ' + count + ' 笔账单？', '删除账单', { type: 'warning' }) }
      finally { confirmingDelete = false }
      if (!deletion.isActive(operation)) return
      const res = await deleteFundapi(ids, operation.config)
      if (!deletion.isActive(operation)) return
      if (res?.code !== 1) { feedback.error(res?.msg || '删除失败'); return }
      feedback.success('删除成功')
      exitSelection()
      await options.onDeleted()
    } catch {
      // 取消删除或请求失败时保留选择。
    } finally {
      deletion.finish(operation)
    }
  }
  onUnmounted(() => { disposed = true; deletion.dispose() })
  return { selection, selectionMap, showSelection, allLoadedSelected, partiallyLoadedSelected, selectionToggle, cancelSelectionButton, focusSelectionAction, deleting, clearSelection, toggleRow, toggleAllLoaded, selectFunds, exitSelection, cancelSelection, deleteFunds }
}
