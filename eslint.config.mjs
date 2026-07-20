import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

const sourceFiles = ["src/**/*.{js,jsx}"];
const testFiles = [
  "**/*.{test,spec}.{js,jsx,mjs,cjs}",
  "main/__tests__/**/*.js",
  "vitest.setup.js",
];

export default [
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "dist-react/**",
      "node_modules/**",
      "performance-results/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  {
    linterOptions: {
      // Legacy files contain no-console and dependency-array suppressions for
      // rules that this focused correctness gate does not enable. Do not turn
      // those historical comments into CI noise.
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-console": "off",
      // Control-character and cross-platform path regexes intentionally use
      // explicit escapes; these rules otherwise flag valid input guards.
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-extra-boolean-cast": "off",
      "no-useless-escape": "off",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
          // React is intentionally imported by older JSX modules even though
          // Vite's automatic JSX runtime no longer references the binding.
          varsIgnorePattern: "^(?:_|React$)",
        },
      ],
    },
  },
  {
    files: sourceFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      sourceType: "module",
    },
    plugins: reactHooks.configs["flat/recommended"][0].plugins,
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...reactHooks.configs["flat/recommended"][0].rules,
      // Existing playback/layout effects intentionally use stable object
      // members and revision tokens. Auditing those dependency arrays is a
      // separate behavioral change; rules-of-hooks and the remaining React
      // correctness rules stay enforced here.
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    files: sourceFiles,
    plugins: { react },
    rules: {
      // JSX identifiers are genuine variable uses even with the automatic JSX
      // runtime. Without this rule, no-unused-vars reports every imported
      // component as dead code.
      "react/jsx-uses-vars": "error",
    },
  },
  {
    files: [
      "main.js",
      "preload.js",
      "main/**/*.js",
      "scripts/**/*.{js,cjs}",
      "tests/**/*.cjs",
      "playwright.electron.config.cjs",
    ],
    languageOptions: {
      globals: globals.node,
      sourceType: "commonjs",
    },
  },
  {
    // These Playwright callbacks are serialized into Electron's renderer.
    files: ["scripts/performance/linux-soak.cjs"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: [
      "vite.config.js",
      "vitest.config.mjs",
      "eslint.config.mjs",
    ],
    languageOptions: {
      globals: globals.node,
      sourceType: "module",
    },
  },
  {
    files: testFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.vitest,
      },
      sourceType: "module",
    },
    rules: {
      // Mock factories deliberately invoke hook-shaped spies outside React;
      // production source remains checked by rules-of-hooks.
      "react-hooks/rules-of-hooks": "off",
    },
  },
];
