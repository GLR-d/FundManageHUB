import type { TestDouble } from './helpers/testTypes.cts'
const test: typeof import('node:test') = require('node:test')
const { assert, fs, path, vue, root, plain, flushTasks, deferred, fixture, form } = require('./helpers/runtime.cts')
const { accountEditorFixture } = require('./helpers/accountFixtures.cts')

test('personal center opens the verified-email flow instead of updating email as plain profile data', () => {
  const f = fixture()
  const page = f.load('src/views/my/index.vue', ['editContact', 'emailVisible', 'dialogVisible'])
  page.editContact('phone')
  assert.equal(page.emailVisible.value, false)
  assert.equal(page.dialogVisible.value, true)
  const source = fs.readFileSync(path.join(root, 'src/views/my/index.vue'), 'utf8')
  assert.match(source, /@click="emailVisible = true"/)
  assert.doesNotMatch(source, /editContact\('email'\)/)
})

test('profile cancellation discards drafts and saving preserves existing user fields', async () => {
  const updates: TestDouble[] = []
  const f = fixture({
    '@/api/my': { updateUser: async () => ({ code: 1 }) },
    '@/services/imageUpload': { uploadImage: () => {} }
  })
  const props = vue.reactive({ visible: false, userData: { id: 1, name: 'original', avatar: '', phone: '123456789' }, editField: 'profile' })
  const profile = f.load('src/views/my/components/updateUserData.vue', ['localData', 'formRef', 'rules', 'handleSubmit'], props,
    (event: TestDouble, data: TestDouble) => { if (event === 'update:userData') updates.push(data) })
  props.visible = true
  await vue.nextTick()
  profile.localData.value.name = 'discarded draft'
  props.visible = false
  await vue.nextTick()
  props.visible = true
  await vue.nextTick()
  assert.equal(profile.localData.value.name, 'original')
  profile.localData.value.name = 'updated'
  profile.formRef.value = form(profile.localData, profile.rules, () => ['name'])
  await profile.handleSubmit()
  assert.equal(updates[0].id, 1)
  assert.equal(updates[0].phone, '123456789')
  assert.equal(updates[0].name, 'updated')
})

test('storage session events synchronize memory, clear the previous profile and notify navigation', () => {
  const f = fixture()
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  auth.currentUser.value = { id: 'A' }
  const handlers = new Map()
  const target = { addEventListener: (name: TestDouble, callback: TestDouble) => handlers.set(name, callback), removeEventListener: (name: TestDouble) => handlers.delete(name) }
  const changes: TestDouble[] = []
  const stop = auth.startSessionSync((user: TestDouble) => changes.push(user?.id || null), target)
  f.storage.set('loginUser', JSON.stringify({ id: 'B', token: 'example-b' }))
  handlers.get('storage')({ key: 'loginUser' })
  assert.equal(auth.loginUser.value.id, 'B')
  assert.deepEqual(plain(auth.currentUser.value), {})
  f.storage.delete('loginUser')
  handlers.get('storage')({ key: 'loginUser' })
  assert.equal(auth.loginUser.value, null)
  assert.deepEqual(changes, ['B', null])
  stop()
  assert.equal(handlers.size, 0)
})

test('late profile response cannot overwrite the account that logged in later', async () => {
  let finish: TestDouble
  const f = fixture({ '@/api/my': { getUser: () => new Promise(resolve => { finish = resolve }) } })
  const auth = f.load('src/stores/auth.ts')
  const user = f.load('src/stores/user.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const operation = user.loadCurrentUser()
  auth.setLoginUser({ id: 'B', token: 'example-b' })
  auth.currentUser.value = { id: 'B', name: 'B' }
  finish({ code: 1, data: { id: 'A', name: 'A' } })
  await operation
  assert.equal(auth.currentUser.value.id, 'B')
})

test('profile loading is deduplicated and does not undo a profile edit', async () => {
  let finish: TestDouble
  let reads = 0
  const f = fixture({ '@/api/my': { getUser: () => { reads++; return new Promise(resolve => { finish = resolve }) } } })
  const auth = f.load('src/stores/auth.ts')
  const user = f.load('src/stores/user.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const first = user.loadCurrentUser()
  const second = user.loadCurrentUser()
  assert.equal(reads, 1)
  auth.currentUser.value = { id: 'A', name: 'edited' }
  finish({ code: 1, data: { id: 'A', name: 'old name' } })
  await Promise.all([first, second])
  assert.equal(auth.currentUser.value.name, 'edited')
})

test('native file validation rejects unsupported avatars without leaving an uploading state', async () => {
  const f = fixture({ '@/api/my': {}, '@/services/imageUpload': { uploadImage: () => {}, abortImageUpload: () => {} } })
  const profile = f.load('src/views/my/components/updateUserData.vue', ['avatarFiles', 'uploading', 'handleBeforeUpload', 'handleUploadChange', 'handleClose'], { visible: false, userData: {} })
  let posted = 0
  const controller = f.load('src/services/nativeUpload.ts').createUploadController({ getFiles:()=>profile.avatarFiles.value, setFiles:(files: TestDouble)=>{ profile.avatarFiles.value=files }, request:async()=>{ posted++ }, abort:()=>{}, beforeUpload:profile.handleBeforeUpload, onChange:profile.handleUploadChange })
  for (const [type, size] of [['image/gif', 10], ['image/jpeg', 21 * 1024 * 1024]] as const) {
    await Promise.all(controller.select([new File([new Uint8Array(size)], 'test-image', { type })]))
    assert.equal(profile.avatarFiles.value.length, 0)
    assert.equal(profile.uploading.value, false)
    let closed = false
    profile.handleClose(() => { closed = true })
    assert.equal(closed, true)
  }
  assert.equal(posted, 0)
})

test('canceling an avatar upload cancels the request and closes the editor', () => {
  const canceled: TestDouble[] = []
  const f = fixture({ '@/api/my': {}, '@/services/imageUpload': { uploadImage: () => {}, abortImageUpload: (id: TestDouble) => canceled.push(id) } })
  const events: TestDouble[] = []
  const profile = f.load('src/views/my/components/updateUserData.vue', ['avatarFiles', 'uploading', 'closeDialog'], { visible: true, userData: {} }, (event: TestDouble, value: TestDouble) => events.push([event, value]))
  profile.avatarFiles.value = [{ uid: 7, status: 'uploading' }]
  assert.equal(profile.uploading.value, true)
  profile.closeDialog()
  assert.equal(profile.uploading.value, false)
  assert.deepEqual(canceled, [7])
  assert.deepEqual(events, [['update:visible', false]])
})

test('native avatar upload retries the original file and accepts the replacement URL', async () => {
  const f = fixture({ '@/api/my': {}, '@/services/imageUpload': { uploadImage: () => {}, abortImageUpload: () => {} } })
  const profile = f.load('src/views/my/components/updateUserData.vue', ['avatarFiles', 'uploadRef', 'failedUploads', 'hasFailedUploads', 'handleBeforeUpload', 'handleUploadError', 'handleUploadChange', 'handleSuccess', 'retryUpload', 'localData'], { visible:true, userData:{} })
  const requests: TestDouble[] = []
  const controller = f.load('src/services/nativeUpload.ts').createUploadController({ getFiles:()=>profile.avatarFiles.value, setFiles:(files: TestDouble)=>{ profile.avatarFiles.value=files }, abort:()=>{}, beforeUpload:profile.handleBeforeUpload, onChange:profile.handleUploadChange, onSuccess:profile.handleSuccess, onError:profile.handleUploadError, request:(options: TestDouble)=>{ const pending=deferred(); requests.push({ pending, raw:options.file }); return pending.promise } })
  profile.uploadRef.value = controller
  const raw: File & { uid?: string | number } = new File(['sample'], 'avatar.png', { type:'image/png' })
  await vue.nextTick()
  const first = controller.select([raw])
  await flushTasks()
  requests[0].pending.reject(new Error('simulated offline'))
  await Promise.all(first)
  assert.equal(profile.avatarFiles.value.length, 0)
  assert.equal(profile.hasFailedUploads.value, true)
  await profile.retryUpload(profile.failedUploads.value[0])
  await flushTasks()
  assert.equal(requests[1].raw, raw)
  requests[1].pending.resolve({ code:1, data:'/images/new-avatar.png' })
  await flushTasks()
  assert.equal(profile.localData.value.avatar, '/images/new-avatar.png')
  assert.equal(profile.hasFailedUploads.value, false)
  assert.equal(profile.avatarFiles.value.length, 0)
})

test('an empty avatar URL stays retryable and cannot overwrite the previous avatar', () => {
  const f = fixture({ '@/api/my': {}, '@/services/imageUpload': { uploadImage: () => {}, abortImageUpload: () => {} } })
  const profile = f.load('src/views/my/components/updateUserData.vue', ['handleSuccess', 'localData', 'hasFailedUploads', 'failedUploads'], { visible: true, userData: { avatar: '/images/original.png' } })
  profile.handleSuccess({ code: 1, data: ' ' }, { uid: 17, name: 'new.png', raw: new File(['sample'], 'new.png', { type: 'image/png' }) })
  assert.equal(profile.localData.value.avatar, '/images/original.png')
  assert.equal(profile.hasFailedUploads.value, true)
  assert.equal(profile.failedUploads.value.length, 1)
})

test('profile reads reuse recent data, expire after 30 seconds and support manual refresh per account', async () => {
  let now = 1000
  let reads = 0
  const f = fixture({ '@/api/my': { getUser: async () => { reads++; return { code: 1, data: { name: 'profile ' + reads } } } } }, undefined, { Date: { now: () => now } })
  const auth = f.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const user = f.load('src/stores/user.ts')
  await user.loadCurrentUser()
  auth.currentUser.value = { name: 'edited locally' }
  assert.equal((await user.loadCurrentUser()).name, 'edited locally')
  assert.equal(reads, 1)
  now += 30001
  await user.loadCurrentUser()
  assert.equal(reads, 2)
  await user.loadCurrentUser({ force: true })
  assert.equal(reads, 3)
  auth.setLoginUser({ id: 'B', token: 'example-b' })
  await user.loadCurrentUser()
  assert.equal(reads, 4)
})

test('invalid profile results do not enter the cache and remain retryable', async () => {
  let reads = 0
  const f = fixture({ '@/api/my': { getUser: async () => ({ code: 1, data: ++reads === 1 ? [] : { name: 'valid' } }) } })
  f.load('src/stores/auth.ts').setLoginUser({ id: 'A', token: 'example-a' })
  const user = f.load('src/stores/user.ts')
  assert.equal(await user.loadCurrentUser(), null)
  assert.equal((await user.loadCurrentUser()).name, 'valid')
  assert.equal(reads, 2)
})

test('manual profile refresh prevents double clicks and suppresses its success notice after leaving', async () => {
  let dispose: TestDouble
  let finish: TestDouble
  let reads = 0
  const f = fixture({
    vue: { ...vue, onMounted: () => {}, onUnmounted: (fn: TestDouble) => { dispose = fn } },
    '@/stores/user': { loadCurrentUser: (options: TestDouble) => { assert.equal(options.force, true); reads++; return new Promise(resolve => { finish = resolve }) } }
  })
  const profile = f.load('src/views/my/index.vue', ['refreshProfile', 'refreshing'])
  const operation = profile.refreshProfile()
  await profile.refreshProfile()
  assert.equal(reads, 1)
  dispose()
  finish({ name: 'latest' })
  await operation
  assert.equal(profile.refreshing.value, false)
  assert.equal(f.notices.length, 0)
})

test('profile fields submit a snapshot and business failure preserves the draft', async () => {
  for (const field of ['profile', 'phone']) {
    const validation = deferred()
    const response = deferred()
    const sent: TestDouble[] = []
    const f = accountEditorFixture('updateUserData', { updateUser: (data: TestDouble, config: TestDouble) => { sent.push({ data, config }); return response.promise } })
    f.props.editField = field
    const original = plain(f.editor.localData.value)
    f.editor.formRef.value.validate = () => validation.promise
    const operation = f.editor.handleSubmit()
    await f.editor.handleSubmit()
    f.editor.localData.value = { avatar: 'changed.jpg', name: 'changed', phone: '19900000000', email: 'changed@example.test' }
    validation.resolve(true)
    await flushTasks()
    assert.equal(sent.length, 1)
    assert.deepEqual(plain(sent[0].data), field === 'profile' ? { avatar: original.avatar, name: original.name } : { [field]: original[field] })
    assert.equal(sent[0].config.expectedSession.token, 'example-a')
    response.resolve({ code: 0, msg: 'profile refused' })
    await operation
    assert.equal(f.props.visible, true)
    assert.equal(f.events.length, 0)
    assert.equal(f.notices.at(-1).text, 'profile refused')
    assert.equal(f.editor.submitting.value, false)
  }
})

test('profile validation cannot continue after leaving, switching account or changing editor field', async () => {
  for (const change of ['unmount', 'account', 'field']) {
    const validation = deferred()
    let sends = 0
    const f = accountEditorFixture('updateUserData', { updateUser: async () => { sends++; return { code: 1 } } })
    f.editor.formRef.value.validate = () => validation.promise
    const operation = f.editor.handleSubmit()
    if (change === 'unmount') f.unmount()
    else if (change === 'account') f.auth.setLoginUser({ id: 'B', token: 'example-b' })
    else f.props.editField = 'phone'
    validation.resolve(true)
    await operation
    assert.equal(sends, 0)
    assert.equal(f.events.length, 0)
    assert.equal(f.notices.length, 0)
  }
})

test('reopening a profile editor isolates its new submission from the previous response', async () => {
  const requests: TestDouble[] = []
  const f = accountEditorFixture('updateUserData', { updateUser: (data: TestDouble, config: TestDouble) => {
    const response = deferred()
    requests.push({ data, config, ...response })
    return response.promise
  } })
  const first = f.editor.handleSubmit()
  await flushTasks()
  f.props.visible = false
  assert.equal(requests[0].config.signal.aborted, true)
  f.props.visible = true
  f.editor.localData.value.name = 'new draft'
  const second = f.editor.handleSubmit()
  await flushTasks()
  requests[0].resolve({ code: 1, data: { name: 'old response' } })
  await first
  assert.equal(f.editor.submitting.value, true)
  assert.equal(f.editor.localData.value.name, 'new draft')
  assert.equal(f.events.length, 0)
  requests[1].resolve({ code: 1 })
  await second
  assert.equal(f.editor.submitting.value, false)
  assert.equal(f.events.find((event: TestDouble) => event.event === 'update:userData').data.name, 'new draft')
  assert.equal(f.notices.filter((item: TestDouble) => item.type === 'success').length, 1)
})

test('profile auto sync starts with the page, pauses for every account editor and stops on exit', () => {
  const mounts: TestDouble[] = []
  const unmounts: TestDouble[] = []
  let starts = 0
  let stops = 0
  let isPaused!: () => boolean
  const f = fixture({
    vue: {...vue,onMounted:(fn: TestDouble)=>mounts.push(fn),onUnmounted:(fn: TestDouble)=>unmounts.push(fn)},
    '@/stores/user': {loadCurrentUser:async()=>null},
    '@/services/profileAutoSync': {startProfileAutoSync:(options: TestDouble)=>{starts++;isPaused=options.isPaused;return ()=>{stops++}}}
  })
  const page = f.load('src/views/my/index.vue',['dialogVisible','dVPassword','emailVisible'])
  mounts.forEach(fn=>fn())
  assert.equal(starts,1)
  assert.equal(isPaused(),false)
  for (const field of ['dialogVisible','dVPassword','emailVisible']) {
    page[field].value=true
    assert.equal(isPaused(),true)
    page[field].value=false
    assert.equal(isPaused(),false)
  }
  unmounts.forEach(fn=>fn())
  assert.equal(stops,1)
})
