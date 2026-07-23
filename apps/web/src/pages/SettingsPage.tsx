/**
 * Settings surface — M1 demo: R5 platform.settings.set with step-up PIN resume.
 * M2: 打印机冒烟 section when Edge preload exposes edgeBridge.printerSmoke.
 */

import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useMemo, useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { AccessSession } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";

export type SettingsPageProps = {
  session: AccessSession;
  authClient: AuthClient;
  commandClient: CommandPort;
  /**
   * Optional override for Edge bridge probe (tests / non-window hosts).
   * When omitted, reads `window.edgeBridge?.printerSmoke` if present.
   */
  edgePrinterSmoke?: (() => Promise<unknown>) | null | undefined;
};

const SETTINGS_KEY = "pricing.min_order_cents";

/** Env var operators set for CLI / Edge USB path (documented name). */
export const PRINTER_PATH_ENV_NAME = "LAUNDRY_PRINTER_PATH";

export type PrinterSmokeView = Readonly<{
  ok: boolean;
  path: string | null;
  kind: string;
  message: string;
  bytes_written?: number;
}>;

/** Parse IPC / CLI JSON shape without trusting extra fields. */
export function parsePrinterSmokeResult(raw: unknown): PrinterSmokeView | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.ok !== "boolean") return null;
  if (!(obj.path === null || typeof obj.path === "string")) return null;
  if (typeof obj.kind !== "string" || obj.kind.length === 0) return null;
  if (typeof obj.message !== "string" || obj.message.length === 0) return null;
  const bytes =
    typeof obj.bytes_written === "number" && Number.isFinite(obj.bytes_written)
      ? obj.bytes_written
      : undefined;
  return Object.freeze({
    ok: obj.ok,
    path: obj.path,
    kind: obj.kind,
    message: obj.message,
    ...(bytes !== undefined ? { bytes_written: bytes } : {}),
  });
}

type EdgeBridgeWindow = {
  edgeBridge?: {
    printerSmoke?: () => Promise<unknown>;
  };
};

/** Resolve Edge preload printerSmoke when running inside edge-agent shell. */
export function resolveEdgePrinterSmoke(
  override?: (() => Promise<unknown>) | null | undefined,
  win: EdgeBridgeWindow | undefined = typeof globalThis !== "undefined"
    ? (globalThis as EdgeBridgeWindow)
    : undefined,
): (() => Promise<unknown>) | null {
  if (override === null) return null;
  if (typeof override === "function") return override;
  const fn = win?.edgeBridge?.printerSmoke;
  return typeof fn === "function" ? fn.bind(win?.edgeBridge) : null;
}

export function SettingsPage({
  session,
  authClient,
  commandClient,
  edgePrinterSmoke: edgePrinterSmokeProp,
}: SettingsPageProps) {
  const toast = useToast();
  const [centsText, setCentsText] = useState("1200");
  const [busy, setBusy] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [smokeBusy, setSmokeBusy] = useState(false);
  const [smokeResult, setSmokeResult] = useState<PrinterSmokeView | null>(null);

  const printerSmokeFn = useMemo(
    () => resolveEdgePrinterSmoke(edgePrinterSmokeProp),
    [edgePrinterSmokeProp],
  );
  const hasPrinterSmoke = printerSmokeFn !== null;

  const finishConfirm = useCallback(
    async (confirmRef: string, valueJson: string) => {
      const second = await commandClient.execute("platform.settings.set", {}, { confirmRef });
      if (!second.ok) {
        toast.push(second.error.message ?? second.error.code, "error");
        return;
      }
      setLastSaved(valueJson);
      toast.push("设置已保存（复核通过）", "success");
    },
    [commandClient, toast],
  );

  const onSave = useCallback(async () => {
    const trimmed = centsText.trim();
    if (!/^\d+$/u.test(trimmed)) {
      toast.push("请输入整数分（如 1200）", "error");
      return;
    }
    setBusy(true);
    try {
      const first = await commandClient.execute("platform.settings.set", {
        entries: [{ key: SETTINGS_KEY, value_json: trimmed }],
      });
      if (first.ok) {
        setLastSaved(trimmed);
        toast.push("设置已保存", "success");
        return;
      }
      if (isStepUpRequired(first)) {
        setPendingRef(first.error.detail.confirm_ref);
        setPendingValue(trimmed);
        return;
      }
      toast.push(first.error.message ?? first.error.code, "error");
    } finally {
      setBusy(false);
    }
  }, [centsText, commandClient, toast]);

  const onPrinterSmoke = useCallback(async () => {
    if (printerSmokeFn === null) return;
    setSmokeBusy(true);
    try {
      const raw = await printerSmokeFn();
      const parsed = parsePrinterSmokeResult(raw);
      if (parsed === null) {
        toast.push("打印机冒烟返回格式无效", "error");
        setSmokeResult(null);
        return;
      }
      setSmokeResult(parsed);
      toast.push(
        parsed.ok ? `冒烟 ok · ${parsed.kind}` : `冒烟失败 · ${parsed.kind}`,
        parsed.ok ? "success" : "error",
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.push(message || "打印机冒烟失败", "error");
    } finally {
      setSmokeBusy(false);
    }
  }, [printerSmokeFn, toast]);

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">设置</h1>
      <p className="ld-shell-main__hint">
        R5「最低消费」写入需现场 PIN 复核（A5/ADR-05：不可自核，不切换当前员工）。
      </p>
      <div className="ld-settings-form">
        <Input
          name="min-order-cents"
          label="最低消费（分）"
          inputMode="numeric"
          value={centsText}
          onChange={(event) => setCentsText(event.target.value)}
          hint="示例：1200 表示 ¥12.00；整数分，零浮点"
          disabled={busy}
        />
        <div className="ld-settings-form__actions">
          <Button variant="primary" type="button" onClick={() => void onSave()} disabled={busy}>
            {busy ? "提交中…" : "保存（可能需复核）"}
          </Button>
        </div>
        {lastSaved !== null ? (
          <p className="ld-settings-form__saved" role="status">
            当前已保存：{lastSaved} 分
          </p>
        ) : null}
      </div>

      <section
        className="ld-settings-printer-smoke"
        data-testid="printer-smoke-section"
        aria-label="打印机冒烟"
      >
        <h2 className="ld-settings-printer-smoke__title">打印机冒烟</h2>
        <p className="ld-settings-printer-smoke__hint">
          验证 Edge 打印机 path（env{" "}
          <code className="ld-settings-printer-smoke__code">{PRINTER_PATH_ENV_NAME}</code>
          ）。接受 <code className="ld-settings-printer-smoke__code">\\.\COM3</code>、
          <code className="ld-settings-printer-smoke__code">\\.\USB001</code>、文件重定向；无硬件时
          mock 亦返回 ok。
        </p>
        {hasPrinterSmoke ? (
          <div className="ld-settings-printer-smoke__actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => void onPrinterSmoke()}
              disabled={smokeBusy}
              data-testid="printer-smoke-run"
            >
              {smokeBusy ? "探测中…" : "运行 path 冒烟"}
            </Button>
          </div>
        ) : (
          <div className="ld-settings-printer-smoke__static" data-testid="printer-smoke-static">
            <p className="ld-settings-printer-smoke__static-lead">
              当前不在 Edge 壳内（无{" "}
              <code className="ld-settings-printer-smoke__code">edgeBridge.printerSmoke</code>
              ）。请在装机机 PowerShell / 终端执行：
            </p>
            <pre className="ld-settings-printer-smoke__cmd" data-testid="printer-smoke-cli-hint">
              {`$env:${PRINTER_PATH_ENV_NAME} = '\\\\.\\COM3'\npnpm --filter @laundry/edge-agent printer-smoke`}
            </pre>
            <p className="ld-settings-printer-smoke__static-foot">
              详见{" "}
              <code className="ld-settings-printer-smoke__code">
                apps/edge-agent/docs/printer-smoke-windows.md
              </code>
              。
            </p>
          </div>
        )}
        {smokeResult !== null ? (
          <dl className="ld-settings-printer-smoke__result" data-testid="printer-smoke-result">
            <div>
              <dt>kind</dt>
              <dd data-testid="printer-smoke-kind">{smokeResult.kind}</dd>
            </div>
            <div>
              <dt>message</dt>
              <dd data-testid="printer-smoke-message">{smokeResult.message}</dd>
            </div>
            <div>
              <dt>bytes_written</dt>
              <dd data-testid="printer-smoke-bytes">
                {smokeResult.bytes_written !== undefined ? String(smokeResult.bytes_written) : "—"}
              </dd>
            </div>
            <div>
              <dt>path</dt>
              <dd data-testid="printer-smoke-path">
                {smokeResult.path !== null ? smokeResult.path : "—"}
              </dd>
            </div>
            <div>
              <dt>ok</dt>
              <dd data-testid="printer-smoke-ok">{smokeResult.ok ? "true" : "false"}</dd>
            </div>
          </dl>
        ) : null}
      </section>

      <StepUpConfirmDialog
        open={pendingRef !== null}
        onClose={() => {
          setPendingRef(null);
          setPendingValue(null);
        }}
        authClient={authClient}
        confirmRef={pendingRef ?? ""}
        currentStaffId={session.session.staff_id}
        commandLabel="修改最低消费"
        onApproved={() => {
          const ref = pendingRef;
          const value = pendingValue;
          setPendingRef(null);
          setPendingValue(null);
          if (ref !== null && value !== null) {
            void finishConfirm(ref, value);
          }
        }}
      />
    </main>
  );
}
