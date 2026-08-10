const maxLines = (max) => [
  "error",
  {
    max,
    skipBlankLines: false,
    skipComments: false,
  },
];

module.exports = {
  root: true,
  extends: ["@electron-toolkit/eslint-config-ts", "@electron-toolkit/eslint-config-prettier"],
  ignorePatterns: [
    "dist/",
    "out/",
    "node_modules/",
    "*.config.js",
    "*.config.cjs",
    "*.config.mjs",
    "*.tsbuildinfo",
  ],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/explicit-function-return-type": "off",
  },
  overrides: [
    {
      files: ["tools/cloud/**/*.mjs", "apps/web/e2e-cloud/**/*.mjs"],
      env: {
        es2021: true,
        node: true,
      },
      rules: {
        "max-lines": maxLines(400),
        "no-undef": "error",
      },
    },
    {
      files: [
        "tools/cloud/**/*.test.mjs",
        "tools/cloud/**/*.spec.mjs",
        "tools/cloud/**/*.test-support.mjs",
        "tools/cloud/**/test/**/*.mjs",
        "tools/cloud/**/tests/**/*.mjs",
        "tools/cloud/**/__tests__/**/*.mjs",
      ],
      rules: {
        "max-lines": maxLines(800),
      },
    },
    {
      files: ["tools/local/**/*.mjs"],
      rules: {
        "max-lines": maxLines(400),
      },
    },
    {
      files: [
        "tools/local/**/*.test.mjs",
        "tools/local/**/*.spec.mjs",
        "tools/local/test/**/*.mjs",
        "tools/local/tests/**/*.mjs",
        "tools/local/__tests__/**/*.mjs",
        "tools/local/e2e/**/*.mjs",
        "tools/local/**/test/**/*.mjs",
        "tools/local/**/tests/**/*.mjs",
        "tools/local/**/__tests__/**/*.mjs",
        "tools/local/**/e2e/**/*.mjs",
      ],
      rules: {
        "max-lines": maxLines(800),
      },
    },
    {
      files: ["tests/foundation/**/*.mjs"],
      rules: {
        "max-lines": maxLines(800),
      },
    },
    {
      files: ["tools/local/config.mjs"],
      rules: {
        "max-lines": maxLines(474),
      },
    },
  ],
};
