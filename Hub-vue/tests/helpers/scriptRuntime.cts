// Shared TypeScript/SFC script evaluation. Each runtime owns its module cache and mocks.
import type { TestDouble } from './testTypes.cts'
const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')
const vm: typeof import('node:vm') = require('node:vm')
const { transformSync }: typeof import('esbuild') = require('esbuild')
const root = path.resolve(__dirname, '../..')
const resolveSourcePath = (file: string) => path.resolve(root, file)
const readSource = (file: string) => fs.readFileSync(resolveSourcePath(file), 'utf8')
const compileTypeScript = (source: string, filename?: string) => transformSync(source, {
  loader: 'ts', format: 'cjs', target: 'node22',
  define: { 'import.meta.hot': 'undefined' }, sourcefile: filename
}).code

interface ScriptRuntimeOptions {
  mocks?: Record<string, TestDouble>
  globals?: Record<string, TestDouble>
}
const createScriptRuntime = ({ mocks = {}, globals = {} }: ScriptRuntimeOptions = {}) => {
  const cache = new Map<string, TestDouble>()
  const load = (file: string, names: readonly string[] = [], moduleGlobals: Record<string, TestDouble> = {}): TestDouble => {
    const filename = resolveSourcePath(file)
    if (!names.length && cache.has(filename)) return cache.get(filename)
    let source = readSource(filename)
    if (file.endsWith('.vue')) {
      const script = source.match(/<script setup\b[^>]*>([\s\S]*?)<\/script>/)
      if (!script) throw new Error('Missing setup script: ' + file)
      source = script[1]
    }
    if (names.length) source += '\n;globalThis.exposed = {' + names.join(',') + '}'
    const module = { exports: {} }
    const context = vm.createContext({
      module, exports: module.exports, ...globals, ...moduleGlobals,
      require: (request: string) => {
        if (Object.hasOwn(mocks, request)) {
          const mock = mocks[request]
          return mock.default ? { __esModule: true, ...mock } : mock
        }
        if (request.endsWith('.png')) return 'captcha-error.png'
        if (request.endsWith('.vue')) return { __esModule: true, default: {} }
        if (request.endsWith('.css')) return {}
        if (request.startsWith('@/')) return load('src/' + request.slice(2) + '.ts')
        if (request.startsWith('.')) return load(path.resolve(path.dirname(filename), request) + '.ts')
        throw new Error('Unexpected import: ' + request)
      }
    })
    vm.runInContext(compileTypeScript(source, filename), context, { filename })
    const result = names.length ? context.exposed : module.exports
    if (!names.length) cache.set(filename, result)
    return result
  }
  return { load }
}
export type ScriptRuntimeFactory = typeof createScriptRuntime
export type ScriptCompiler = typeof compileTypeScript
export type SourceReader = typeof readSource
module.exports = { createScriptRuntime, compileTypeScript, readSource, resolveSourcePath }
