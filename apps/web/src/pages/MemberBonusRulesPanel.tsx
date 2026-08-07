import { Button, Dialog, Input, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";

import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { unwrapQueryResult } from "./customer-model.js";
import {
  centsToYuanInput,
  parseMemberBonusRules,
  topupAmountToCents,
  yuanAmountToCents,
  type MemberBonusRuleView,
} from "./member-model.js";

type RuleBody = Readonly<{
  rule_id?: string;
  min_topup_cents: number;
  bonus_cents: number;
  status: "active" | "retired";
  note?: string;
}>;

type RuleForm = Readonly<{
  ruleId: string | null;
  threshold: string;
  bonus: string;
  note: string;
}>;

export type MemberBonusRulesPanelProps = Readonly<{
  commandClient: CommandPort;
  queryClient: QueryPort;
}>;

const EMPTY_FORM: RuleForm = Object.freeze({
  ruleId: null as string | null,
  threshold: "",
  bonus: "",
  note: "",
});

/** Resume an R3 rule change with only the server-frozen confirmation reference. */
export function resumeMemberBonusRule(commandClient: CommandPort, confirmRef: string) {
  return commandClient.execute("member.bonus_rule.upsert", {}, { confirmRef });
}

export function MemberBonusRulesPanel({ commandClient, queryClient }: MemberBonusRulesPanelProps) {
  const toast = useToast();
  const [rules, setRules] = useState<readonly MemberBonusRuleView[]>([]);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<Readonly<{ ref: string; body: RuleBody }> | null>(null);

  const reload = useCallback(async () => {
    const result = await queryClient.execute<unknown>("member.bonus_rules.list", {
      include_retired: true,
    });
    if (!result.ok) {
      setFailed(true);
      toast.push(result.error.message ?? result.error.code, "error");
      return;
    }
    const parsed = parseMemberBonusRules(unwrapQueryResult(result.data));
    if (parsed === null) {
      setFailed(true);
      toast.push("赠送档位无法解析", "error");
      return;
    }
    setRules(parsed);
    setFailed(false);
  }, [queryClient, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = useCallback(
    async (body: RuleBody) => {
      setBusy(true);
      try {
        const result = await commandClient.execute("member.bonus_rule.upsert", body);
        if (result.ok) {
          toast.push(body.status === "active" ? "赠送档位已保存" : "赠送档位已停用", "success");
          setForm(EMPTY_FORM);
          await reload();
          return;
        }
        if (isStepUpRequired(result) && result.error.code === "POLICY_CONFIRMATION_REQUIRED") {
          setPending(Object.freeze({ ref: result.error.detail.confirm_ref, body }));
          return;
        }
        toast.push(result.error.message ?? result.error.code, "error");
      } finally {
        setBusy(false);
      }
    },
    [commandClient, reload, toast],
  );

  const save = useCallback(() => {
    const threshold = topupAmountToCents(form.threshold);
    const bonus = yuanAmountToCents(form.bonus);
    if (threshold === null || bonus === null) {
      toast.push("请输入有效的满额与赠送金额，最多两位小数", "error");
      return;
    }
    const note = form.note.trim();
    void submit({
      ...(form.ruleId === null ? {} : { rule_id: form.ruleId }),
      min_topup_cents: threshold,
      bonus_cents: bonus,
      status: "active",
      ...(note.length === 0 ? {} : { note }),
    });
  }, [form, submit, toast]);

  const edit = useCallback((rule: MemberBonusRuleView) => {
    setForm(
      Object.freeze({
        ruleId: rule.rule_id,
        threshold: centsToYuanInput(rule.min_topup_cents),
        bonus: centsToYuanInput(rule.bonus_cents),
        note: rule.note ?? "",
      }),
    );
  }, []);

  const confirm = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    try {
      const result = await resumeMemberBonusRule(commandClient, pending.ref);
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      const status = pending.body.status;
      setPending(null);
      setForm(EMPTY_FORM);
      toast.push(status === "active" ? "赠送档位已保存" : "赠送档位已停用", "success");
      await reload();
    } finally {
      setBusy(false);
    }
  }, [commandClient, pending, reload, toast]);

  return (
    <section
      className="ld-member-rules lg-card"
      aria-label="充值赠送档位"
      data-testid="member-rules"
    >
      <h2 className="ld-shell-main__title">充值赠送</h2>
      <p className="ld-shell-main__hint">
        按命中的最高满额档位赠送；停用只影响后续充值，不重估历史流水。
      </p>
      <div className="ld-member-rules__form">
        <Input
          label="充满（元）"
          value={form.threshold}
          inputMode="decimal"
          onChange={(event) =>
            setForm((current) => Object.freeze({ ...current, threshold: event.target.value }))
          }
          disabled={busy}
        />
        <Input
          label="赠送（元）"
          value={form.bonus}
          inputMode="decimal"
          onChange={(event) =>
            setForm((current) => Object.freeze({ ...current, bonus: event.target.value }))
          }
          disabled={busy}
        />
        <Input
          label="备注（可选）"
          value={form.note}
          onChange={(event) =>
            setForm((current) => Object.freeze({ ...current, note: event.target.value }))
          }
          disabled={busy}
        />
        <Button variant="primary" type="button" onClick={save} disabled={busy}>
          {form.ruleId === null ? "新增档位" : "保存档位"}
        </Button>
        {form.ruleId === null ? null : (
          <Button variant="ghost" type="button" onClick={() => setForm(EMPTY_FORM)} disabled={busy}>
            取消编辑
          </Button>
        )}
      </div>
      {failed ? (
        <Button onClick={() => void reload()} disabled={busy}>
          重试读取
        </Button>
      ) : null}
      <ul className="ld-member-rules__list">
        {rules.map((rule) => (
          <li key={rule.rule_id} className="ld-member-rules__row">
            <span>
              充 <MoneyText fen={rule.min_topup_cents} /> 送 <MoneyText fen={rule.bonus_cents} />
            </span>
            <span>{rule.status === "active" ? "启用" : "已停用"}</span>
            <Button variant="ghost" type="button" onClick={() => edit(rule)} disabled={busy}>
              编辑
            </Button>
            {rule.status === "active" ? (
              <Button
                variant="ghost"
                type="button"
                onClick={() =>
                  void submit({
                    rule_id: rule.rule_id,
                    min_topup_cents: rule.min_topup_cents,
                    bonus_cents: rule.bonus_cents,
                    status: "retired",
                    ...(rule.note === null ? {} : { note: rule.note }),
                  })
                }
                disabled={busy}
              >
                停用
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {rules.length === 0 && !failed ? (
        <p className="ld-shell-main__hint">尚未配置赠送档位，充值只增加本金。</p>
      ) : null}
      <Dialog
        open={pending !== null}
        title="确认修改赠送档位"
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void confirm()} disabled={busy}>
              确认保存
            </Button>
          </>
        }
      >
        {pending === null ? null : (
          <p>
            充 <MoneyText fen={pending.body.min_topup_cents} /> 赠{" "}
            <MoneyText fen={pending.body.bonus_cents} />
            ，状态：{pending.body.status === "active" ? "启用" : "停用"}。本次修改只影响后续充值。
          </p>
        )}
      </Dialog>
    </section>
  );
}
