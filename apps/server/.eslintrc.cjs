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
  extends: ["../../packages/config/eslint/base.cjs"],
  overrides: [
    {
      files: ["src/local/bootstrap.ts"],
      rules: {
        "max-lines": maxLines(795),
      },
    },
    {
      files: ["src/identity/pg-store.ts"],
      rules: {
        "max-lines": maxLines(773),
      },
    },
    {
      files: ["src/http/login-rate-limit.ts"],
      rules: {
        "max-lines": maxLines(632),
      },
    },
    {
      files: ["src/order/pg-order-store.ts"],
      rules: {
        "max-lines": maxLines(506),
      },
    },
    {
      files: ["src/identity/memory-store.ts"],
      rules: {
        "max-lines": maxLines(481),
      },
    },
    {
      files: ["src/local/create-runtime.ts"],
      rules: {
        "max-lines": maxLines(457),
      },
    },
    {
      files: ["src/identity/pg-pin-repo.ts"],
      rules: {
        "max-lines": maxLines(456),
      },
    },
    {
      files: ["src/identity/session.ts"],
      rules: {
        "max-lines": maxLines(418),
      },
    },
  ],
};
