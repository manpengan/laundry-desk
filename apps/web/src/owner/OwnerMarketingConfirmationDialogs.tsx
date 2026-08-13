import type { AuthClient } from "../auth/AuthClient.js";
import { DangerConfirmDialog } from "../pages/DangerConfirmDialog.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import {
  MarketingAudienceFreezeConfirmationDetails,
  MarketingCampaignSetConfirmationDetails,
} from "./MarketingCampaignConfirmationDetails.js";
import type { MarketingCampaignPending } from "./marketing-campaign-authority.js";

export function OwnerMarketingConfirmationDialogs({
  pending,
  busy,
  authClient,
  currentStaffId,
  onClose,
  onResume,
  onApproved,
}: Readonly<{
  pending: MarketingCampaignPending | null;
  busy: boolean;
  authClient: AuthClient;
  currentStaffId: string;
  onClose: () => void;
  onResume: (pending: MarketingCampaignPending) => void;
  onApproved: (pending: MarketingCampaignPending) => void;
}>) {
  const summary =
    pending?.summary.kind === "marketing_campaign_set" ? (
      <MarketingCampaignSetConfirmationDetails summary={pending.summary} />
    ) : pending?.summary.kind === "marketing_audience_freeze" ? (
      <MarketingAudienceFreezeConfirmationDetails summary={pending.summary} />
    ) : undefined;
  return (
    <>
      <DangerConfirmDialog
        open={pending !== null && !pending.stepUp}
        title="确认营销变更"
        description="请逐项核对服务端冻结的活动、预算与受众权威。"
        summary={summary}
        confirmLabel="确认执行"
        busy={busy}
        serverConfirmation
        onClose={onClose}
        onConfirm={() => {
          if (pending !== null) onResume(pending);
        }}
      />
      <StepUpConfirmDialog
        open={pending?.stepUp === true}
        onClose={onClose}
        authClient={authClient}
        confirmRef={pending?.confirmRef ?? ""}
        currentStaffId={currentStaffId}
        commandLabel="高预算营销活动"
        summary={summary}
        onApproved={() => {
          if (pending !== null) onApproved(pending);
        }}
      />
    </>
  );
}
