import type { AutomationPolicy, AutomationRun } from "@laundry/contracts";
import { Button, EmptyState, Skeleton, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CommandPort, QueryPort } from "../commands/types.js";
import {
  buildAutomationDraft,
  EMPTY_AUTOMATION_FORM,
  formFromPolicy,
  loadAutomationPolicies,
  loadAutomationRuns,
  mutateAutomationPolicy,
  type AutomationFormValue,
} from "./automation-model.js";
import {
  AUTOMATION_OUTCOME_LABEL,
  AUTOMATION_STATUS_LABEL,
  AutomationPolicyEditorFields,
  formatAutomationTime,
} from "./automation-view.js";

export type OwnerAutomationPageProps = Readonly<{
  commandClient: CommandPort;
  queryClient: QueryPort;
}>;

export function OwnerAutomationPage({ commandClient, queryClient }: OwnerAutomationPageProps) {
  const toast = useToast();
  const [policies, setPolicies] = useState<readonly AutomationPolicy[]>([]);
  const [runs, setRuns] = useState<readonly AutomationRun[]>([]);
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AutomationPolicy | null>(null);
  const [form, setForm] = useState<AutomationFormValue>(EMPTY_AUTOMATION_FORM);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPolicyId, setBusyPolicyId] = useState<string | null>(null);
  const generation = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const mutationAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    setLoading(true);
    setError(null);
    const result = await loadAutomationPolicies(queryClient, controller.signal);
    if (controller.signal.aborted || generation.current !== currentGeneration) return;
    if (!result.ok) {
      setError(result.error);
      setPolicies([]);
    } else {
      setPolicies(result.data);
    }
    setLoading(false);
  }, [queryClient]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
      loadAbort.current?.abort();
      mutationAbort.current?.abort();
    };
  }, [load]);

  const refreshRuns = useCallback(
    async (policyId: string) => {
      loadAbort.current?.abort();
      const controller = new AbortController();
      loadAbort.current = controller;
      const currentGeneration = generation.current + 1;
      generation.current = currentGeneration;
      const result = await loadAutomationRuns(queryClient, policyId, controller.signal);
      if (controller.signal.aborted || generation.current !== currentGeneration) return;
      if (!result.ok) {
        toast.push(result.error, "error");
        return;
      }
      setSelectedPolicyId(policyId);
      setRuns(result.data);
    },
    [queryClient, toast],
  );

  const mutate = useCallback(
    async (name: string, input: unknown, policyId = "new") => {
      mutationAbort.current?.abort();
      const controller = new AbortController();
      mutationAbort.current = controller;
      setBusyPolicyId(policyId);
      try {
        const result = await mutateAutomationPolicy(commandClient, name, input, controller.signal);
        if (controller.signal.aborted) return;
        if (!result.ok) {
          toast.push(result.error, "error");
          return;
        }
        toast.push("自动化策略已更新", "success");
        setEditing(null);
        setForm(EMPTY_AUTOMATION_FORM);
        await load();
      } finally {
        if (!controller.signal.aborted) setBusyPolicyId(null);
      }
    },
    [commandClient, load, toast],
  );

  const save = useCallback(() => {
    const built = buildAutomationDraft(form, new Date());
    if (!built.ok) {
      toast.push(built.error, "error");
      return;
    }
    if (editing === null) {
      void mutate("automation.policy.create", built.draft);
      return;
    }
    void mutate(
      "automation.policy.update",
      { ...built.draft, policy_id: editing.policy_id, expected_version: editing.row_version },
      editing.policy_id,
    );
  }, [editing, form, mutate, toast]);

  const transition = useCallback(
    (policy: AutomationPolicy, operation: "approve" | "pause" | "resume" | "archive") => {
      void mutate(
        `automation.policy.${operation}`,
        {
          policy_id: policy.policy_id,
          expected_version: policy.row_version,
          reason:
            operation === "approve" ? "店长核对范围、时段和额度后批准" : `店长执行${operation}`,
        },
        policy.policy_id,
      );
    },
    [mutate],
  );

  if (loading && policies.length === 0) {
    return (
      <div className="ld-owner-management lg-card">
        <Skeleton lines={7} rounded="md" />
      </div>
    );
  }
  if (error !== null && policies.length === 0) {
    return (
      <section className="ld-owner-management lg-card" role="alert">
        <EmptyState
          title="无法读取自动化策略"
          description={error}
          actionLabel="重新加载"
          onAction={() => void load()}
        />
      </section>
    );
  }

  return (
    <div className="ld-owner-management-page" data-testid="owner-automation">
      <header className="ld-owner-section-heading">
        <span className="ld-owner-dashboard__date">仅允许固定取件提醒工具</span>
        <h1>有界自动化</h1>
        <p>所有策略必须由店长批准，并受对象、时段、每日次数、整数分金额和 24 小时风险上限约束。</p>
      </header>
      <section className="ld-owner-management lg-card" aria-labelledby="automation-editor-title">
        <header className="ld-owner-management__header">
          <div>
            <h2 id="automation-editor-title">{editing === null ? "新建策略" : "编辑策略"}</h2>
            <p>修改后会回到待批准状态；不能输入脚本、SQL、URL 或任意工具参数。</p>
          </div>
          <span>{editing === null ? "固定模板" : `版本 ${editing.row_version}`}</span>
        </header>
        <AutomationPolicyEditorFields value={form} onChange={setForm} />
        <div className="ld-owner-automation__actions">
          <Button type="button" variant="primary" disabled={busyPolicyId !== null} onClick={save}>
            {editing === null ? "创建待批准策略" : "保存并重新批准"}
          </Button>
          {editing === null ? null : (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEditing(null);
                setForm(EMPTY_AUTOMATION_FORM);
              }}
            >
              取消编辑
            </Button>
          )}
        </div>
      </section>
      <section className="ld-owner-management lg-card" aria-labelledby="automation-list-title">
        <header className="ld-owner-management__header">
          <div>
            <h2 id="automation-list-title">策略与调度</h2>
            <p>额度触发、连续失败或人工操作都会立即停止后续调度。</p>
          </div>
          <Button type="button" variant="ghost" disabled={loading} onClick={() => void load()}>
            刷新
          </Button>
        </header>
        {policies.length === 0 ? (
          <p>暂无自动化策略。</p>
        ) : (
          <div className="ld-owner-management__table-wrap">
            <table className="ld-owner-management__table">
              <thead>
                <tr>
                  <th>策略</th>
                  <th>状态</th>
                  <th>额度</th>
                  <th>下次运行</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.policy_id}>
                    <th scope="row">
                      <strong>{policy.name}</strong>
                      <small>{policy.tool}</small>
                    </th>
                    <td>{AUTOMATION_STATUS_LABEL[policy.status]}</td>
                    <td>
                      {policy.limits.max_runs_per_day} 次 / {policy.limits.max_amount_cents} 分
                    </td>
                    <td>{formatAutomationTime(policy.next_run_at)}</td>
                    <td>
                      <div className="ld-owner-automation__row-actions">
                        {policy.status === "pending_approval" ? (
                          <Button
                            size="sm"
                            type="button"
                            disabled={busyPolicyId === policy.policy_id}
                            onClick={() => transition(policy, "approve")}
                          >
                            批准
                          </Button>
                        ) : null}
                        {policy.status === "active" ? (
                          <Button
                            size="sm"
                            type="button"
                            variant="secondary"
                            disabled={busyPolicyId === policy.policy_id}
                            onClick={() => transition(policy, "pause")}
                          >
                            暂停
                          </Button>
                        ) : null}
                        {["paused", "quota_paused"].includes(policy.status) ? (
                          <Button
                            size="sm"
                            type="button"
                            variant="secondary"
                            disabled={busyPolicyId === policy.policy_id}
                            onClick={() => transition(policy, "resume")}
                          >
                            恢复
                          </Button>
                        ) : null}
                        {policy.status !== "archived" ? (
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              setEditing(policy);
                              setForm(formFromPolicy(policy));
                            }}
                          >
                            编辑
                          </Button>
                        ) : null}
                        {policy.status !== "archived" ? (
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            disabled={busyPolicyId === policy.policy_id}
                            onClick={() => transition(policy, "archive")}
                          >
                            归档
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => void refreshRuns(policy.policy_id)}
                        >
                          运行记录
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {selectedPolicyId === null ? null : (
        <section className="ld-owner-management lg-card" aria-labelledby="automation-runs-title">
          <header className="ld-owner-management__header">
            <div>
              <h2 id="automation-runs-title">运行记录</h2>
              <p>只显示结果、参数摘要、对象数、金额和安全错误码，不保存消息正文。</p>
            </div>
            <span>{runs.length} 条</span>
          </header>
          {runs.length === 0 ? (
            <p>暂无运行记录。</p>
          ) : (
            <div className="ld-owner-management__table-wrap">
              <table className="ld-owner-management__table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>结果</th>
                    <th>订单</th>
                    <th>金额</th>
                    <th>错误码</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.run_id}>
                      <td>{formatAutomationTime(run.started_at)}</td>
                      <td>{AUTOMATION_OUTCOME_LABEL[run.outcome]}</td>
                      <td>{run.object_count}</td>
                      <td>{run.amount_cents} 分</td>
                      <td>{run.error_code ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
