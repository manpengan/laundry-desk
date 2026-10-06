# 已验证事实与执行约束

- 原审查基线 dacc01b0，报告 11 项问题；66 分不是当前主线的重新评分。
- PR #230 合入 fetch 绑定、设置组件、金额单位及错误文案；#231 修复工作台账目字段权限。
- 修复前 ReceivePage 成功后保留表单且快捷键 canSubmit 仅判断 busy/policy；切页卸载组件丢失局部状态。
- 修复前顶部连接状态来自启动期 MockConnection；不能以启动时在线推定运行期健康或已同步。
- PR #232 对 ReceiveTicketResult 增加开单后扫码预付，实施需保留该能力并在其合入后处理交叉。
- 当前 Windows 原服务和原仓库属于既有工作，测试须使用本轮独立目录与明确身份。
- Windows SSH 默认 cmd.exe；复杂检查使用 UTF-16LE EncodedCommand；运行脚本抑制 PowerShell progress。
- 根 task_plan/progress/findings 是大量历史档案，本轮状态集中于本目录，不改写历史结论。

- 最终生产代码 9f66ee13 已在 Windows 原生安装环境通过主要业务闭环和真实请求丢响应重试；源码、app.asar、SPA 均已核对。
- CI 续修保留客户会员页面，只隔离员工开单与未采用重量；390px 分区标题按实际顶栏高度定位。
- 原生关窗按钮操作仍受锁屏影响而未完成，不能把健康断连/恢复或浏览器保护对话框通过记作该项通过。
