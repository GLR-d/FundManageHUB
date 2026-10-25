<template>
  <div class="page-heading">
    <h1>设置</h1>
  </div>
  <section class="settings-panel" aria-label="设置选项">
    <div class="setting-row setting-row--chat">
      <h2 id="chat-sidebar-label">进入聊天时显示历史记录</h2>
      <button type="button" class="setting-switch desktop-setting-control" role="switch" :aria-checked="preferences.showChatSidebar" aria-labelledby="chat-sidebar-label" @click="updatePreference('showChatSidebar', !preferences.showChatSidebar)">
        <span aria-hidden="true" />
      </button>
      <UiSelect class="mobile-setting-control" aria-label="进入聊天时显示历史记录" :model-value="String(preferences.showChatSidebar)" :options="[{ value: 'true', label: '显示' }, { value: 'false', label: '收起' }]" @update:model-value="updatePreference('showChatSidebar', $event === 'true')" />
    </div>
    <MonthlyExpenseLimitSetting />
    <div class="setting-row">
      <h2>导入账单</h2>
      <UiButton class="setting-action" aria-label="导入账单" @click="openTransfer('import')">导入</UiButton>
    </div>
    <div class="setting-row">
      <h2>导出账单</h2>
      <UiButton class="setting-action" aria-label="导出账单" @click="openTransfer('export')">导出</UiButton>
    </div>
  </section>
  <FundTransfer ref="fundTransfer" />
</template>
<script setup lang="ts">
import { ref } from 'vue'
import UiButton from '@/components/ui/uiButton.vue'
import UiSelect from '@/components/ui/uiSelect.vue'
import FundTransfer from './components/fundTransfer.vue'
import MonthlyExpenseLimitSetting from './components/monthlyExpenseLimitSetting.vue'
import { feedback } from '@/utils/feedback'
import { preferences, savePreferences } from '@/stores/preferences'

defineOptions({ name: 'Setting' })
const fundTransfer = ref<InstanceType<typeof FundTransfer> | null>(null)
const openTransfer = (kind: 'import' | 'export') => fundTransfer.value?.open(kind)
const updatePreference = (key: keyof typeof preferences.value, value: boolean) => {
  try { savePreferences({ ...preferences.value, [key]: value }); feedback.success('设置已保存') }
  catch { feedback.warning('设置已生效，但无法保存到本地') }
}
</script>
<style scoped>
.settings-panel { max-width: 1100px; padding: 0 24px; border: 1px solid var(--line); border-radius: 24px; background: #fff; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 92px; padding: 22px 0; border-bottom: 1px solid var(--line); }
.setting-row:last-child { border-bottom: 0; }
.setting-row h2 { min-width: 0; margin: 0; color: var(--text); font-size: 16px; font-weight: 550; line-height: 1.6; }
.setting-action { flex-shrink: 0; min-width: 80px; border-color: transparent; border-radius: 14px; background: #f3f4f6; color: #394355; font-size: 15px; }
.setting-action:hover:not(:disabled) { border-color: transparent; background: #e9ebef; }
.setting-switch { position: relative; flex: 0 0 auto; width: 46px; height: 28px; padding: 3px; border: 0; border-radius: 999px; background: #e5e7eb; transition: background .18s ease; }
.setting-switch span { display: block; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px #20283815; transition: transform .18s ease; }
.setting-switch[aria-checked=true] { background: var(--primary); }
.setting-switch[aria-checked=true] span { transform: translateX(18px); }
.mobile-setting-control { display: none; }
@media(min-width:761px) {
  .page-heading,.settings-panel { max-width: 1100px; margin-inline: auto; }
}
@media(max-width:760px) {
  .settings-panel { max-width: 600px; padding: 0 20px; border-radius: 20px; }
  .setting-row { gap: 16px; }
  .setting-row h2 { font-size: 14px; }
  .setting-row--chat { align-items: stretch; flex-direction: column; gap: 14px; }
  .desktop-setting-control { display: none; }
  .mobile-setting-control { display: inline-flex; max-width: 240px; }
}
@media(prefers-reduced-motion:reduce) { .setting-switch,.setting-switch span { transition: none; } }
</style>
