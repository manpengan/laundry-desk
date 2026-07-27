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
      files: ["src/desktop/http-transport.ts"],
      rules: {
        "max-lines": maxLines(799),
      },
    },
    {
      files: ["scripts/sync-spa.mjs"],
      rules: {
        "max-lines": maxLines(687),
      },
    },
  ],
};
