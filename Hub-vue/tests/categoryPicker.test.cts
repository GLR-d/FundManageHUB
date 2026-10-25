type CategoryPickerDouble = any
const categoryTest: typeof import('node:test') = require('node:test')
const categoryAssert: typeof import('node:assert/strict') = require('node:assert/strict')
const categoryFs: typeof import('node:fs') = require('node:fs')
const categoryPath: typeof import('node:path') = require('node:path')
const categoryVm: typeof import('node:vm') = require('node:vm')
const categoryTransform: typeof import('esbuild').transformSync = require('esbuild').transformSync
const categoryVue = require('vue')

function categoryFixture(overrides: CategoryPickerDouble = {}) {
  const props = categoryVue.reactive({ modelValue: '', options: [{ value: '0', label: '消费' }, { value: '1', label: '餐饮', disabled: true }, { value: '8', label: '交通' }], disabled: false, readonly: false, ...overrides })
  const emitted: unknown[][] = []
  const focused: number[] = []
  const formDisabled = categoryVue.ref(false)
  let validations = 0
  let nativeDisabled = false
  const controls = props.options.map((_option: unknown, index: number) => ({ focus: () => focused.push(index), matches: () => nativeDisabled }))
  const source = categoryFs.readFileSync(categoryPath.resolve(__dirname, '../src/components/ui/uiTagSelect.vue'), 'utf8').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)![1] + ';globalThis.exposed={choose,tabStopIndex,focusSelected,handleKeydown,root}'
  const code = categoryTransform(source, { loader: 'ts', format: 'cjs', target: 'node22' }).code
  const module = { exports: {} }
  const context = categoryVm.createContext({
    module, exports: module.exports, defineOptions: () => {}, defineProps: () => props,
    withDefaults: (value: unknown) => value,
    defineEmits: () => (event: string, value: string) => { emitted.push([event, value]); if (event === 'update:modelValue') props.modelValue = value },
    defineExpose: () => {},
    require: (name: string) => {
      if (name === 'vue') return { ...categoryVue, useId: () => 'test', inject: (key: string) => key === 'ui-field' ? { id: 'type', error: categoryVue.ref('请选择类型'), validate: () => { validations++ } } : { disabled: formDisabled } }
      throw new Error('Unexpected import: ' + name)
    }
  })
  categoryVm.runInContext(code, context)
  const picker = (context as CategoryPickerDouble).exposed
  picker.root.value = { querySelectorAll: () => controls }
  return { picker, props, emitted, focused, formDisabled, validations: () => validations, nativeDisabled: () => { nativeDisabled = true } }
}
const categoryKey = (key: string, overrides: CategoryPickerDouble = {}) => ({ key, preventDefault: () => {}, stopPropagation: () => {}, ...overrides })

categoryTest('tabbing into an unselected tag group does not change its value', async () => {
  const f = categoryFixture()
  f.picker.focusSelected()
  categoryAssert.equal(f.props.modelValue, '')
  categoryAssert.deepEqual(f.emitted, [])
  categoryAssert.equal(f.picker.tabStopIndex.value, 0)
  categoryAssert.deepEqual(f.focused, [0])
  f.picker.choose(2)
  await categoryVue.nextTick()
  categoryAssert.equal(f.props.modelValue, '8')
  categoryAssert.equal(f.picker.tabStopIndex.value, 2)
  categoryAssert.deepEqual(f.emitted, [['update:modelValue', '8'], ['change', '8']])
  categoryAssert.equal(f.validations(), 1)
})

categoryTest('arrow navigation skips unavailable choices and wraps; Home and End select their endpoints', async () => {
  const f = categoryFixture({ modelValue: '0' })
  f.picker.handleKeydown(categoryKey('ArrowRight'), 0)
  await categoryVue.nextTick()
  categoryAssert.equal(f.props.modelValue, '8')
  categoryAssert.equal(f.focused.at(-1), 2)
  f.picker.handleKeydown(categoryKey('ArrowDown'), 2)
  await categoryVue.nextTick()
  categoryAssert.equal(f.props.modelValue, '0')
  f.picker.handleKeydown(categoryKey('ArrowLeft'), 0)
  await categoryVue.nextTick()
  categoryAssert.equal(f.props.modelValue, '8')
  f.picker.handleKeydown(categoryKey('Home'), 2)
  await categoryVue.nextTick()
  categoryAssert.equal(f.props.modelValue, '0')
  f.picker.handleKeydown(categoryKey('End'), 0)
  await categoryVue.nextTick()
  categoryAssert.equal(f.props.modelValue, '8')
})

categoryTest('Space chooses the focused category once and does not intercept Tab, shortcuts or IME', async () => {
  const f = categoryFixture()
  f.picker.handleKeydown(categoryKey('Tab'), 0)
  f.picker.handleKeydown(categoryKey(' ', { isComposing: true }), 0)
  f.picker.handleKeydown(categoryKey('ArrowRight', { ctrlKey: true }), 0)
  categoryAssert.deepEqual(f.emitted, [])
  f.picker.handleKeydown(categoryKey(' '), 0)
  f.picker.handleKeydown(categoryKey('Enter'), 0)
  await categoryVue.nextTick()
  categoryAssert.deepEqual(f.emitted, [['update:modelValue', '0'], ['change', '0']])
})

categoryTest('readonly and disabled forms reject changes from pointer and keyboard while submitting', async () => {
  for (const mode of ['readonly', 'disabled', 'form', 'native']) {
    const f = categoryFixture({ modelValue: '0' })
    if (mode === 'form') f.formDisabled.value = true
    else if (mode === 'native') f.nativeDisabled()
    else f.props[mode] = true
    f.picker.choose(2)
    f.picker.handleKeydown(categoryKey(' '), 2)
    f.picker.handleKeydown(categoryKey('ArrowRight'), 0)
    await categoryVue.nextTick()
    categoryAssert.equal(f.props.modelValue, '0')
    categoryAssert.deepEqual(f.emitted, [])
    categoryAssert.equal(f.validations(), 0)
  }
})

categoryTest('editing focuses the existing selection and options can switch without selecting a new type', async () => {
  const f = categoryFixture({ modelValue: '8' })
  f.picker.focusSelected()
  categoryAssert.deepEqual(f.focused, [2])
  f.props.options = [{ value: '6', label: '薪资' }, { value: '7', label: '理财' }]
  f.props.modelValue = ''
  categoryAssert.equal(f.picker.tabStopIndex.value, 0)
  categoryAssert.deepEqual(f.emitted, [])
  f.picker.choose(20)
  categoryAssert.deepEqual(f.emitted, [])
  f.props.options = []
  f.picker.handleKeydown(categoryKey('ArrowDown'), 0)
  await categoryVue.nextTick()
  categoryAssert.equal(f.picker.tabStopIndex.value, -1)
  categoryAssert.deepEqual(f.emitted, [])
})
