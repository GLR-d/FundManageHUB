// Shared route scenario fixtures.
import type { TestDouble } from './testTypes.cts'
const { path, fixture } = require('./runtime.cts')

function routeFixture(options: TestDouble = {}) {
  const VueRouter = require('vue-router')
  const reloads: TestDouble[] = []
  const reloadMethods: TestDouble[] = []
  const hashReplacements: TestDouble[] = []
  const errors: TestDouble[] = []
  const location = {
    href: options.href || 'http://127.0.0.1:7070/fund',
    assign: (href: TestDouble) => { reloadMethods.push('assign'); reloads.push(href); options.reload?.(href) },
    reload: () => { reloadMethods.push('reload'); reloads.push(location.href); options.reload?.(location.href) }
  }
  const context = fixture({ 'vue-router': { ...VueRouter, createWebHistory: () => VueRouter.createMemoryHistory() } }, undefined, {
    window: { location, history: { state: { position: 3 }, replaceState: (state: TestDouble, title: TestDouble, href: TestDouble) => { location.href = href; hashReplacements.push({ state, href }) } } },
    console: { ...console, error: (error: TestDouble) => errors.push(error) }
  })
  const auth = context.load('src/stores/auth.ts')
  auth.setLoginUser({ id: 'A', token: 'example-a' })
  const { default: router, routeRecovery } = context.load('src/router/index.ts')
  router.getRoutes().forEach((route: TestDouble) => { if (route.components) route.components.default = { render: () => null } })
  return { ...context, auth, router, recovery: routeRecovery, reloads, reloadMethods, hashReplacements, errors, record: (routePath: TestDouble) => router.getRoutes().find((route: TestDouble) => route.path === routePath) }
}

module.exports = { routeFixture }
