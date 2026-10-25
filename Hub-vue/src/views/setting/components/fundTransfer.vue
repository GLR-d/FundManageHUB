<template>
  <UiDialog v-model="visible" :title="mode === 'import' ? '导入账单' : '导出账单'" width="520px">
    <div v-if="mode === 'import'" class="transfer-content">
      <input ref="fileInput" class="transfer-file-input" type="file" accept=".csv,text/csv" tabindex="-1" aria-label="选择 CSV 文件" :disabled="busy" @change="selectFile" />
      <button v-if="!file" type="button" class="file-picker" :disabled="busy" autofocus @click="chooseFile">
        <span class="file-marker" aria-hidden="true"><UiIcon name="plus" /></span>
        <strong>选择 CSV 文件</strong>
      </button>
      <div v-else class="selected-file">
        <span class="file-format" aria-hidden="true">CSV</span>
        <div class="file-summary"><strong :title="file.name">{{ file.name }}</strong><span>{{ fileSize }}</span></div>
        <div class="file-actions">
          <UiButton size="small" :disabled="busy" @click="chooseFile">更换</UiButton>
          <button type="button" class="file-clear" aria-label="清除所选文件" title="清除" :disabled="busy" @click="clearFile"><UiIcon name="close" /></button>
        </div>
      </div>
      <details class="transfer-notes">
        <summary>导入说明<UiIcon name="chevron" /></summary>
        <div class="notes-content">
          <p>导入只新增账单，重复导入会产生重复记录。</p>
          <p>时间、类型和金额必填，备注和图片地址可留空。</p>
          <p>图片仅保存地址，不包含图片文件。每次最多 2 MB、5000 笔。</p>
          <p>有错误时整批不导入。网络中断时，请先检查账单，再决定是否重试。</p>
        </div>
      </details>
    </div>
    <div v-else class="transfer-content">
      <div class="export-summary">
        <span class="export-marker" aria-hidden="true"><UiIcon name="wallet" /></span>
        <div><strong>全部账单</strong><span>仅当前账号</span></div>
        <span class="export-format">CSV</span>
      </div>
      <p class="export-description">导出包含全部账单，不受搜索或分页影响，可用 Excel 打开。图片仅保留地址，不包含图片文件。</p>
    </div>
    <p v-if="error" class="transfer-error" role="alert">{{ error }}</p>
    <p v-if="success" class="transfer-success" role="status">{{ success }}</p>
    <template #footer>
      <UiButton @click="close">关闭</UiButton>
      <UiButton v-if="mode === 'import'" type="primary" :disabled="!file || busy" :loading="action === 'import'" @click="importFile">确认导入</UiButton>
      <UiButton v-else type="primary" :disabled="busy" :loading="action === 'export'" autofocus @click="download">导出账单</UiButton>
    </template>
  </UiDialog>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import UiButton from '@/components/ui/uiButton.vue'
import UiDialog from '@/components/ui/uiDialog.vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import { exportFundsapi, importFundsapi } from '@/api/fund'
import router from '@/router'
import { captureSession, isCurrentSession, onSessionChange } from '@/stores/auth'
import { dateKey, localDateTime } from '@/utils/dateTime'
import { getFundTransferError, saveFundCsv, validateFundCsv, validateFundImportFile } from '@/utils/fundTransfer'
import { createSubmissionGuard } from '@/services/submission'

type TransferKind = 'import' | 'export'
const emit = defineEmits<{ imported: [] }>()
const session = captureSession()
let disposed = false
const visible = ref(false)
const mode = ref<TransferKind>('import')
const fileInput = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const fileSize = computed(() => !file.value ? '' : file.value.size >= 1024 * 1024 ? (file.value.size / (1024 * 1024)).toFixed(2) + ' MB' : Math.max(1, Math.ceil(file.value.size / 1024)) + ' KB')
const error = ref('')
const success = ref('')
const action = ref<'import' | 'export' | null>(null)
const submission = createSubmissionGuard(() => visible.value && !disposed, () => { action.value = null })
const busy = submission.busy
const reset = () => {
  submission.cancel()
  action.value = null
  file.value = null
  if (fileInput.value) fileInput.value.value = ''
  error.value = ''
  success.value = ''
}
watch(visible, reset, { flush: 'sync' })
const close = () => { visible.value = false; reset() }
const open = (kind: TransferKind = 'import') => {
  if (disposed || !isCurrentSession(session) || (kind !== 'import' && kind !== 'export')) return
  reset()
  mode.value = kind
  visible.value = true
}
watch(() => router.currentRoute.value.fullPath, close, { flush: 'sync' })
const unsubscribe = onSessionChange(close)
onUnmounted(() => { disposed = true; close(); submission.dispose(); unsubscribe() })

const chooseFile = () => { if (visible.value && mode.value === 'import' && !busy.value && !disposed && isCurrentSession(session)) fileInput.value?.click() }
const clearFile = () => { if (!busy.value && mode.value === 'import') { file.value = null; error.value = ''; success.value = '' } }
const selectFile = (event: Event) => {
  const input = event.target as HTMLInputElement
  const selected = input.files?.[0]
  // 清空原生 input，允许修正文件后再次选择同名文件。
  input.value = ''
  if (!visible.value || mode.value !== 'import' || busy.value || !selected || disposed) return
  success.value = ''
  error.value = validateFundImportFile(selected)
  file.value = error.value ? null : selected
}
const download = async () => {
  if (mode.value !== 'export') return
  const operation = submission.begin()
  if (!operation) return
  action.value = 'export'
  error.value = ''
  success.value = ''
  try {
    const blob = await exportFundsapi(operation.config)
    await validateFundCsv(blob)
    if (!submission.isActive(operation)) return
    saveFundCsv(blob, `账单_${dateKey(localDateTime())}.csv`)
    success.value = '账单已开始下载。'
  } catch (reason) {
    const message = await getFundTransferError(reason)
    if (submission.isActive(operation)) error.value = message
  } finally {
    if (submission.isActive(operation)) action.value = null
    submission.finish(operation)
  }
}
const importFile = async () => {
  const selected = file.value
  if (mode.value !== 'import' || !selected) return
  const operation = submission.begin()
  if (!operation) return
  action.value = 'import'
  error.value = ''
  success.value = ''
  try {
    const result = await importFundsapi(selected, operation.config)
    if (!submission.isActive(operation)) return
    if (result?.code !== 1) { error.value = result?.msg || '导入失败，请检查 CSV 文件。'; return }
    file.value = null
    success.value = `成功导入 ${result.data.imported} 笔账单。`
    emit('imported')
  } catch (reason) {
    const message = await getFundTransferError(reason)
    if (submission.isActive(operation)) error.value = message
  } finally {
    if (submission.isActive(operation)) action.value = null
    submission.finish(operation)
  }
}
defineExpose({ open })
</script>
<style scoped>
.transfer-content { display: grid; gap: 18px; min-width: 0; }
.transfer-file-input { display: none; }
.file-picker { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 11px; min-height: 190px; width: 100%; padding: 26px 16px; border: 1px dashed #ccd6ef; border-radius: 20px; background: #f8faff; color: #63718a; font: inherit; transition: border-color .16s, background .16s; }
.file-picker:hover:not(:disabled) { border-color: #3964fe; background: #f1f5ff; }
.file-picker:disabled { cursor: wait; opacity: .65; }
.file-marker { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 15px; background: #eaf0ff; color: #3964fe; }
.file-marker .ui-icon { width: 24px; height: 24px; }
.file-picker strong { color: #42516b; font-size: 16px; font-weight: 550; }
.selected-file { display: flex; align-items: center; gap: 12px; min-height: 108px; padding: 20px 16px; border: 1px solid #e3e9f5; border-radius: 18px; background: #f8faff; }
.file-format { display: grid; place-items: center; flex: 0 0 auto; width: 44px; height: 48px; border-radius: 12px; background: #eaf0ff; color: #3964fe; font-size: 12px; font-weight: 650; }
.file-summary { flex: 1; display: grid; gap: 7px; min-width: 0; }
.file-summary strong { overflow: hidden; color: #47536b; font-size: 14px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.file-summary span { color: #8b96a8; font-size: 13px; }
.file-actions { display: flex; align-items: center; flex: 0 0 auto; gap: 6px; }
.file-clear { display: grid; place-items: center; width: 30px; height: 30px; padding: 7px; border: 0; border-radius: 10px; background: transparent; color: #8a96a9; }
.file-clear:hover:not(:disabled) { background: #eaf0fa; color: #53647e; }
.file-clear:disabled { opacity: .4; }
.file-clear .ui-icon { width: 16px; height: 16px; }
.transfer-notes { padding-top: 16px; border-top: 1px solid #edf0f5; }
.transfer-notes summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #6b7890; font-size: 14px; cursor: pointer; list-style: none; }
.transfer-notes summary::-webkit-details-marker { display: none; }
.transfer-notes summary .ui-icon { width: 16px; height: 16px; color: #9ba6b7; transition: transform .16s; }
.transfer-notes[open] summary .ui-icon { transform: rotate(90deg); }
.notes-content { display: grid; gap: 10px; margin-top: 14px; color: #7d889b; font-size: 13px; line-height: 1.8; }
.notes-content p { margin: 0; }
.export-summary { display: flex; align-items: center; gap: 14px; padding: 22px 18px; border: 1px solid #e8edf6; border-radius: 18px; background: #f8faff; }
.export-marker { display: grid; place-items: center; flex: 0 0 auto; width: 46px; height: 46px; border-radius: 14px; background: #eaf0ff; color: #3964fe; }
.export-marker .ui-icon { width: 25px; height: 25px; }
.export-summary > div { display: grid; flex: 1; gap: 7px; min-width: 0; }
.export-summary strong { color: #43516a; font-size: 16px; font-weight: 550; }
.export-summary > div > span { color: #8793a6; font-size: 13px; }
.export-format { padding: 6px 10px; border-radius: 9px; background: #edf1fa; color: #6c7d99; font-size: 13px; font-weight: 550; }
.export-description { margin: 0; color: #6f7d92; font-size: 14px; line-height: 1.9; }
.transfer-error,.transfer-success { margin: 18px 0 0; padding: 12px 14px; border-radius: 12px; font-size: 14px; line-height: 1.7; white-space: pre-line; overflow-wrap: anywhere; }
.transfer-error { color: #c34851; background: #fff3f4; }
.transfer-success { color: #30866f; background: #eff9f5; }
@media(max-width:480px) { .file-picker { min-height: 174px; border-radius: 17px; } .selected-file { flex-wrap: wrap; gap: 12px; padding: 16px; } .file-summary { flex-basis: calc(100% - 58px); } .file-actions { margin-left: auto; } .export-summary { padding: 18px 14px; gap: 10px; } }
@media(prefers-reduced-motion:reduce) { .file-picker,.transfer-notes summary .ui-icon { transition: none; } }
</style>
