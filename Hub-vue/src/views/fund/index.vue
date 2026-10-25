<template>
  <section class="fund" :aria-busy="loading">
    <FundToolbar :selection-state="selection" :search-state="search" :total-funds="totalFunds" @add="addFund" />
    <div v-if="loadError && !appendError" class="fund-retry" :class="{ 'fund-retry--empty': !totalFunds }">
      <UiButton type="primary" :loading="loading" @click="retryLoad">
        <UiIcon name="refresh" />
        重新加载
      </UiButton>
    </div>
    <FundDayCard v-for="(rows, day) in visibleFundData" :key="day" :day="String(day)" :rows="rows" :selected-rows="selectionMap.get(String(day)) || []" :show-selection="showSelection" :deleting="deleting" :submitting="submitting" @edit="editRow" @row-keydown="handleRowKeydown" @toggle-row="(row, checked) => toggleRow(String(day), row, checked)" />
    <div v-if="showEmpty" class="empty-state">
      <UiIcon name="wallet" />
      <span>暂无账单</span>
      <UiButton type="primary" @click="addFund">记下第一笔</UiButton>
    </div>
    <div v-show="!loadError || appendError" ref="loadMoreRef" class="load-more" role="status" :aria-busy="loading">
      <UiButton v-if="loadError && appendError" type="primary" :loading="loading" @click="retryLoad">
        <UiIcon name="refresh" />
        重新加载
      </UiButton>
      <span v-else-if="loading">正在加载账单…</span>
      <span v-else-if="hasMoreDays">继续向下滚动，查看更早的账单</span>
    </div>
  </section>
  <FundEditorDialog :editor="editor" />
</template>
<script setup lang="ts">
import UiButton from '@/components/ui/uiButton.vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import FundToolbar from './components/fundToolbar.vue'
import FundDayCard from './components/fundDayCard.vue'
import FundEditorDialog from './components/fundEditorDialog.vue'
import { useFundPage } from '@/composables/useFundPage'
defineOptions({ name: 'Fund' })
const { list, selection, editor, search, editRow, handleRowKeydown } = useFundPage()
const { loading, loadError, appendError, totalFunds, visibleFundData, showEmpty, loadMoreRef, hasMoreDays, retryLoad } = list
const { selectionMap, showSelection, deleting, toggleRow } = selection
const { submitting, addFund } = editor
</script>
<style scoped>
.fund {
  position: relative;
  min-height: 100%;
  container-type: inline-size;
}
.fund-retry {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 120px;
}
.fund-retry--empty {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.fund-retry--empty .ui-button {
  pointer-events: auto;
}
.load-more {
  padding: 18px 0;
  text-align: center;
  color: #a0a7b4;
  font-size: 12px;
}
</style>
