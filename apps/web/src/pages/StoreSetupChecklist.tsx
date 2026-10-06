import { Button } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryPort } from "../commands/types.js";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { unwrapCommandResult } from "./order-form.js";
import { readPricingPolicy } from "./pricing-policy-model.js";

type SetupStatus = Readonly<{ catalog: "loading" | "ready" | "empty" | "error"; pricing: string }>;
const INITIAL: SetupStatus = { catalog: "loading", pricing: "正在读取" };
export function StoreSetupChecklist({
  queryClient,
  authClient,
  session,
  onSelect,
}: Readonly<{
  queryClient: QueryPort;
  authClient: AuthClient;
  session: SessionView;
  onSelect: (id: string) => void;
}>) {
  const [status, setStatus] = useState<SetupStatus>(INITIAL);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setStatus(INITIAL);
    const results = await Promise.allSettled([
      queryClient.execute("catalog.items.list", { limit: 1 }),
      queryClient.execute("pricing.policy.get", {}),
    ]);
    if (current !== generation.current) return;
    const catalogResponse = results[0];
    const payload =
      catalogResponse.status === "fulfilled" && catalogResponse.value.ok
        ? unwrapCommandResult(catalogResponse.value.data)
        : null;
    const catalog =
      typeof payload === "object" &&
      payload !== null &&
      "items" in payload &&
      Array.isArray(payload.items)
        ? payload.items.length > 0
          ? "ready"
          : "empty"
        : "error";
    const pricingResponse = results[1];
    const policy =
      pricingResponse.status === "fulfilled" && pricingResponse.value.ok
        ? readPricingPolicy(pricingResponse.value.data)
        : null;
    setStatus({
      catalog,
      pricing: policy === null ? "读取失败，请重试" : `已读取版本 ${policy.version}，请核对金额`,
    });
  }, [queryClient]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  const approver = authClient
    .listSwitchableStaff()
    .some((staff) => staff.role === "admin" && staff.staff_id !== session.session.staff_id);
  const labels = {
    loading: "正在读取",
    ready: "已有可用价目",
    empty: "尚无价目，开单前先添加",
    error: "读取失败，请重试",
  } as const;
  return (
    <details className="ld-setup-checklist lg-card" open={status.catalog === "empty"}>
      <summary>
        开店准备 <span>{labels[status.catalog]}</span>
      </summary>
      <ol>
        <li>
          <Button variant="ghost" onClick={() => onSelect("settings-catalog")}>
            1. 添加衣物价目
          </Button>
          <span>{labels[status.catalog]}</span>
        </li>
        <li>
          <Button variant="ghost" onClick={() => onSelect("settings-pricing")}>
            2. 核对计价规则
          </Button>
          <span>{status.pricing}</span>
        </li>
        <li>
          <Button variant="ghost" onClick={() => onSelect("settings-staff")}>
            3. 检查员工与复核人
          </Button>
          <span>
            {approver
              ? "当前目录已有其他店长，请确认其可现场复核"
              : "当前目录没有其他店长，请先配置复核账号"}
          </span>
        </li>
      </ol>
      <p>
        备份状态请到 Windows Runtime
        维护入口查看最近成功时间，并定期保留离机副本。扫码支付、短信、AI 可按需配置。
      </p>
      <Button variant="secondary" size="sm" onClick={() => void refresh()}>
        重新检查准备情况
      </Button>
    </details>
  );
}
