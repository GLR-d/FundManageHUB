import 'axios'
import type { SessionSnapshot } from './account'
declare module 'axios' {
  interface AxiosRequestConfig {
    silentError?: boolean
    expectedSession?: SessionSnapshot
    _session?: SessionSnapshot
    _releaseRequest?: () => void
  }
}
