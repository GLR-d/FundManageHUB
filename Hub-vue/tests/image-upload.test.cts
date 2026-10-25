import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, vue, axios, flushTasks, deferred, fixture } = require('./helpers/runtime.cts')

test('upload uses the authenticated request instance', async () => {
  const f = fixture()
  f.storage.set('loginUser', JSON.stringify({ id: 1, token: 'example-token' }))
  const { request } = f.load('src/utils/request.ts')
  const { uploadImage } = f.load('src/services/imageUpload.ts')
  let config: TestDouble
  request.defaults.adapter = async (value: TestDouble) => {
    config = value
    return { status: 200, data: { code: 1, data: 'image.jpg' }, config: value }
  }
  const result = await uploadImage({ file: new Blob(['image'], { type: 'image/jpeg' }), filename: 'file' })
  assert.equal(config.headers.token, 'example-token')
  assert.equal(config.url, '/upload')
  assert.equal(result.data, 'image.jpg')
})

test('small images pass through; large JPEG and PNG keep their type and fit the server limit', async () => {
  const imageUpload = fixture().load('src/utils/imageUpload.ts')
  const small: File & { uid?: string | number } = new File(['small'], 'small.png', { type: 'image/png' })
  assert.equal(await imageUpload.compressUploadImage(small), small)
  for (const type of ['image/jpeg', 'image/png']) {
    const large: File & { uid?: string | number } = new File([new Uint8Array(2 * 1024 * 1024)], 'large-image', { type })
    let attempts = 0
    let released = false
    const canvas: TestDouble = { getContext: () => ({ drawImage: () => {} }), toBlob: (done: TestDouble, outputType: TestDouble) => {
      attempts++
      assert.equal(outputType, type)
      done(new Blob([new Uint8Array(attempts === 1 ? 1200000 : 900000)], { type: outputType }))
    } }
    const compressed = await imageUpload.compressUploadImage(large, undefined, {
      decodeImage: async () => ({ width: 4000, height: 3000, close: () => { released = true } }),
      createCanvas: () => canvas
    })
    assert.equal(compressed.type, type)
    assert.equal(compressed.name, large.name)
    assert.ok(compressed.size <= imageUpload.MAX_UPLOAD_BYTES)
    assert.equal(attempts, 2)
    assert.equal(released, true)
    assert.equal(canvas.width, 0)
  }
})

test('canceling during image decoding releases the bitmap and prevents compression', async () => {
  const upload = fixture().load('src/utils/imageUpload.ts')
  const controller = new AbortController()
  let finish: TestDouble
  let released = false
  const operation = upload.compressUploadImage(new File([new Uint8Array(2 * 1024 * 1024)], 'large.jpg', { type: 'image/jpeg' }), controller.signal, {
    decodeImage: () => new Promise(resolve => { finish = resolve }),
    createCanvas: () => { throw new Error('should not create canvas') }
  })
  controller.abort()
  finish({ width: 1000, height: 1000, close: () => { released = true } })
  await assert.rejects(operation, (error: TestDouble) => error.code === 'ERR_CANCELED')
  assert.equal(released, true)
})

test('cancel or account change during image preparation never posts the file or displays an error', async () => {
  for (const changeAccount of [false, true]) {
    let finish: TestDouble
    const f = fixture({ '@/utils/imageUpload': { compressUploadImage: () => new Promise(resolve => { finish = resolve }) } })
    const auth = f.load('src/stores/auth.ts')
    auth.setLoginUser({ id: 'A', token: 'example-a' })
    const upload = f.load('src/services/imageUpload.ts')
    const request = f.load('src/utils/request.ts').request
    let posts = 0
    request.defaults.adapter = async (config: TestDouble) => { posts++; return { status: 200, data: {}, config } }
    const file: File & { uid?: string | number } = new File(['test'], 'test.jpg', { type: 'image/jpeg' })
    file.uid = 9
    const operation = upload.uploadImage({ file })
    if (changeAccount) auth.setLoginUser({ id: 'B', token: 'example-b' })
    else upload.abortImageUpload(file.uid)
    finish(file)
    await assert.rejects(operation, axios.isCancel)
    assert.equal(posts, 0)
    assert.equal(f.notices.length, 0)
  }
})

test('image decode failures stop the upload with a useful error', async () => {
  const imageUpload = fixture().load('src/utils/imageUpload.ts')
  await assert.rejects(imageUpload.compressUploadImage(new File([new Uint8Array(2 * 1024 * 1024)], 'broken.jpg', { type: 'image/jpeg' }), undefined, {
    decodeImage: async () => { throw new Error('broken image') }, createCanvas: () => {}
  }), /图片压缩失败/)
})

test('an upload started by a stale page never uses another account credentials', async () => {
  let processed = 0
  const f = fixture({ '@/utils/imageUpload': { compressUploadImage: async (file: TestDouble) => { processed++; return file } } })
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const upload = f.load('src/services/imageUpload.ts')
    const request = f.load('src/utils/request.ts').request
  let posts = 0
  request.defaults.adapter = async (config: TestDouble) => { posts++; return { status: 200, data: {}, config } }
  f.storage.set('loginUser', JSON.stringify({ id: 'B', token: 'example-b' }))
  await assert.rejects(upload.uploadImage({ file: new File(['test'], 'test.jpg', { type: 'image/jpeg' }) }), axios.isCancel)
  assert.equal(processed, 0)
  assert.equal(posts, 0)
  assert.equal(f.notices.length, 0)
})

test('an uploaded bill image releases the temporary preview and original file', () => {
  const released: TestDouble[] = []
  const image = {
    getImageUploadError: () => '', releaseImagePreview: (file: TestDouble) => { if (file?.url?.startsWith('blob:')) released.push(file.url) }
  }
  const f = fixture({ '@/api/fund': {}, '@/services/imageUpload': { uploadImage: () => {}, abortImageUpload: () => {} }, '@/utils/imageUpload': image })
  const fund = f.load('src/composables/useFundEditor.ts').useFundEditor({ isDeleting: () => false, onSaved: async () => {} })
  const file = { uid: 1, status: 'uploading', url: 'blob:preview', raw: new File(['sample'], 'sample.png') }
  fund.fileList.value = [file]
  fund.handleSuccess({ code: 1, data: '/images/upload.png' }, file)
  assert.equal(file.url, '/images/upload.png')
  assert.equal(file.raw, undefined)
  assert.deepEqual(released, ['blob:preview'])
  fund.handleUploadError(new Error('offline'), { url: 'blob:failed-preview' })
  assert.deepEqual(released, ['blob:preview', 'blob:failed-preview'])
})

test('retry starts once and closing the editor before the next tick cancels a queued retry', async () => {
  const f = fixture()
  const files = vue.ref([])
  let active = true
  let submissions = 0
  const uploadRef = vue.ref({ submit: () => { submissions++ } })
  const retry = f.load('src/composables/useUploadRetry.ts').useUploadRetry({ files, uploadRef, isActive: () => active })
  const raw: File & { uid?: string | number } = new File(['sample'], 'receipt.png', { type: 'image/png' })
  const file = { uid: 12, name: raw.name, raw }
  retry.rememberFailure(file)
  const first = retry.retryUpload(retry.failedUploads.value[0])
  await retry.retryUpload(file)
  await first
  assert.equal(submissions, 1)
  assert.equal(files.value[0].raw, raw)
  assert.equal(retry.hasFailedUploads.value, false)
  files.value = []
  retry.rememberFailure(file)
  const queued = retry.retryUpload(file)
  active = false
  files.value = []
  retry.clearFailures()
  await queued
  assert.equal(submissions, 1)
  retry.rememberFailure(file)
  assert.equal(retry.hasFailedUploads.value, false)
})

test('canceled uploads and unsupported files never become retry failures', () => {
  const f = fixture()
  const retry = f.load('src/composables/useUploadRetry.ts').useUploadRetry({ files: vue.ref([]), uploadRef: vue.ref(null), isActive: () => true })
  const file = { uid: 1, name: 'photo.png', raw: new File(['sample'], 'photo.png', { type: 'image/png' }) }
  retry.rememberFailure(file, new axios.CanceledError())
  retry.rememberFailure({ ...file, raw: new File(['sample'], 'photo.gif', { type: 'image/gif' }) })
  assert.equal(retry.failedUploads.value.length, 0)
})

test('native upload cannot submit twice and a removed or disposed file never publishes late progress or success', async () => {
  const f=fixture()
  const files=vue.ref([]), canceled=[], requests: TestDouble[]=[], successes=[], progress=[]
  const controller=f.load('src/services/nativeUpload.ts').createUploadController({getFiles:()=>files.value,setFiles:(value: TestDouble)=>{files.value=value},abort:(uid: TestDouble)=>canceled.push(uid),request:(options: TestDouble)=>{const pending=deferred();requests.push({options,pending});return pending.promise},onSuccess:(response: TestDouble)=>successes.push(response),onProgress:(event: TestDouble)=>progress.push(event)})
  const first=controller.select([new File(['data'],'receipt.png',{type:'image/png'})])
  await flushTasks()
  controller.submit()
  assert.equal(requests.length,1)
  requests[0].options.onProgress({percent:40})
  assert.equal(files.value[0].percentage,40)
  controller.remove(files.value[0])
  requests[0].options.onProgress({percent:90})
  requests[0].pending.resolve({code:1,data:'/photo.png'})
  await Promise.all(first)
  assert.equal(files.value.length,0)
  assert.equal(progress.length,1)
  assert.equal(successes.length,0)
  assert.equal(canceled.length,1)
  const second=controller.select([new File(['data'],'receipt.png',{type:'image/png'})])
  await flushTasks()
  controller.dispose()
  requests[1].pending.resolve({code:1,data:'/photo.png'})
  await Promise.all(second)
  assert.equal(successes.length,0)
  assert.equal(files.value.length,0)
  assert.equal(controller.select([new File(['data'],'later.png')]).length,0)
})
