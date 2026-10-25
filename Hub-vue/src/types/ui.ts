import type { ComputedRef, Ref } from 'vue'
export interface FormContext {
  errors: Ref<Record<string, string>>
  disabled: ComputedRef<boolean>
  register: (field: string) => unknown
  unregister: (field: string) => void
  validateField: (field?: string) => Promise<void>
}
export interface FieldContext {
  id: string
  error: ComputedRef<string>
  validate: () => Promise<void> | undefined
}

export interface FormHandle {
  validate: () => Promise<boolean>
  clearValidate: (field?: string) => void
}

export interface ValidationRule {
  required?: boolean
  message?: string
  trigger?: string
  pattern?: RegExp
  type?: string
  validator?: (rule: ValidationRule, value: unknown, callback: (error?: Error) => void) => void | Promise<void>
}

export type FormRules = Record<string, ValidationRule[]>

export interface SelectOption<T = string | number | boolean> {
  value: T
  label: string
  disabled?: boolean
}
