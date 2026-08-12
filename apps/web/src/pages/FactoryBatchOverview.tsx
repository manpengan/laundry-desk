import type { FactoryHandoffBatchSummary, FactoryHandoffEligibleGarment } from "@laundry/contracts";
import { Button, Input } from "@laundry/ui";

import { FACTORY_BATCH_STATUS_LABELS } from "./factory-handoff-model.js";

export type FactoryBatchOverviewProps = Readonly<{
  batches: readonly FactoryHandoffBatchSummary[];
  eligible: readonly FactoryHandoffEligibleGarment[];
  selectedGarments: ReadonlySet<string>;
  factoryCode: string;
  busy: boolean;
  onFactoryCodeChange: (value: string) => void;
  onToggleGarment: (garmentId: string, selected: boolean) => void;
  onCreate: () => void;
  onOpenBatch: (batchId: string) => void;
}>;

export function FactoryBatchOverview({
  batches,
  eligible,
  selectedGarments,
  factoryCode,
  busy,
  onFactoryCodeChange,
  onToggleGarment,
  onCreate,
  onOpenBatch,
}: FactoryBatchOverviewProps) {
  return (
    <div className="ld-factory-overview">
      <section className="ld-factory-card" aria-label="创建工厂交接批次">
        <h2>组建出厂清单</h2>
        <Input
          name="factory-code"
          label="工厂代码"
          value={factoryCode}
          onChange={(event) => onFactoryCodeChange(event.target.value.toUpperCase())}
          hint="仅大写字母、数字、点、横线或下划线"
          disabled={busy}
        />
        <p>已选 {selectedGarments.size} 件；51–100 件需要另一位管理员现场复核。</p>
        <div className="ld-factory-garments" data-testid="factory-eligible-garments">
          {eligible.map((garment) => (
            <label key={garment.garment_id} className="ld-factory-garment">
              <input
                type="checkbox"
                checked={selectedGarments.has(garment.garment_id)}
                onChange={(event) => onToggleGarment(garment.garment_id, event.target.checked)}
                disabled={busy}
              />
              <strong>{garment.ticket_no}</strong>
              <span>{garment.barcode}</span>
              <small>{garment.status}</small>
            </label>
          ))}
          {eligible.length === 0 ? <p>当前没有可加入交接批次的衣物。</p> : null}
        </div>
        <Button
          type="button"
          onClick={onCreate}
          disabled={busy || selectedGarments.size === 0 || factoryCode.trim().length === 0}
        >
          创建交接批次
        </Button>
      </section>

      <section className="ld-factory-card" aria-label="工厂交接批次列表">
        <h2>交接批次</h2>
        <div className="ld-factory-batches">
          {batches.map((batch) => (
            <button
              key={batch.batch_id}
              type="button"
              className="ld-factory-batch"
              onClick={() => onOpenBatch(batch.batch_id)}
              disabled={busy}
            >
              <strong>{batch.factory_code}</strong>
              <span>{FACTORY_BATCH_STATUS_LABELS[batch.status]}</span>
              <span>
                {batch.manifest_count} 件 · 异常 {batch.exception_count}
              </span>
              <small>版本 {batch.version}</small>
            </button>
          ))}
          {batches.length === 0 ? <p>还没有交接批次。</p> : null}
        </div>
      </section>
    </div>
  );
}
