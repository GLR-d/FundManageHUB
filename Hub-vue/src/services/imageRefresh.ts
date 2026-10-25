import { refreshImageUrl } from '@/api/upload'
import { captureSession, isCurrentSession, onSessionChange } from '@/stores/auth'

// 只续签系统生成的 OSS 图片；验证码、外链和本地预览沿用普通 img 行为。
export const isManagedOssImage = (source: string) => {
  try {
    const url = new URL(source)
    if (!/^\/images\/\d+\/[a-f0-9]{32}\.(jpg|png)$/.test(url.pathname)) return false
    if (url.protocol === 'oss:') return Boolean(url.hostname)
    // OSS 也可能绑定自定义域名；具体 Bucket、域名和归属由后端校验。
    if (!['http:', 'https:'].includes(url.protocol)) return false
    return (url.searchParams.has('OSSAccessKeyId') && url.searchParams.has('Expires') && url.searchParams.has('Signature')) || url.searchParams.has('x-oss-signature')
  } catch { return false }
}

interface ImageRefreshOptions {
  onChange: (source: string, revision: number) => void
  onError: (event: Event) => void
}

export const createImageRefreshController = (options: ImageRefreshOptions) => {
  let source = ''
  let displaySource = ''
  let revision = 0
  let generation = 0
  let attempted = false
  let failed = false
  let active = true
  let disposed = false
  let pending: AbortController | undefined
  let session = captureSession()

  const cancel = () => {
    generation++
    pending?.abort()
    pending = undefined
  }
  const current = () => !disposed && active && isCurrentSession(session)
  const publish = () => options.onChange(displaySource, ++revision)
  const fail = (event: Event) => {
    if (!failed && current()) { failed = true; options.onError(event) }
  }
  const stopSession = onSessionChange(cancel)

  return {
    setSource(value: string | undefined) {
      if (disposed || source === (value || '')) return
      cancel()
      source = displaySource = value || ''
      session = captureSession()
      attempted = failed = false
      publish()
    },
    setActive(value: boolean) {
      if (disposed || active === value) return
      active = value
      cancel()
      if (active) { attempted = failed = false; publish() }
    },
    async handleError(event: Event) {
      if (!current() || pending || failed) return
      if (attempted || !session.token || !isManagedOssImage(source)) { fail(event); return }
      attempted = true
      const controller = pending = new AbortController()
      const operation = generation
      const valid = () => current() && generation === operation && !controller.signal.aborted
      try {
        const result = await refreshImageUrl(source, { signal: controller.signal, expectedSession: session })
        if (!valid()) return
        pending = undefined
        if (result.code !== 1 || typeof result.data !== 'string' || !result.data.startsWith('https://') || !isManagedOssImage(result.data)) { fail(event); return }
        displaySource = result.data
        // 即使服务端在同一秒返回相同链接，也重新创建 img，保证只重试一次。
        publish()
      } catch {
        if (valid()) fail(event)
      } finally {
        if (pending === controller) pending = undefined
      }
    },
    cancel,
    dispose() { disposed = true; cancel(); stopSession() }
  }
}
