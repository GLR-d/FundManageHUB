import { errorDetails } from './errors'
// Chromium 会缓存失败的原生模块下载；用户再次打开/重试时，仅给失败的页面入口换 URL。
// 正常首次加载仍使用 Vite 生成的 import（包含对应 CSS 预加载）。
import { onStyleFailure, reloadStyle } from './styleRecovery'
export const createPageImport = <T>(importer: () => Promise<T>, pageName: string, load: (url: string) => Promise<T> = url => import(/* @vite-ignore */ url), location = () => window.location.href, styles = { subscribe: onStyleFailure, reload: reloadStyle }) => {
  let failedUrl: string | null = null
  let attempt = 0
  const failedStyles = new Set<string>()
  return async () => {
    const currentFailures = new Set<string>()
    const stop = styles.subscribe(url => currentFailures.add(url))
    try {
      const results = await Promise.allSettled([...failedStyles].map(url => styles.reload(url).then(() => failedStyles.delete(url))))
      const failure = results.find(result => result.status === 'rejected')
      if (failure) throw failure.reason
      if (!failedUrl) return await importer()
      const url = new URL(failedUrl)
      url.searchParams.set('page-retry', String(++attempt))
      return await load(url.href)
    } catch (cause) {
      const error = errorDetails(cause)
      if (/Unable to preload CSS for /i.test(error?.message || '')) {
        currentFailures.forEach(url => failedStyles.add(url))
        const address = error.message?.match(/https?:\/\/[^\s]+/)?.[0]
        if (address) {
          try {
            const url = new URL(address)
            if (url.origin === new URL(location()).origin && url.pathname.endsWith('.css')) failedStyles.add(url.href)
          } catch { /* 无效地址交给原加载器及整页刷新处理。 */ }
        }
      }
      // 不根据未知异常、外站地址或共享依赖加载另一组件；这类故障可主动整页刷新。
      if (!failedUrl && /Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(error?.message || '')) {
        const address = error.message?.match(/https?:\/\/[^\s]+/)?.[0]
        if (address) {
          try {
            const current = new URL(location())
            const url = new URL(address)
            const filename = url.pathname.split('/').pop()
            const prefix = pageName + '-'
            if (url.origin === current.origin && !url.username && !url.password && url.pathname.startsWith('/assets/') && filename?.startsWith(prefix) && /^[\w-]+\.js$/.test(filename.slice(prefix.length))) failedUrl = url.href
          } catch { /* 无有效页面入口地址时保留原重试与整页刷新入口。 */ }
        }
      }
      throw cause
    } finally { stop() }
  }
}
