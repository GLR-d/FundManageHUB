<template>
  <div class="page-heading" :class="{ 'is-selecting': showSelection }">
    <h1 v-if="!showSelection">我的账单</h1>
    <UiButton v-else class="selection-all-button" :disabled="deleting || !totalFunds" :aria-label="allLoadedSelected ? '取消全选已加载账单' : '全选已加载账单'" :aria-pressed="partiallyLoadedSelected ? 'mixed' : allLoadedSelected" title="仅选择当前已加载的账单，继续加载的账单不会自动选中" @click="toggleAllLoaded">
      <span class="selection-all-marker" :class="{ 'is-checked': allLoadedSelected, 'is-partial': partiallyLoadedSelected }" aria-hidden="true">
        <UiIcon v-if="allLoadedSelected" name="check" />
        <span v-else-if="partiallyLoadedSelected" class="selection-all-dash" />
      </span>
      {{ allLoadedSelected ? '取消全选' : '全选' }}
    </UiButton>
    <div class="fund-actions">
      <Transition name="fund-toolbar" mode="out-in" @after-enter="focusSelectionAction">
        <div v-if="!showSelection" key="normal" class="fund-action-group">
          <form ref="searchShell" class="search-shell" :class="{ 'search-shell--open': searchVisible }" role="search" aria-label="搜索账单" @submit.prevent="searchFunds" @keydown.esc.stop="closeSearch" @keydown.capture="restartSearchIdle" @pointerdown.capture="restartSearchIdle" @input="restartSearchIdle" @focusin="restartSearchIdle" @focusout="restartSearchIdle" @toggle.capture="restartSearchIdle" @compositionstart="startSearchComposition" @compositionend="endSearchComposition">
            <div id="bill-search-fields" ref="searchFields" class="search-fields" :inert="!searchVisible" :aria-hidden="!searchVisible">
              <UiSelect v-model="searchType" class="search-kind" compact :options="[{ value: '1', label: '类型' }, { value: '2', label: '金额' }, { value: '3', label: '备注' }]" aria-label="搜索方式" />
              <UiSelect v-if="searchType === '1'" v-model="searchText" class="search-value" compact :options="typeOptions" placeholder="选择类型" data-search-value aria-label="账单类型" />
              <UiInput v-else v-model="searchText" :type="searchType === '2' ? 'number' : 'text'" :placeholder="searchType === '2' ? '请输入金额' : '搜索备注'" data-search-value aria-label="搜索内容" />
              <button v-if="hasSearchText" type="button" class="search-clear" aria-label="清空搜索" title="清空搜索内容" @click="clearSearch">
                <UiIcon name="close" />
              </button>
            </div>
            <UiButton ref="searchToggle" circle class="search-trigger" :aria-label="searchVisible ? '搜索账单' : '展开搜索'" :title="searchVisible ? '搜索' : '展开搜索'" aria-controls="bill-search-fields" :aria-expanded="searchVisible" @click="searchVisible ? searchFunds() : toggleSearch()">
              <UiIcon name="search" />
            </UiButton>
          </form>
          <UiButton ref="selectionToggle" circle class="selection-toggle" aria-label="多选账单" title="多选" @click="selectFunds">
            <UiIcon name="select" />
          </UiButton>
          <UiButton class="desktop-add-button" type="primary" @click="emit('add')">
            <UiIcon name="plus" />
            记一笔
          </UiButton>
        </div>
        <div v-else key="selection" class="fund-action-group fund-selection-actions">
          <span class="selection-count" role="status" :title="'已选' + selection.length + '笔'">已选{{ selection.length }}笔</span>
          <UiButton ref="cancelSelectionButton" class="selection-action-button" :disabled="deleting" @click="cancelSelection">取消</UiButton>
          <UiButton class="selection-action-button" type="danger" aria-label="删除选中账单" title="删除选中账单" :disabled="!selection.length" :loading="deleting" @click="deleteFunds">
            <span v-if="!deleting">删除</span>
          </UiButton>
        </div>
      </Transition>
    </div>
  </div>
</template>
<script setup lang="ts">
import UiButton from '@/components/ui/uiButton.vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import UiSelect from '@/components/ui/uiSelect.vue'
import UiInput from '@/components/ui/uiInput.vue'
import { typeOptions } from '@/utils/funds'
import type { useFundSelection } from '@/composables/useFundSelection'
import type { useFundSearch } from '@/composables/useFundSearch'
const props = defineProps<{ selectionState: ReturnType<typeof useFundSelection>; searchState: ReturnType<typeof useFundSearch>; totalFunds: number }>()
const emit = defineEmits<{ add: [] }>()
const { selection, showSelection, allLoadedSelected, partiallyLoadedSelected, selectionToggle, cancelSelectionButton, focusSelectionAction, deleting, toggleAllLoaded, selectFunds, cancelSelection, deleteFunds } = props.selectionState
const { searchVisible, searchShell, searchFields, searchToggle, searchText, searchType, hasSearchText, closeSearch, restartSearchIdle, startSearchComposition, endSearchComposition, clearSearch, toggleSearch, searchFunds } = props.searchState
</script>
<style scoped>
.fund-actions {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  flex-shrink: 0;
  gap: 8px;
  margin-left: auto;
}
.fund-action-group {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: nowrap;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}
.fund-toolbar-enter-active {
  transition: opacity .18s ease, transform .18s ease;
}
.fund-toolbar-leave-active {
  transition: opacity .12s ease, transform .12s ease;
}
.fund-toolbar-enter-from {
  opacity: 0;
  transform: translateY(6px) scale(.98);
}
.fund-toolbar-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(.98);
}
.selection-toggle {
  transition: transform .15s ease, background .15s ease;
}
.selection-toggle:active {
  transform: scale(.92);
}
.selection-count {
  color: var(--muted);
  font-size: 13px;
  margin-right: 6px;
}
.selection-action-button {
  box-sizing: border-box;
  flex: 0 0 64px;
  width: 64px;
  min-width: 64px;
  height: 40px;
  padding: 9px 16px;
}
.selection-all-button {
  flex-shrink: 0;
}
.selection-all-marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  border: 1.5px solid #9aa5b7;
  border-radius: 2px;
  transition: border-color .16s ease, background .16s ease;
}
.selection-all-marker.is-checked,.selection-all-marker.is-partial {
  border-color: var(--primary);
  background: var(--primary);
  color: white;
}
.selection-all-marker .ui-icon {
  width: 13px;
  height: 13px;
}
.selection-all-dash {
  width: 8px;
  height: 2px;
  border-radius: 1px;
  background: currentColor;
}
.search-shell {
  position: relative;
  flex: 0 0 auto;
  width: 40px;
  max-width: 100%;
  height: 40px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #fff;
  overflow: hidden;
  transition: width .28s ease, border-color .18s ease, box-shadow .18s ease;
}
.search-shell--open {
  width: min(340px, calc(100cqi - 270px));
  border-color: var(--primary-border);
}
.search-shell:focus-within {
  box-shadow: none;
}
.search-fields {
  position: absolute;
  inset: 0 40px 0 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  opacity: 0;
  transform: translateX(16px);
  transition: opacity .16s ease, transform .28s ease;
}
.search-shell--open .search-fields {
  opacity: 1;
  transform: translateX(0);
  transition-delay: .08s;
}
.search-fields :deep(.ui-input-wrap input) {
  height: 38px;
  min-height: 38px;
  border: 0;
  border-radius: 0;
  padding: 6px 0;
  background: transparent;
  font-size: 13px;
  box-shadow: none;
}
.search-fields .search-kind {
  flex: 0 0 66px;
  width: 66px;
}
.search-fields .search-value,.search-fields :deep(.ui-input-wrap) {
  flex: 1;
  min-width: 0;
  width: 0;
}
.search-clear {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 24px;
  width: 24px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
}
.search-clear:hover {
  color: var(--text);
  background: var(--primary-soft);
}
.search-clear .ui-icon {
  width: 16px;
  height: 16px;
}
.search-trigger {
  position: absolute;
  top: -1px;
  right: -1px;
  border-color: transparent;
  background: transparent;
}
.search-shell--open .search-trigger {
  color: var(--primary);
}
.search-shell--open .search-trigger:hover:not(:disabled),.search-shell--open .search-trigger:active {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}
@media(max-width:760px) {
.desktop-add-button {
    display: none;
  }
.search-shell--open {
    width: min(340px, calc(100cqi - 160px));
  }
}
@media(max-width:480px) {
.fund-actions,.fund-action-group {
    width: 100%;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
.search-shell--open {
    width: calc(100% - 48px);
  }
}
.page-heading.is-selecting { flex-wrap: nowrap; gap: 8px; }
.page-heading.is-selecting .fund-actions { flex: 0 1 auto; min-width: 0; width: auto; }
.page-heading.is-selecting .fund-selection-actions { width: auto; min-width: 0; flex-wrap: nowrap; }
.page-heading.is-selecting .selection-count { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media(max-width:480px) {
.page-heading.is-selecting .fund-selection-actions { gap: 6px; }
.page-heading.is-selecting .selection-count { margin-right: 0; font-size: 12px; }
.selection-all-button { gap: 6px; padding: 9px 10px; font-size: 13px; white-space: nowrap; }
.selection-action-button { flex-basis: 48px; width: 48px; min-width: 48px; padding: 9px 8px; font-size: 13px; }
}
</style>
