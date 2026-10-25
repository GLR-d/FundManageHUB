// Shared isolated VM runtime and async utilities.
import type { TestDouble } from './testTypes.cts'
import type { ScriptRuntimeFactory } from './scriptRuntime.cts'
const { createScriptRuntime }: { createScriptRuntime: ScriptRuntimeFactory } = require('./scriptRuntime.cts')

const assert = require('node:assert/strict')

const fs: typeof import('node:fs') = require('node:fs')

const path: typeof import('node:path') = require('node:path')

const vm: typeof import('node:vm') = require('node:vm')

const { transformSync } = require('esbuild')

const vue = require('vue')

const axios = require('axios')

const root = path.resolve(__dirname, '../..')

const plain = (value: TestDouble) => JSON.parse(JSON.stringify(value))

const flushTasks = () => new Promise(resolve => setImmediate(resolve))

const deferred = () => {
  let resolve!: (value?: TestDouble) => void
  let reject!: (reason?: TestDouble) => void
  const promise = new Promise<TestDouble>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture(overrides: TestDouble = {}, sharedStorage?: Map<string, string>, environment: TestDouble = {}) {
  const storage = sharedStorage || new Map()
  const notices: TestDouble[] = []
  const redirects: TestDouble[] = []
  const unmounts: TestDouble[] = []
  const storageReads = { enumerations: 0 }
  const localStorage = {
    getItem: (key: TestDouble) => storage.get(key) ?? null,
    setItem: (key: TestDouble, value: TestDouble) => storage.set(key, value),
    removeItem: (key: TestDouble) => storage.delete(key),
    get length() { return storage.size },
    key: (index: TestDouble) => { storageReads.enumerations++; return [...storage.keys()][index] ?? null }
  }
  const router: TestDouble = {
    currentRoute: vue.ref({ path: '/fund', fullPath: '/fund', query: {} }),
    replace: async (target: TestDouble) => redirects.push(target)
  }
  const message = Object.fromEntries(['error', 'success', 'warning', 'info'].map(type => [type, (value: TestDouble) => notices.push({ type, text: typeof value === 'string' ? value : value.message })]))
  const mocks: Record<string, TestDouble> = {
    vue: { ...vue, onMounted: () => {}, onUnmounted: (fn: TestDouble) => { unmounts.push(fn) } },
    axios,
    '@/router': { default: router },
    './toasts': { toastMessages: message },
    '@/utils/confirm': { confirmDialog: {
      confirm: async () => true,
      alert: async (text: TestDouble, title: TestDouble, options: TestDouble) => { notices.push({ type: options.type, text }) }
    } },
    ...overrides
  }
  const runtime = createScriptRuntime({ mocks, globals: {
    console, localStorage, FormData, Blob, File, URL, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: { addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false }) },
    defineOptions: () => {}, defineExpose: () => {}, ...environment
  } })
  function load(file: string, names: string[] = [], props: TestDouble = {}, emit: (...args: TestDouble[]) => void = () => {}): TestDouble {
    return runtime.load(file, names, {
      defineProps: () => props,
      withDefaults: (value: TestDouble, defaults: TestDouble) => {
        const fallback = Object.fromEntries(Object.entries(defaults).map(([key, item]) => [key, typeof item === 'function' ? item() : item]))
        return new Proxy(value, { get: (target, key) => target[key] === undefined ? fallback[String(key)] : target[key] })
      },
      defineEmits: () => emit
    })
  }
  return { load, storage, storageReads, notices, redirects, router, mocks, unmount: () => unmounts.splice(0).forEach(fn => fn()) }
}

function form(model: TestDouble, rules: TestDouble, fields = () => Object.keys(rules)) {
  return {
    validate: async () => {
      const selected = Object.fromEntries(fields().map(key => [key, rules[key]]))
      const errors = await fixture().load('src/utils/formValidation.ts').validateFields(model.value, selected)
      return !Object.keys(errors).length
    },
    clearValidate: () => {}
  }
}

function controlledTimers() {
  let sequence = 0
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const set = (callback: () => void, delay = 0) => { const id = ++sequence; timers.set(id, { callback, delay }); return id }
  return {
    timers,
    environment: { setTimeout: set, clearTimeout: (id: number) => timers.delete(id) },
    fire: (id = timers.keys().next().value) => {
      assert.notEqual(id, undefined, 'expected a scheduled timer')
      const timer = timers.get(id!)
      if (!timer) throw new Error('scheduled timer was not found')
      timers.delete(id!)
      timer.callback()
    }
  }
}

module.exports = { assert, fs, path, vm, transformSync, vue, axios, root, plain, flushTasks, deferred, fixture, form, controlledTimers }
