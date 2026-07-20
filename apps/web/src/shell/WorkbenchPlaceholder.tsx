import { MoneyText, StatusBadge } from "@laundry/ui";
import { navLabel, type NavItemId } from "../nav.js";

export type WorkbenchPlaceholderProps = {
  activeId: NavItemId;
};

/** Counter home stub — real pages land in M2; proves E2 MoneyText/StatusBadge wiring. */
export function WorkbenchPlaceholder({ activeId }: WorkbenchPlaceholderProps) {
  return (
    <main className="ld-shell-main lg-card">
      <h1 className="ld-shell-main__title">{navLabel(activeId)}</h1>
      <p className="ld-shell-main__hint">
        M1 骨架页：无业务数据。金额只走 MoneyText，状态色+形双编码。
      </p>
      <div className="ld-shell-demo-row">
        <div>
          <div className="ld-shell-demo-label">今日示例营业额</div>
          <MoneyText fen={128650} size="lg" />
        </div>
        <div>
          <div className="ld-shell-demo-label">件状态样例</div>
          <StatusBadge family="garment" status="ready" />
        </div>
        <div>
          <div className="ld-shell-demo-label">打印队列样例</div>
          <StatusBadge family="print" status="queued" />
        </div>
      </div>
    </main>
  );
}
