/** 今日看板 (ADR-100): owners see money against yesterday; counter staff see the day's work. */

import { Icon, MoneyText, type IconName } from "@laundry/ui";
import type { ReactNode } from "react";

import type { NavItemId } from "../../nav.js";
import { RollingCount, RollingMoney } from "../rolling-figures.js";
import type { DaySummaryView } from "../StatsPage.js";
import type { WorkbenchData } from "./use-workbench-data.js";
import { versusYesterday } from "./workbench-model.js";
import { AgingBar, HourBars, Meter, Ring } from "./workbench-visuals.js";

/** The old board used a dash while loading; acceptance waits for it to clear. */
const LOADING = "—";
const MISSING = "暂无数据";
const OWNER_NOTE =
  "今日实收已扣除退款与冲正，含会员充值，与账目一致；营业额按开单结算，含会员余额付款。";
const GROSS_NOTE = "含会员余额付款；欠款补缴和冲正请查看账目。";

type KpiProps = Readonly<{
  icon: IconName;
  label: string;
  aside?: string | undefined;
  value: ReactNode;
  tone?: "warn" | "late" | undefined;
  visual?: ReactNode;
  foot: ReactNode;
  onOpen: () => void;
}>;

function Kpi({ icon, label, aside, value, tone, visual, foot, onOpen }: KpiProps) {
  return (
    <button type="button" className="ld-wb-kpi lg-spec" data-tone={tone} onClick={onOpen}>
      <span className="ld-wb-kpi__label">
        <Icon name={icon} size={15} />
        {label}
        {aside === undefined ? null : <small>{aside}</small>}
      </span>
      <span className="ld-wb-kpi__main">
        <strong className="ld-wb-kpi__value">{value}</strong>
        {visual}
      </span>
      <span className="ld-wb-kpi__foot">{foot}</span>
    </button>
  );
}

function Versus({
  today,
  yesterday,
}: Readonly<{ today: number; yesterday: number | null | undefined }>) {
  if (yesterday === undefined) return <>{LOADING}</>;
  const progress = versusYesterday(today, yesterday);
  if (progress === null) return <>昨日数据暂不可用</>;
  return (
    <>
      {progress.fraction === null ? null : <Meter fraction={progress.fraction} />}
      <span>{progress.label}</span>
    </>
  );
}

type KpiSetProps = Readonly<{ data: WorkbenchData; onNavigate: (id: NavItemId) => void }>;

function ReceivedKpi({ data, onNavigate }: KpiSetProps) {
  const { summary, rhythm } = data;
  const delta =
    rhythm === null || rhythm === undefined || rhythm.yesterdaySoFar === null
      ? null
      : rhythm.todayTotal - rhythm.yesterdaySoFar;
  return (
    <Kpi
      icon="receive"
      label="今日收衣"
      value={
        summary === undefined ? (
          LOADING
        ) : summary === null ? (
          MISSING
        ) : (
          <>
            <RollingCount value={summary.order_count} />
            <small>单</small>
            <small className="ld-wb-kpi__sub">{`${summary.garment_count} 件`}</small>
          </>
        )
      }
      visual={rhythm === null || rhythm === undefined ? null : <HourBars rhythm={rhythm} />}
      foot={
        delta === null ? (
          "按营业日统计"
        ) : (
          <span className={delta >= 0 ? "ld-wb-delta ld-wb-delta--up" : "ld-wb-delta"}>
            {`较昨日同时段 ${delta >= 0 ? "+" : ""}${delta} 单`}
          </span>
        )
      }
      onOpen={() => onNavigate("orders")}
    />
  );
}

function PickedKpi({ data, onNavigate }: KpiSetProps) {
  const { summary } = data;
  const fraction =
    summary === null || summary === undefined || summary.garment_count === 0
      ? 0
      : summary.picked_garment_count / summary.garment_count;
  return (
    <Kpi
      icon="shirt"
      label="衣物取走"
      value={
        summary === undefined ? (
          LOADING
        ) : summary === null ? (
          MISSING
        ) : (
          <>
            <RollingCount value={summary.picked_garment_count} />
            <small>{` / ${summary.garment_count} 件`}</small>
          </>
        )
      }
      visual={summary === null || summary === undefined ? null : <Ring fraction={fraction} />}
      foot={
        summary === null || summary === undefined
          ? "今日收衣的取走进度"
          : `${Math.round(fraction * 100)}% · 还有 ${summary.garment_count - summary.picked_garment_count} 件在店`
      }
      onOpen={() => onNavigate("pickup")}
    />
  );
}

function DebtKpi({ data, onNavigate, money }: KpiSetProps & Readonly<{ money: boolean }>) {
  const { debt } = data;
  const value =
    debt === undefined ? (
      LOADING
    ) : debt === null ? (
      MISSING
    ) : money ? (
      <>
        {debt.complete ? null : <small>≥</small>}
        <MoneyText fen={debt.sumFen} />
      </>
    ) : (
      <>
        <RollingCount value={debt.count} />
        <small>单</small>
      </>
    );
  return (
    <Kpi
      icon="wallet"
      label={money ? "欠款" : "欠款订单"}
      aside={money ? "按欠款天数" : undefined}
      tone={debt !== null && debt !== undefined && debt.count > 0 ? "warn" : undefined}
      value={value}
      visual={
        debt === null || debt === undefined || debt.count === 0 ? null : (
          <AgingBar counts={[debt.within3, debt.within7, debt.over7]} />
        )
      }
      foot={
        debt === null || debt === undefined
          ? "全部未结清订单"
          : debt.count === 0
            ? "没有欠款"
            : `${debt.count} 单 · 最久 ${debt.oldestDays} 天`
      }
      onOpen={() => onNavigate("orders")}
    />
  );
}

function moneyFigures(summary: DaySummaryView) {
  const net =
    summary.real_income_cents !== undefined && summary.performance_income_cents !== undefined;
  return net
    ? ({
        net,
        income: summary.real_income_cents ?? 0,
        sales: summary.performance_income_cents ?? 0,
      } as const)
    : ({ net, income: summary.payment_cents, sales: summary.payable_cents } as const);
}

function OwnerMoney({ data, onNavigate }: KpiSetProps) {
  const { summary, yesterday } = data;
  if (summary === undefined || summary === null) {
    const value = summary === undefined ? LOADING : MISSING;
    return (
      <>
        <Kpi
          icon="wallet"
          label="今日实收"
          value={value}
          foot="已扣除退款与冲正"
          onOpen={() => onNavigate("stats")}
        />
        <Kpi
          icon="stats"
          label="营业额"
          value={value}
          foot="按开单结算"
          onOpen={() => onNavigate("stats")}
        />
      </>
    );
  }
  const today = moneyFigures(summary);
  const past = yesterday === undefined || yesterday === null ? yesterday : moneyFigures(yesterday);
  return (
    <>
      <Kpi
        icon="wallet"
        label={today.net ? "今日实收" : "收款（退款前）"}
        value={<RollingMoney fen={today.income} />}
        foot={
          <Versus
            today={today.income}
            yesterday={past === undefined ? undefined : past === null ? null : past.income}
          />
        }
        onOpen={() => onNavigate("stats")}
      />
      <Kpi
        icon="stats"
        label={today.net ? "营业额" : "开单应收"}
        value={<RollingMoney fen={today.sales} />}
        foot={
          <Versus
            today={today.sales}
            yesterday={past === undefined ? undefined : past === null ? null : past.sales}
          />
        }
        onOpen={() => onNavigate("stats")}
      />
    </>
  );
}

function CountKpi({
  icon,
  label,
  rows,
  tone,
  foot,
  onOpen,
}: Readonly<{
  icon: IconName;
  label: string;
  rows: Readonly<{ total: number }> | null | undefined;
  tone?: "late" | undefined;
  foot: string;
  onOpen: () => void;
}>) {
  return (
    <Kpi
      icon={icon}
      label={label}
      tone={rows !== null && rows !== undefined && rows.total > 0 ? tone : undefined}
      value={
        rows === undefined ? (
          LOADING
        ) : rows === null ? (
          MISSING
        ) : (
          <>
            <RollingCount value={rows.total} />
            <small>单</small>
          </>
        )
      }
      foot={foot}
      onOpen={onOpen}
    />
  );
}

export function WorkbenchKpis({
  data,
  owner,
  onNavigate,
}: KpiSetProps & Readonly<{ owner: boolean }>) {
  const summary = data.summary;
  const net =
    summary?.real_income_cents !== undefined && summary?.performance_income_cents !== undefined;
  return (
    <section className="ld-wb-kpis" aria-label="今日看板" data-testid="counter-workbench-metrics">
      <div className="ld-wb-kpis__grid">
        {owner ? (
          <OwnerMoney data={data} onNavigate={onNavigate} />
        ) : (
          <CountKpi
            icon="pickup"
            label="未取件订单"
            rows={data.queues.open}
            foot={
              data.queues.ready === undefined || data.queues.ready === null
                ? "含今天收的单"
                : `已上架 ${data.queues.ready.total} 单`
            }
            onOpen={() => onNavigate("orders")}
          />
        )}
        <ReceivedKpi data={data} onNavigate={onNavigate} />
        <PickedKpi data={data} onNavigate={onNavigate} />
        {owner ? null : (
          <CountKpi
            icon="clock"
            label="超 30 天未取"
            rows={data.queues.overdue}
            tone="late"
            foot="需要联系顾客取衣"
            onOpen={() => onNavigate("reminders")}
          />
        )}
        <DebtKpi data={data} onNavigate={onNavigate} money={owner} />
      </div>
      {owner && summary !== undefined && summary !== null ? (
        <p className="ld-wb-kpis__note">{net ? OWNER_NOTE : GROSS_NOTE}</p>
      ) : null}
    </section>
  );
}
