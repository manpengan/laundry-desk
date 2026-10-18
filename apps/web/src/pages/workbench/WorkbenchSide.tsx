/** Side cards (ADR-100): 今日节奏, 生产进度 and 接下来. Charts are SVG attributes only (CSP). */

import { Button, Icon, Skeleton } from "@laundry/ui";
import type { ReactNode } from "react";

import type { NavItemId } from "../../nav.js";
import {
  DELIVERY_DIRECTION_LABELS,
  type DeliveryAppointmentView,
} from "../delivery-appointment-model.js";
import type { ShiftClosingView } from "../shift-closing-view.js";
import {
  boundedCount,
  clockRange,
  segmentWidths,
  toMillis,
  windowLabel,
  type RhythmView,
  type StageView,
} from "./workbench-model.js";

function CardHead({
  icon,
  title,
  children,
}: Readonly<{ icon: "stats" | "fulfillment" | "clock"; title: string; children?: ReactNode }>) {
  return (
    <header className="ld-wb-card__head">
      <h2 className="ld-wb-card__title">
        <Icon name={icon} size={16} />
        {title}
      </h2>
      {children}
    </header>
  );
}

function rhythmLead(rhythm: RhythmView): string {
  if (rhythm.yesterdaySoFar === null) return `今日已收 ${rhythm.todayTotal} 单`;
  const delta = rhythm.todayTotal - rhythm.yesterdaySoFar;
  return `比昨日同时段${delta >= 0 ? "多" : "少"} ${Math.abs(delta)} 单`;
}

function RhythmChart({ rhythm }: Readonly<{ rhythm: RhythmView }>) {
  const columns = rhythm.buckets.length;
  const scale = (count: number) => (count / rhythm.max) * 92;
  const line = rhythm.buckets
    .map((bucket, index) => `${index * 10 + 5},${(100 - scale(bucket.yesterday)).toFixed(1)}`)
    .join(" ");
  const nowX = rhythm.nowFraction * columns * 10;
  return (
    <svg
      className="ld-wb-chart"
      viewBox={`0 0 ${columns * 10} 100`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`今日每小时收衣：${rhythm.buckets.map((bucket) => `${bucket.hour} 点 ${bucket.today} 单`).join("，")}`}
    >
      {rhythm.buckets.map((bucket, index) => {
        const height = scale(bucket.today);
        return (
          <g key={bucket.hour}>
            <rect
              className="ld-wb-chart__track"
              x={index * 10 + 1.5}
              y="0"
              width="7"
              height="100"
            />
            {bucket.today === 0 ? null : (
              <rect
                className={`ld-wb-chart__bar ld-wb-chart__bar--${bucket.state}`}
                x={index * 10 + 1.5}
                y={100 - height}
                width="7"
                height={height}
              >
                <title>{`${bucket.hour}:00–${bucket.hour + 1}:00 · 今日 ${bucket.today} 单 · 昨日 ${bucket.yesterday} 单`}</title>
              </rect>
            )}
          </g>
        );
      })}
      {rhythm.yesterdaySoFar === null ? null : (
        <polyline className="ld-wb-chart__line" points={line} vectorEffect="non-scaling-stroke" />
      )}
      <line
        className="ld-wb-chart__now"
        x1={nowX}
        x2={nowX}
        y1="0"
        y2="100"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function RhythmCard({ rhythm }: Readonly<{ rhythm: RhythmView | null | undefined }>) {
  if (rhythm === null) return null;
  return (
    <section className="ld-wb-card ld-wb-side__card" aria-label="今日节奏">
      <CardHead icon="stats" title="今日节奏">
        <span className="ld-wb-legend" aria-hidden="true">
          <i data-key="today" />
          今日收衣
          <i data-key="yesterday" />
          昨日
        </span>
      </CardHead>
      {rhythm === undefined ? (
        <Skeleton lines={3} />
      ) : (
        <>
          <p className="ld-wb-card__lead">
            <strong>
              {rhythm.peak === null
                ? "今天还没有收衣"
                : `高峰 ${rhythm.peak.hour} 点 · ${rhythm.peak.count} 单`}
            </strong>
            <span>{rhythmLead(rhythm)}</span>
          </p>
          <RhythmChart rhythm={rhythm} />
          <div className="ld-wb-chart__axis" aria-hidden="true">
            {rhythm.buckets.map((bucket) => (
              <span key={bucket.hour}>{bucket.hour % 2 === 0 ? bucket.hour : ""}</span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function ProductionCard({
  stages,
  overdue,
  onNavigate,
}: Readonly<{
  stages: readonly StageView[] | null | undefined;
  overdue: number | null;
  onNavigate: (id: NavItemId) => void;
}>) {
  if (stages === null) return null;
  return (
    <section className="ld-wb-card ld-wb-side__card" aria-label="生产进度">
      <CardHead icon="fulfillment" title="生产进度">
        <button type="button" className="ld-wb-link" onClick={() => onNavigate("fulfillment")}>
          去生产
          <Icon name="arrowRight" size={14} />
        </button>
      </CardHead>
      {stages === undefined ? <Skeleton lines={3} /> : <StageBar stages={stages} />}
      {overdue === null || overdue === 0 ? null : (
        <footer className="ld-wb-card__foot">
          <span className="ld-wb-chip" data-tone="late">{`超 30 天未取 ${overdue} 单`}</span>
          <Button
            size="sm"
            variant="secondary"
            type="button"
            onClick={() => onNavigate("reminders")}
          >
            <Icon name="reminders" size={14} />
            去催取
          </Button>
        </footer>
      )}
    </section>
  );
}

function StageBar({ stages }: Readonly<{ stages: readonly StageView[] }>) {
  const widths = segmentWidths(stages.map((stage) => stage.count));
  let offset = 0;
  return (
    <>
      <svg
        className="ld-wb-stages"
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect className="ld-wb-stages__track" width="100" height="10" />
        {widths.map((width, index) => {
          const x = offset;
          offset += width;
          return width === 0 ? null : (
            <rect
              key={stages[index]?.key ?? index}
              className={`ld-wb-stages__seg ld-wb-stages__seg--${index}`}
              x={x}
              width={width}
              height="10"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <dl className="ld-wb-stages__list">
        {stages.map((stage, index) => (
          <div key={stage.key}>
            <dt>
              <i className={`ld-wb-stages__dot ld-wb-stages__dot--${index}`} aria-hidden="true" />
              {stage.label}
            </dt>
            <dd className="ld-wb-num">{boundedCount(stage.count, stage.capped)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function AppointmentRow({
  appointment,
  now,
}: Readonly<{ appointment: DeliveryAppointmentView; now: number }>) {
  const start = appointment.scheduled_start_at * 1000;
  const end = appointment.scheduled_end_at * 1000;
  return (
    <li className="ld-wb-agenda__item">
      <span className="ld-wb-mono">{clockRange(start, end).split("–")[0]}</span>
      <span className="ld-wb-agenda__what">
        <strong>{DELIVERY_DIRECTION_LABELS[appointment.direction]}</strong>
        <small>{`${clockRange(start, end)} · 服务区 ${appointment.service_area_code}`}</small>
      </span>
      <span className="ld-wb-chip" data-tone={now >= start ? "ok" : "plain"}>
        {windowLabel(now, start, end)}
      </span>
    </li>
  );
}

function ShiftRow({
  shift,
  onNavigate,
}: Readonly<{ shift: ShiftClosingView | "open"; onNavigate: (id: NavItemId) => void }>) {
  if (shift !== "open") {
    const closed = new Date(toMillis(shift.closed_at));
    const time = `${String(closed.getHours()).padStart(2, "0")}:${String(closed.getMinutes()).padStart(2, "0")}`;
    return (
      <li className="ld-wb-agenda__item">
        <span className="ld-wb-mono">{time}</span>
        <span className="ld-wb-agenda__what">
          <strong>今日已日结</strong>
          <small>交班记录已签字</small>
        </span>
        <span className="ld-wb-chip" data-tone="ok">
          已完成
        </span>
      </li>
    );
  }
  return (
    <li className="ld-wb-agenda__item">
      <span className="ld-wb-mono">今天</span>
      <span className="ld-wb-agenda__what">
        <strong>尚未日结交班</strong>
        <small>打烊前核对现金与小票</small>
      </span>
      <Button size="sm" variant="secondary" type="button" onClick={() => onNavigate("stats")}>
        日结与交班
      </Button>
    </li>
  );
}

export function AgendaCard({
  appointments,
  shift,
  onNavigate,
}: Readonly<{
  appointments: readonly DeliveryAppointmentView[] | null | undefined;
  shift: ShiftClosingView | "open" | null | undefined;
  onNavigate: (id: NavItemId) => void;
}>) {
  if (appointments === null && shift === null) return null;
  const now = Date.now();
  const coming = (appointments ?? [])
    .filter((appointment) => appointment.scheduled_end_at * 1000 > now)
    .sort((a, b) => a.scheduled_start_at - b.scheduled_start_at);
  const total = appointments?.length ?? 0;
  return (
    <section className="ld-wb-card ld-wb-side__card" aria-label="接下来">
      <CardHead icon="clock" title="接下来">
        {appointments === null || appointments === undefined ? null : (
          <span
            className="ld-wb-chip"
            data-tone="plain"
          >{`今日预约 ${total} · 还剩 ${coming.length}`}</span>
        )}
      </CardHead>
      {appointments === undefined && shift === undefined ? (
        <Skeleton lines={2} />
      ) : (
        <ul className="ld-wb-agenda">
          {coming.slice(0, 2).map((appointment) => (
            <AppointmentRow key={appointment.appointment_id} appointment={appointment} now={now} />
          ))}
          {appointments !== null && appointments !== undefined && coming.length === 0 ? (
            <li className="ld-wb-agenda__empty">今天没有待办的取送预约</li>
          ) : null}
          {shift === null || shift === undefined ? null : (
            <ShiftRow shift={shift} onNavigate={onNavigate} />
          )}
        </ul>
      )}
    </section>
  );
}
