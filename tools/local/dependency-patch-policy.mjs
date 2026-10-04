// Exact local remediations; these are not unpatched advisory exceptions.
const policies = {
  "GHSA-ch52-4w7c-c8xp": {
    moduleName: "http-cache-semantics",
    severity: "high",
    vulnerableVersions: "<=4.2.0",
    patchedVersions: ">=4.2.1",
    patchSha256: "f64e8e5cfcb3deaad6c544854b1919e80115f1054d83c48d8fe2895686fec1ff",
    files: {
      "index.js": "fc85b2cf19c3d4bfefb8f55f3f20d5efe22075ef2ef802118da77343c0fe7cf3",
    },
    findings: [
      {
        version: "4.2.0",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>electron-builder>app-builder-lib>@electron/get>got>cacheable-request>http-cache-semantics",
      },
      {
        version: "4.2.0",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>electron-builder>dmg-builder>app-builder-lib>@electron/get>got>cacheable-request>http-cache-semantics",
      },
    ],
  },
  "GHSA-vfj7-8cjw-p6xm": {
    moduleName: "braces",
    severity: "high",
    vulnerableVersions: "<=3.0.3",
    patchedVersions: ">=3.0.4",
    patchSha256: "8b33a51c3e479bf6a452e56af086fabf2f2d9c8de3cb4796b6b3bf3129e5ac98",
    files: {
      "index.js": "332ea07c7b006361aad12aa994ca75dc1db8e8382b884909e2f38f10b85c88a4",
      "lib/compile.js": "94750740b7682ac1deab153756cf1c91b116e4c75ad864bc88ba9f56c28d1cdc",
      "lib/constants.js": "fc3db282b8a5b8b8a55cda2e85ba05f0c49da138edc76227454d3f3cbc76d5fb",
      "lib/expand.js": "c4e617daae8d27ad61204c512029392fe2c4732c959df8bab73afe1c1bb9e598",
      "lib/parse.js": "960455ca69f4734265dcd988a2aa572c85ce11635a60b653db0441e8646e08fd",
      "lib/stringify.js": "cd8dbdad44fd24d6d89913ebafe03c0610f158be730ecc1f02f3b5d17e14c392",
    },
    findings: [
      {
        version: "3.0.3",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>@electron-toolkit/eslint-config-ts>@typescript-eslint/eslint-plugin>@typescript-eslint/parser>@typescript-eslint/typescript-estree>globby>fast-glob>micromatch>braces",
      },
      {
        version: "3.0.3",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>@electron-toolkit/eslint-config-ts>@typescript-eslint/eslint-plugin>@typescript-eslint/type-utils>@typescript-eslint/typescript-estree>globby>fast-glob>micromatch>braces",
      },
      {
        version: "3.0.3",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>@electron-toolkit/eslint-config-ts>@typescript-eslint/eslint-plugin>@typescript-eslint/type-utils>@typescript-eslint/utils>@typescript-eslint/typescript-estree>globby>fast-glob>micromatch>braces",
      },
      {
        version: "3.0.3",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>@electron-toolkit/eslint-config-ts>@typescript-eslint/eslint-plugin>@typescript-eslint/utils>@typescript-eslint/typescript-estree>globby>fast-glob>micromatch>braces",
      },
      {
        version: "3.0.3",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>@electron-toolkit/eslint-config-ts>@typescript-eslint/parser>@typescript-eslint/typescript-estree>globby>fast-glob>micromatch>braces",
      },
      {
        version: "3.0.3",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>@typescript-eslint/eslint-plugin>@typescript-eslint/parser>@typescript-eslint/typescript-estree>globby>fast-glob>micromatch>braces",
      },
      {
        version: "3.0.3",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>@typescript-eslint/eslint-plugin>@typescript-eslint/type-utils>@typescript-eslint/typescript-estree>globby>fast-glob>micromatch>braces",
      },
      {
        version: "3.0.3",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>@typescript-eslint/eslint-plugin>@typescript-eslint/type-utils>@typescript-eslint/utils>@typescript-eslint/typescript-estree>globby>fast-glob>micromatch>braces",
      },
      {
        version: "3.0.3",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>@typescript-eslint/eslint-plugin>@typescript-eslint/utils>@typescript-eslint/typescript-estree>globby>fast-glob>micromatch>braces",
      },
      {
        version: "3.0.3",
        dev: true,
        optional: false,
        bundled: false,
        path: ".>@typescript-eslint/parser>@typescript-eslint/typescript-estree>globby>fast-glob>micromatch>braces",
      },
    ],
  },
};

export const DEPENDENCY_AUDIT_PATCHES = Object.freeze(
  Object.fromEntries(
    Object.entries(policies).map(([id, policy]) => [
      id,
      Object.freeze({
        ...policy,
        files: Object.freeze(policy.files),
        findings: Object.freeze(policy.findings.map((finding) => Object.freeze(finding))),
      }),
    ]),
  ),
);
