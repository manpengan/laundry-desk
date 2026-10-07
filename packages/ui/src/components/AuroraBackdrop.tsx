/**
 * 呼吸背景 (ADR-99): four palette-coloured fields and a static film grain on a
 * fixed layer behind every staff surface. Decorative only; aurora.css decides
 * whether the fields drift (data-motion="full") or stay still.
 */
export function AuroraBackdrop() {
  return (
    <div className="lg-aurora" aria-hidden="true">
      <span className="lg-aurora__blob" />
      <span className="lg-aurora__blob" />
      <span className="lg-aurora__blob" />
      <span className="lg-aurora__blob" />
      <svg className="lg-aurora__grain" focusable="false">
        <filter id="lg-aurora-grain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.85"
            numOctaves={2}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#lg-aurora-grain)" />
      </svg>
    </div>
  );
}
