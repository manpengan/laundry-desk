module.exports = {
  root: true,
  extends: [
    "@electron-toolkit/eslint-config-ts",
    "@electron-toolkit/eslint-config-prettier",
  ],
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
};
