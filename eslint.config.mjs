import js from '@eslint/js';

/**
 * Deliberately narrow: pipeline, tests, and the browser islands. TypeScript is
 * covered by `npm run typecheck` (astro check), not double-linted here.
 */
export default [
  { ignores: ['dist/', 'node_modules/', '.astro/', 'data/'] },
  {
    ...js.configs.recommended,
    files: ['pipeline/**/*.mjs', 'tests/**/*.mjs', 'src/lib/model.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', fetch: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', AbortController: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
      },
    },
    rules: {
      // `const { collected_at, ...rest } = r` is the discard idiom, not a leak.
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    ...js.configs.recommended,
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', location: 'readonly',
        history: 'readonly', matchMedia: 'readonly', URLSearchParams: 'readonly',
        fetch: 'readonly', console: 'readonly',
      },
    },
    // The islands are old-school on purpose: no build step, runs as-is.
    rules: { 'no-var': 'off' },
  },
];
