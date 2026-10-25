// Compile and mount actual SFC templates in a small in-memory Vue host.
// This exercises public props and emitted events without relying on setup-local names.
import type { TestDouble } from './testTypes.cts'
const { fs, path, vm, root, vue, fixture } = require('./runtime.cts')
const { parse, compileScript } = require('@vue/compiler-sfc')
import type { ScriptCompiler } from './scriptRuntime.cts'
const { compileTypeScript }: { compileTypeScript: ScriptCompiler } = require('./scriptRuntime.cts')

interface HostNode { type: string; text: string; props: Record<string, TestDouble>; children: HostNode[]; parent: HostNode | null }
const hostNode = (type: string, text = ''): HostNode => ({ type, text, props: {}, children: [], parent: null })

function mountSfc(relativePath: string, props: TestDouble, listeners: TestDouble = {}, mocks: TestDouble = {}) {
  const filename = path.join(root, relativePath)
  const source = fs.readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const compiled = compileScript(descriptor, { id: 'public-contract-test', inlineTemplate: true })
  const module = { exports: {} as TestDouble }
  const context = fixture(mocks)
  vm.runInNewContext(compileTypeScript(compiled.content, filename), {
    module, exports: module.exports,
    require: (name: string) => {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name === 'vue') return vue
      if (name.startsWith('@/')) return context.load('src/' + name.slice(2) + '.ts')
      throw new Error('Unexpected component dependency: ' + name)
    }
  }, { filename })
  const component = module.exports.default
  const detach = (child: HostNode) => {
    const siblings = child.parent?.children
    if (siblings) siblings.splice(siblings.indexOf(child), 1)
    child.parent = null
  }
  const renderer = vue.createRenderer({
    createElement: (tag: string) => hostNode(tag),
    createText: (value: string) => hostNode('#text', value),
    createComment: (value: string) => hostNode('#comment', value),
    setText: (element: HostNode, value: string) => { element.text = value },
    setElementText: (element: HostNode, value: string) => { element.text = value; element.children = [] },
    patchProp: (element: HostNode, key: string, previous: TestDouble, next: TestDouble) => { element.props[key] = next },
    insert: (child: HostNode, parent: HostNode, anchor: HostNode | null = null) => {
      detach(child)
      const at = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(at < 0 ? parent.children.length : at, 0, child)
      child.parent = parent
    },
    remove: detach,
    parentNode: (element: HostNode) => element.parent,
    nextSibling: (element: HostNode) => {
      const siblings = element.parent?.children || []
      return siblings[siblings.indexOf(element) + 1] || null
    }
  })
  const container = hostNode('#root')
  const app = renderer.createApp({ render: () => vue.h(component, { ...props, ...listeners }) })
  app.mount(container)
  const findAll = (type: string): HostNode[] => {
    const visit = (node: HostNode): HostNode[] => [...(node.type === type ? [node] : []), ...node.children.flatMap(visit)]
    return visit(container)
  }
  const text = (node: HostNode = container): string => (node.type === '#comment' ? '' : node.text) + node.children.map(text).join('')
  const trigger = (element: HostNode, event: string, payload: TestDouble) => {
    const handler = element.props[event]
    if (Array.isArray(handler)) handler.forEach(callback => callback(payload))
    else handler?.(payload)
  }
  return { findAll, text, trigger, unmount: () => { app.unmount(); context.unmount() } }
}

module.exports = { mountSfc }
