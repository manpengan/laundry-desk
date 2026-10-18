# 已核实事实

- Windows 通过严格 winbox wrapper 访问，当前原服务为 localhost:8787；所有变更前后保留环境快照。
- 旧验收脚本保存在 Windows C:\dev\ld-release-20261017-pilot6；本地 Claude scratchpad 中有派生脚本与 rebind.mjs。使用副本，保留旧证据。
- 补充专项：离线重启不恢复会话时实际拒写 AUTHENTICATION_FAILED，旧断言只接受 RESOURCE_UNAVAILABLE；尚未到恰好一次重放检查。
- 新增显式只读恢复后的查询断言暴露产品组合缺陷：service 已恢复只读会话，HTTP transport 无令牌，查询本地 AUTHENTICATION_FAILED 被当作服务端撤权。修复必须区分缓存恢复与在线认证，并保护会话切换并发。
- 经营专项：客户历史读取部分超过 5 秒，管理员复核未完成；需测量后决定改产品或修测试。
- 升级回退后备份按设计关闭，旧普通权限预检错误要求自动备份任务存在；需按实际状态验证关闭提醒、再授权开启及业务。
