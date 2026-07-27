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
  env: {
    browser: true,
  },
  overrides: [
    {
      files: ["src/host/desktop-ports.ts"],
      rules: {
        "max-lines": maxLines(671),
      },
    },
    {
      files: ["src/auth/HttpAuthClient.ts"],
      rules: {
        "max-lines": maxLines(534),
      },
    },
    {
      files: ["src/pages/ReceivePage.tsx"],
      rules: {
        "max-lines": maxLines(411),
      },
    },
  ],
};
