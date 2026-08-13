import type { AiApprovalView } from "@laundry/contracts";
import { useEffect, useRef, useState } from "react";

import type { ApprovalPort } from "../ai/approval-port.js";

export type ApprovalCenterPageProps = Readonly<{
  approvalPort: ApprovalPort;
  currentStaffId: string;
}>;

const STATUS_LABELS: Readonly<Record<AiApprovalView["status"], string>> = Object.freeze({
  pending: "待审批",
  approved: "已批准，待执行",
  denied: "已驳回",
  expired: "已过期",
  consumed: "已执行",
});

function formatExpiry(epoch: number): string {
  return new Date(epoch * 1_000).toLocaleString("zh-CN", { hour12: false });
}

export function ApprovalCenterPage({ approvalPort, currentStaffId }: ApprovalCenterPageProps) {
  const [scope, setScope] = useState<"pending" | "history">("pending");
  const [items, setItems] = useState<readonly AiApprovalView[]>(Object.freeze([]));
  const [selected, setSelected] = useState<AiApprovalView | null>(null);
  const [denialReason, setDenialReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const listAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const actionAbort = useRef<AbortController | null>(null);
  const actionGeneration = useRef(0);

  const load = (nextScope: "pending" | "history"): void => {
    const generation = ++listGeneration.current;
    detailGeneration.current += 1;
    detailAbort.current?.abort();
    listAbort.current?.abort();
    const abort = new AbortController();
    listAbort.current = abort;
    setLoading(true);
    setError(null);
    void approvalPort
      .list(nextScope, abort.signal)
      .then((result) => {
        if (generation !== listGeneration.current) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setItems(result.data);
        setSelected(null);
      })
      .catch((reason: unknown) => {
        if (
          generation === listGeneration.current &&
          !(reason instanceof DOMException && reason.name === "AbortError")
        ) {
          setError("审批列表加载失败");
        }
      })
      .finally(() => {
        if (generation === listGeneration.current) setLoading(false);
      });
  };

  useEffect(() => {
    load(scope);
    return () => {
      listGeneration.current += 1;
      detailGeneration.current += 1;
      actionGeneration.current += 1;
      listAbort.current?.abort();
      detailAbort.current?.abort();
      actionAbort.current?.abort();
    };
  }, [scope]);

  const openDetail = (approvalRef: string): void => {
    const generation = ++detailGeneration.current;
    detailAbort.current?.abort();
    const abort = new AbortController();
    detailAbort.current = abort;
    setError(null);
    void approvalPort
      .get(approvalRef, abort.signal)
      .then((result) => {
        if (generation !== detailGeneration.current) return;
        if (!result.ok) setError(result.error.message);
        else setSelected(result.data);
      })
      .catch((reason: unknown) => {
        if (
          generation === detailGeneration.current &&
          !(reason instanceof DOMException && reason.name === "AbortError")
        ) {
          setError("审批详情加载失败");
        }
      });
  };

  const decide = (decision: "approve" | "deny"): void => {
    if (selected === null || acting) return;
    if (decision === "deny" && denialReason.trim().length === 0) {
      setError("驳回原因不能为空");
      return;
    }
    actionAbort.current?.abort();
    const generation = ++actionGeneration.current;
    const abort = new AbortController();
    actionAbort.current = abort;
    setActing(true);
    setError(null);
    const operation =
      decision === "approve"
        ? approvalPort.approve(selected.approval_ref, selected.row_version, abort.signal)
        : approvalPort.deny(
            selected.approval_ref,
            selected.row_version,
            denialReason.trim(),
            abort.signal,
          );
    void operation
      .then((result) => {
        if (generation !== actionGeneration.current) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setDenialReason("");
        load(scope);
      })
      .catch((reason: unknown) => {
        if (
          generation === actionGeneration.current &&
          !(reason instanceof DOMException && reason.name === "AbortError")
        ) {
          setError("审批操作失败");
        }
      })
      .finally(() => {
        if (generation === actionGeneration.current) setActing(false);
      });
  };

  const selfApproval = selected?.requester_staff_id === currentStaffId;
  const canRetryApproved =
    selected?.status === "approved" && selected.decided_by_staff_id === currentStaffId;
  return (
    <section className="ld-approval-center" aria-labelledby="approval-center-title">
      <header className="ld-approval-center__header">
        <div>
          <h1 id="approval-center-title">异步审批中心</h1>
          <p>仅处理服务端冻结的 R4 动作；参数、版本或权限变化会拒绝执行。</p>
        </div>
        <div className="ld-approval-center__tabs" role="tablist" aria-label="审批范围">
          {(["pending", "history"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={scope === value}
              onClick={() => setScope(value)}
            >
              {value === "pending" ? "待办" : "历史"}
            </button>
          ))}
        </div>
      </header>
      {error === null ? null : (
        <p className="ld-approval-center__error" role="alert">
          {error}
        </p>
      )}
      <div className="ld-approval-center__layout">
        <div className="ld-approval-center__queue" aria-busy={loading}>
          {loading ? <p>正在加载…</p> : null}
          {!loading && items.length === 0 ? <p>当前没有审批记录。</p> : null}
          {items.map((item) => (
            <button
              key={item.approval_ref}
              type="button"
              className="ld-approval-center__card"
              aria-pressed={selected?.approval_ref === item.approval_ref}
              onClick={() => openDetail(item.approval_ref)}
            >
              <strong>{item.command}</strong>
              <span>{STATUS_LABELS[item.status]}</span>
              <small>发起人 {item.requester_staff_id}</small>
              <small>到期 {formatExpiry(item.expires_at_epoch)}</small>
            </button>
          ))}
        </div>
        <aside className="ld-approval-center__detail" aria-label="审批详情">
          {selected === null ? (
            <p>选择一条记录查看完整冻结参数。</p>
          ) : (
            <>
              <h2>{selected.command}</h2>
              <dl>
                <dt>状态</dt>
                <dd>{STATUS_LABELS[selected.status]}</dd>
                <dt>参数摘要哈希</dt>
                <dd>
                  <code>{selected.args_hash}</code>
                </dd>
                <dt>幂等键</dt>
                <dd>
                  <code>{selected.idempotency_key}</code>
                </dd>
                <dt>实体版本</dt>
                <dd>{selected.entity_versions.length} 项</dd>
              </dl>
              <h3>完整冻结参数</h3>
              <pre>{JSON.stringify(selected.args, null, 2)}</pre>
              {selected.status === "pending" ? (
                <div className="ld-approval-center__actions">
                  <textarea
                    value={denialReason}
                    maxLength={500}
                    placeholder="驳回原因（驳回时必填）"
                    onChange={(event) => setDenialReason(event.currentTarget.value)}
                  />
                  {selfApproval ? <p role="note">发起人不能审批自己的动作。</p> : null}
                  <button
                    type="button"
                    disabled={acting || selfApproval}
                    onClick={() => decide("approve")}
                  >
                    批准并执行
                  </button>
                  <button
                    type="button"
                    disabled={acting || selfApproval}
                    onClick={() => decide("deny")}
                  >
                    驳回
                  </button>
                </div>
              ) : canRetryApproved ? (
                <div className="ld-approval-center__actions">
                  <button type="button" disabled={acting} onClick={() => decide("approve")}>
                    重试执行
                  </button>
                </div>
              ) : null}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
