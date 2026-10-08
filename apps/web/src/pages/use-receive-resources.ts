import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@laundry/ui";
import type { QueryPort } from "../commands/types.js";
import { parseOrderListRows, unwrapQueryResult, type OrderListRowView } from "./OrdersList.js";
import {
  EMPTY_PRICING_POLICY,
  readPricingPolicy,
  type PricingPolicyView,
} from "./pricing-policy-model.js";

/**
 * Without a pricing policy, 开单 and 挂单 stay disabled to avoid wrong prices.
 * A failed read (service restart, token refresh after a forced kill) retries on
 * its own instead of disabling the page until it is remounted: 1s, 2s, 4s, 8s,
 * then every 15s while 开单 stays open.
 */
export const POLICY_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  1000, 2000, 4000, 8000, 15_000,
]);

/** Pure: wait before the next read after `failures` consecutive failures (≥ 1). */
export function policyRetryDelay(failures: number): number {
  const index = Math.min(Math.max(failures - 1, 0), POLICY_RETRY_DELAYS_MS.length - 1);
  return POLICY_RETRY_DELAYS_MS[index] ?? 15_000;
}

type PolicyRead = Readonly<{ policy: PricingPolicyView } | { problem: string }>;

async function readPolicyOnce(queryClient: QueryPort): Promise<PolicyRead> {
  try {
    const response = await queryClient.execute<unknown>("pricing.policy.get", {});
    if (!response.ok) return { problem: response.error.message ?? response.error.code };
    const policy = readPricingPolicy(response.data);
    return policy === null ? { problem: "计价设置返回格式无效" } : { policy };
  } catch {
    return { problem: "无法读取计价设置，请检查服务连接" };
  }
}

function usePricingPolicy(queryClient: QueryPort | undefined) {
  const toast = useToast();
  const [policy, setPolicy] = useState<PricingPolicyView>(EMPTY_PRICING_POLICY);
  const [policyReady, setPolicyReady] = useState(queryClient === undefined);
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    if (queryClient === undefined) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void readPolicyOnce(queryClient).then((read) => {
      if (!alive) return;
      if ("policy" in read) {
        failures.current = 0;
        setPolicy(read.policy);
        setPolicyReady(true);
        return;
      }
      failures.current += 1;
      setPolicyReady(false);
      // One toast per outage; the panel hint stays visible while retrying.
      if (failures.current === 1) toast.push(read.problem, "error");
      timer = setTimeout(
        () => setAttempt((value) => value + 1),
        policyRetryDelay(failures.current),
      );
    });
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [queryClient, toast, attempt]);

  const reloadPolicy = useCallback(() => setAttempt((value) => value + 1), []);
  return { policy, policyReady, reloadPolicy };
}

export function useReceiveResources(queryClient: QueryPort | undefined) {
  const toast = useToast();
  const { policy, policyReady, reloadPolicy } = usePricingPolicy(queryClient);
  const [draftRows, setDraftRows] = useState<readonly OrderListRowView[]>([]);
  const [draftLoading, setDraftLoading] = useState(false);

  const reloadDrafts = useCallback(async () => {
    if (queryClient === undefined) return;
    setDraftLoading(true);
    try {
      const response = await queryClient.execute<unknown>("order.list", {
        status: "draft",
        limit: 20,
      });
      if (!response.ok) {
        setDraftRows([]);
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      const parsed = parseOrderListRows(unwrapQueryResult(response.data));
      if (parsed === null) {
        setDraftRows([]);
        toast.push("挂单列表返回格式无效", "error");
        return;
      }
      setDraftRows(Object.freeze(parsed.filter((row) => row.status === "draft")));
    } catch {
      setDraftRows([]);
      toast.push("无法读取挂单列表，请检查服务连接", "error");
    } finally {
      setDraftLoading(false);
    }
  }, [queryClient, toast]);

  useEffect(() => {
    void reloadDrafts();
  }, [reloadDrafts]);

  return { policy, policyReady, reloadPolicy, draftRows, draftLoading, reloadDrafts };
}
