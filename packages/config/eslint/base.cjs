const maxLines = (max) => [
  "error",
  {
    max,
    skipBlankLines: false,
    skipComments: false,
  },
];

module.exports = {
  extends: ["@electron-toolkit/eslint-config-ts", "@electron-toolkit/eslint-config-prettier"],
  ignorePatterns: ["dist/", "node_modules/", "*.tsbuildinfo"],
  rules: {
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-explicit-any": "error",
    "max-lines": maxLines(400),
  },
  overrides: [
    {
      files: [
        "**/*.test.*",
        "**/*.spec.*",
        "test/**",
        "tests/**",
        "**/test/**",
        "**/tests/**",
        "__tests__/**",
        "**/__tests__/**",
        "e2e/**",
        "**/e2e/**",
      ],
      rules: {
        "max-lines": maxLines(800),
      },
    },
  ],
};
