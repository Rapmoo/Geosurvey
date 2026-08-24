'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      'storage/**',
      'coverage/**',
      'PWA/icons/**',
      '**/*.min.js',
    ],
  },

  // Backend: CommonJS, Node runtime
  {
    files: ['Backend/**/*.js'],
    ignores: ['Backend/__tests__/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      // Pre-existing issues — tracked as warnings so lint doesn't block
      // CI while these are cleaned up; tighten to 'error' once fixed.
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
      'no-useless-assignment': 'warn',
    },
  },

  // Backend tests: CommonJS + Jest
  {
    files: ['Backend/__tests__/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // PWA: native ES modules, browser runtime
  {
    files: ['PWA/**/*.js'],
    ignores: ['PWA/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Loaded globally via <script> tags rather than import,
        // so ESLint can't see where they come from.
        L: 'readonly', // Leaflet
        XLSX: 'readonly', // SheetJS (export)
        shpwrite: 'readonly', // Shapefile export
        VAPID_KEY: 'readonly', // injected at build/deploy time
        process: 'readonly', // env values injected at build/deploy time
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Pre-existing issues in the legacy monolith file — tracked as
      // warnings so lint doesn't block CI while these are cleaned up.
      'no-useless-escape': 'warn',
      'no-useless-assignment': 'warn',
    },
  },

  // Service worker: runs in its own global scope, not "browser"
  {
    files: ['PWA/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.serviceworker,
        firebase: 'readonly', // loaded via importScripts()
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
