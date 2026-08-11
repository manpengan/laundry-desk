import { PricingPolicySetInputSchema, type PricingPolicySetInput } from "@laundry/contracts";
import { Button, Input, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import {
  EMPTY_PRICING_POLICY,
  readPricingPolicy,
  type PricingPolicyView,
} from "./pricing-policy-model.js";

type AddonDraft = Readonly<{
  row_id: string;
  code: string;
  name: string;
  price_text: string;
  is_active: boolean;
  sort_text: string;
}>;

type PricingPolicyBody = Readonly<
  Omit<PricingPolicySetInput, "addons"> & {
    addons: readonly Readonly<PricingPolicySetInput["addons"][number]>[];
  }
>;

type PendingSave = Readonly<{ confirmRef: string; body: PricingPolicyBody }>;

export type PricingSettingsPanelProps = Readonly<{
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient: QueryPort;
}>;

const digits = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const draftFromPolicy = (policy: PricingPolicyView): readonly AddonDraft[] =>
  Object.freeze(
    policy.addons.map((addon, index) =>
      Object.freeze({
        row_id: `persisted-${index}-${addon.code}`,
        code: addon.code,
        name: addon.name,
        price_text: String(addon.unit_price_cents),
        is_active: addon.is_active,
        sort_text: String(addon.sort_order),
      }),
    ),
  );

const newAddon = (index: number): AddonDraft =>
  Object.freeze({
    row_id: `new-${Date.now()}-${index}`,
    code: "",
    name: "",
    price_text: "0",
    is_active: true,
    sort_text: String(index),
  });

function buildPolicyBody(
  version: number,
  urgentText: string,
  freightText: string,
  addons: readonly AddonDraft[],
): Readonly<{ ok: true; body: PricingPolicyBody }> | Readonly<{ ok: false; message: string }> {
  const urgent = digits(urgentText);
  const freight = digits(freightText);
  const parsedAddons = addons.map((addon) => ({
    code: addon.code.trim(),
    name: addon.name.trim(),
    unit_price_cents: digits(addon.price_text),
    is_active: addon.is_active,
    sort_order: digits(addon.sort_text),
  }));
  if (
    urgent === null ||
    freight === null ||
    parsedAddons.some((addon) => addon.unit_price_cents === null || addon.sort_order === null)
  ) {
    return Object.freeze({ ok: false as const, message: "金额和排序必须是非负整数" });
  }
  const candidate = {
    expected_version: version,
    urgent_cents: urgent,
    freight_cents: freight,
    addons: parsedAddons,
  };
  const parsed = PricingPolicySetInputSchema.safeParse(candidate);
  if (!parsed.success) {
    return Object.freeze({ ok: false as const, message: "附加项编码、名称或金额格式无效" });
  }
  const codes = parsed.data.addons.map((addon) => addon.code);
  if (new Set(codes).size !== codes.length) {
    return Object.freeze({ ok: false as const, message: "附加项编码不能重复" });
  }
  const body = Object.freeze({
    ...parsed.data,
    addons: Object.freeze(parsed.data.addons.map((addon) => Object.freeze({ ...addon }))),
  });
  return Object.freeze({ ok: true as const, body });
}

export function PricingSettingsPanel({
  session,
  authClient,
  commandClient,
  queryClient,
}: PricingSettingsPanelProps) {
  const toast = useToast();
  const [policy, setPolicy] = useState<PricingPolicyView>(EMPTY_PRICING_POLICY);
  const [urgentText, setUrgentText] = useState("0");
  const [freightText, setFreightText] = useState("0");
  const [addons, setAddons] = useState<readonly AddonDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<PendingSave | null>(null);

  const applyPolicy = useCallback((next: PricingPolicyView) => {
    setPolicy(next);
    setUrgentText(String(next.urgent_cents));
    setFreightText(String(next.freight_cents));
    setAddons(draftFromPolicy(next));
    setLoaded(true);
  }, []);

  const reload = useCallback(async () => {
    try {
      const result = await queryClient.execute<unknown>("pricing.policy.get", {});
      if (!result.ok) {
        setLoaded(false);
        toast.push(result.error.message ?? result.error.code, "error");
        return false;
      }
      const next = readPricingPolicy(result.data);
      if (next === null) {
        setLoaded(false);
        toast.push("计价设置返回格式无效", "error");
        return false;
      }
      applyPolicy(next);
      return true;
    } catch {
      setLoaded(false);
      toast.push("无法读取计价设置，请检查服务连接", "error");
      return false;
    }
  }, [applyPolicy, queryClient, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patchAddon = useCallback((rowId: string, patch: Partial<AddonDraft>) => {
    setAddons((current) =>
      Object.freeze(
        current.map((addon) =>
          addon.row_id === rowId
            ? Object.freeze({ ...addon, ...patch, row_id: addon.row_id })
            : addon,
        ),
      ),
    );
  }, []);

  const finish = useCallback(
    async (confirmRef: string) => {
      setBusy(true);
      try {
        const result = await commandClient.execute("pricing.policy.set", {}, { confirmRef });
        if (!result.ok) {
          toast.push(result.error.message ?? result.error.code, "error");
          return;
        }
        setPending(null);
        const refreshed = await reload();
        toast.push(
          refreshed ? "计价设置已保存并生效" : "计价设置已保存，但当前界面仍需重新读取",
          refreshed ? "success" : "error",
        );
      } catch {
        toast.push("无法完成计价设置复核，请检查服务连接", "error");
      } finally {
        setBusy(false);
      }
    },
    [commandClient, reload, toast],
  );

  const save = useCallback(async () => {
    const built = buildPolicyBody(policy.version, urgentText, freightText, addons);
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    setBusy(true);
    try {
      const result = await commandClient.execute("pricing.policy.set", built.body);
      if (result.ok) {
        const refreshed = await reload();
        toast.push(
          refreshed ? "计价设置已保存并生效" : "计价设置已保存，但当前界面仍需重新读取",
          refreshed ? "success" : "error",
        );
        return;
      }
      if (isStepUpRequired(result)) {
        setPending(
          Object.freeze({ confirmRef: result.error.detail.confirm_ref, body: built.body }),
        );
        return;
      }
      toast.push(result.error.message ?? result.error.code, "error");
    } catch {
      toast.push("无法保存计价设置，请检查服务连接", "error");
    } finally {
      setBusy(false);
    }
  }, [addons, commandClient, freightText, policy.version, reload, toast, urgentText]);

  return (
    <section
      className="ld-settings-pricing lg-card"
      aria-label="柜台计价设置"
      data-testid="pricing-settings"
    >
      <h2 className="ld-shell-main__title">柜台计价设置</h2>
      <p className="ld-shell-main__hint">
        加急、运费和附加项由服务端按本店设置计价；修改需另一位店长现场复核。
      </p>
      <div className="ld-settings-form">
        <Input
          label="加急固定费（分）"
          inputMode="numeric"
          value={urgentText}
          onChange={(event) => setUrgentText(event.target.value)}
          disabled={busy || !loaded}
        />
        <Input
          label="运费固定费（分）"
          inputMode="numeric"
          value={freightText}
          onChange={(event) => setFreightText(event.target.value)}
          disabled={busy || !loaded}
        />
      </div>
      <div className="ld-settings-pricing__addons">
        {addons.map((addon) => (
          <article key={addon.row_id} className="ld-settings-pricing__addon">
            <Input
              label="附加项编码"
              value={addon.code}
              onChange={(event) => patchAddon(addon.row_id, { code: event.target.value })}
              disabled={busy}
            />
            <Input
              label="显示名称"
              value={addon.name}
              onChange={(event) => patchAddon(addon.row_id, { name: event.target.value })}
              disabled={busy}
            />
            <Input
              label="每件金额（分）"
              inputMode="numeric"
              value={addon.price_text}
              onChange={(event) => patchAddon(addon.row_id, { price_text: event.target.value })}
              disabled={busy}
            />
            <Input
              label="排序"
              inputMode="numeric"
              value={addon.sort_text}
              onChange={(event) => patchAddon(addon.row_id, { sort_text: event.target.value })}
              disabled={busy}
            />
            <label className="ld-settings-pricing__toggle">
              <input
                type="checkbox"
                checked={addon.is_active}
                onChange={(event) => patchAddon(addon.row_id, { is_active: event.target.checked })}
                disabled={busy}
              />
              启用
            </label>
            <Button
              variant="ghost"
              type="button"
              onClick={() =>
                setAddons((current) =>
                  Object.freeze(current.filter((item) => item.row_id !== addon.row_id)),
                )
              }
              disabled={busy}
            >
              移除
            </Button>
          </article>
        ))}
      </div>
      <div className="ld-settings-form__actions">
        <Button
          variant="secondary"
          type="button"
          onClick={() =>
            setAddons((current) => Object.freeze([...current, newAddon(current.length)]))
          }
          disabled={busy || !loaded}
        >
          添加附加项
        </Button>
        <Button
          variant="primary"
          type="button"
          onClick={() => void save()}
          disabled={busy || !loaded}
        >
          {busy ? "提交中…" : "保存计价设置"}
        </Button>
        <Button variant="ghost" type="button" onClick={() => void reload()} disabled={busy}>
          重新读取
        </Button>
      </div>
      <p className="ld-shell-main__hint" role="status">
        当前版本 {policy.version}；加急 <MoneyText fen={policy.urgent_cents} />
        ，运费 <MoneyText fen={policy.freight_cents} />。
      </p>
      <StepUpConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        authClient={authClient}
        confirmRef={pending?.confirmRef ?? ""}
        currentStaffId={session.session.staff_id}
        commandLabel="修改柜台计价"
        summary={
          pending === null ? undefined : (
            <p>
              加急 <MoneyText fen={pending.body.urgent_cents} />
              ，运费 <MoneyText fen={pending.body.freight_cents} />
              ，附加项 {pending.body.addons.length} 个。
            </p>
          )
        }
        onApproved={() => {
          const ref = pending?.confirmRef;
          if (ref !== undefined) void finish(ref);
        }}
      />
    </section>
  );
}
