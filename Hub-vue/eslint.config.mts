import { basename } from 'node:path'
import type { Rule } from 'eslint'
import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'
import globals from 'globals'
const camelCaseComponentFileName: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { camelCase: '组件文件名请使用小驼峰，例如 updatePassword.vue。' }
  },
  create: context => ({
    Program(node) {
      const name = basename(context.filename, '.vue')
      if (name !== '404' && !/^[a-z][a-zA-Z0-9]*$/.test(name)) context.report({ node, messageId: 'camelCase' })
    }
  })
}

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['src/**/*.{ts,vue}', '*.mts', 'scripts/**/*.cts', 'tests/**/*.cts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] }
  },
  { files: ['scripts/**/*.cts', 'tests/**/*.cts'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
  { files: ['tests/**/*.cts'], rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-vars': 'off' } },
  {
    files: ['src/**/*.vue'],
    plugins: { project: { rules: { 'component-file-name': camelCaseComponentFileName } } },
    languageOptions: { parser: vueParser, parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] } },
    rules: {
      'project/component-file-name': 'error',
      'vue/multi-word-component-names': 'off',
      'vue/no-undef-properties': 'error',
      'vue/no-undef-components': ['error', { ignorePatterns: ['^router-'] }]
    }
  }
)
