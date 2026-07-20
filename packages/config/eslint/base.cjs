module.exports = {
  extends: ["@electron-toolkit/eslint-config-ts", "@electron-toolkit/eslint-config-prettier"],
  ignorePatterns: ["dist/", "node_modules/", "*.tsbuildinfo"],
  rules: {
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-explicit-any": "error",
  },
};
