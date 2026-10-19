/**
 * 工作台 (ADR-100): scan-first counter home. The scan field and the two counter actions
 * lead; today's figures, the work queue and the side cards follow, each loading on its own.
 */

import { Icon } from "@laundry/ui";
import { useRef, useState } from "react";

import type { SessionView } from "../auth/types.js";
import type { QueryPort } from "../commands/types.js";
import type { NavItemId } from "../nav.js";
import { useScanFocus } from "./use-scan-focus.js";
import { useWorkbenchData, type QueueTabId } from "./workbench/use-workbench-data.js";
import { businessDayLabel, greetingFor, workbenchRole } from "./workbench/workbench-model.js";
import { WorkbenchHero } from "./workbench/WorkbenchHero.js";
import { WorkbenchKpis } from "./workbench/WorkbenchKpis.js";
import { WorkbenchQueue } from "./workbench/WorkbenchQueue.js";
import { AgendaCard, ProductionCard, RhythmCard } from "./workbench/WorkbenchSide.js";

export type CounterWorkbenchProps = Readonly<{
  queryClient: QueryPort;
  /** Role, store features and display name; without it the workbench shows the staff view. */
  session?: SessionView | undefined;
  onNavigate: (id: NavItemId) => void;
  onOpenPickup: (orderId: string) => void;
  onOpenPickupLookup: (key: string) => void;
  /** Open 客户 with this lookup (and select the customer when known). */
  onOpenCustomer?: (query: string, customerId?: string) => void;
}>;

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function CounterWorkbench({
  queryClient,
  session,
  onNavigate,
  onOpenPickup,
  onOpenPickupLookup,
  onOpenCustomer,
}: CounterWorkbenchProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  useScanFocus(rootRef, 'input[name="quick-pickup"]');
  const owner = session !== undefined && workbenchRole(session.role) === "owner";
  const fulfillment = session?.features.fulfillment_enabled === true;
  const delivery = session?.features.delivery_enabled === true;
  const { data, refresh } = useWorkbenchData(queryClient, { owner, fulfillment, delivery });
  const [tab, setTab] = useState<QueueTabId>("open");

  const day =
    data.summary === undefined || data.summary === null
      ? null
      : businessDayLabel(data.summary.business_date);
  const meta = `${greetingFor(new Date().getHours())}，${session?.display.staff_name ?? "欢迎回来"}${day === null ? "" : ` · ${day}`}`;
  const live = data.busy
    ? "正在更新…"
    : data.refreshedAt === null
      ? "正在读取…"
      : `实时 · ${clock(data.refreshedAt)} 更新`;

  return (
    <main
      ref={rootRef}
      className="ld-shell-main ld-workbench ld-wb"
      id="main-content"
      tabIndex={-1}
    >
      <h1 className="ld-shell-main__title">工作台</h1>
      <p className="ld-wb-meta">{meta}</p>
      <div className="ld-wb-tools">
        <span className="ld-wb-live" role="status" data-busy={data.busy ? "true" : undefined}>
          {live}
        </span>
        <button
          type="button"
          className="ld-wb-refresh"
          aria-label="刷新"
          title="刷新"
          disabled={data.busy}
          onClick={() => void refresh()}
        >
          <Icon name="refresh" size={16} />
        </button>
      </div>
      <WorkbenchHero
        scan={{
          queryClient,
          onOpenPickup,
          onOpenPickupLookup,
          ...(onOpenCustomer === undefined ? {} : { onOpenCustomer }),
        }}
        drafts={data.queues.drafts?.total}
        onNavigate={onNavigate}
      />
      <WorkbenchKpis data={data} owner={owner} onNavigate={onNavigate} />
      <div className="ld-wb-body">
        <WorkbenchQueue
          data={data}
          fulfillment={fulfillment}
          tab={tab}
          onTab={setTab}
          onOpenPickup={onOpenPickup}
          onNavigate={onNavigate}
        />
        <div className="ld-wb-side">
          <RhythmCard rhythm={data.rhythm} />
          <ProductionCard
            stages={fulfillment ? data.stages : null}
            overdue={data.queues.overdue?.total ?? null}
            onNavigate={onNavigate}
          />
          <AgendaCard
            appointments={delivery ? data.appointments : null}
            shift={owner ? data.shift : null}
            onNavigate={onNavigate}
          />
        </div>
      </div>
    </main>
  );
}
