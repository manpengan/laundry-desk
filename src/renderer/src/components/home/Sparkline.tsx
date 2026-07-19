import { useId } from "react";

export function Sparkline({ points }: { points: number[] }) {
  const gid = useId().replace(/:/g, "");
  if (points.length < 2) return <div className="h-[34px]" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((v, i) => [
    (i / (points.length - 1)) * 200,
    35 - ((v - min) / span) * 28,
  ]);
  const line = xy
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L200 40 L0 40 Z`;
  const [ex, ey] = xy[xy.length - 1];
  return (
    <svg
      className="mt-1.5 block h-[34px] w-full"
      viewBox="0 0 200 40"
      preserveAspectRatio="none"
      style={{ color: "var(--lg-accent)" }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.25" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx={ex} cy={ey} r="3" fill="currentColor" />
    </svg>
  );
}
