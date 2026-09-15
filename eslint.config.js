import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['docs/**', '_out/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  stylistic.configs.customize({ indent: 2, quotes: 'single', semi: false, jsx: false }),
  {
    rules: {
      'curly': ['error', 'multi-or-nest', 'consistent'],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
)
