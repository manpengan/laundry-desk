import { useCallback, useEffect, useState } from "react";
import { useToast } from "@laundry/ui";
import type { QueryPort } from "../commands/types.js";
import { parseOrderListRows, unwrapQueryResult, type OrderListRowView } from "./OrdersList.js";
import {
  EMPTY_PRICING_POLICY,
  readPricingPolicy,
  type PricingPolicyView,
} from "./pricing-policy-model.js";

export function useReceiveResources(queryClient: QueryPort | undefined) {
  const toast = useToast();
  const [policy, setPolicy] = useState<PricingPolicyView>(EMPTY_PRICING_POLICY);
  const [policyReady, setPolicyReady] = useState(queryClient === undefined);
  const [draftRows, setDraftRows] = useState<readonly OrderListRowView[]>([]);
  const [draftLoading, setDraftLoading] = useState(false);
  const reloadPolicy = useCallback(async () => {
    if (queryClient === undefined) return;
    try {
      const response = await queryClient.execute<unknown>("pricing.policy.get", {});
      if (!response.ok) {
        setPolicyReady(false);
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      const parsed = readPricingPolicy(response.data);
      if (parsed === null) {
        setPolicyReady(false);
        toast.push("计价设置返回格式无效", "error");
        return;
      }
      setPolicy(parsed);
      setPolicyReady(true);
    } catch {
      setPolicyReady(false);
      toast.push("无法读取计价设置，请检查服务连接", "error");
    }
  }, [queryClient, toast]);

  useEffect(() => {
    void reloadPolicy();
  }, [reloadPolicy]);

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

  return { policy, policyReady, draftRows, draftLoading, reloadDrafts };
}
