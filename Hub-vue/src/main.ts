import { createApp } from 'vue'
import App from './app.vue'
import router from './router'
import { startSessionSync } from './stores/auth'
import { startPreferencesSync } from './stores/preferences'
import { isRouteLoadError } from './utils/routeRecovery'
import { startStyleRetrySupport } from './utils/styleRecovery'
const stopSessionSync = startSessionSync(user => {
  const route = router.currentRoute.value
  if (route.meta.requiresAuth) router.replace(user ? '/dashboard' : { path: '/login', query: { redirect: route.fullPath } }).catch(error => { if (!isRouteLoadError(error)) throw error })
})
const stopPreferencesSync = startPreferencesSync()
const stopStyleRetry = startStyleRetrySupport()
if (import.meta.hot) import.meta.hot.dispose(() => { stopSessionSync(); stopPreferencesSync(); stopStyleRetry() })
import './styles/ui.css'
createApp(App).use(router).mount('#app')
