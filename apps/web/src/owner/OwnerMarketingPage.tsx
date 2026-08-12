import type { MarketingCampaign } from "@laundry/contracts";
import { EmptyState, Skeleton, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { StepUpAttemptToken } from "../shell/step-up-attempt-authority.js";
import { OwnerMarketingEditor } from "./OwnerMarketingEditor.js";
import { OwnerMarketingCampaignList } from "./OwnerMarketingCampaignList.js";
import { OwnerMarketingConfirmationDialogs } from "./OwnerMarketingConfirmationDialogs.js";
import {
  createMarketingRequestToken,
  createMarketingPendingAuthority,
  marketingAuthorityKey,
  marketingRequestMatches,
  marketingSessionScope,
  readMarketingCampaignSummary,
  type MarketingCampaignPending,
  type MarketingCampaignRequest,
  type MarketingRequestToken,
} from "./marketing-campaign-authority.js";
import {
  buildMarketingCampaignInput,
  campaignToDraft,
  emptyMarketingDraft,
  freezeMarketingAudience,
  loadMarketingCampaigns,
  parseAudienceFreeze,
  parseAudiencePreview,
  parseCampaignList,
  parseSetCampaign,
  previewMarketingAudience,
  setMarketingCampaign,
  type MarketingCampaignDraft,
} from "./owner-marketing-model.js";

type Preview = NonNullable<ReturnType<typeof parseAudiencePreview>>;

export type OwnerMarketingPageProps = Readonly<{
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient: QueryPort;
}>;

export function OwnerMarketingPage({
  session,
  authClient,
  commandClient,
  queryClient,
}: OwnerMarketingPageProps) {
  const toast = useToast();
  const sessionScope = marketingSessionScope(session);
  const [viewScope, setViewScope] = useState(sessionScope);
  const [campaigns, setCampaigns] = useState<readonly MarketingCampaign[] | null>(null);
  const [draft, setDraft] = useState<MarketingCampaignDraft>(() => emptyMarketingDraft());
  const [selected, setSelected] = useState<MarketingCampaign | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState<MarketingCampaignPending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const commandGeneration = useRef(0);
  const pendingAuthority = useRef(createMarketingPendingAuthority());
  const approvedConfirmation = useRef<string | null>(null);
  const currentScope = useRef(sessionScope);
  currentScope.current = sessionScope;

  const current = useCallback(
    (token: MarketingRequestToken, generation: number, authorityKey: string) =>
      marketingRequestMatches(token, generation, currentScope.current, authorityKey),
    [],
  );

  const load = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    const token = createMarketingRequestToken(generation, sessionScope, "campaign-list");
    setError(null);
    try {
      const response = await loadMarketingCampaigns(queryClient);
      if (!current(token, loadGeneration.current, "campaign-list")) return;
      if (!response.ok) {
        setError(response.error.message ?? response.error.code);
        return;
      }
      const parsed = parseCampaignList(response.data);
      if (parsed === null) {
        setError("活动清单返回格式无效");
        return;
      }
      setCampaigns(parsed);
      setSelected((value) =>
        value === null
          ? null
          : (parsed.find((item) => item.campaign_id === value.campaign_id) ?? null),
      );
    } catch {
      if (current(token, loadGeneration.current, "campaign-list")) {
        setError("无法读取营销活动，请检查服务连接");
      }
    }
  }, [current, queryClient, sessionScope]);

  useEffect(() => {
    loadGeneration.current += 1;
    previewGeneration.current += 1;
    commandGeneration.current += 1;
    pendingAuthority.current.invalidate();
    approvedConfirmation.current = null;
    setViewScope(sessionScope);
    setCampaigns(null);
    setDraft(emptyMarketingDraft());
    setSelected(null);
    setPreview(null);
    setPending(null);
    setBusy(false);
    void load();
    return () => {
      loadGeneration.current += 1;
      previewGeneration.current += 1;
      commandGeneration.current += 1;
      pendingAuthority.current.invalidate();
    };
  }, [load]);

  const invalidateInput = useCallback(() => {
    previewGeneration.current += 1;
    commandGeneration.current += 1;
    pendingAuthority.current.invalidate();
    approvedConfirmation.current = null;
    setBusy(false);
    setPreview(null);
    setPending(null);
  }, []);

  const updateDraft = <TKey extends keyof MarketingCampaignDraft>(
    key: TKey,
    value: MarketingCampaignDraft[TKey],
  ) => {
    invalidateInput();
    setDraft((currentDraft) => Object.freeze({ ...currentDraft, [key]: value }));
  };

  const selectCampaign = (campaign: MarketingCampaign) => {
    invalidateInput();
    setSelected(campaign);
    setDraft(campaignToDraft(campaign));
  };

  const applyResult = useCallback(
    async (action: MarketingCampaignRequest["action"], value: unknown) => {
      if (action === "marketing.campaign.set") {
        const campaign = parseSetCampaign(value);
        if (campaign === null) throw new Error("invalid campaign result");
        setSelected(campaign);
        setDraft(campaignToDraft(campaign));
        setPreview(null);
        toast.push("营销活动已保存", "success");
      } else {
        const snapshot = parseAudienceFreeze(value);
        if (snapshot === null) throw new Error("invalid snapshot result");
        toast.push(`受众已冻结：${snapshot.recipient_count} 人`, "success");
      }
      setPending(null);
      await load();
    },
    [load, toast],
  );

  const acceptResponse = useCallback(
    async (
      request: MarketingCampaignRequest,
      response: Awaited<ReturnType<CommandPort["execute"]>>,
      token: MarketingRequestToken,
    ) => {
      const key = marketingAuthorityKey(request);
      if (!current(token, commandGeneration.current, key)) return;
      if (response.ok) {
        await applyResult(request.action, response.data);
        return;
      }
      const detail = response.error.detail;
      const summary = readMarketingCampaignSummary(request, detail?.summary);
      if (
        typeof detail?.confirm_ref === "string" &&
        ["POLICY_CONFIRMATION_REQUIRED", "POLICY_STEP_UP_REQUIRED"].includes(response.error.code) &&
        summary !== null
      ) {
        const snapshot = Object.freeze({
          request,
          confirmRef: detail.confirm_ref,
          stepUp: response.error.code === "POLICY_STEP_UP_REQUIRED",
          actionGeneration: token.generation,
          summary,
        }) as MarketingCampaignPending;
        pendingAuthority.current.begin(snapshot, token.sessionScope);
        setPending(snapshot);
        return;
      }
      toast.push(
        summary === null && detail?.confirm_ref !== undefined
          ? "服务端未返回可核对的完整营销操作，请勿确认"
          : (response.error.message ?? response.error.code),
        "error",
      );
    },
    [applyResult, current, toast],
  );

  const runCommand = useCallback(
    async (request: MarketingCampaignRequest) => {
      const generation = commandGeneration.current + 1;
      commandGeneration.current = generation;
      const key = marketingAuthorityKey(request);
      const token = createMarketingRequestToken(generation, sessionScope, key);
      setBusy(true);
      try {
        const response =
          request.action === "marketing.campaign.set"
            ? await setMarketingCampaign(commandClient, request.input)
            : await freezeMarketingAudience(commandClient, request.input);
        await acceptResponse(request, response, token);
      } catch {
        if (current(token, commandGeneration.current, key)) {
          toast.push("营销操作失败，请检查服务连接或重新预览", "error");
        }
      } finally {
        if (current(token, commandGeneration.current, key)) setBusy(false);
      }
    },
    [acceptResponse, commandClient, current, sessionScope, toast],
  );

  const save = () => {
    if (busy) return;
    const built = buildMarketingCampaignInput(draft);
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    void runCommand(Object.freeze({ action: "marketing.campaign.set", input: built.input }));
  };

  const runPreview = async () => {
    if (selected === null || busy) return;
    const authority = Object.freeze({
      campaign_id: selected.campaign_id,
      expected_version: selected.version,
    });
    const key = marketingAuthorityKey(authority);
    const generation = previewGeneration.current + 1;
    previewGeneration.current = generation;
    const token = createMarketingRequestToken(generation, sessionScope, key);
    setBusy(true);
    try {
      const response = await previewMarketingAudience(queryClient, selected);
      if (!current(token, previewGeneration.current, key)) return;
      if (!response.ok) {
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      const parsed = parseAudiencePreview(response.data);
      if (
        parsed === null ||
        parsed.campaign_id !== selected.campaign_id ||
        parsed.campaign_version !== selected.version ||
        parsed.audience_rule_sha256 !== selected.audience_rule_sha256
      ) {
        throw new Error("invalid preview result");
      }
      setPreview(parsed);
    } catch {
      if (current(token, previewGeneration.current, key)) {
        toast.push("无法预览受众，请检查活动版本", "error");
      }
    } finally {
      if (current(token, previewGeneration.current, key)) setBusy(false);
    }
  };

  const freeze = () => {
    if (selected === null || preview === null || busy) return;
    void runCommand(
      Object.freeze({
        action: "marketing.campaign.audience.freeze",
        input: Object.freeze({
          campaign_id: selected.campaign_id,
          expected_version: selected.version,
          preview_digest: preview.audience_digest,
          expected_recipient_count: preview.recipient_count,
        }),
      }),
    );
  };

  const resume = async (
    snapshot: MarketingCampaignPending,
    expectedStepUp?: StepUpAttemptToken,
  ) => {
    if (busy) return;
    if (
      !pendingAuthority.current.matches(
        snapshot,
        currentScope.current,
        commandGeneration.current,
        expectedStepUp,
      )
    )
      return;
    pendingAuthority.current.invalidate();
    const request = snapshot.request;
    const key = marketingAuthorityKey(request);
    const generation = commandGeneration.current + 1;
    commandGeneration.current = generation;
    const token = createMarketingRequestToken(generation, sessionScope, key);
    setBusy(true);
    try {
      const response = await commandClient.execute<unknown>(
        request.action,
        {},
        {
          confirmRef: snapshot.confirmRef,
        },
      );
      if (!current(token, commandGeneration.current, key)) return;
      if (!response.ok) {
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      await applyResult(request.action, response.data);
    } catch {
      if (current(token, commandGeneration.current, key)) {
        toast.push("无法完成确认，请重新操作", "error");
      }
    } finally {
      approvedConfirmation.current = null;
      if (current(token, commandGeneration.current, key)) setBusy(false);
    }
  };

  const closePending = () => {
    if (pending !== null && approvedConfirmation.current === pending.confirmRef) {
      approvedConfirmation.current = null;
      setPending(null);
      return;
    }
    pendingAuthority.current.invalidate();
    commandGeneration.current += 1;
    setPending(null);
  };

  if (viewScope !== sessionScope) return <Skeleton lines={8} rounded="md" />;
  if (campaigns === null && error === null) return <Skeleton lines={8} rounded="md" />;
  if (campaigns === null) {
    return <EmptyState title="无法读取营销活动" description={error ?? "查询失败"} />;
  }
  return (
    <div className="ld-marketing-page" data-testid="owner-marketing">
      <OwnerMarketingCampaignList
        campaigns={campaigns}
        onSelect={selectCampaign}
        onNew={() => {
          invalidateInput();
          setSelected(null);
          setDraft(emptyMarketingDraft());
        }}
      />
      <OwnerMarketingEditor
        draft={draft}
        busy={busy || pending !== null}
        hasSelected={selected !== null}
        preview={preview}
        onChange={updateDraft}
        onSave={save}
        onPreview={() => void runPreview()}
        onFreeze={freeze}
      />
      <OwnerMarketingConfirmationDialogs
        pending={pending}
        busy={busy}
        authClient={authClient}
        currentStaffId={session.session.staff_id}
        onClose={closePending}
        onResume={(snapshot) => void resume(snapshot)}
        onApproved={(snapshot) => {
          const token = pendingAuthority.current.currentStepUp();
          if (token === null) return;
          approvedConfirmation.current = snapshot.confirmRef;
          void resume(snapshot, token);
        }}
      />
    </div>
  );
}
