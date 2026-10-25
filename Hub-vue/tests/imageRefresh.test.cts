type ImageDouble = any
const imageTest: typeof import('node:test') = require('node:test')
const imageAssert: typeof import('node:assert/strict') = require('node:assert/strict')
const imageFs: typeof import('node:fs') = require('node:fs')
const imagePath: typeof import('node:path') = require('node:path')
const imageVm: typeof import('node:vm') = require('node:vm')
const imageTransform: typeof import('esbuild').transformSync = require('esbuild').transformSync
const imageSfc: typeof import('@vue/compiler-sfc') = require('@vue/compiler-sfc')
const imageVue: typeof import('vue') = require('vue')
const imageRoot = imagePath.resolve(__dirname, '..')
const imageUrl = (id = '1', signature = 'expired') => `https://fund-manage-hub.oss-cn-beijing.aliyuncs.com/images/${id}/${'a'.repeat(32)}.jpg?OSSAccessKeyId=test&Expires=1&Signature=${signature}`
const imageDeferred = () => {
  let resolve!: (value: ImageDouble) => void
  let reject!: (value: ImageDouble) => void
  const promise = new Promise<ImageDouble>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

// 用 Vue 实际执行组件渲染和事件，不依赖浏览器、真实账号或云服务。
function imageFixture(response: (...args: ImageDouble[]) => Promise<ImageDouble> = async () => ({ code: 1, data: imageUrl('1', 'renewed') })) {
  const cache = new Map<string, ImageDouble>()
  const storage = new Map<string, string>()
  const calls: ImageDouble[][] = []
  const router = { currentRoute: imageVue.ref({ fullPath: '/fund' }) }
  const mocks: ImageDouble = {
    vue: imageVue,
    '@/router': { default: router },
    '@/utils/request': { default: { post: (...args: ImageDouble[]) => { calls.push(args); return response(...args) } } }
  }
  const load = (file: string): ImageDouble => {
    const filename = imagePath.resolve(imageRoot, file)
    if (cache.has(filename)) return cache.get(filename)
    let source = imageFs.readFileSync(filename, 'utf8')
    if (file.endsWith('.vue')) {
      const { descriptor } = imageSfc.parse(source, { filename })
      source = imageSfc.compileScript(descriptor, { id: file, inlineTemplate: true }).content
    }
    const module = { exports: {} }
    const context = imageVm.createContext({
      module, exports: module.exports, console, URL, AbortController,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      },
      require: (request: string) => {
        if (Object.hasOwn(mocks, request)) {
          const value = mocks[request]
          return value.default ? { __esModule: true, ...value } : value
        }
        const extension = imagePath.extname(request) ? '' : '.ts'
        if (request.startsWith('@/')) return load('src/' + request.slice(2) + extension)
        if (request.startsWith('.')) return load(imagePath.relative(imageRoot, imagePath.resolve(imagePath.dirname(filename), request)) + extension)
        throw new Error('Unexpected import: ' + request)
      }
    })
    imageVm.runInContext(imageTransform(source, { loader: 'ts', format: 'cjs', target: 'node22' }).code, context)
    cache.set(filename, module.exports)
    return module.exports
  }
  const node = (type: string, text = ''): ImageDouble => ({ type, text, props: {}, children: [], parent: null })
  const remove = (child: ImageDouble) => {
    const children = child.parent?.children
    if (children) children.splice(children.indexOf(child), 1)
    child.parent = null
  }
  const renderer = imageVue.createRenderer<ImageDouble, ImageDouble>({
    createElement: type => node(type),
    createText: text => node('#text', text),
    createComment: text => node('#comment', text),
    setText: (target, text) => { target.text = text },
    setElementText: (target, text) => { target.text = text; target.children = [] },
    parentNode: child => child.parent,
    nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
    remove,
    insert: (child, parent, anchor) => {
      remove(child)
      child.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child)
    },
    patchProp: (target, key, _previous, value) => { target.props[key] = value }
  })
  const find = (target: ImageDouble, type: string): ImageDouble => target.type === type ? target : target.children.map((child: ImageDouble) => find(child, type)).find(Boolean)
  const auth = load('src/stores/auth.ts')
  auth.setLoginUser({ id: 1, token: 'token-a' })
  const mount = (props: ImageDouble = {}, file = 'src/components/ui/uiImage.vue') => {
    const values = imageVue.reactive(props)
    const root = node('root')
    const component = load(file).default
    const app = renderer.createApp({ setup: () => () => imageVue.h(component, values) })
    app.mount(root)
    return {
      props: values, root,
      image: () => find(root, 'img'),
      icon: () => find(root, 'svg'),
      setProps: async (value: ImageDouble) => { Object.assign(values, value); await imageVue.nextTick() },
      error: async () => { await find(root, 'img').props.onError(new Event('error')); await imageVue.nextTick() },
      unmount: () => app.unmount()
    }
  }
  return { load, calls, auth, router, mount }
}

imageTest('image refresh API posts only the original URL and keeps cancellation, session and silent errors', async () => {
  const f = imageFixture()
  const api = f.load('src/api/upload.ts')
  const controller = new AbortController()
  const session = f.auth.captureSession()
  await api.refreshImageUrl(imageUrl(), { signal: controller.signal, expectedSession: session, silentError: false })
  imageAssert.equal(f.calls.length, 1)
  const [path, body, config] = f.calls[0]
  imageAssert.equal(path, '/upload/refresh')
  imageAssert.equal(JSON.stringify(body), JSON.stringify({ url: imageUrl() }))
  imageAssert.equal(config.signal, controller.signal)
  imageAssert.equal(config.expectedSession, session)
  imageAssert.equal(config.silentError, true)
})

imageTest('failed OSS images renew once, keep the saved source and forward only the final failure', async () => {
  const errors: Event[] = []
  const f = imageFixture()
  const component = f.mount({ src: imageUrl(), alt: '账单图片', class: 'preview', style: { width: '100%' }, onError: (event: Event) => errors.push(event) })
  imageAssert.equal(component.image().props.src, imageUrl())
  await component.error()
  imageAssert.equal(f.calls.length, 1)
  imageAssert.equal(f.calls[0][2].expectedSession.token, 'token-a')
  imageAssert.equal(component.image().props.src, imageUrl('1', 'renewed'))
  imageAssert.equal(component.props.src, imageUrl())
  imageAssert.equal(component.image().props.alt, '账单图片')
  imageAssert.equal(component.image().props.class, 'preview')
  imageAssert.equal(component.image().props.style.width, '100%')
  imageAssert.equal(errors.length, 0)
  await component.error()
  await component.error()
  imageAssert.equal(f.calls.length, 1)
  imageAssert.equal(errors.length, 1)
  component.unmount()
})

imageTest('an identical renewed URL still replaces the img once and cannot refresh in a loop', async () => {
  const f = imageFixture(async () => ({ code: 1, data: imageUrl() }))
  const component = f.mount({ src: imageUrl() })
  const original = component.image()
  await component.error()
  imageAssert.equal(component.image().props.src, imageUrl())
  imageAssert.notEqual(component.image(), original)
  await component.error()
  imageAssert.equal(f.calls.length, 1)
  component.unmount()
})

imageTest('static, local, legacy and unrelated external images never request OSS renewal', async () => {
  const f = imageFixture()
  const tools = f.load('src/services/imageRefresh.ts')
  const sources = ['/assets/logo.png', 'blob:preview', 'data:image/png;base64,AA', '/uploads/old.jpg', 'https://example.com/photo.jpg', imageUrl().replace('fund-manage-hub.oss-cn-beijing.aliyuncs.com', 'example.com').split('?')[0], imageUrl().split('?')[0], imageUrl().replace('/images/', '/other/')]
  for (const src of sources) {
    let errors = 0
    const component = f.mount({ src, onError: () => errors++ })
    await component.error()
    imageAssert.equal(errors, 1, src)
    imageAssert.equal(tools.isManagedOssImage(src), false, src)
    component.unmount()
  }
  imageAssert.equal(f.calls.length, 0)
  imageAssert.equal(tools.isManagedOssImage(imageUrl()), true)
  imageAssert.equal(tools.isManagedOssImage('oss://fund-manage-hub/images/1/' + 'a'.repeat(32) + '.png'), true)
})

imageTest('OSS images served from a custom domain renew without changing the saved URL', async () => {
  const original = imageUrl().replace('fund-manage-hub.oss-cn-beijing.aliyuncs.com', 'images.example.com')
  const renewed = original.replace('Signature=expired', 'Signature=renewed')
  const f = imageFixture(async () => ({ code: 1, data: renewed }))
  const component = f.mount({ src: original })
  await component.error()
  imageAssert.equal(f.calls.length, 1)
  imageAssert.equal(f.calls[0][1].url, original)
  imageAssert.equal(component.image().props.src, renewed)
  imageAssert.equal(component.props.src, original)
  component.unmount()
})

imageTest('duplicate load errors while renewal is pending share the existing attempt', async () => {
  const deferred = imageDeferred()
  const f = imageFixture(() => deferred.promise)
  let errors = 0
  const component = f.mount({ src: imageUrl(), onError: () => errors++ })
  const pending = component.error()
  await component.error()
  imageAssert.equal(f.calls.length, 1)
  imageAssert.equal(errors, 0)
  deferred.resolve({ code: 1, data: imageUrl('1', 'renewed') })
  await pending
  imageAssert.equal(component.image().props.src, imageUrl('1', 'renewed'))
  imageAssert.equal(errors, 0)
  component.unmount()
})

imageTest('source changes abort old renewal and ignore its late response', async () => {
  const old = imageDeferred()
  const f = imageFixture(() => f.calls.length === 1 ? old.promise : Promise.resolve({ code: 1, data: imageUrl('2', 'renewed') }))
  let errors = 0
  const component = f.mount({ src: imageUrl(), onError: () => errors++ })
  const pending = component.error()
  await component.setProps({ src: imageUrl('2') })
  imageAssert.equal(f.calls[0][2].signal.aborted, true)
  old.resolve({ code: 1, data: imageUrl('1', 'stale') })
  await pending
  imageAssert.equal(component.image().props.src, imageUrl('2'))
  imageAssert.equal(errors, 0)
  await component.error()
  imageAssert.equal(component.image().props.src, imageUrl('2', 'renewed'))
  imageAssert.equal(f.calls.length, 2)
  component.unmount()
})

for (const boundary of ['close', 'unmount', 'route', 'session'] as const) {
  imageTest(`image renewal is cancelled at ${boundary} and ignores a late successful response`, async () => {
    const deferred = imageDeferred()
    const f = imageFixture(() => deferred.promise)
    let errors = 0
    const component = f.mount({ src: imageUrl(), onError: () => errors++ })
    const pending = component.error()
    if (boundary === 'close') await component.setProps({ active: false })
    if (boundary === 'unmount') component.unmount()
    if (boundary === 'route') { f.router.currentRoute.value = { fullPath: '/my' }; await imageVue.nextTick() }
    if (boundary === 'session') f.auth.setLoginUser({ id: 2, token: 'token-b' })
    imageAssert.equal(f.calls[0][2].signal.aborted, true)
    deferred.resolve({ code: 1, data: imageUrl('1', 'stale') })
    await pending
    imageAssert.equal(errors, 0)
    if (boundary === 'close' || boundary === 'unmount') imageAssert.equal(component.image(), undefined)
    else imageAssert.equal(component.image().props.src, imageUrl())
    if (boundary !== 'unmount') component.unmount()
  })
}

imageTest('closed image views do not refresh and can retry when opened again', async () => {
  const f = imageFixture()
  const component = f.mount({ src: imageUrl(), active: false })
  imageAssert.equal(component.image(), undefined)
  imageAssert.equal(f.calls.length, 0)
  await component.setProps({ active: true })
  await component.error()
  imageAssert.equal(f.calls.length, 1)
  component.unmount()
})

imageTest('unauthenticated images, rejected requests and invalid responses fall back once', async () => {
  for (const failure of ['anonymous', 'rejected', 'error-result', 'invalid-url']) {
    const f = imageFixture(async () => {
      if (failure === 'rejected') throw new Error('404')
      return failure === 'error-result' ? { code: 0, msg: '失败', data: null } : { code: 1, data: 'https://example.com/untrusted.jpg' }
    })
    if (failure === 'anonymous') f.auth.clearSession()
    let errors = 0
    const component = f.mount({ src: imageUrl(), onError: () => errors++ })
    await component.error()
    await component.error()
    imageAssert.equal(errors, 1, failure)
    imageAssert.equal(f.calls.length, failure === 'anonymous' ? 0 : 1, failure)
    component.unmount()
  }
})

imageTest('avatar retains its existing user icon after the renewed image also fails', async () => {
  const f = imageFixture()
  const component = f.mount({ src: imageUrl(), size: 84 }, 'src/components/ui/uiAvatar.vue')
  imageAssert.equal(component.icon(), undefined)
  await component.error()
  imageAssert.equal(component.icon(), undefined)
  await component.error()
  imageAssert.equal(component.image(), undefined)
  imageAssert.equal(component.icon().props.class, 'ui-icon')
  imageAssert.equal(f.calls.length, 1)
  await component.setProps({ src: imageUrl('2') })
  imageAssert.equal(component.image().props.src, imageUrl('2'))
  component.unmount()
})
