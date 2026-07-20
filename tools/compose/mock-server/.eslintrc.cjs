// mock-server 是 CommonJS 的一次性 spike 服务（无 package.json type:module，
// 由 Dockerfile 直接 node server.js 启动），require 是其正当写法。
// 仅在本目录关闭该规则，不影响仓库其余部分。
module.exports = {
  rules: {
    "@typescript-eslint/no-var-requires": "off",
  },
};
