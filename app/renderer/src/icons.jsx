// 16px stroke icons from the Ledger designs (designs/canvas/project/Main.dc.html).

import { BRAND } from "../../../core/brand.mjs";
function Svg({ size = 16, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ChevronDown = (p) => <Svg {...p}><path d="M4 6l4 4 4-4" /></Svg>;
export const ChevronLeft = (p) => <Svg {...p}><path d="M10 4L6 8l4 4" /></Svg>;
export const ChevronRight = (p) => <Svg {...p}><path d="M6 4l4 4-4 4" /></Svg>;
export const GlobeIcon = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M2.5 8h11M8 2.5c1.6 1.6 1.6 9.4 0 11M8 2.5c-1.6 1.6-1.6 9.4 0 11" />
  </Svg>
);
export const PageIcon = (p) => (
  <Svg {...p}>
    <rect x="3" y="2.5" width="10" height="11" rx="1.5" />
    <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" />
  </Svg>
);
export const BlankIcon = (p) => (
  <Svg {...p}>
    <rect x="3" y="2.5" width="10" height="11" rx="1.5" />
  </Svg>
);
export const MenuIcon = (p) => <Svg {...p}><path d="M3 4.5h10M3 8h10M3 11.5h10" /></Svg>;
export const PlusIcon = (p) => <Svg {...p}><path d="M8 3v10M3 8h10" /></Svg>;
export const DbIcon = (p) => (
  <Svg {...p}>
    <ellipse cx="8" cy="4" rx="5" ry="1.8" />
    <path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" />
  </Svg>
);
export const CodeIcon = (p) => <Svg {...p}><path d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5" /></Svg>;
export const FileIcon = (p) => (
  <Svg {...p}>
    <path d="M4 2.5h5l3 3v8h-8z" />
    <path d="M9 2.5v3h3" />
  </Svg>
);
export const FolderIcon = (p) => (
  <Svg {...p}>
    <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
  </Svg>
);

export function Spinner({ size = 14, label }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    />
  );
}
export const CloseIcon = (p) => <Svg {...p}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Svg>;

/** The "Tiles" mark (build/icon.svg, cropped to the tile). */
export const QuireMark = ({ size = 40 }) => (
  <svg width={size} height={size} viewBox="100 100 824 824" aria-hidden="true" focusable="false" className="quire-mark">
    <rect x="100" y="100" width="824" height="824" rx="185" fill="#111111" />
    <g transform="translate(192 192) scale(10)">
      <rect x="8" y="8" width="22" height="22" rx="6" fill="#FFFFFF" />
      <rect x="13" y="14" width="12" height="2.5" rx="1.25" fill="#111111" />
      <rect x="13" y="19" width="12" height="2.5" rx="1.25" fill="#111111" />
      <rect x="13" y="24" width="7" height="2.5" rx="1.25" fill="#111111" />
      <rect x="34" y="8" width="22" height="22" rx="6" fill="#FFFFFF" fillOpacity="0.45" />
      <rect x="8" y="34" width="22" height="22" rx="6" fill="#FFFFFF" fillOpacity="0.45" />
      <rect x="34" y="34" width="22" height="22" rx="11" fill="#FFFFFF" fillOpacity="0.75" />
    </g>
  </svg>
);

/** The wordmark: BRAND.word in ink, BRAND.tld in grey (styles.css .wordmark). */
export const Wordmark = () => (
  <span className="wordmark" aria-label={BRAND.name}>
    {BRAND.word}
    <span className="wordmark-tld">{BRAND.tld}</span>
  </span>
);

/** The Noteblock AI mark: a small burst (designs/canvas/build-ai.mjs). No sparkles. */
export const AiIcon = (p) => (
  <Svg {...p}>
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.5 1.5M10.5 10.5L12 12M12 4l-1.5 1.5M5.5 10.5L4 12" />
  </Svg>
);
export const ArrowUpIcon = (p) => <Svg {...p}><path d="M8 13V3M4 7l4-4 4 4" /></Svg>;
export const StopIcon = (p) => (
  <Svg {...p}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
);
export const UndoIcon = (p) => (
  <Svg {...p}>
    <path d="M5 4L2.5 6.5 5 9" />
    <path d="M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7" />
  </Svg>
);
export const CheckIcon = (p) => <Svg {...p}><path d="M3.5 8.5l3 3 6-7" /></Svg>;

// Noteblock AI v2 (designs/canvas/build-ai2.mjs): the ⌘J assistant's header, rows and history.
export const ClockIcon = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </Svg>
);
export const DockIcon = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <path d="M10 3v10" />
  </Svg>
);
export const MoveIcon = (p) => <Svg {...p}><path d="M3 8h9M9 5l3 3-3 3" /></Svg>;
export const GearIcon = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 2.5v1.5M8 12v1.5M2.5 8H4M12 8h1.5M4.1 4.1l1 1M10.9 10.9l1 1M11.9 4.1l-1 1M5.1 10.9l-1 1" />
  </Svg>
);
/** A panel with its left column: hides or shows the sidebar. */
export const SidebarIcon = (p) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M6 3v10" />
  </Svg>
);
export const SearchIcon = (p) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4" />
    <path d="M10 10l3 3" />
  </Svg>
);
export const WarnIcon = (p) => (
  <Svg {...p}>
    <path d="M8 3l5.5 10h-11z" />
    <path d="M8 7v2.5M8 11.2v.1" />
  </Svg>
);
export const TrashIcon = (p) => (
  <Svg {...p}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5" />
  </Svg>
);
