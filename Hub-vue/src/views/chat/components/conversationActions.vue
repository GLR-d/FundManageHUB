<template>
  <span class="conversation-actions">
    <button ref="trigger" type="button" class="more-button" :class="{ 'is-open': opened }" :aria-label="title + ' 的更多操作'" :title="'更多操作'" aria-haspopup="menu" :aria-expanded="opened" :aria-controls="menuId" @click.stop="toggle" @keydown.down.prevent="openMenu()" @keydown.up.prevent="openMenu(true)">
      <UiIcon name="more" />
    </button>
    <div :id="menuId" ref="panel" class="ui-floating-panel conversation-menu" popover="auto" role="menu" :aria-label="title + ' 的操作'" :style="panelStyle" @toggle="sync" @keydown="handleKeydown">
      <button type="button" role="menuitem" class="menu-action" @click="choose('pin')">
        <UiIcon name="pin" />
        <span>{{ pinned ? '取消置顶' : '置顶' }}</span>
      </button>
      <button type="button" role="menuitem" class="menu-action" @click="choose('rename')">
        <UiIcon name="edit" />
        <span>重命名</span>
      </button>
      <div class="menu-separator" role="separator" />
      <button type="button" role="menuitem" class="menu-action menu-action--danger" @click="choose('delete')">
        <UiIcon name="trash" />
        <span>删除</span>
      </button>
    </div>
  </span>
</template>
<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import UiIcon from '@/components/ui/uiIcon.vue'
import { useFloatingPanel } from '@/composables/useFloatingPanel'
withDefaults(defineProps<{ title?: string; pinned?: boolean }>(), { title: '对话', pinned: false })
const emit = defineEmits<{ pin: []; rename: []; delete: [] }>()
const trigger = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const menuId = 'conversation-actions-' + useId()
const { opened, panelStyle, show, hide, sync } = useFloatingPanel(trigger, panel, { width: 164, maxHeight: 160 })
const openMenu = async (last = false) => {
  await show()
  await nextTick()
  const items = panel.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
  items?.[last ? items.length - 1 : 0]?.focus()
}
const toggle = () => { if (opened.value) hide(); else openMenu() }
const choose = (action: 'pin' | 'rename' | 'delete') => {
  hide(true)
  if (action === 'pin') emit('pin')
  else if (action === 'rename') emit('rename')
  else emit('delete')
}
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(true); return }
  if (event.key === 'Tab') { hide(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = Array.from(panel.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])
  if (!items.length) return
  const current = items.indexOf(event.target as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
}
</script>
<style scoped>
.conversation-actions { display: inline-flex; flex: 0 0 auto; }
.more-button { display: grid; place-items: center; width: 32px; height: 32px; padding: 6px; border: 0; border-radius: 10px; color: #8790a0; background: transparent; transition: color .16s ease, background .16s ease; }
.more-button:hover,.more-button.is-open { color: var(--text); background: #e8ecf3; }
.more-button .ui-icon { width: 20px; height: 20px; }
.conversation-menu { padding: 6px; border-radius: 15px; box-shadow: 0 6px 12px #20283808, 0 16px 40px #20283818; }
.conversation-menu:popover-open { animation: conversation-menu-enter .16s ease-out; }
.menu-action { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 9px 12px; border: 0; border-radius: 10px; background: transparent; color: #475269; font-size: 13px; text-align: left; }
.menu-action:hover,.menu-action:focus-visible { background: #f0f2f6; }
.menu-action .ui-icon { width: 17px; height: 17px; }
.menu-action--danger { color: #d84b55; }
.menu-action--danger:hover,.menu-action--danger:focus-visible { background: #fff1f2; }
.menu-separator { height: 1px; margin: 4px 8px; background: var(--line); }
@keyframes conversation-menu-enter { from { opacity: 0; transform: translateY(-4px) scale(.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
@media(max-width:760px) { .more-button { width: 38px; height: 38px; } .menu-action { min-height: 44px; } }
</style>
