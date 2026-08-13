import type { MarketingCampaign } from "@laundry/contracts";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { MarketingCampaignPending } from "./marketing-campaign-authority.js";
import { OwnerMarketingCampaignList } from "./OwnerMarketingCampaignList.js";
import { OwnerMarketingConfirmationDialogs } from "./OwnerMarketingConfirmationDialogs.js";
import { OwnerMarketingCouponReversal } from "./OwnerMarketingCouponReversal.js";
import { OwnerMarketingCoupons } from "./OwnerMarketingCoupons.js";
import { OwnerMarketingEditor, type OwnerMarketingEditorProps } from "./OwnerMarketingEditor.js";
import { OwnerMarketingGroupBuy } from "./OwnerMarketingGroupBuy.js";
import { OwnerMarketingReferral } from "./OwnerMarketingReferral.js";
import type { MarketingCampaignDraft } from "./owner-marketing-model.js";

export type OwnerMarketingWorkspaceProps = Readonly<{
  campaigns: readonly MarketingCampaign[];
  selected: MarketingCampaign | null;
  draft: MarketingCampaignDraft;
  preview: OwnerMarketingEditorProps["preview"];
  busy: boolean;
  pending: MarketingCampaignPending | null;
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient: QueryPort;
  onSelect: (campaign: MarketingCampaign) => void;
  onNew: () => void;
  onDraftChange: OwnerMarketingEditorProps["onChange"];
  onSave: () => void;
  onPreview: () => void;
  onFreeze: () => void;
  onChanged: () => Promise<void>;
  onClosePending: () => void;
  onResume: (snapshot: MarketingCampaignPending) => void;
  onApproved: (snapshot: MarketingCampaignPending) => void;
}>;

export function OwnerMarketingWorkspace(props: OwnerMarketingWorkspaceProps) {
  return (
    <div className="ld-marketing-page" data-testid="owner-marketing">
      <OwnerMarketingCampaignList
        campaigns={props.campaigns}
        onSelect={props.onSelect}
        onNew={props.onNew}
      />
      <OwnerMarketingEditor
        draft={props.draft}
        busy={props.busy || props.pending !== null}
        hasSelected={props.selected !== null}
        preview={props.preview}
        onChange={props.onDraftChange}
        onSave={props.onSave}
        onPreview={props.onPreview}
        onFreeze={props.onFreeze}
      />
      <OwnerMarketingCoupons
        campaign={props.selected}
        session={props.session}
        authClient={props.authClient}
        commandClient={props.commandClient}
        queryClient={props.queryClient}
        onChanged={props.onChanged}
      />
      <OwnerMarketingCouponReversal
        session={props.session}
        authClient={props.authClient}
        commandClient={props.commandClient}
      />
      <OwnerMarketingReferral
        campaign={props.selected}
        session={props.session}
        authClient={props.authClient}
        commandClient={props.commandClient}
        onChanged={props.onChanged}
      />
      <OwnerMarketingGroupBuy
        session={props.session}
        authClient={props.authClient}
        commandClient={props.commandClient}
      />
      <OwnerMarketingConfirmationDialogs
        pending={props.pending}
        busy={props.busy}
        authClient={props.authClient}
        currentStaffId={props.session.session.staff_id}
        onClose={props.onClosePending}
        onResume={props.onResume}
        onApproved={props.onApproved}
      />
    </div>
  );
}
