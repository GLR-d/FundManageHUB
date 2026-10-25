import type { FormRules } from '@/types/ui'

import { errorDetails } from './errors'
// 只校验当前表单中实际显示的字段，保留业务层的自定义校验规则。
export const validateFields = async (model: Record<string, unknown>, rules: FormRules, fields = Object.keys(rules || {})) => {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = model?.[field];
    for (const rule of rules?.[field] || []) {
      const empty = value === '' || value === null || value === undefined || typeof value === 'string' && !value.trim();
      let message = '';
      if (rule.required && empty) message = rule.message || '请填写此项';else if (!empty && rule.pattern && !rule.pattern.test(String(value))) message = rule.message || '格式不正确';else if (!empty && rule.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) message = rule.message || '请输入有效邮箱';
      const validator = rule.validator;
      if (!message && validator) {
        try {
          await new Promise<void>((resolve, reject) => {
            const result = validator(rule, value, error => error ? reject(error) : resolve());
            if (result?.then) result.then(resolve, reject);
          });
        } catch (error) {
          message = errorDetails(error).message || '格式不正确';
        }
      }
      if (message) {
        errors[field] = message;
        break;
      }
    }
  }
  return errors;
};
