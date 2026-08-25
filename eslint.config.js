import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles = ['**/*.{js,mjs,cjs,ts,tsx}'];
const testFiles = ['**/{__tests__,tests}/**/*.{js,mjs,cjs,ts,tsx}', '**/*.{test,spec}.{js,mjs,cjs,ts,tsx}'];
const rendererFiles = ['desktop/src/renderer/**/*.{ts,tsx}', 'desktop/src/shared/**/*.{ts,tsx}'];
const docsFiles = ['docs/src/**/*.{js,mjs,ts,tsx}', 'docs/vite.config.js'];
const productionTsFiles = ['src/**/*.{ts,tsx}', 'desktop/src/**/*.{ts,tsx}'];
const oldMetadataDirectories = [
  ['.', 'a', 'mux'].join(''),
  ['.', 'a', 'u', 'm', 'x'].join(''),
];
const nodeFiles = [
  '*.config.{js,mjs,cjs}',
  'scripts/**/*.{js,mjs,cjs,ts}',
  'src/**/*.{ts,tsx}',
  'desktop/scripts/**/*.{js,mjs,cjs,ts}',
  'desktop/src/main/**/*.{ts,tsx}',
  'desktop/src/shared/**/*.{ts,tsx}',
  'desktop/*.config.{js,mjs,cjs,ts}',
  'docs/worker/**/*.{ts,tsx}',
  'docs/vite.config.js',
];

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    ...oldMetadataDirectories.map((directory) => `**/${directory}/**`),
    '**/.muxbase/**',
    '**/.claude/**',
    '**/dist/**',
    '**/out/**',
    '**/release/**',
    '**/coverage/**',
    '**/.vite/**',
    '**/.turbo/**',
    'src/utils/generated-agents-doc.ts',
  ]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: sourceFiles,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.es2022,
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-case-declarations': 'off',
      'no-control-regex': 'off',
      'no-useless-catch': 'off',
      'no-useless-escape': 'off',
      'no-unused-vars': 'off',
      'prefer-const': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: nodeFiles,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: rendererFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: docsFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: testFiles,
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
  {
    files: productionTsFiles,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['desktop/src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    files: ['desktop/src/**/*.{ts,tsx}'],
    ignores: [
      'desktop/src/main/services/MuxBaseBridge.ts',
      'desktop/src/main/services/SupportBundleService.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "MemberExpression[property.name='agentStatus']",
        message: 'Raw pane.agentStatus reads are banned outside the reviewed legacy-fallback allowlist — use the PaneActivity policy module (desktop/src/shared/pane-activity.ts) instead. If this file genuinely needs a fallback, add it to the allowlist in eslint.config.js with justification.',
      }],
    },
  },
  {
    files: rendererFiles,
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{
          name: 'muxbase',
          allowTypeImports: true,
          message: 'muxbase is externalized in the renderer build — import types only.',
        }],
        patterns: [{
          group: ['muxbase/*', '!muxbase/pane-name', '!muxbase/pane-terminal-profile'],
          allowTypeImports: true,
          message: 'muxbase/* is externalized in the renderer build — import types only.',
        }],
      }],
    },
  },
  {
    files: ['desktop/src/renderer/**/*.tsx'],
    plugins: {
      'jsx-a11y': jsxA11y,
    },
    rules: {
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',
    },
  },
]);
