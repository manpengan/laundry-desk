# 顾客微信小程序

活动 V2 原生 WXML/WXSS 客户端，调用 Windows 本地服务中的专用顾客 API。
包含微信登录与手机号绑定、本人订单/衣物/收据、取送预约及地址、储值充值与付款、
券/次卡/积分消费、微信订阅提醒。后端以服务端身份、价格与支付核验为准。
不会部署 Cloud 环境，也不包含 AppSecret、商户私钥或自动支付流程。

## 构建与检查

仓库根执行：

```sh
pnpm --filter @laundry/contracts build
pnpm --filter @laundry/customer-miniapp build
pnpm --filter @laundry/customer-miniapp test
pnpm --filter @laundry/customer-miniapp lint
```

未设置公开配置时显示“门店暂未开通小程序服务”，不会访问测试服务或返回虚假业务成功。
正式配置用 `LAUNDRY_MINIAPP_API_ORIGIN` 指定已登记的 HTTPS request 合法域名，
`LAUNDRY_MINIAPP_APP_ID` 指定实际 AppID；两者均为公开标识，不是密钥。
重新构建后，用微信开发者工具打开本目录的 `dist/`，其中包含自足 `project.config.json`
和 `miniprogram/`。默认 `touristappid` 仅作未配置模板，不证明可真机预览。
`dev` 持续运行类型编译；修改页面后重新执行 `build` 更新原生包。

服务端 `/api/v2/miniapp/public` 提供门店显示名、AppID 和模板 ID。客户端将服务端 AppID、
付款 AppID 与微信当前 AppID 核对。生产前还需配置微信平台域名、隐私保护指引、手机号能力、
订阅模板、支付商户绑定和可达的受控 HTTPS 入口；本轮不创建云代理或暴露 Windows 端口。

## 行为约束

- `wx.login` 与首次绑定的手机号临时代码仅交服务端核验，不接受二维码传入服务地址、租户或身份。
- 顾客 token 仅在内存中保存；15 分钟失效。退出、卸载页面或认证失效会中止请求并清除顾客视图。
- 网络不确定时复用幂等键；付款记录由服务端保存并在重新登录后读回。未决付款先查询，不重复发起。
- `wx.requestPayment` 成功仅表示提交，必须服务端回查 `paid` 才显示已支付。
- 订阅只记录原生弹窗中逐项 `accept` 的固定模板；拒绝不影响订单查询。
- 预约按中国标准时间显示，明确支持 Shanghai/Taipei/Hong_Kong 时区，其它时区拒绝选时并提示联系门店。
- 测试夹具全为合成数据，不调用真实短信或支付。原生编译、模拟器、真机和渠道验收分别记录。

协议参考：[微信官方示例](https://github.com/wechat-miniprogram/miniprogram-demo)、
[官方 API 类型](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)。
详细边界见 [ADR-87](../../docs/adr/2026-10-03-adr-87-native-customer-miniapp.md)。
