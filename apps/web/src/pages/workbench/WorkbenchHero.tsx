/** 扫码区 (ADR-100): the scan field beside the two counter actions that start every visit. */

import { Icon, type IconName } from "@laundry/ui";

import type { NavItemId } from "../../nav.js";
import { ScanBox, type ScanBoxProps } from "./ScanBox.js";

function Tile({
  icon,
  title,
  hint,
  primary = false,
  onClick,
}: Readonly<{
  icon: IconName;
  title: string;
  hint: string;
  primary?: boolean;
  onClick: () => void;
}>) {
  return (
    <button
      type="button"
      className={primary ? "ld-wb-tile ld-wb-tile--primary lg-spec" : "ld-wb-tile lg-spec"}
      onClick={onClick}
    >
      <span className="ld-wb-tile__icon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <span className="ld-wb-tile__text">
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
    </button>
  );
}

export function WorkbenchHero({
  scan,
  drafts,
  onNavigate,
}: Readonly<{
  scan: ScanBoxProps;
  drafts: number | null | undefined;
  onNavigate: (id: NavItemId) => void;
}>) {
  return (
    <section className="ld-wb-card ld-wb-hero" aria-label="扫码与快捷操作">
      <ScanBox {...scan} />
      <div className="ld-wb-hero__actions">
        <Tile
          icon="receive"
          title="开单"
          hint="收衣出票 · Alt+2"
          primary
          onClick={() => onNavigate("receive")}
        />
        <Tile
          icon="pickup"
          title="取衣"
          hint="扫码直达 · Alt+3"
          onClick={() => onNavigate("pickup")}
        />
        <div className="ld-wb-hero__minor">
          <button type="button" className="ld-wb-minor" onClick={() => onNavigate("receive")}>
            <Icon name="layers" size={16} />
            挂单
            {drafts === null || drafts === undefined || drafts === 0 ? null : (
              <span className="ld-wb-count" data-tone="accent">
                {drafts}
              </span>
            )}
          </button>
          <button type="button" className="ld-wb-minor" onClick={() => onNavigate("orders")}>
            <Icon name="wallet" size={16} />
            收欠款
          </button>
        </div>
      </div>
    </section>
  );
}
