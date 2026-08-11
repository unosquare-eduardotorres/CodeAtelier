import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '.claude/worktrees/**',
      '.agent-studio/**',
      '.opencode/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    }
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.e2e.ts',
      '**/test-harness.ts',
      '**/__tests__/**/*.ts'
    ],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    // Main-process source is bundled by electron-vite into a flat `out/main`.
    // A require() with a RELATIVE specifier is kept verbatim by the bundler and
    // then resolves against the bundle layout, not the source tree — so it
    // throws MODULE_NOT_FOUND at runtime in packaged builds while working fine
    // in dev. Several of these shipped inside silent try/catch blocks and
    // disabled notifications, workspace names, and the bug tracker for months.
    //
    // require() of BARE specifiers (native modules, optional deps) stays allowed —
    // those are externalised by the bundler and resolve correctly.
    // This is deliberately a separate rule from @typescript-eslint/no-require-imports
    // so the existing `eslint-disable` comments for that rule cannot suppress it.
    files: ['src/main/**/*.ts'],
    ignores: ['src/main/**/__tests__/**', 'src/main/**/*.test.ts', 'src/main/db/test-helpers.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value=/^[.]/]",
          message:
            'Relative require() does not survive electron-vite bundling and throws MODULE_NOT_FOUND in packaged builds. Use a static ESM import instead (or setter injection if there is a genuine cycle).'
        }
      ]
    }
  },
  eslintConfigPrettier
)
