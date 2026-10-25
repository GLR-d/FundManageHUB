// Shared fund scenario fixtures.
import type { TestDouble } from './testTypes.cts'
const { path, vue, plain, flushTasks, fixture, form, controlledTimers } = require('./runtime.cts')

function fundPage(items = {}, hasMore = false) {
  return { items, hasMore, nextCursor: hasMore ? Object.keys(items).sort().at(0) : null }
}

const fundDays = (first: TestDouble, last = 1) => Object.fromEntries(Array.from({ length: first - last + 1 }, (_, index) => {
  const day = '2026-10-' + String(first - index).padStart(2, '0')
  return [day, [{ id: first - index, remark: 'rent', type: '1', amount: '1.00', time: day + ' 12:00' }]]
}))

const pageOfFunds = (data: TestDouble, params: TestDouble = {}) => {
  const days = Object.keys(data).sort().reverse().filter(day => !params.before || day < params.before)
  const visible = days.slice(0, params.days || 5)
  return fundPage(Object.fromEntries(visible.map(day => [day, data[day]])), days.length > visible.length)
}

function fundFixture(apis: TestDouble = {}, options: TestDouble = {}) {
  const sent: TestDouble[] = []
  let reads = 0
  const context = fixture({ '@/api/fund': {
    getFundapi: async () => { reads++; return { code: 1, data: fundPage() } },
    addFundapi: async (data: TestDouble) => { sent.push(plain(data)); return { code: 1 } },
    updateFundapi: async (data: TestDouble) => { sent.push(plain(data)); return { code: 1 } },
    deleteFundapi: async () => ({ code: 1 }),
    searchFundsapi: async (params: TestDouble) => { sent.push(plain(params)); return { code: 1, data: fundPage() } },
    ...apis
  }, '@/services/imageUpload': { uploadImage: () => {}, abortImageUpload: () => {} }, ...options.mocks }, undefined, options.environment || {})
  options.setup?.(context)
  const page = context.load('src/composables/useFundPage.ts').useFundPage()
  // Exercise the workflow's exported contract, independent of page-local variable names.
  const fund = { ...page.list, ...page.selection, ...page.editor, ...page.search, editRow: page.editRow, handleRowKeydown: page.handleRowKeydown }
  fund.formRef.value = form(fund.formData, fund.formRules)
  return { ...context, fund, sent, reads: () => reads }
}

function fundSearchFixture(apis: TestDouble = {}) {
  const timers = controlledTimers()
  let inputFocuses = 0
  let buttonFocuses = 0
  let popoverOpen = false
  const ownerDocument: TestDouble = { activeElement: null }
  const input = { focus: () => { inputFocuses++; ownerDocument.activeElement = input } }
  const button = { focus: () => { buttonFocuses++; ownerDocument.activeElement = button } }
  const f = fundFixture(apis, { environment: timers.environment })
  f.fund.searchShell.value = vue.markRaw({
    ownerDocument,
    contains: (element: TestDouble) => element === input || element === button,
    querySelector: () => popoverOpen ? {} : null
  })
  f.fund.searchFields.value = vue.markRaw({ querySelector: () => input })
  f.fund.searchToggle.value = vue.markRaw({ $el: button })
  return {
    ...f, timers, ownerDocument, input,
    inputFocuses: () => inputFocuses,
    buttonFocuses: () => buttonFocuses,
    setPopoverOpen: (opened: boolean) => { popoverOpen = opened }
  }
}

function categoryFundFixture(category: TestDouble, apis: TestDouble = {}) {
  const timers = controlledTimers()
  const mounted: TestDouble[] = []
  const unmounted: TestDouble[] = []
  const f = fundFixture(apis, {
    mocks: { vue: { ...vue, onMounted: (callback: TestDouble) => mounted.push(callback), onUnmounted: (callback: TestDouble) => unmounted.push(callback) } },
    environment: { ...timers.environment, IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} } },
    setup: (context: TestDouble) => {
      context.router.currentRoute.value = { path: '/fund', fullPath: '/fund', query: category === undefined ? { source: 'dashboard' } : { type: category, source: 'dashboard' }, hash: '#bills' }
      context.router.replace = async (target: TestDouble) => {
        context.redirects.push(plain(target))
        context.router.currentRoute.value = target
      }
    }
  })
  return { ...f, timers, mount: async () => { mounted.forEach(callback => callback()); await flushTasks() }, unmount: () => { unmounted.splice(0).forEach(callback => callback()); f.unmount() } }
}

module.exports = { fundPage, fundDays, pageOfFunds, fundFixture, fundSearchFixture, categoryFundFixture }
