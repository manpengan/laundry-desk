import { Button, Dialog, Input, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import {
  EMPTY_BENEFIT_DEFINITION_DRAFT,
  benefitDefinitionDraft,
  buildBenefitDefinitionBody,
  formatBenefitDiscountPercent,
  listBenefitDefinitions,
  parseMemberBenefitCatalog,
  type BenefitCatalogDefinition,
  type BenefitDefinitionDraft,
  type MemberBenefitDefinitionInput,
} from "./member-benefits-model.js";

export type MemberBenefitDefinitionsPanelProps = Readonly<{
  commandClient: CommandPort;
  queryClient: QueryPort;
}>;

type PendingDefinition = Readonly<{
  body: Readonly<{ definition: MemberBenefitDefinitionInput }>;
  confirmRef: string;
}>;

const KIND_OPTIONS = Object.freeze([
  { value: "tier", label: "会员等级" },
  { value: "points_policy", label: "积分规则" },
  { value: "punch_type", label: "次卡类型" },
  { value: "coupon_type", label: "优惠券" },
] as const);

function definitionTitle(item: BenefitCatalogDefinition): string {
  return item.kind === "points_policy" ? "积分规则" : `${item.name}（${item.code}）`;
}

function definitionDetail(item: BenefitCatalogDefinition) {
  if (item.kind === "tier") {
    return (
      <>
        等级序号 {item.level}，自动折扣 {formatBenefitDiscountPercent(item.discount_bps)}%
      </>
    );
  }
  if (item.kind === "points_policy") {
    return (
      <>
        每满 <MoneyText fen={item.unit_cents} /> 得 {item.points_per_unit} 分，{item.valid_days}{" "}
        天有效
      </>
    );
  }
  if (item.kind === "punch_type")
    return (
      <>
        {item.total_uses} 次，{item.valid_days} 天有效
      </>
    );
  return (
    <>
      减 <MoneyText fen={item.discount_cents} />
      ，满 <MoneyText fen={item.min_order_cents} /> 可用，
      {item.valid_days} 天有效
    </>
  );
}

function primaryLabel(kind: BenefitDefinitionDraft["kind"]): string {
  if (kind === "tier") return "等级序号";
  if (kind === "points_policy") return "每满金额（元）";
  if (kind === "punch_type") return "总次数";
  return "优惠金额（元）";
}

export function MemberBenefitDefinitionsPanel({
  commandClient,
  queryClient,
}: MemberBenefitDefinitionsPanelProps) {
  const toast = useToast();
  const [catalog, setCatalog] = useState<ReturnType<typeof parseMemberBenefitCatalog>>(null);
  const [draft, setDraft] = useState<BenefitDefinitionDraft>(EMPTY_BENEFIT_DEFINITION_DRAFT);
  const [pending, setPending] = useState<PendingDefinition | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const definitions = useMemo(
    () => (catalog === null ? [] : listBenefitDefinitions(catalog)),
    [catalog],
  );

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const result = await queryClient.execute<unknown>("member.benefit_catalog.get", {
        include_retired: true,
      });
      if (!result.ok) {
        setFailed(true);
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      const parsed = parseMemberBenefitCatalog(result.data);
      if (parsed === null) {
        setFailed(true);
        toast.push("会员权益定义响应无法解析", "error");
        return;
      }
      setCatalog(parsed);
      setFailed(false);
    } finally {
      setBusy(false);
    }
  }, [queryClient, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const finish = useCallback(async () => {
    setPending(null);
    setDraft(EMPTY_BENEFIT_DEFINITION_DRAFT);
    toast.push("会员权益定义已保存", "success");
    await reload();
  }, [reload, toast]);

  const submit = useCallback(
    async (body: Readonly<{ definition: MemberBenefitDefinitionInput }>) => {
      setBusy(true);
      try {
        const result = await commandClient.execute("member.benefit_definition.upsert", body);
        if (result.ok) {
          await finish();
          return;
        }
        if (isStepUpRequired(result) && result.error.code === "POLICY_CONFIRMATION_REQUIRED") {
          setPending(Object.freeze({ body, confirmRef: result.error.detail.confirm_ref }));
          return;
        }
        toast.push(result.error.message ?? result.error.code, "error");
      } finally {
        setBusy(false);
      }
    },
    [commandClient, finish, toast],
  );

  const save = useCallback(() => {
    const body = buildBenefitDefinitionBody(draft);
    if (body === null) {
      toast.push("请检查代码、名称、数值和有效天数", "error");
      return;
    }
    void submit(body);
  }, [draft, submit, toast]);

  const retire = useCallback(
    (item: BenefitCatalogDefinition) => {
      const body = buildBenefitDefinitionBody(benefitDefinitionDraft(item), "retired");
      if (body === null) {
        toast.push("当前定义无法停用，请刷新后重试", "error");
        return;
      }
      void submit(body);
    },
    [submit, toast],
  );

  const confirm = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    try {
      const result = await commandClient.execute(
        "member.benefit_definition.upsert",
        {},
        { confirmRef: pending.confirmRef },
      );
      if (!result.ok) {
        setPending(null);
        toast.push(result.error.message ?? result.error.code, "error");
        await reload();
        return;
      }
      await finish();
    } finally {
      setBusy(false);
    }
  }, [commandClient, finish, pending, reload, toast]);

  const patchDraft = useCallback((patch: Partial<BenefitDefinitionDraft>) => {
    setDraft((current) => Object.freeze({ ...current, ...patch }));
  }, []);

  return (
    <section className="ld-benefit-definitions lg-card" data-testid="benefit-definitions">
      <h2 className="ld-shell-main__title">会员权益定义</h2>
      <p className="ld-shell-main__hint">定义更新只影响后续发放；已发积分、次卡和券保留原快照。</p>
      <div className="ld-benefit-form">
        <label className="ld-member-panel__method">
          <span>类型</span>
          <select
            value={draft.kind}
            disabled={busy || draft.expectedVersion > 0}
            onChange={(event) => {
              const kind = event.target.value as BenefitDefinitionDraft["kind"];
              setDraft(
                Object.freeze({
                  ...EMPTY_BENEFIT_DEFINITION_DRAFT,
                  kind,
                  secondary: kind === "tier" ? "0" : "",
                }),
              );
            }}
            data-testid="benefit-definition-kind"
          >
            {KIND_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {draft.kind === "points_policy" ? null : (
          <>
            <Input
              label="代码"
              value={draft.code}
              disabled={busy || draft.expectedVersion > 0}
              onChange={(event) => patchDraft({ code: event.target.value })}
            />
            <Input
              label="名称"
              value={draft.name}
              disabled={busy}
              onChange={(event) => patchDraft({ name: event.target.value })}
            />
          </>
        )}
        <Input
          label={primaryLabel(draft.kind)}
          value={draft.primary}
          inputMode="decimal"
          disabled={busy}
          onChange={(event) => patchDraft({ primary: event.target.value })}
        />
        {draft.kind === "tier" ? (
          <Input
            label="等级折扣（%）"
            value={draft.secondary}
            inputMode="decimal"
            disabled={busy}
            onChange={(event) => patchDraft({ secondary: event.target.value })}
          />
        ) : draft.kind === "points_policy" ? (
          <Input
            label="每档积分"
            value={draft.secondary}
            inputMode="numeric"
            disabled={busy}
            onChange={(event) => patchDraft({ secondary: event.target.value })}
          />
        ) : draft.kind === "coupon_type" ? (
          <Input
            label="最低订单（元）"
            value={draft.secondary}
            inputMode="decimal"
            disabled={busy}
            onChange={(event) => patchDraft({ secondary: event.target.value })}
          />
        ) : null}
        {draft.kind === "tier" ? null : (
          <Input
            label="有效天数"
            value={draft.validDays}
            inputMode="numeric"
            disabled={busy}
            onChange={(event) => patchDraft({ validDays: event.target.value })}
          />
        )}
        <Input
          label="备注（可选）"
          value={draft.note}
          disabled={busy}
          onChange={(event) => patchDraft({ note: event.target.value })}
        />
        <Button variant="primary" type="button" disabled={busy} onClick={save}>
          {draft.expectedVersion === 0 ? "新增定义" : "保存修改"}
        </Button>
        {draft.expectedVersion > 0 ? (
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => setDraft(EMPTY_BENEFIT_DEFINITION_DRAFT)}
          >
            取消编辑
          </Button>
        ) : null}
      </div>
      {failed ? (
        <Button type="button" onClick={() => void reload()} disabled={busy}>
          重试读取
        </Button>
      ) : null}
      <ul className="ld-benefit-definitions__list">
        {definitions.map((item) => {
          const id = item.kind === "points_policy" ? item.policy_id : item.definition_id;
          return (
            <li key={`${item.kind}:${id}`} className="ld-benefit-definitions__row">
              <span>
                <strong>{definitionTitle(item)}</strong>
                <small>{definitionDetail(item)}</small>
              </span>
              <span>
                {item.status === "active" ? "启用" : "已停用"} · v{item.version}
              </span>
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => setDraft(benefitDefinitionDraft(item))}
              >
                编辑
              </Button>
              {item.status === "active" ? (
                <Button variant="ghost" type="button" disabled={busy} onClick={() => retire(item)}>
                  停用
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {definitions.length === 0 && !failed ? (
        <p className="ld-shell-main__hint">尚未配置等级、积分、次卡或优惠券。</p>
      ) : null}
      <Dialog
        open={pending !== null}
        title="确认修改会员权益定义"
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="ghost" type="button" disabled={busy} onClick={() => setPending(null)}>
              取消
            </Button>
            <Button variant="primary" type="button" disabled={busy} onClick={() => void confirm()}>
              确认保存
            </Button>
          </>
        }
      >
        <p>服务端已冻结本次定义参数。确认后只影响后续发放，不追溯修改既有会员资产。</p>
      </Dialog>
    </section>
  );
}
