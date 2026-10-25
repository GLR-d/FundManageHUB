import type { EntityId } from './api'

export interface LoginUser {
  token: string
  id: EntityId
  email?: string
}

export interface UserProfile {
  id?: EntityId
  avatar?: string
  name?: string
  phone?: string
  email?: string
  email_verified?: boolean
}

export type ProfileField = 'profile' | 'phone'

export interface SessionSnapshot {
  version: number
  token: string | null
}
