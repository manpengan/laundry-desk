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
  extends: ["../config/eslint/base.cjs"],
  overrides: [
    {
      files: ["src/auth/pin.ts"],
      rules: {
        "max-lines": maxLines(549),
      },
    },
    {
      files: ["src/index.ts"],
      rules: {
        "max-lines": maxLines(533),
      },
    },
  ],
};
