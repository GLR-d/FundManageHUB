// Vite 会缓存样式预加载；移除加载失败的本地样式链接，让下一次路由重试重新请求。
const observers = new Set<(url: string) => void>()
const pending = new Map<string, Promise<Event>>()
export const onStyleFailure = (listener: (url: string) => void) => {
  observers.add(listener)
  return () => observers.delete(listener)
}

// Vite 会把失败 CSS 的预加载标记留在缓存中；重试时显式等待样式恢复。
export const reloadStyle = (href: string, target = window) => {
  const url = new URL(href, target.location.href)
  if (url.origin !== new URL(target.location.href).origin || !url.pathname.endsWith('.css')) return Promise.reject(new Error('样式地址异常'))
  const existing = pending.get(url.href)
  if (existing) return existing
  const link = target.document.createElement('link')
  link.rel = 'stylesheet'
  link.href = url.href
  const promise = new Promise<Event>((resolve, reject) => {
    link.addEventListener('load', resolve, { once: true })
    link.addEventListener('error', () => {
      link.remove()
      reject(new Error('Unable to preload CSS for ' + url.href))
    }, { once: true })
    target.document.head.appendChild(link)
  })
  pending.set(url.href, promise)
  const clear = () => pending.delete(url.href)
  promise.then(clear, clear)
  return promise
}

export const startStyleRetrySupport = (target = window) => {
  const handleError = (event: Event) => {
    const link = event.target as HTMLLinkElement | null
    if (link?.tagName !== 'LINK' || link.rel !== 'stylesheet') return
    try {
      const current = new URL(target.location.href)
      const resource = new URL(link.href, current)
      if (resource.origin === current.origin && resource.pathname.endsWith('.css')) {
        link.remove()
        observers.forEach(listener => listener(resource.href))
      }
    } catch { /* 非法或外部链接不在页面文件恢复范围内。 */ }
  }
  target.addEventListener('error', handleError, true)
  return () => target.removeEventListener('error', handleError, true)
}
