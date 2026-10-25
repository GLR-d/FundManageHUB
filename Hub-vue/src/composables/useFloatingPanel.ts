import type { CSSProperties, Ref } from 'vue'
import { nextTick, onUnmounted, ref } from 'vue'

// 原生 popover 将面板放到顶层，避免被搜索框或弹窗的圆角、滚动区域裁切。
export const useFloatingPanel = (trigger: Ref<HTMLElement | null>, panel: Ref<HTMLElement | null>, { minWidth = 120, width, maxHeight = 320 }: { minWidth?: number; width?: number; maxHeight?: number } = {}) => {
  const opened = ref(false)
  const panelStyle = ref<CSSProperties>({})
  let disposed = false
  let listening = false
  const position = () => {
    if (!opened.value || !trigger.value?.isConnected || !panel.value) return
    const box = trigger.value.getBoundingClientRect()
    const viewport = window.visualViewport
    const viewportWidth = viewport?.width || document.documentElement.clientWidth
    const viewportHeight = viewport?.height || document.documentElement.clientHeight
    const offsetLeft = viewport?.offsetLeft || 0
    const offsetTop = viewport?.offsetTop || 0
    const edge = 12
    const panelWidth = Math.min(width || Math.max(minWidth, box.width), viewportWidth - edge * 2)
    const below = offsetTop + viewportHeight - box.bottom - edge - 6
    const above = box.top - offsetTop - edge - 6
    const panelHeight = Math.min(panel.value.scrollHeight + 2, maxHeight)
    const placeBelow = below >= Math.min(panelHeight, maxHeight) || below >= above
    const available = Math.max(0, placeBelow ? below : above)
    const height = Math.min(panelHeight, available)
    panelStyle.value = {
      width: panelWidth + 'px',
      left: Math.max(offsetLeft + edge, Math.min(box.left, offsetLeft + viewportWidth - panelWidth - edge)) + 'px',
      top: (placeBelow ? box.bottom + 6 : Math.max(offsetTop + edge, box.top - 6 - height)) + 'px',
      maxHeight: Math.min(maxHeight, available) + 'px'
    }
  }
  const listen = (active: boolean) => {
    if (listening === active) return
    listening = active
    const method = active ? 'addEventListener' : 'removeEventListener'
    window[method]('resize', position)
    window[method]('scroll', position, true)
    window.visualViewport?.[method]('resize', position)
    window.visualViewport?.[method]('scroll', position)
  }
  const sync = () => {
    if (disposed) return
    opened.value = Boolean(panel.value?.matches(':popover-open'))
    listen(opened.value)
    if (opened.value) nextTick(position)
  }
  const show = async () => {
    if (disposed || !panel.value || !trigger.value || trigger.value.matches(':disabled')) return
    const box = trigger.value.getBoundingClientRect()
    panelStyle.value = { width: (width || Math.max(minWidth, box.width)) + 'px', left: '12px', top: '12px', maxHeight: maxHeight + 'px' }
    await nextTick()
    if (disposed || !panel.value || !trigger.value || trigger.value.matches(':disabled')) return
    panel.value.showPopover()
    opened.value = true
    listen(true)
    position()
    await nextTick()
    position()
  }
  const hide = (restoreFocus = false) => {
    if (panel.value?.matches(':popover-open')) panel.value.hidePopover()
    opened.value = false
    listen(false)
    if (restoreFocus && trigger.value?.isConnected) trigger.value.focus()
  }
  onUnmounted(() => { disposed = true; hide() })
  return { opened, panelStyle, show, hide, sync }
}
