/** Small SVG figures for the workbench cards (ADR-100): geometry in attributes, colour in CSS. */

import { segmentWidths, type RhythmView } from "./workbench-model.js";

export function Meter({ fraction }: Readonly<{ fraction: number }>) {
  return (
    <svg className="ld-wb-meter" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
      <rect className="ld-wb-meter__track" width="100" height="6" rx="3" />
      <rect className="ld-wb-meter__fill" width={Math.round(fraction * 100)} height="6" rx="3" />
    </svg>
  );
}

export function Ring({ fraction }: Readonly<{ fraction: number }>) {
  const length = 2 * Math.PI * 15;
  return (
    <svg className="ld-wb-ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle className="ld-wb-ring__track" cx="18" cy="18" r="15" />
      <circle
        className="ld-wb-ring__fill"
        cx="18"
        cy="18"
        r="15"
        strokeDasharray={`${(fraction * length).toFixed(1)} ${length.toFixed(1)}`}
        transform="rotate(-90 18 18)"
      />
    </svg>
  );
}

export function HourBars({ rhythm }: Readonly<{ rhythm: RhythmView }>) {
  const width = rhythm.buckets.length * 4;
  return (
    <svg
      className="ld-wb-hours"
      viewBox={`0 0 ${width} 32`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {rhythm.buckets.map((bucket, index) => {
        const height =
          bucket.state === "future" ? 3 : Math.max(2, (bucket.today / rhythm.max) * 30);
        return (
          <rect
            key={bucket.hour}
            className={`ld-wb-hours__bar ld-wb-hours__bar--${bucket.state}`}
            x={index * 4}
            y={32 - height}
            width="3"
            height={height}
          />
        );
      })}
    </svg>
  );
}

export function AgingBar({ counts }: Readonly<{ counts: readonly number[] }>) {
  const widths = segmentWidths(counts);
  let offset = 0;
  return (
    <svg className="ld-wb-aging" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
      {widths.map((width, index) => {
        const x = offset;
        offset += width;
        return width === 0 ? null : (
          <rect
            key={index}
            className={`ld-wb-aging__seg ld-wb-aging__seg--${index}`}
            x={x}
            width={width}
            height="8"
          />
        );
      })}
    </svg>
  );
}
