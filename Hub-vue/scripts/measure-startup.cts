// 使用与 npm run dev / serve 相同的 Vite 配置，记录服务和 HTML 就绪时间。
const { performance }: typeof import('node:perf_hooks') = require('node:perf_hooks')
const path: typeof import('node:path') = require('node:path')
const fs: typeof import('node:fs/promises') = require('node:fs/promises')
const started = performance.now()

async function cleanupCache(coldCache: string, cacheRoot: string) {
  const target = path.resolve(coldCache)
  if (path.dirname(target) !== path.resolve(cacheRoot) || !path.basename(target).startsWith('vite-startup-check-')) throw new Error('临时缓存路径异常')
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('临时缓存不能是目录链接')
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function main() {
  const { createServer } = await import('vite')
  const root = path.resolve(__dirname, '..')
  const cold = process.argv.includes('--cold')
  const cacheRoot = path.join(root, 'node_modules/.cache')
  const coldCache = cold ? path.join(cacheRoot, 'vite-startup-check-' + process.pid + '-' + Date.now()) : null
  let server
  try {
    server = await createServer({
      root,
      configFile: path.join(root, 'vite.config.mts'),
      ...(coldCache ? { cacheDir: coldCache } : {}),
      server: { host: '127.0.0.1', port: 7071, strictPort: true, open: false }
    })
    await server.listen()
    const readySeconds = ((performance.now() - started) / 1000).toFixed(2)
    const response = await fetch('http://127.0.0.1:7071/login', { headers: { Accept: 'text/html' } })
    if (!response.ok) throw new Error('页面访问失败：' + response.status)
    console.log('SERVER_READY_SECONDS=' + readySeconds)
    console.log('STARTUP_SECONDS=' + ((performance.now() - started) / 1000).toFixed(2))
    console.log('HTTP_STATUS=' + response.status)
    console.log('CACHE=' + (cold ? 'isolated-new-cache' : 'normal-cache'))
    console.log('MEASURE_SCOPE=server-and-html-only;browser-module-loading-is-not-included')
  } finally {
    await server?.close()
    if (coldCache) await cleanupCache(coldCache, cacheRoot)
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
