<template>
  <article class="fund-card">
    <header class="card-header">
      <div class="day-title">
        <span class="day-marker" />
        <h2>{{ day }}</h2>
        <span class="day-count">{{ rows.length }} 笔</span>
      </div>
      <div class="day-summary">
        <span>
          支出
          <strong class="expense">{{ formatCents(totals.expense) }}</strong>
        </span>
        <span>
          收入
          <strong class="income">{{ formatCents(totals.income) }}</strong>
        </span>
      </div>
    </header>
    <div class="table-wrap">
      <table class="fund-table" :class="{ 'fund-table--selecting': showSelection }">
        <caption class="sr-only">{{ day }} 的账单</caption>
        <colgroup>
          <col class="selection-column" />
          <col class="time-column" />
          <col class="type-column" />
          <col class="amount-column" />
          <col />
        </colgroup>
        <tbody>
          <tr v-for="(row, index) in rows" :key="row.id ?? index" :class="{ 'is-editable': !showSelection && !deleting && !submitting, 'is-selected': showSelection && selectedRows.includes(row) }" :tabindex="showSelection || deleting || submitting ? undefined : 0" :aria-label="showSelection ? undefined : '编辑 ' + row.time + ' 的账单，' + (typeMap[row.type] || row.type) + '，' + row.amount + '元，' + (row.remark || '无备注')" :aria-haspopup="showSelection ? undefined : 'dialog'" @click="emit('edit', row)" @keydown="emit('row-keydown', $event, row)">
            <td class="selection-cell" :aria-hidden="!showSelection">
              <div class="selection-control" :inert="!showSelection">
                <input type="checkbox" :checked="selectedRows.includes(row)" :disabled="!showSelection || deleting" :tabindex="showSelection ? 0 : -1" :aria-label="'选择账单 ' + (index + 1) + '，' + (row.remark || '无备注')" @change="emit('toggle-row', row, ($event.target as HTMLInputElement).checked)" />
              </div>
            </td>
            <td class="time-cell" data-label="时间" :aria-label="'时间：' + row.time">{{ formatBillTime(row.time) }}</td>
            <td class="type-cell" data-label="类型" :aria-label="'类型：' + (typeMap[row.type] || row.type)">
              <span class="type-tag" :class="'type-tag--' + row.type" :style="getFundTypeColors(row.type)">{{ typeMap[row.type] || row.type }}</span>
            </td>
            <td class="amount-cell" :class="incomeTypes.includes(String(row.type)) ? 'income' : 'expense'" data-label="金额" :aria-label="'金额：' + (incomeTypes.includes(String(row.type)) ? '收入' : '支出') + formatCents(toCents(row.amount)) + '元'">{{ incomeTypes.includes(String(row.type)) ? '+' : '−' }}{{ formatCents(toCents(row.amount)) }}</td>
            <td class="remark-cell" data-label="备注" :aria-label="'备注：' + (row.remark || '无备注')">{{ row.remark || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </article>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { FundRecord } from '@/types/fund'

import { calculateFundTotals, formatCents, getFundTypeColors, incomeTypes, toCents, typeMap } from '@/utils/funds'
const props = withDefaults(defineProps<{ day: string; rows: FundRecord[]; selectedRows?: FundRecord[]; showSelection: boolean; deleting: boolean; submitting: boolean }>(), { selectedRows: () => [] })
const emit = defineEmits<{ edit: [row: FundRecord]; 'row-keydown': [event: KeyboardEvent, row: FundRecord]; 'toggle-row': [row: FundRecord, checked: boolean] }>()
const totals = computed(() => calculateFundTotals(props.rows))
const formatBillTime = (time: string) => time.match(/[ T](\d{1,2}:\d{2})/)?.[1]?.padStart(5, '0') || '—'
</script>
<style scoped>
.fund-card {
  margin-bottom: 22px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: white;
  box-shadow: 0 2px 6px #2028380a, 0 12px 28px #20283814;
  overflow: hidden;
}
.card-header {
  padding: 22px 26px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  border-bottom: 1px solid var(--line);
}
.day-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.day-title h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}
.day-marker {
  width: 4px;
  height: 16px;
  background: var(--primary);
  border-radius: 3px;
}
.day-count {
  color: #98a0ae;
  font-size: 12px;
}
.day-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  font-size: 12px;
  color: #96a0b0;
}
.day-summary strong {
  color: #59677e;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-left: 8px;
}
.day-summary .income,.income {
  color: var(--income-color);
}
.day-summary .expense,.fund-table td.expense {
  color: var(--expense-color);
}
.table-wrap {
  padding: 0 26px 10px;
}
.fund-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0 6px;
  table-layout: fixed;
  text-align: left;
  font-size: 13px;
}
.fund-table tbody tr {
  --bill-row-background: transparent;
  border-radius: 12px;
  transition: background .18s ease, padding-left .24s cubic-bezier(.2,.7,.2,1);
}
.fund-table tbody tr:focus-visible {
  outline: 2px solid var(--primary-focus);
  outline-offset: 2px;
}
.fund-table tr.is-editable {
  cursor: pointer;
}
.fund-table tr.is-selected {
  --bill-row-background: var(--primary-soft);
}
.fund-table tr.is-editable:active {
  --bill-row-background: var(--primary-soft);
}
@media(hover:hover) {
.fund-table tr.is-editable:hover {
    --bill-row-background: var(--primary-tint);
  }
}
.fund-table td {
  padding: 16px;
  border: 0;
  background: var(--bill-row-background);
  color: #59657a;
  overflow-wrap: anywhere;
  transition: background .18s ease;
}
.fund-table tbody td:first-child,.fund-table tbody .time-cell {
  border-radius: 12px 0 0 12px;
}
.fund-table--selecting tbody .time-cell {
  border-radius: 0;
}
.fund-table tbody td:last-child {
  border-radius: 0 12px 12px 0;
}
.fund-table td.income {
  color: var(--income-color);
}
.fund-table td:first-child {
  padding-left: 0;
}
.fund-table .selection-column {
  width: 0;
  transition: width .24s cubic-bezier(.2,.7,.2,1);
}
.fund-table--selecting .selection-column {
  width: 44px;
}
.fund-table .selection-cell {
  padding: 0;
  overflow: hidden;
}
.selection-control {
  display: flex;
  align-items: center;
  width: 44px;
  min-height: 20px;
  padding-left: 14px;
  box-sizing: border-box;
  opacity: 0;
  visibility: hidden;
  transform: translateX(-8px) scale(.9);
  transform-origin: left center;
  transition: opacity .16s ease, transform .24s cubic-bezier(.2,.7,.2,1), visibility 0s .24s;
}
.fund-table--selecting .selection-control {
  opacity: 1;
  visibility: visible;
  transform: translateX(0) scale(1);
  transition-delay: 0s;
}
.selection-control input {
  flex-shrink: 0;
  margin: 0;
}
.fund-table .time-cell {
  padding-left: 16px;
  transition: background .18s ease, padding-left .24s cubic-bezier(.2,.7,.2,1);
}
.fund-table td.time-cell {
  font-size: 12px;
  color: #8d96a6;
}
.fund-table .time-column {
  width: 192px;
}
.fund-table .type-column {
  width: 100px;
}
.fund-table .amount-column {
  width: 156px;
}
.fund-table .type-cell {
  text-align: left;
}
.fund-table .remark-cell {
  padding-left: 64px;
}
.fund-table .amount-cell {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 550;
}
.fund-table td.remark-cell {
  color: #949caa;
  font-size: 12px;
}
.type-tag {
  padding: 4px 9px;
  background: #eef1f4;
  color: #68758a;
  font-size: 11px;
  border-radius: 6px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0,0,0,0);
}
@media(min-width:761px) and (max-width:1000px) {
.fund-table .time-column { width: 30%; }
.fund-table .type-column { width: 15%; }
.fund-table .amount-column { width: 22%; }
.fund-table .remark-cell { padding-left: 40px; }
}
@media(max-width:760px) {
.card-header {
    padding: 18px;
  }
.day-summary {
    gap: 16px;
  }
.table-wrap {
    padding: 0 18px;
  }
.fund-table colgroup {
    display: none;
  }
.fund-table,.fund-table tbody {
    display: block;
  }
.fund-table tbody tr {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0,1fr) minmax(0,auto);
    gap: 12px 16px;
    padding: 16px 12px;
    margin: 6px 0;
    border: 0;
    border-radius: 14px;
    background: var(--bill-row-background);
  }
.fund-table tbody td,.fund-table tbody td:first-child,.fund-table tbody td:last-child,.fund-table tbody .time-cell {
    border: 0;
    padding: 0;
    border-radius: 0;
    background: transparent;
  }
.fund-table .time-cell {
    grid-column: 1 / -1;
    padding-left: 0;
    font-size: 11px;
  }
.fund-table .amount-cell {
    padding: 0;
  }
.fund-table .type-cell {
    text-align: left;
  }
.fund-table tbody td.remark-cell {
    grid-column: 1 / -1;
    padding: 6px 0 0;
  }
.fund-table--selecting tbody tr {
    padding-left: 42px;
  }
.fund-table .selection-cell {
    position: absolute;
    left: 12px;
    top: 14px;
    width: 30px;
  }
.selection-control {
    width: 30px;
    padding-left: 0;
  }
}
@media(prefers-reduced-motion:reduce) {
.fund-table .selection-column,.selection-control,.fund-table tbody tr,.fund-table td,.fund-table .time-cell {
    transition: none;
  }
}
</style>
