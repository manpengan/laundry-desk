/** Hand-drawn 24px stroke icon set (no third-party glyphs, no icon font). */

function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

const ICONS = {
  home: ["M3 10.5 12 3l9 7.5", "M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"],
  receive: [
    "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
    "M14 3v5h5",
    "M12 11v6",
    "M9 14h6",
  ],
  pickup: [
    "M10 5.2a2 2 0 1 1 2 2v1.6",
    "M12 8.8 3.7 14.4A1.4 1.4 0 0 0 4.5 17h15a1.4 1.4 0 0 0 .8-2.6z",
  ],
  delivery: [
    "M2.5 6.5h11v9.5h-11z",
    "M13.5 9.5h4.2l3.3 3.3v3.2h-7.5",
    circle(6.5, 17.5, 1.8),
    circle(17, 17.5, 1.8),
  ],
  fulfillment: [
    "M5.5 3h13A1.5 1.5 0 0 1 20 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-15A1.5 1.5 0 0 1 5.5 3z",
    "M4 7.5h16",
    circle(12, 14, 4),
    "M7 5.2h.01",
    "M9.6 5.2h.01",
  ],
  orders: ["M6 3h12v18l-3-2-3 2-3-2-3 2z", "M9 8h6", "M9 12h6", "M9 16h3"],
  customers: [
    circle(9, 8, 3.2),
    "M3.5 19.5a5.5 5.5 0 0 1 11 0",
    "M15.5 4.9a3.1 3.1 0 0 1 0 6.1",
    "M17.5 13.6a5.5 5.5 0 0 1 3 5.9",
  ],
  reminders: [
    "M6 9.5a6 6 0 0 1 12 0c0 5.5 2.5 7 2.5 7h-17S6 15 6 9.5z",
    "M10 20a2.1 2.1 0 0 0 4 0",
  ],
  stats: ["M4 20.5h16", "M7.5 16.5v-5", "M12 16.5V6.5", "M16.5 16.5v-8"],
  settings: [
    "M4 6.5h9",
    "M17 6.5h3",
    circle(15, 6.5, 2),
    "M4 12h3",
    "M11 12h9",
    circle(9, 12, 2),
    "M4 17.5h11",
    "M19 17.5h1",
    circle(17, 17.5, 2),
  ],
  search: [circle(11, 11, 6.5), "M20 20l-4.3-4.3"],
  close: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  alert: ["M12 3.8 2.8 19.8h18.4z", "M12 10v4.4", "M12 17.2h.01"],
  info: [circle(12, 12, 9), "M12 11v5", "M12 8h.01"],
  alertCircle: [circle(12, 12, 9), "M12 7.5v5.5", "M12 16.5h.01"],
  printer: [
    "M7 9V3.5h10V9",
    "M7 17.5H5a2 2 0 0 1-2-2v-4.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2h-2",
    "M7 14h10v6.5H7z",
  ],
  online: [
    "M2.5 9a14 14 0 0 1 19 0",
    "M5.5 12.5a9.6 9.6 0 0 1 13 0",
    "M8.8 16a4.8 4.8 0 0 1 6.4 0",
    "M12 19.5h.01",
  ],
  offline: [
    "M3 3l18 18",
    "M8.8 16a4.8 4.8 0 0 1 6.4 0",
    "M5.5 12.5a9.6 9.6 0 0 1 5-2.6",
    "M12 19.5h.01",
  ],
  refresh: [
    "M20 11a8 8 0 0 0-14.4-4.8L4 8",
    "M4 4v4h4",
    "M4 13a8 8 0 0 0 14.4 4.8L20 16",
    "M20 20v-4h-4",
  ],
  sun: [
    circle(12, 12, 4),
    "M12 2.5v2",
    "M12 19.5v2",
    "M4.9 4.9l1.4 1.4",
    "M17.7 17.7l1.4 1.4",
    "M2.5 12h2",
    "M19.5 12h2",
    "M4.9 19.1l1.4-1.4",
    "M17.7 6.3l1.4-1.4",
  ],
  moon: ["M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"],
  monitor: [
    "M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
    "M8.5 20h7",
    "M12 16v4",
  ],
  keyboard: [
    "M4 6.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z",
    "M7 10.5h.01",
    "M10.5 10.5h.01",
    "M14 10.5h.01",
    "M17.5 10.5h.01",
    "M8 14h8",
  ],
  switchUser: [
    circle(10, 8, 3.5),
    "M3.5 20a6.5 6.5 0 0 1 10.5-5.1",
    "M17 13.5l3 3-3 3",
    "M20 16.5h-6",
  ],
  chevronLeft: ["M15 18l-6-6 6-6"],
  chevronRight: ["M9 18l6-6-6-6"],
  chevronDown: ["M6 9l6 6 6-6"],
  arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", circle(12, 12, 3)],
  eyeOff: [
    "M3 3l18 18",
    "M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2",
    "M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6",
    "M9.9 9.9a3 3 0 0 0 4.2 4.2",
  ],
  scan: [
    "M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8",
    "M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8",
    "M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16",
    "M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16",
    "M8 8.5v7",
    "M11 8.5v7",
    "M14 8.5v7",
    "M16.5 8.5v7",
  ],
  command: ["M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  trash: ["M4 7h16", "M9.5 7V4.5h5V7", "M6 7l1 13h10l1-13"],
  sparkles: [
    "M11 3.5l1.7 4.6 4.6 1.7-4.6 1.7L11 16.1l-1.7-4.6-4.6-1.7 4.6-1.7z",
    "M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z",
  ],
  lock: ["M6 11h12v9.5H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
  phone: [
    "M5.5 4H9l1.5 4-2.2 1.4a11 11 0 0 0 6.3 6.3L16 13.5l4 1.5v3.5a1.5 1.5 0 0 1-1.5 1.5A16 16 0 0 1 4 5.5 1.5 1.5 0 0 1 5.5 4z",
  ],
  clock: [circle(12, 12, 9), "M12 7v5l3.2 2"],
  shirt: ["M8.5 3.5 3.5 6.5l2 4 2-1v11h9v-11l2 1 2-4-5-3a3.5 3.5 0 0 1-7 0z"],
  logout: ["M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3", "M10 16l-4-4 4-4", "M6 12h10"],
  camera: [
    "M4 7.5h3.2L8.8 5h6.4l1.6 2.5H20a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1z",
    circle(12, 13.5, 3.6),
  ],
} as const;

export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.freeze(Object.keys(ICONS) as IconName[]);

export type IconProps = Readonly<{
  name: IconName;
  size?: number;
  strokeWidth?: number;
  /** Accessible label; omit for decorative icons (aria-hidden). */
  title?: string;
  className?: string;
}>;

export function Icon({ name, size = 20, strokeWidth = 1.8, title, className }: IconProps) {
  const paths = ICONS[name];
  return (
    <svg
      className={className === undefined ? "ld-icon" : `ld-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(title === undefined
        ? { "aria-hidden": true as const }
        : { role: "img", "aria-label": title })}
    >
      {paths.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}
