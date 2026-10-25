import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, path, root, flushTasks, deferred, fixture } = require('./helpers/runtime.cts')
const { routeFixture } = require('./helpers/routeFixtures.cts')

test('route recovery recognizes Vite and native browser asset failures without misclassifying API or programming errors', () => {
  const { isRouteLoadError } = fixture().load('src/utils/routeRecovery.ts')
  for (const error of [
    new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/my-demo.js'),
    new TypeError('error loading dynamically imported module: http://127.0.0.1:7070/assets/my-demo.js'),
    new TypeError('Importing a module script failed.'),
    new Error('Unable to preload CSS for http://127.0.0.1:7070/assets/chat-demo.css')
  ]) assert.equal(isRouteLoadError(error), true)
  for (const error of [null, undefined, new TypeError('Cannot read properties of null'), { code: 'ERR_NETWORK', message: 'Network Error' }, new Error('HTTP 500'), new Error('保存失败'), { name: 'ChunkLoadError' }, { code: 'CSS_CHUNK_LOAD_FAILED' }, new Error('Loading chunk 17 failed.'), new Error('Loading CSS chunk 17 failed.')]) assert.equal(isRouteLoadError(error), false)
})

test('initial route failure retries once and preserves the intended query and hash', async () => {
  const f = routeFixture()
  const response = deferred()
  const error = new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js')
  let reads = 0
  f.record('/fund').components.default = () => { reads++; return reads === 1 ? Promise.reject(error) : response.promise }
  const target = '/fund?keyword=example#day'
  await assert.rejects(f.router.push(target), (failure: TestDouble) => failure === error)
  assert.equal(f.router.currentRoute.value.matched.length, 0)
  assert.equal(f.recovery.failure.value.path, target)
  assert.equal(f.notices.length, 1)
  const retry = f.recovery.retry()
  await f.recovery.retry()
  await flushTasks()
  assert.equal(reads, 2)
  assert.equal(f.recovery.retrying.value, true)
  response.resolve({ default: { render: () => null } })
  await retry
  assert.equal(f.router.currentRoute.value.fullPath, target)
  assert.equal(f.recovery.failure.value, null)
  assert.equal(f.recovery.retrying.value, false)
  assert.equal(f.reloads.length, 0)
})

test('failed navigation keeps the current route and can stay without reloading or navigating', async () => {
  const f = routeFixture()
  await f.router.push('/fund?keep=selection')
  const previous = f.router.currentRoute.value
  const error = new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js')
  f.record('/my').components.default = () => Promise.reject(error)
  await assert.rejects(f.router.push('/my'), (failure: TestDouble) => failure === error)
  assert.equal(f.router.currentRoute.value, previous)
  assert.equal(f.recovery.failure.value.path, '/my')
  f.recovery.dismiss()
  assert.equal(f.recovery.failure.value, null)
  assert.equal(f.router.currentRoute.value, previous)
  assert.equal(f.reloads.length, 0)
})

test('route retry success opens the requested page and retains browser back navigation', async () => {
  const f = routeFixture()
  await f.router.push('/fund?original=1')
  let reads = 0
  f.record('/my').components.default = () => {
    reads++
    return reads === 1 ? Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js')) : Promise.resolve({ default: { render: () => null } })
  }
  await assert.rejects(f.router.push('/my?source=fund#profile'))
  await f.recovery.retry()
  assert.equal(f.router.currentRoute.value.fullPath, '/my?source=fund#profile')
  f.router.back()
  await flushTasks()
  assert.equal(f.router.currentRoute.value.fullPath, '/fund?original=1')
})

test('repeated CSS failure keeps recovery available and refresh targets the full intended URL once', async () => {
  const f = routeFixture()
  await f.router.push('/fund')
  let reads = 0
  const error = new Error('Unable to preload CSS for http://127.0.0.1:7070/assets/chat-demo.css')
  f.record('/chat').components.default = () => { reads++; return Promise.reject(error) }
  await assert.rejects(f.router.push('/chat?conversation=A#latest'))
  await f.recovery.retry()
  assert.equal(reads, 2)
  assert.equal(f.recovery.failure.value.path, '/chat?conversation=A#latest')
  assert.equal(f.recovery.retrying.value, false)
  assert.equal(f.router.currentRoute.value.path, '/fund')
  f.recovery.refresh()
  f.recovery.refresh()
  f.recovery.dismiss()
  assert.deepEqual(f.reloads, ['http://127.0.0.1:7070/chat?conversation=A#latest'])
  assert.equal(f.recovery.retrying.value, true)
  assert.equal(f.recovery.failure.value.path, '/chat?conversation=A#latest')
})

test('a late asset failure after another successful navigation does not restore the old recovery UI', async () => {
  const f = routeFixture()
  await f.router.push('/fund')
  const response = deferred()
  f.record('/my').components.default = () => response.promise
  const operation = f.router.push('/my')
  const rejected = assert.rejects(operation)
  await flushTasks()
  await f.router.push('/setting')
  response.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js'))
  await rejected
  assert.equal(f.router.currentRoute.value.path, '/setting')
  assert.equal(f.recovery.failure.value, null)
  assert.equal(f.notices.length, 0)
})

test('changing account clears recovery and prevents retry or refresh from the previous account', async () => {
  const f = routeFixture()
  let reads = 0
  f.record('/my').components.default = () => { reads++; return Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js')) }
  await assert.rejects(f.router.push('/my'))
  f.auth.setLoginUser({ id: 'B', token: 'example-b' })
  await f.recovery.retry()
  f.recovery.refresh()
  assert.equal(reads, 1)
  assert.equal(f.recovery.failure.value, null)
  assert.equal(f.reloads.length, 0)
})

test('a delayed retry failure from the previous account cannot replace a newer page state', async () => {
  const f = routeFixture()
  await f.router.push('/fund')
  let reads = 0
  const response = deferred()
  f.record('/my').components.default = () => { reads++; return reads === 1 ? Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js')) : response.promise }
  await assert.rejects(f.router.push('/my'))
  const retry = f.recovery.retry()
  await flushTasks()
  f.auth.setLoginUser({ id: 'B', token: 'example-b' })
  await f.router.push('/dashboard')
  response.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js'))
  await retry
  assert.equal(f.router.currentRoute.value.path, '/dashboard')
  assert.equal(f.recovery.failure.value, null)
  assert.equal(f.recovery.retrying.value, false)
  assert.equal(f.notices.length, 1)
})

test('programming errors are reported and do not become an asset retry prompt', async () => {
  const f = routeFixture()
  await f.router.push('/fund')
  const error = new TypeError('broken page module')
  f.record('/my').components.default = () => Promise.reject(error)
  await assert.rejects(f.router.push('/my'), (failure: TestDouble) => failure === error)
  assert.equal(f.recovery.failure.value, null)
  assert.equal(f.notices.length, 0)
  assert.equal(f.errors[0], error)
})

test('a programming error during retry clears the obsolete asset prompt and remains rejected', async () => {
  const f = routeFixture()
  let reads = 0
  const bug = new TypeError('broken module')
  f.record('/my').components.default = () => {
    reads++
    return Promise.reject(reads === 1 ? new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js') : bug)
  }
  await assert.rejects(f.router.push('/my'))
  await assert.rejects(f.recovery.retry(), (error: TestDouble) => error === bug)
  assert.equal(f.recovery.failure.value, null)
  assert.equal(f.recovery.retrying.value, false)
  assert.equal(f.errors[0], bug)
})

test('a failed browser refresh unlocks recovery and gives a usable top message', async () => {
  const f = routeFixture({ reload: () => { throw new Error('blocked refresh') } })
  f.record('/my').components.default = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js'))
  await assert.rejects(f.router.push('/my'))
  f.recovery.refresh()
  assert.equal(f.recovery.retrying.value, false)
  assert.equal(f.recovery.failure.value.path, '/my')
  assert.match(f.notices.at(-1).text, /浏览器的刷新按钮/)
})

test('logout during initial route download rechecks authorization before showing the protected page', async () => {
  const f = routeFixture()
  const response = deferred()
  f.record('/fund').components.default = () => response.promise
  const operation = f.router.push('/fund?requested=1#day')
  await flushTasks()
  f.auth.clearSession()
  response.resolve({ default: { render: () => null } })
  await operation
  assert.equal(f.router.currentRoute.value.path, '/login')
  assert.equal(f.router.currentRoute.value.query.redirect, '/fund?requested=1#day')
  assert.equal(f.notices.length, 0)
})

test('disposing recovery removes its router handlers and account listener', async () => {
  const f = routeFixture()
  f.record('/my').components.default = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js'))
  await assert.rejects(f.router.push('/my'))
  f.recovery.dispose()
  await f.router.push('/setting')
  assert.equal(f.recovery.failure.value, null)
  await f.recovery.retry()
  f.recovery.refresh()
  assert.equal(f.reloads.length, 0)
})

test('route refresh cannot interpret a double-slash path as another website', async () => {
  const f = routeFixture()
  f.record('/:pathMatch(.*)*').components.default = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js'))
  await assert.rejects(f.router.push('//outside.example/path'))
  assert.equal(f.recovery.failure.value.path, '//outside.example/path')
  f.recovery.refresh()
  assert.equal(f.reloads.length, 0)
  assert.equal(f.recovery.retrying.value, false)
  assert.match(f.notices.at(-1).text, /浏览器的刷新按钮/)
})

test('refreshing the same failed address with a hash reloads the document instead of a fragment navigation', async () => {
  const target = '/fund?qa=refresh#day'
  const f = routeFixture({ href: 'http://127.0.0.1:7070' + target })
  f.record('/fund').components.default = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js'))
  await assert.rejects(f.router.push(target))
  f.recovery.refresh()
  assert.deepEqual(f.reloadMethods, ['reload'])
  assert.deepEqual(f.reloads, ['http://127.0.0.1:7070' + target])
  assert.equal(f.hashReplacements.length, 0)
})

test('refreshing a different hash on the same path updates the intended hash before reloading', async () => {
  const f = routeFixture({ href: 'http://127.0.0.1:7070/fund?qa=refresh#old' })
  f.record('/fund').components.default = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/page-demo.js'))
  await assert.rejects(f.router.push('/fund?qa=refresh#new'))
  f.recovery.refresh()
  assert.deepEqual(f.reloadMethods, ['reload'])
  assert.deepEqual(f.reloads, ['http://127.0.0.1:7070/fund?qa=refresh#new'])
  assert.equal(f.hashReplacements[0].href, f.reloads[0])
  assert.equal(f.hashReplacements[0].state.position, 3)
})

test('Vite configuration keeps development and preview on loopback and preserves backend URL rewriting', async () => {
  const configModule = '../vite.config.mts'
  const {default:config}: { default: TestDouble }=await import(configModule)
  assert.equal(config.server.host,'127.0.0.1')
  assert.equal(config.server.port,7070)
  assert.equal(config.server.strictPort,true)
  assert.equal(config.preview.host,'127.0.0.1')
  assert.equal(config.preview.strictPort,true)
  const proxy=config.server.proxy['/api']
  assert.equal(proxy.target,'http://localhost:8080')
  assert.equal(proxy.rewrite('/api/fund/search?searchType=2&searchValue=0'),'/fund/search?searchType=2&searchValue=0')
  assert.equal(proxy.rewrite('/api'),'/')
  assert.equal(proxy.rewrite('/apiary'),'/apiary')
  assert.equal(config.preview.proxy['/api'].rewrite('/api/login/captcha'),'/login/captcha')
  assert.equal(path.resolve(config.resolve.alias['@']),path.join(root,'src'))
  const chunkName=config.build.rolldownOptions.output.chunkFileNames
  assert.equal(chunkName({facadeModuleId:path.join(root,'src/views/fund/index.vue')}),'assets/fund-[hash].js')
  assert.equal(chunkName({facadeModuleId:path.join(root,'src/layout/index.vue')}),'assets/layout-[hash].js')
  assert.equal(chunkName({facadeModuleId:null}),'assets/[name]-[hash].js')
})

test('failed same-origin styles are removed so Vite can request them again; scripts and external resources are untouched', () => {
  const f=fixture()
  const handlers=new Map(), removals: TestDouble[]=[]
  const target={location:{href:'http://127.0.0.1:7070/fund'},addEventListener:(type: TestDouble,listener: TestDouble,capture: TestDouble)=>{handlers.set(type,{listener,capture})},removeEventListener:(type: TestDouble,listener: TestDouble,capture: TestDouble)=>{assert.equal(handlers.get(type).listener,listener);assert.equal(capture,true);handlers.delete(type)}}
  const stop=f.load('src/utils/styleRecovery.ts').startStyleRetrySupport(target)
  assert.equal(handlers.get('error').capture,true)
  const dispatch=(link: TestDouble)=>handlers.get('error').listener({target:link})
  const link={tagName:'LINK',rel:'stylesheet',href:'/assets/chat-demo.css',remove:()=>removals.push('style')}
  dispatch(link)
  dispatch({...link,href:'https://outside.example/chat.css'})
  dispatch({...link,rel:'modulepreload',href:'/assets/chat-demo.js'})
  dispatch({...link,tagName:'SCRIPT'})
  dispatch({...link,href:'file:///bad.css'})
  dispatch({})
  assert.deepEqual(removals,['style'])
  stop()
  assert.equal(handlers.size,0)
})

test('Vite CSS load failures keep the current route, retry repeatedly, and recover the intended URL after resources return', async () => {
  const f=routeFixture()
  await f.router.push('/fund')
  let available=false,calls=0
  const error=new Error('Unable to preload CSS for http://127.0.0.1:7070/assets/chat-demo.css')
  f.record('/chat').components.default=async()=>{calls++;if(!available)throw error;return {render:()=>null}}
  await assert.rejects(f.router.push('/chat?qa=vite#older'),(failure: TestDouble)=>failure===error)
  assert.equal(f.router.currentRoute.value.path,'/fund')
  assert.equal(f.recovery.failure.value.path,'/chat?qa=vite#older')
  await f.recovery.retry()
  assert.equal(calls,2)
  assert.equal(f.router.currentRoute.value.path,'/fund')
  assert.equal(f.recovery.retrying.value,false)
  available=true
  await f.recovery.retry()
  assert.equal(f.router.currentRoute.value.fullPath,'/chat?qa=vite#older')
  assert.equal(f.recovery.failure.value,null)
  assert.equal(f.reloads.length,0)
})

test('failed native page imports request a new entry URL only on the next user attempt and can retry repeatedly', async () => {
  const {createPageImport}=fixture().load('src/utils/pageImport.ts')
  const failure=new Error('Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/fund-ab_12.js?existing=1')
  const urls: TestDouble[]=[];let imports=0,available=false
  const component={default:{render:()=>null}}
  const page=createPageImport(async()=>{imports++;throw failure},'fund',async (url: TestDouble)=>{urls.push(url);if(!available)throw failure;return component},()=> 'http://127.0.0.1:7070/fund')
  await assert.rejects(page(),(error: TestDouble)=>error===failure)
  assert.equal(urls.length,0)
  await assert.rejects(page(),(error: TestDouble)=>error===failure)
  available=true
  assert.equal(await page(),component)
  assert.equal(imports,1)
  assert.deepEqual(urls,['http://127.0.0.1:7070/assets/fund-ab_12.js?existing=1&page-retry=1','http://127.0.0.1:7070/assets/fund-ab_12.js?existing=1&page-retry=2'])
})

test('CSS, foreign URLs, shared dependencies and code errors never bypass the original Vite page loader', async () => {
  const {createPageImport}=fixture().load('src/utils/pageImport.ts')
  for(const message of [
    'Failed to fetch dynamically imported module: https://outside.example/assets/fund-demo.js',
    'Failed to fetch dynamically imported module: http://127.0.0.1:7070/assets/shared-demo.js',
    'Failed to fetch dynamically imported module: http://127.0.0.1:7070/uploads/fund-demo.js',
    'Failed to fetch dynamically imported module: http://user:password@127.0.0.1:7070/assets/fund-demo.js',
    'ordinary programming error'
  ]) {
    const error=new Error(message);let imports=0,loads=0
    const page=createPageImport(async()=>{imports++;throw error},'fund',async()=>{loads++},()=> 'http://127.0.0.1:7070/fund')
    await assert.rejects(page(),(failure: TestDouble)=>failure===error)
    await assert.rejects(page(),(failure: TestDouble)=>failure===error)
    assert.equal(imports,2)
    assert.equal(loads,0)
  }
})

test('successful native page imports keep the normal Vite loading and caching behavior', async () => {
  const {createPageImport}=fixture().load('src/utils/pageImport.ts')
  const component={default:{render:()=>null}};let loads=0
  const page=createPageImport(async()=>component,'fund',async()=>{loads++})
  assert.equal(await page(),component)
  assert.equal(await page(),component)
  assert.equal(loads,0)
})

test('page retry waits for every failed stylesheet and retries only those that are still unavailable', async () => {
  const {createPageImport}=fixture().load('src/utils/pageImport.ts')
  const listeners=new Set<(url: string) => void>(),urls: TestDouble[]=[],first='http://127.0.0.1:7070/assets/chat-demo.css',second='http://127.0.0.1:7070/assets/chat-extra.css'
  let imports=0,available=false
  const component={default:{render:()=>null}}
  const failure=new Error('Unable to preload CSS for '+first)
  const styles={subscribe:(fn: TestDouble)=>{listeners.add(fn);return()=>listeners.delete(fn)},reload:async (url: TestDouble)=>{urls.push(url);if(url===first&&!available)throw failure}}
  const page=createPageImport(async()=>{imports++;if(imports===1){listeners.forEach(fn=>{fn(first);fn(second)});throw failure}return component},'chat',async()=>{throw new Error('CSS recovery must use the original importer')},()=> 'http://127.0.0.1:7070/my',styles)
  await assert.rejects(page(),(error: TestDouble)=>error===failure)
  assert.equal(urls.length,0)
  assert.equal(listeners.size,0)
  await assert.rejects(page(),(error: TestDouble)=>error===failure)
  assert.equal(imports,1)
  assert.equal(listeners.size,0)
  available=true
  assert.equal(await page(),component)
  assert.equal(imports,2)
  assert.deepEqual(urls,[first,second,first])
  assert.equal(listeners.size,0)
})

test('stylesheet reload shares pending requests, removes failed links and becomes retryable after failure', async () => {
  const {reloadStyle}=fixture().load('src/utils/styleRecovery.ts')
  const links: TestDouble[]=[];let removals=0
  const target={location:{href:'http://127.0.0.1:7070/my'},document:{createElement:()=>({handlers:new Map(),addEventListener(type: TestDouble,fn: TestDouble){this.handlers.set(type,fn)},remove:()=>removals++}),head:{appendChild:(link: TestDouble)=>links.push(link)}}}
  const first=reloadStyle('/assets/chat-demo.css',target)
  assert.equal(reloadStyle('/assets/chat-demo.css',target),first)
  assert.equal(links.length,1)
  const rejection=assert.rejects(first,/Unable to preload CSS/)
  links[0].handlers.get('error')()
  await rejection
  assert.equal(removals,1)
  const retry=reloadStyle('/assets/chat-demo.css',target)
  assert.equal(links.length,2)
  links[1].handlers.get('load')()
  await retry
  await assert.rejects(reloadStyle('https://outside.example/chat.css',target),/样式地址异常/)
  assert.equal(links.length,2)
})
