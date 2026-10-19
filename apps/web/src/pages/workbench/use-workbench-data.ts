/** Workbench data hook (ADR-100): progressive, panel-by-panel loading with one refresh cycle. */

import { useCallback, useEffect, useReducer, useRef } from "react";

import type { QueryPort } from "../../commands/types.js";
import type { DeliveryAppointmentView } from "../delivery-appointment-model.js";
import type { ShiftClosingView } from "../shift-closing-view.js";
import type { DaySummaryView } from "../StatsPage.js";
import { useRequestLifetime } from "../use-request-lifetime.js";
import {
  loadDaySummary,
  loadDebtRows,
  loadGarments,
  loadOrderPage,
  loadOrderPages,
  loadShiftClosing,
  loadTodayAppointments,
  QUEUE_PAGE,
  type OrderFilter,
  type OrderRows,
} from "./workbench-loaders.js";
import {
  debtAging,
  groupGarmentsByOrder,
  PRODUCTION_PAGE,
  productionStages,
  receiptTimes,
  rhythmView,
  shiftBusinessDay,
  type DebtAging,
  type GarmentGroup,
  type RhythmView,
  type StageView,
} from "./workbench-model.js";

export type QueueTabId = "open" | "ready" | "overdue" | "debt" | "drafts";

/** undefined = still loading; null = unavailable for this session or store. */
export type WorkbenchData = Readonly<{
  busy: boolean;
  refreshedAt: number | null;
  summary: DaySummaryView | null | undefined;
  yesterday: DaySummaryView | null | undefined;
  queues: Readonly<Partial<Record<QueueTabId, OrderRows | null>>>;
  debt: DebtAging | null | undefined;
  groups: ReadonlyMap<string, GarmentGroup>;
  stages: readonly StageView[] | null | undefined;
  rhythm: RhythmView | null | undefined;
  appointments: readonly DeliveryAppointmentView[] | null | undefined;
  shift: ShiftClosingView | "open" | null | undefined;
}>;

export type WorkbenchOptions = Readonly<{
  owner: boolean;
  fulfillment: boolean;
  delivery: boolean;
}>;

type Patch = Partial<Omit<WorkbenchData, "queues">> &
  Readonly<{ queues?: Partial<Record<QueueTabId, OrderRows | null>> }>;

const INITIAL: WorkbenchData = Object.freeze({
  busy: false,
  refreshedAt: null,
  summary: undefined,
  yesterday: undefined,
  queues: Object.freeze({}),
  debt: undefined,
  groups: new Map<string, GarmentGroup>(),
  stages: undefined,
  rhythm: undefined,
  appointments: undefined,
  shift: undefined,
});

function reduce(state: WorkbenchData, patch: Patch): WorkbenchData {
  return Object.freeze({
    ...state,
    ...patch,
    queues: patch.queues === undefined ? state.queues : { ...state.queues, ...patch.queues },
  });
}

const AUTO_REFRESH_MS = 120_000;
const DEBT_PAGES = 4;
const DAY_PAGES = 4;
const OVERDUE_DAYS = 30;

function toRows(page: Awaited<ReturnType<typeof loadOrderPage>>): OrderRows | null {
  return page === null ? null : Object.freeze({ orders: page.orders, total: page.total });
}

/** Oldest rows of a filter first: the page at the end of the newest-first list, reversed. */
async function loadOldest(queryClient: QueryPort, filter: OrderFilter): Promise<OrderRows | null> {
  const first = await loadOrderPage(queryClient, filter, QUEUE_PAGE, 0);
  if (first === null) return null;
  const tail =
    first.total > QUEUE_PAGE
      ? await loadOrderPage(queryClient, filter, QUEUE_PAGE, first.total - QUEUE_PAGE)
      : first;
  const rows = (tail ?? first).orders;
  return Object.freeze({ orders: Object.freeze([...rows].reverse()), total: first.total });
}

/** Two bounded reads: garments ready to hand over, and garments still being processed. */
async function loadProduction(queryClient: QueryPort, apply: (patch: Patch) => void) {
  const [ready, early] = await Promise.all([
    loadGarments(queryClient, ["ready", "racked"]),
    loadGarments(queryClient, ["received", "washing"]),
  ]);
  apply({ groups: groupGarmentsByOrder([...(ready ?? []), ...(early ?? [])]) });
  if (ready === null || early === null) return null;
  const washing = early.filter((row) => row.status === "washing").length;
  return Object.freeze({
    received: early.length - washing,
    washing,
    ready: ready.length,
    earlyPageFull: early.length >= PRODUCTION_PAGE,
  });
}

async function loadDayDetails(
  queryClient: QueryPort,
  summary: DaySummaryView,
  options: WorkbenchOptions,
  apply: (patch: Patch) => void,
): Promise<void> {
  const day = summary.business_date;
  const previous = shiftBusinessDay(day, -1);
  const cutoff = shiftBusinessDay(day, -OVERDUE_DAYS);
  const now = new Date();
  await Promise.all([
    cutoff === null
      ? Promise.resolve()
      : loadOldest(queryClient, { status: "open", date_to: cutoff }).then((rows) =>
          apply({ queues: { overdue: rows } }),
        ),
    Promise.all([
      loadOrderPages(queryClient, { business_date: day }, DAY_PAGES),
      previous === null
        ? null
        : loadOrderPages(queryClient, { business_date: previous }, DAY_PAGES),
    ]).then(([today, yesterday]) =>
      apply({
        rhythm:
          today === null
            ? null
            : rhythmView(
                receiptTimes(today.orders),
                yesterday === null ? null : receiptTimes(yesterday.orders),
                now,
              ),
      }),
    ),
    options.owner && previous !== null
      ? loadDaySummary(queryClient, previous).then((yesterday) => apply({ yesterday }))
      : Promise.resolve(apply({ yesterday: null })),
    options.owner
      ? loadShiftClosing(queryClient, day).then((shift) => apply({ shift }))
      : Promise.resolve(apply({ shift: null })),
  ]);
}

function queueTasks(
  queryClient: QueryPort,
  options: WorkbenchOptions,
  apply: (patch: Patch) => void,
): Promise<unknown>[] {
  const queue = (id: QueueTabId, filter: OrderFilter) =>
    loadOrderPage(queryClient, filter, QUEUE_PAGE).then((page) =>
      apply({ queues: { [id]: toRows(page) } }),
    );
  return [
    queue("open", { status: "open" }),
    options.fulfillment
      ? queue("ready", { status: "open", ready_for_pickup: true })
      : Promise.resolve(),
    queue("drafts", { status: "draft" }),
    loadDebtRows(queryClient, DEBT_PAGES).then((rows) =>
      apply({
        queues: { debt: rows },
        debt: rows === null ? null : debtAging(rows.orders, rows.total, Date.now()),
      }),
    ),
    options.delivery
      ? loadTodayAppointments(queryClient, new Date()).then((appointments) =>
          apply({ appointments }),
        )
      : Promise.resolve(apply({ appointments: null })),
  ];
}

export function useWorkbenchData(queryClient: QueryPort, options: WorkbenchOptions) {
  const requests = useRequestLifetime(queryClient);
  const [data, dispatch] = useReducer(reduce, INITIAL);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const refresh = useCallback(async () => {
    const token = requests.begin();
    if (token === null) return;
    const apply = (patch: Patch) => {
      if (requests.isCurrent(token)) dispatch(patch);
    };
    const current = optionsRef.current;
    apply({ busy: true });
    const production = current.fulfillment
      ? loadProduction(queryClient, apply)
      : Promise.resolve(null);
    const summaryTask = loadDaySummary(queryClient).then(async (summary) => {
      apply({ summary });
      if (summary === null) {
        apply({ rhythm: null, yesterday: null, shift: null });
        return summary;
      }
      await loadDayDetails(queryClient, summary, current, apply);
      return summary;
    });
    const [summary, counts] = await Promise.all([
      summaryTask,
      production,
      ...queueTasks(queryClient, current, apply),
    ]);
    apply({
      stages:
        counts === null || summary === null
          ? null
          : productionStages(
              counts.received,
              counts.washing,
              counts.ready,
              summary.picked_garment_count,
              counts.earlyPageFull,
            ),
      busy: false,
      refreshedAt: Date.now(),
    });
  }, [queryClient, requests]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { data, refresh };
}
