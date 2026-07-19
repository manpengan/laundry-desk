# Windows 防火墙演练

## 步骤

1. 首次 `npm run wss` 监听 `127.0.0.1:17443`  
2. 观察是否弹出「Windows Defender 防火墙已阻止…」  
3. 若弹出：选「专用网络」允许，记录是否仍拦截 loopback  
4. 用管理员 PowerShell 查看规则：

```powershell
Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*node*' } | Format-List
Get-NetFirewallPortFilter | Where-Object { $_.LocalPort -eq 17443 }
```

5. 确认绑定是 `127.0.0.1` 而非 `0.0.0.0`（生产 Edge 必须 loopback-only，除非明确 LAN 调试）  
6. 企业机测试：第三方防火墙（360/火绒等）是否静默丢包  

## 记录

| 项 | 结果 |
|---|---|
| 首次弹窗 | 有 / 无 |
| loopback 是否被拦 | 是 / 否 |
| 需管理员 | 是 / 否 |
| 第三方安全软件 |  |

## 建议默认

- Edge Agent 只绑 `127.0.0.1`  
- 安装器可预加 **loopback 豁免** 说明，避免店员误点「取消」  
- 不在 M0 对公网开端口  
