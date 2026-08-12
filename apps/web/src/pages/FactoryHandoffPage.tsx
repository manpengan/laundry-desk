import type {
  FactoryBatchCancelInput,
  FactoryHandoffBatchGetResult,
  FactoryHandoffBatchesListResult,
  FactoryHandoffConfirmationSummary,
  FactoryHandoffDiscrepancyResolveInput,
  GarmentQualityReworkReason,
} from "@laundry/contracts";
import { Button, useToast } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";
import { FactoryBatchDetail } from "./FactoryBatchDetail.js";
import { FactoryBatchOverview } from "./FactoryBatchOverview.js";
import { FactoryHandoffConfirmation } from "./FactoryHandoffConfirmation.js";
import {
  appendUniqueBarcode,
  nextFactoryCheckpoint,
  parseFactoryBatchDetail,
  parseFactoryBatchList,
} from "./factory-handoff-model.js";

type PendingFactoryAction = Readonly<{
  confirmRef: string;
  command: string;
  label: string;
  kind: "confirm" | "step_up";
  summary: FactoryHandoffConfirmationSummary;
}>;

export type FactoryHandoffPageProps = Readonly<{
  queryClient: QueryPort;
  commandClient: CommandPort;
  authClient: AuthClient;
  session: SessionView;
}>;

function factorySummary(value: unknown): FactoryHandoffConfirmationSummary | null {
  return typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "factory_handoff"
    ? (value as FactoryHandoffConfirmationSummary)
    : null;
}

export function FactoryHandoffPage({
  queryClient,
  commandClient,
  authClient,
  session,
}: FactoryHandoffPageProps) {
  const toast = useToast();
  const [overview, setOverview] = useState<FactoryHandoffBatchesListResult>({
    batches: [],
    eligible_garments: [],
  });
  const [detail, setDetail] = useState<FactoryHandoffBatchGetResult | null>(null);
  const [selectedGarments, setSelectedGarments] = useState<ReadonlySet<string>>(() => new Set());
  const [factoryCode, setFactoryCode] = useState("");
  const [scanDraft, setScanDraft] = useState("");
  const [scannedBarcodes, setScannedBarcodes] = useState<readonly string[]>([]);
  const [qcSelected, setQcSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [qcReason, setQcReason] = useState<GarmentQualityReworkReason>("stain_remaining");
  const [cancelReason, setCancelReason] =
    useState<FactoryBatchCancelInput["reason_code"]>("operational_error");
  const [discrepancyReason, setDiscrepancyReason] =
    useState<FactoryHandoffDiscrepancyResolveInput["reason_code"]>("exception_accepted");
  const [pending, setPending] = useState<PendingFactoryAction | null>(null);
  const [busy, setBusy] = useState(false);

  const loadOverview = useCallback(async () => {
    setBusy(true);
    try {
      const response = await queryClient.execute<unknown>("fulfillment.batches.list", {
        limit: 20,
      });
      if (!response.ok) {
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      const parsed = parseFactoryBatchList(response.data);
      if (parsed === null) {
        toast.push("交接批次响应格式错误", "error");
        return;
      }
      setOverview(parsed);
      setSelectedGarments((current) => {
        const eligibleIds = new Set(parsed.eligible_garments.map(({ garment_id }) => garment_id));
        return new Set([...current].filter((id) => eligibleIds.has(id)));
      });
    } finally {
      setBusy(false);
    }
  }, [queryClient, toast]);

  const loadDetail = useCallback(
    async (batchId: string) => {
      setBusy(true);
      try {
        const response = await queryClient.execute<unknown>("fulfillment.batch.get", {
          batch_id: batchId,
        });
        if (!response.ok) {
          toast.push(response.error.message ?? response.error.code, "error");
          return;
        }
        const parsed = parseFactoryBatchDetail(response.data);
        if (parsed === null) {
          toast.push("交接批次详情格式错误", "error");
          return;
        }
        setDetail(parsed);
        setScannedBarcodes(Object.freeze([]));
        setScanDraft("");
        setQcSelected(new Set());
      } finally {
        setBusy(false);
      }
    },
    [queryClient, toast],
  );

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const afterMutation = useCallback(async () => {
    setPending(null);
    setSelectedGarments(new Set());
    await loadOverview();
    if (detail !== null) await loadDetail(detail.batch.batch_id);
  }, [detail, loadDetail, loadOverview]);

  const execute = useCallback(
    async (command: string, input: unknown, label: string, confirmRef?: string) => {
      setBusy(true);
      try {
        const response = await commandClient.execute<unknown>(
          command,
          confirmRef === undefined ? input : {},
          confirmRef === undefined ? undefined : { confirmRef },
        );
        if (response.ok) {
          toast.push(`${label}完成`, "success");
          await afterMutation();
          return;
        }
        if (isStepUpRequired(response)) {
          const summary = factorySummary(response.error.detail.summary);
          if (summary === null) {
            toast.push("服务端未返回可核对的交接摘要", "error");
            return;
          }
          setPending(
            Object.freeze({
              confirmRef: response.error.detail.confirm_ref,
              command,
              label,
              kind: response.error.code === "POLICY_STEP_UP_REQUIRED" ? "step_up" : "confirm",
              summary,
            }),
          );
          return;
        }
        toast.push(response.error.message ?? response.error.code, "error");
      } finally {
        setBusy(false);
      }
    },
    [afterMutation, commandClient, toast],
  );

  const createBatch = useCallback(() => {
    void execute(
      "fulfillment.batch.create",
      { factory_code: factoryCode.trim(), garment_ids: [...selectedGarments] },
      "创建交接批次",
    );
  }, [execute, factoryCode, selectedGarments]);

  const recordCheckpoint = useCallback(() => {
    if (detail === null) return;
    const checkpoint = nextFactoryCheckpoint(detail.batch.status);
    if (checkpoint === null) return;
    const garmentIds = detail.manifest
      .filter(({ member_state }) => member_state === "active")
      .map(({ garment_id }) => garment_id);
    void execute(
      "fulfillment.handoff.checkpoint.record",
      {
        batch_id: detail.batch.batch_id,
        checkpoint,
        expected_version: detail.batch.version,
        garment_ids: garmentIds,
        scanned_barcodes: [...scannedBarcodes],
      },
      "提交交接清点",
    );
  }, [detail, execute, scannedBarcodes]);

  const resolveDiscrepancy = useCallback(() => {
    if (detail?.latest_attempt?.outcome !== "discrepancy") return;
    const missing = new Set(detail.latest_attempt.missing_barcodes);
    const missingIds = detail.manifest
      .filter(({ barcode }) => missing.has(barcode))
      .map(({ garment_id }) => garment_id);
    void execute(
      "fulfillment.handoff.discrepancy.resolve",
      {
        batch_id: detail.batch.batch_id,
        attempt_id: detail.latest_attempt.attempt_id,
        expected_version: detail.batch.version,
        garment_ids: missingIds,
        reason_code: discrepancyReason,
      },
      "处置交接差异",
    );
  }, [detail, discrepancyReason, execute]);

  const recordQuality = useCallback(
    (outcome: "pass" | "rework") => {
      if (detail === null) return;
      const garmentIds = [...qcSelected];
      void execute(
        "fulfillment.quality_check.record",
        {
          batch_id: detail.batch.batch_id,
          expected_version: detail.batch.version,
          garment_ids: garmentIds,
          checks: garmentIds.map((garmentId) => ({
            garment_id: garmentId,
            outcome,
            reason_code: outcome === "pass" ? null : qcReason,
          })),
        },
        outcome === "pass" ? "记录质检合格" : "记录返工",
      );
    },
    [detail, execute, qcReason, qcSelected],
  );

  return (
    <main className="ld-shell-main lg-card ld-factory" id="main-content" tabIndex={-1}>
      <header className="ld-fulfillment__header">
        <div>
          <h1 className="ld-shell-main__title">店厂交接</h1>
          <p>四节点完整清点、差异冻结与质检返工；页面不显示客户身份。</p>
        </div>
        <Button
          variant="secondary"
          type="button"
          onClick={() => void loadOverview()}
          disabled={busy}
        >
          刷新
        </Button>
      </header>

      {detail === null ? (
        <FactoryBatchOverview
          batches={overview.batches}
          eligible={overview.eligible_garments}
          selectedGarments={selectedGarments}
          factoryCode={factoryCode}
          busy={busy}
          onFactoryCodeChange={setFactoryCode}
          onToggleGarment={(garmentId, selected) =>
            setSelectedGarments((current) => {
              const next = new Set(current);
              if (selected) next.add(garmentId);
              else next.delete(garmentId);
              return next;
            })
          }
          onCreate={createBatch}
          onOpenBatch={(batchId) => void loadDetail(batchId)}
        />
      ) : (
        <FactoryBatchDetail
          detail={detail}
          scanDraft={scanDraft}
          scannedBarcodes={scannedBarcodes}
          qcSelected={qcSelected}
          qcReason={qcReason}
          cancelReason={cancelReason}
          discrepancyReason={discrepancyReason}
          canResolveDiscrepancy={session.role === "admin"}
          busy={busy}
          onScanDraftChange={setScanDraft}
          onAddScan={() => {
            setScannedBarcodes((current) => appendUniqueBarcode(current, scanDraft));
            setScanDraft("");
          }}
          onRemoveScan={(barcode) =>
            setScannedBarcodes((current) => current.filter((value) => value !== barcode))
          }
          onRecordCheckpoint={recordCheckpoint}
          onResolve={resolveDiscrepancy}
          onToggleQc={(garmentId, selected) =>
            setQcSelected((current) => {
              const next = new Set(current);
              if (selected) next.add(garmentId);
              else next.delete(garmentId);
              return next;
            })
          }
          onQcReasonChange={setQcReason}
          onCancelReasonChange={setCancelReason}
          onDiscrepancyReasonChange={setDiscrepancyReason}
          onRecordQuality={recordQuality}
          onCancel={() =>
            void execute(
              "fulfillment.batch.cancel",
              {
                batch_id: detail.batch.batch_id,
                expected_version: detail.batch.version,
                reason_code: cancelReason,
              },
              "取消交接批次",
            )
          }
          onBack={() => setDetail(null)}
          onRefresh={() => void loadDetail(detail.batch.batch_id)}
        />
      )}

      <DangerConfirmDialog
        open={pending?.kind === "confirm"}
        title="确认店厂交接操作"
        description="请按服务端冻结的票号、条码、数量与摘要逐项核对。"
        summary={
          pending === null ? undefined : <FactoryHandoffConfirmation summary={pending.summary} />
        }
        confirmLabel="确认执行"
        serverConfirmation
        busy={busy}
        onClose={() => setPending(null)}
        onConfirm={() =>
          pending === null
            ? undefined
            : void execute(pending.command, {}, pending.label, pending.confirmRef)
        }
      />
      {pending?.kind === "step_up" ? (
        <StepUpConfirmDialog
          open
          onClose={() => setPending(null)}
          authClient={authClient}
          confirmRef={pending.confirmRef}
          currentStaffId={session.session.staff_id}
          commandLabel={pending.label}
          summary={<FactoryHandoffConfirmation summary={pending.summary} />}
          onApproved={() => void execute(pending.command, {}, pending.label, pending.confirmRef)}
        />
      ) : null}
    </main>
  );
}
