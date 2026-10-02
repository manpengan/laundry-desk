/**
 * Technician-only direct-port printer diagnostics. Collapsed by default: store
 * staff never need it, installers find the exact commands in one place.
 */

/** Env var operators set for CLI / Edge USB path (documented name). */
export const PRINTER_PATH_ENV_NAME = "LAUNDRY_PRINTER_PATH";

export function PrinterSupportPanel() {
  return (
    <details
      className="ld-settings-printer-smoke ld-settings-section lg-card"
      data-testid="printer-smoke-section"
      aria-label="技术支持：直连打印机诊断"
    >
      <summary className="ld-settings-printer-smoke__title">
        技术支持：串口 / USB 直连打印机诊断（仅限装机与维修人员）
      </summary>
      <p className="ld-settings-printer-smoke__hint">
        {"日常收银无需操作。仅当需要绕过系统打印队列、直接测试串口或 USB 小票机时使用；"}
        {"Windows 端口写法如 "}
        <code className="ld-settings-printer-smoke__code">\\.\COM3</code>、
        <code className="ld-settings-printer-smoke__code">\\.\LPT1</code>、
        <code className="ld-settings-printer-smoke__code">\\.\USB001</code>。
      </p>
      <div className="ld-settings-printer-smoke__static" data-testid="printer-smoke-static">
        <p className="ld-settings-printer-smoke__static-lead">
          出于安全考虑，柜台界面不直接访问打印端口。请在维护电脑的终端中先校验配置，再执行实物测试：
        </p>
        <pre className="ld-settings-printer-smoke__cmd" data-testid="printer-smoke-cli-hint">
          {`$env:${PRINTER_PATH_ENV_NAME} = '\\\\.\\COM3'\npnpm --filter @laundry/edge-agent printer-smoke -- --validate\npnpm --filter @laundry/edge-agent printer-smoke`}
        </pre>
        <p className="ld-settings-printer-smoke__static-foot">
          完整步骤见维护手册《Windows 打印机冒烟检查》。
        </p>
      </div>
    </details>
  );
}
