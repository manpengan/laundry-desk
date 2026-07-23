/**
 * 交班 / 日结签字 — shift.close (R3 confirm) + shift.get.
 *
 * R3: first hop returns POLICY_CONFIRMATION_REQUIRED; UI auto-resumes with confirm_ref
 * (self-confirm allowed). POLICY_STEP_UP_REQUIRED (optional manager path) uses
 * StepUpConfirmDialog when authClient + session are provided.
 */

import { Button, Input, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { AccessSession } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";

export type ShiftClosingView = Readonly<{
  shift_id: string;
  business_date: string;
  closed_at: number;
  order_count: number;
  payable_cents: number;
  paid_cents: number;
  payment_cents: number;
  signature_name?: string;
  note?: string | null;
}>;

export type ShiftClosePanelProps = {
  queryClient: QueryPort;
  commandClient: CommandPort;
  /** Bound business date (YYYY-MM-DD). */
  businessDate: string;
  /** Skip auto-load on mount (tests). */
  autoLoad?: boolean;
  /** Optional: enable manager step-up dialog for POLICY_STEP_UP_REQUIRED. */
  session?: AccessSession;
  authClient?: AuthClient;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Unwrap bus `{ execution, result }` or bare result. */
export function unwrapShiftResult(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if ("result" in data) return data.result;
  return data;
}

export function parseShiftClosing(value: unknown): ShiftClosingView | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  if (typeof value.shift_id !== "string") return null;
  if (typeof value.business_date !== "string") return null;
  const closed_at = asInt(value.closed_at);
  const order_count = asInt(value.order_count);
  const payable_cents = asInt(value.payable_cents);
  const paid_cents = asInt(value.paid_cents);
  const payment_cents = asInt(value.payment_cents);
  if (
    closed_at === null ||
    order_count === null ||
    payable_cents === null ||
    paid_cents === null ||
    payment_cents === null
  ) {
    return null;
  }
  return Object.freeze({
    shift_id: value.shift_id,
    business_date: value.business_date,
    closed_at,
    order_count,
    payable_cents,
    paid_cents,
    payment_cents,
    ...(typeof value.signature_name === "string" ? { signature_name: value.signature_name } : {}),
    ...(value.note === null || typeof value.note === "string" ? { note: value.note } : {}),
  });
}

function applyCloseResult(
  res: Awaited<ReturnType<CommandPort["execute"]>>,
  setClosing: (v: ShiftClosingView | null) => void,
  setLoaded: (v: boolean) => void,
  toast: ReturnType<typeof useToast>,
): boolean {
  if (!res.ok) {
    toast.push(res.error.message ?? res.error.code, "error");
    return false;
  }
  const parsed = parseShiftClosing(unwrapShiftResult(res.data));
  if (parsed === null) {
    toast.push("交班成功但结果无法解析", "error");
    return false;
  }
  setClosing(parsed);
  setLoaded(true);
  toast.push("交班已确认", "success");
  return true;
}

export function ShiftClosePanel({
  queryClient,
  commandClient,
  businessDate,
  autoLoad = true,
  session,
  authClient,
}: ShiftClosePanelProps) {
  const toast = useToast();
  const [signatureName, setSignatureName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState<ShiftClosingView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);

  const load = useCallback(async () => {
    const day = businessDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
      return;
    }
    setBusy(true);
    try {
      const res = await queryClient.execute<unknown>("shift.get", {
        business_date: day,
      });
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        setClosing(null);
        setLoaded(true);
        return;
      }
      const raw = unwrapShiftResult(res.data);
      if (raw === null) {
        setClosing(null);
        setLoaded(true);
        return;
      }
      const parsed = parseShiftClosing(raw);
      if (parsed === null) {
        toast.push("交班记录无法解析", "error");
        setClosing(null);
        setLoaded(true);
        return;
      }
      setClosing(parsed);
      setLoaded(true);
    } finally {
      setBusy(false);
    }
  }, [businessDate, queryClient, toast]);

  loadRef.current = load;

  useEffect(() => {
    if (!autoLoad) return;
    void loadRef.current();
  }, [autoLoad, businessDate]);

  const finishConfirm = useCallback(
    async (confirmRef: string) => {
      setBusy(true);
      try {
        const second = await commandClient.execute<unknown>("shift.close", {}, { confirmRef });
        applyCloseResult(second, setClosing, setLoaded, toast);
      } finally {
        setBusy(false);
      }
    },
    [commandClient, toast],
  );

  const onClose = useCallback(async () => {
    const day = businessDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
      toast.push("请先选择有效营业日", "error");
      return;
    }
    const name = signatureName.trim();
    if (name.length < 1 || name.length > 64) {
      toast.push("请输入签字人姓名（1–64 字）", "error");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, string> = {
        business_date: day,
        signature_name: name,
      };
      const noteText = note.trim();
      if (noteText.length > 0) {
        body.note = noteText;
      }
      const first = await commandClient.execute<unknown>("shift.close", body);
      if (first.ok) {
        applyCloseResult(first, setClosing, setLoaded, toast);
        return;
      }
      if (isStepUpRequired(first)) {
        const code = first.error.code;
        const ref = first.error.detail.confirm_ref;
        // R3 confirm card: self-confirm resume (button click is the confirmation).
        if (code === "POLICY_CONFIRMATION_REQUIRED") {
          const second = await commandClient.execute<unknown>(
            "shift.close",
            {},
            { confirmRef: ref },
          );
          applyCloseResult(second, setClosing, setLoaded, toast);
          return;
        }
        // Optional manager step-up path when auth is wired.
        if (
          code === "POLICY_STEP_UP_REQUIRED" &&
          authClient !== undefined &&
          session !== undefined
        ) {
          setPendingRef(ref);
          return;
        }
        toast.push(first.error.message ?? first.error.code, "error");
        return;
      }
      toast.push(first.error.message ?? first.error.code, "error");
    } finally {
      setBusy(false);
    }
  }, [authClient, businessDate, commandClient, note, session, signatureName, toast]);

  return (
    <section className="ld-shift-panel" data-testid="shift-close-panel" aria-label="交班日结">
      <h2 className="ld-shift-panel__title">交班 / 日结签字</h2>
      <p className="ld-shift-panel__hint">
        对营业日 {businessDate} 快照当日汇总并签字确认（R3 确认卡）。同日仅可交班一次。
      </p>

      {loaded && closing !== null ? (
        <div className="ld-shift-status" data-testid="shift-closed-status">
          <div className="ld-shift-status__badge">已交班</div>
          <div className="ld-shift-status__row">
            <span>签字人</span>
            <strong data-testid="shift-signature-name">{closing.signature_name ?? "—"}</strong>
          </div>
          <div className="ld-shift-status__row">
            <span>开单笔数</span>
            <strong data-testid="shift-order-count">{closing.order_count}</strong>
          </div>
          <div className="ld-shift-status__row">
            <span>应收</span>
            <MoneyText fen={closing.payable_cents} size="md" />
          </div>
          <div className="ld-shift-status__row">
            <span>已收</span>
            <MoneyText fen={closing.paid_cents} size="md" />
          </div>
          <div className="ld-shift-status__row">
            <span>收款流水</span>
            <MoneyText fen={closing.payment_cents} size="md" />
          </div>
          {closing.note ? (
            <div className="ld-shift-status__note" data-testid="shift-note">
              {closing.note}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="ld-shift-form">
          <Input
            name="shift-signature"
            label="签字人"
            value={signatureName}
            onChange={(event) => setSignatureName(event.target.value)}
            disabled={busy}
            placeholder="店员显示名"
            data-testid="shift-signature-input"
          />
          <Input
            name="shift-note"
            label="备注（可选）"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={busy}
            placeholder="班次说明"
            data-testid="shift-note-input"
          />
          <div className="ld-shift-form__actions">
            <Button
              variant="primary"
              type="button"
              onClick={() => void onClose()}
              disabled={busy}
              data-testid="shift-close-btn"
            >
              {busy ? "提交中…" : "交班确认"}
            </Button>
            <Button
              variant="secondary"
              type="button"
              onClick={() => void load()}
              disabled={busy}
              data-testid="shift-refresh-btn"
            >
              刷新状态
            </Button>
          </div>
        </div>
      )}

      {authClient !== undefined && session !== undefined ? (
        <StepUpConfirmDialog
          open={pendingRef !== null}
          onClose={() => setPendingRef(null)}
          authClient={authClient}
          confirmRef={pendingRef ?? ""}
          currentStaffId={session.session.staff_id}
          commandLabel="交班日结"
          onApproved={() => {
            const ref = pendingRef;
            setPendingRef(null);
            if (ref !== null) {
              void finishConfirm(ref);
            }
          }}
        />
      ) : null}
    </section>
  );
}
