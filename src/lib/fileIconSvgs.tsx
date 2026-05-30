/**
 * Pointer file-type icon set — original SVG artwork.
 *
 * Every icon is hand-composed from geometric primitives (rounded
 * rectangles, hexagons, circles, polygons) plus a short monogram or
 * a small pictogram. We use colours that are widely associated with
 * each technology so engineers recognise the icon instantly, but
 * every mark is our own design. No trademarked logo is reproduced.
 *
 * Design constraints (the hard part of small icons):
 *
 *   • Render legibly at 11–13 px (file tree default), still hold up
 *     at 16 px (tabs) and 20 px (chat attachment chips).
 *   • Work against dark backgrounds. Most icons use a brand-coloured
 *     filled background with a contrasting glyph; a thin inner outline
 *     keeps the badge from melting into a dark panel.
 *   • One visual language across the whole set. Most files are
 *     "rounded square + monogram"; non-source files (lock, key,
 *     terminal, image, archive…) use distinctive pictograms.
 *   • Pure components — no fetched assets, no fonts beyond the
 *     system stack, no animation. Bundle cost is just the JSX.
 *
 * The exported icons all share the `IconProps` shape so the resolver
 * can swap them in anywhere a Lucide icon used to live.
 */

import type { CSSProperties } from "@/lib/preactSignalCompat";

export type IconProps = {
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
};

// ──────────────────────────────────────────────────────────────────
// Shared SVG primitives.
//
// Wrapping the <svg> here means every icon gets the same defaults:
// crisp rendering, no inherited stroke colour leakage, and a tiny
// inner outline that lifts brand-coloured badges off the noir panel.
// ──────────────────────────────────────────────────────────────────

/**
 * Shared SVG wrapper for every icon. Named with the `Frame_` prefix
 * to keep it out of the way of the exported `Frame` (which is
 * the *shell-script* icon, not a layout primitive).
 */
function Frame({
  size = 12,
  className,
  style,
  title,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ display: "inline-block", flexShrink: 0, ...style }}
      shapeRendering="geometricPrecision"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/**
 * The workhorse "rounded badge + monogram" shape. Most language
 * icons compose from this — only the fill colour, the glyph, and
 * its colour differ.
 *
 * The font size is dialled in so two-character monograms ("TS",
 * "JS", "RB"…) sit visually centred at every render size. We use
 * an explicit `font-family` stack so we don't inherit whatever
 * weird font the parent might've set (Monaco's monospace, etc.).
 */
function Badge({
  fill,
  outline = "rgba(255,255,255,0.10)",
  mono,
  monoFill = "#fff",
  monoSize = 7,
  accent,
  ...props
}: IconProps & {
  fill: string;
  outline?: string;
  mono: string;
  monoFill?: string;
  /** Approximate font size in px for the monogram inside the 16x16 box. */
  monoSize?: number;
  /** Optional decoration — e.g. a tiny underline or corner dot. */
  accent?: React.ReactNode;
}) {
  // 1-char monograms get extra size; 2-char comfortably at 7px;
  // 3-char (rare — e.g. "TSX") drops to 6px.
  const sz = mono.length === 1 ? 10 : mono.length === 2 ? monoSize : 5.5;
  return (
    <Frame {...props}>
      <rect x="1" y="1" width="14" height="14" rx="3" ry="3" fill={fill} />
      <rect
        x="1.5"
        y="1.5"
        width="13"
        height="13"
        rx="2.5"
        ry="2.5"
        fill="none"
        stroke={outline}
      />
      <text
        x="8"
        y={mono.length === 1 ? 11.5 : 11}
        textAnchor="middle"
        fontSize={sz}
        fontWeight={700}
        fontFamily="ui-sans-serif, -apple-system, system-ui, sans-serif"
        fill={monoFill}
        letterSpacing={mono.length >= 3 ? "-0.4" : "-0.2"}
      >
        {mono}
      </text>
      {accent}
    </Frame>
  );
}

/** Hexagonal badge — used for systems/foundational tech (Rust-ish). */
function Hex({
  fill,
  outline = "rgba(255,255,255,0.10)",
  mono,
  monoFill = "#fff",
  ...props
}: IconProps & {
  fill: string;
  outline?: string;
  mono: string;
  monoFill?: string;
}) {
  return (
    <Frame {...props}>
      <polygon
        points="8,1 14.5,4.5 14.5,11.5 8,15 1.5,11.5 1.5,4.5"
        fill={fill}
        stroke={outline}
        strokeWidth="0.75"
      />
      <text
        x="8"
        y={mono.length === 1 ? 11.5 : 11}
        textAnchor="middle"
        fontSize={mono.length === 1 ? 9 : 6.5}
        fontWeight={700}
        fontFamily="ui-sans-serif, -apple-system, system-ui, sans-serif"
        fill={monoFill}
        letterSpacing={-0.2}
      >
        {mono}
      </text>
    </Frame>
  );
}

/** Diamond badge — for "gem" languages (Ruby, Crystal, Solidity). */
function Diamond({
  fill,
  outline = "rgba(255,255,255,0.10)",
  mono,
  monoFill = "#fff",
  ...props
}: IconProps & {
  fill: string;
  outline?: string;
  mono: string;
  monoFill?: string;
}) {
  return (
    <Frame {...props}>
      <polygon
        points="8,1 15,8 8,15 1,8"
        fill={fill}
        stroke={outline}
        strokeWidth="0.75"
      />
      <text
        x="8"
        y={9.6}
        textAnchor="middle"
        fontSize={mono.length === 1 ? 7 : 5.5}
        fontWeight={700}
        fontFamily="ui-sans-serif, -apple-system, system-ui, sans-serif"
        fill={monoFill}
      >
        {mono}
      </text>
    </Frame>
  );
}

/** Stacked-page silhouette — used for plain-text / prose docs. */
function PageGlyph({
  fill,
  accent,
  ...props
}: IconProps & { fill: string; accent?: React.ReactNode }) {
  return (
    <Frame {...props}>
      <path
        d="M3.5 1.5 H9.5 L13 5 V13.5 A1 1 0 0 1 12 14.5 H3.5 A1 1 0 0 1 2.5 13.5 V2.5 A1 1 0 0 1 3.5 1.5 Z"
        fill={fill}
        stroke="rgba(0,0,0,0.25)"
        strokeWidth="0.5"
      />
      <path d="M9.5 1.5 V5 H13" fill="none" stroke="rgba(0,0,0,0.25)" />
      {accent}
    </Frame>
  );
}

// ──────────────────────────────────────────────────────────────────
// Brand-tinted language icons.
// ──────────────────────────────────────────────────────────────────

export const IconTypeScript = (p: IconProps) => (
  <Badge {...p} fill="#3178c6" mono="TS" title="TypeScript" />
);
export const IconJavaScript = (p: IconProps) => (
  <Badge {...p} fill="#f7df1e" mono="JS" monoFill="#0e0e0e" title="JavaScript" />
);
export const IconTSX = (p: IconProps) => (
  // We tint TSX with a teal note (React-ish) and leave a corner notch
  // so it reads differently from plain TS at small sizes.
  <Badge
    {...p}
    fill="#27c2c5"
    mono="TSX"
    monoSize={6}
    title="TypeScript React"
    accent={
      <circle cx="12.5" cy="3.5" r="1.2" fill="rgba(0,0,0,0.35)" />
    }
  />
);
export const IconJSX = (p: IconProps) => (
  <Badge
    {...p}
    fill="#4dc9ff"
    monoFill="#0e0e0e"
    mono="JSX"
    monoSize={6}
    title="JavaScript React"
    accent={<circle cx="12.5" cy="3.5" r="1.2" fill="rgba(0,0,0,0.35)" />}
  />
);
export const IconMJS = (p: IconProps) => (
  <Badge {...p} fill="#facc15" monoFill="#0e0e0e" mono="MJS" monoSize={5.5} title="ES Module" />
);
export const IconCJS = (p: IconProps) => (
  <Badge {...p} fill="#eab308" monoFill="#0e0e0e" mono="CJS" monoSize={5.5} title="CommonJS Module" />
);

export const IconVue = (p: IconProps) => (
  // Original mark: a downward chevron with a darker inner V. Vue is
  // commonly associated with green, which is what we lean on.
  <Frame {...p} title="Vue Single-File Component">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e1614" />
    <polygon points="2.5,3.5 13.5,3.5 8,14.5" fill="#41b883" />
    <polygon points="5,3.5 11,3.5 8,9" fill="#35495e" />
  </Frame>
);

export const IconSvelte = (p: IconProps) => (
  // Original mark: rounded square with two opposing arcs that form
  // a stylised "S".
  <Frame {...p} title="Svelte">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#ff3e00" />
    <path
      d="M5 11 C6.5 14, 11 13, 11 9 C11 6, 6 6, 6 4 C6 2.5, 8 1.8, 10 3"
      fill="none"
      stroke="#fff"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </Frame>
);

export const IconAstro = (p: IconProps) => (
  // Original mark: a sharp triangle pointing up — "rocket nose".
  <Frame {...p} title="Astro">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0d0420" />
    <polygon points="8,2.5 13,13.5 8,11.5 3,13.5" fill="#ff5d01" />
    <polygon points="8,5 11,12 8,10.7 5,12" fill="#ffb497" />
  </Frame>
);

// CSS family — each has a distinguishable accent so SCSS and SASS
// don't blur into "another pink S".
export const IconCSS = (p: IconProps) => (
  <Badge {...p} fill="#1572b6" mono="CSS" monoSize={5.5} title="CSS" />
);
export const IconSCSS = (p: IconProps) => (
  <Badge
    {...p}
    fill="#c76494"
    mono="SCSS"
    monoSize={5}
    title="SCSS / Sass (SCSS syntax)"
  />
);
export const IconSass = (p: IconProps) => (
  <Badge {...p} fill="#cf649a" mono="SASS" monoSize={5} title="Sass" />
);
export const IconLess = (p: IconProps) => (
  <Badge {...p} fill="#1d365d" mono="LESS" monoSize={5} title="Less" />
);
export const IconStylus = (p: IconProps) => (
  <Badge {...p} fill="#7c5e2b" mono="STYL" monoSize={5} title="Stylus" />
);
export const IconPostCSS = (p: IconProps) => (
  <Badge {...p} fill="#dd3a0a" mono="PCSS" monoSize={5} title="PostCSS" />
);

// HTML / XML / templating
export const IconHTML = (p: IconProps) => (
  <Frame {...p} title="HTML">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#e34f26" />
    <path d="M3 3 L13 3 L12 13 L8 14 L4 13 Z" fill="rgba(0,0,0,0.25)" />
    <text
      x="8"
      y="11.5"
      textAnchor="middle"
      fontSize={6.5}
      fontWeight={800}
      fontFamily="ui-sans-serif, system-ui, sans-serif"
      fill="#fff"
    >
      HTML
    </text>
  </Frame>
);
export const IconXML = (p: IconProps) => (
  <Badge {...p} fill="#c46c33" mono="XML" monoSize={6} title="XML" />
);
export const IconEJS = (p: IconProps) => (
  <Badge {...p} fill="#a91e50" mono="EJS" monoSize={6} title="EJS template" />
);
export const IconHandlebars = (p: IconProps) => (
  <Badge {...p} fill="#f0772b" monoFill="#0e0e0e" mono="HBS" monoSize={6} title="Handlebars" />
);
export const IconPug = (p: IconProps) => (
  <Badge {...p} fill="#56332b" mono="PUG" monoSize={6} title="Pug template" />
);
export const IconLiquid = (p: IconProps) => (
  <Badge {...p} fill="#2f7a45" mono="LIQ" monoSize={6} title="Liquid template" />
);
export const IconJinja = (p: IconProps) => (
  <Badge {...p} fill="#9c1f1f" mono="J2" title="Jinja2 template" />
);

// Data / config
export const IconJSON = (p: IconProps) => (
  // Original mark: curly braces flanking a centred dot. The braces
  // are an obvious "this is structured data" cue.
  <Frame {...p} title="JSON">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e1014" />
    <text
      x="3.5"
      y="11.5"
      fontFamily="ui-monospace, SFMono-Regular, monospace"
      fontWeight={700}
      fontSize={10}
      fill="#fbbf24"
    >
      {"{"}
    </text>
    <text
      x="9.5"
      y="11.5"
      fontFamily="ui-monospace, SFMono-Regular, monospace"
      fontWeight={700}
      fontSize={10}
      fill="#fbbf24"
    >
      {"}"}
    </text>
    <circle cx="8" cy="8" r="1.1" fill="#fbbf24" />
  </Frame>
);
export const IconJSONC = (p: IconProps) => (
  <Frame {...p} title="JSON with comments">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e1014" />
    <text
      x="3.5"
      y="11.5"
      fontFamily="ui-monospace, SFMono-Regular, monospace"
      fontWeight={700}
      fontSize={10}
      fill="#fbbf24"
    >
      {"{"}
    </text>
    <text
      x="9.5"
      y="11.5"
      fontFamily="ui-monospace, SFMono-Regular, monospace"
      fontWeight={700}
      fontSize={10}
      fill="#fbbf24"
    >
      {"}"}
    </text>
    <line x1="6.5" y1="7" x2="9.5" y2="7" stroke="#10b981" strokeWidth="1.3" strokeLinecap="round" />
  </Frame>
);
export const IconJSON5 = (p: IconProps) => (
  <Badge {...p} fill="#fbbf24" monoFill="#0e0e0e" mono="JS5" monoSize={6} title="JSON5" />
);
export const IconYAML = (p: IconProps) => (
  // Original mark: three stacked horizontal bars suggesting an indent
  // tree — that's YAML's defining shape.
  <Frame {...p} title="YAML">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#c40e0e" />
    <rect x="3" y="4.2" width="10" height="1.4" rx="0.5" fill="#fff" />
    <rect x="5" y="7.3" width="8" height="1.4" rx="0.5" fill="#fff" />
    <rect x="7" y="10.4" width="6" height="1.4" rx="0.5" fill="#fff" />
  </Frame>
);
export const IconTOML = (p: IconProps) => (
  // Original mark: a section header in square brackets.
  <Frame {...p} title="TOML">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#9c4221" />
    <text
      x="8"
      y="11"
      textAnchor="middle"
      fontFamily="ui-monospace, SFMono-Regular, monospace"
      fontWeight={700}
      fontSize={7}
      fill="#ffe1b3"
    >
      [§]
    </text>
  </Frame>
);
export const IconINI = (p: IconProps) => (
  <Badge {...p} fill="#525252" mono="INI" monoSize={6} title="INI config" />
);
export const IconConf = (p: IconProps) => (
  <Frame {...p} title="Configuration">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#2a323d" />
    <circle cx="8" cy="8" r="2.4" fill="none" stroke="#94a3b8" strokeWidth="1.4" />
    <circle cx="8" cy="8" r="0.7" fill="#94a3b8" />
    <g stroke="#94a3b8" strokeWidth="1.2" strokeLinecap="round">
      <line x1="8" y1="3.5" x2="8" y2="5" />
      <line x1="8" y1="11" x2="8" y2="12.5" />
      <line x1="3.5" y1="8" x2="5" y2="8" />
      <line x1="11" y1="8" x2="12.5" y2="8" />
      <line x1="4.8" y1="4.8" x2="5.8" y2="5.8" />
      <line x1="10.2" y1="10.2" x2="11.2" y2="11.2" />
      <line x1="11.2" y1="4.8" x2="10.2" y2="5.8" />
      <line x1="5.8" y1="10.2" x2="4.8" y2="11.2" />
    </g>
  </Frame>
);
export const IconEnv = (p: IconProps) => (
  // Original mark: a key on a green panel — secrets / credentials.
  <Frame {...p} title="Environment variables">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#064e3b" />
    <circle cx="6" cy="8" r="2.4" fill="none" stroke="#34d399" strokeWidth="1.4" />
    <path
      d="M8 8 L13 8 M11 8 V10 M13 8 V10"
      fill="none"
      stroke="#34d399"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </Frame>
);

// Markdown family
export const IconMarkdown = (p: IconProps) => (
  // Original mark: down-arrow + horizontal bar — the universal
  // "markdown" shorthand of a bar with a downward chevron.
  <Frame {...p} title="Markdown">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e1620" />
    <path
      d="M3.5 5 V11 M3.5 5 L6 8 L8.5 5 V11"
      fill="none"
      stroke="#94a3b8"
      strokeWidth="1.3"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    <path
      d="M11 5 V11 M9.5 9 L11 11 L12.5 9"
      fill="none"
      stroke="#94a3b8"
      strokeWidth="1.3"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </Frame>
);
export const IconMDX = (p: IconProps) => (
  // Same markdown silhouette tinted fuchsia — MDX is markdown with
  // JSX, so we add a little angle bracket accent.
  <Frame {...p} title="MDX">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#3f0d3f" />
    <path
      d="M3 5 V11 M3 5 L5.5 8 L8 5 V11"
      fill="none"
      stroke="#f0abfc"
      strokeWidth="1.3"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    <text
      x="11"
      y="11"
      fontFamily="ui-monospace, SFMono-Regular, monospace"
      fontWeight={800}
      fontSize={6.5}
      fill="#f0abfc"
      textAnchor="middle"
    >
      {"</>"}
    </text>
  </Frame>
);
export const IconText = (p: IconProps) => (
  <PageGlyph {...p} title="Plain text" fill="#cbd5e1"
    accent={
      <g stroke="#475569" strokeWidth="0.7" strokeLinecap="round">
        <line x1="4.5" y1="7" x2="11" y2="7" />
        <line x1="4.5" y1="9" x2="11" y2="9" />
        <line x1="4.5" y1="11" x2="9" y2="11" />
      </g>
    }
  />
);
export const IconRichText = (p: IconProps) => (
  <PageGlyph {...p} title="Rich text" fill="#fde68a"
    accent={
      <g stroke="#92400e" strokeWidth="0.7" strokeLinecap="round">
        <line x1="4.5" y1="7" x2="11" y2="7" />
        <line x1="4.5" y1="9" x2="11" y2="9" />
        <line x1="4.5" y1="11" x2="9" y2="11" />
      </g>
    }
  />
);
export const IconReStructuredText = (p: IconProps) => (
  <Badge {...p} fill="#314e6f" mono="RST" monoSize={6} title="reStructuredText" />
);
export const IconAsciiDoc = (p: IconProps) => (
  <Badge {...p} fill="#5d8aa8" mono="ADOC" monoSize={5.2} title="AsciiDoc" />
);
export const IconLaTeX = (p: IconProps) => (
  <Badge {...p} fill="#008080" mono="TEX" monoSize={6} title="LaTeX" />
);

// Python & friends
export const IconPython = (p: IconProps) => (
  // Original mark: two interlocking rounded shapes (one blue, one
  // yellow) — a generic "two-tone language" composition.
  <Frame {...p} title="Python">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0b1c2e" />
    <path
      d="M5 3 H9.5 A2 2 0 0 1 11.5 5 V8.5 H7 A1.5 1.5 0 0 0 5.5 10 V11.5 H4 A1.5 1.5 0 0 1 2.5 10 V5 A2 2 0 0 1 4.5 3 Z"
      fill="#3776ab"
    />
    <path
      d="M11 13 H6.5 A2 2 0 0 1 4.5 11 V7.5 H9 A1.5 1.5 0 0 0 10.5 6 V4.5 H12 A1.5 1.5 0 0 1 13.5 6 V11 A2 2 0 0 1 11.5 13 Z"
      fill="#ffd43b"
    />
    <circle cx="5.5" cy="5" r="0.6" fill="#ffd43b" />
    <circle cx="10.5" cy="11" r="0.6" fill="#3776ab" />
  </Frame>
);
export const IconPyi = (p: IconProps) => (
  <Badge {...p} fill="#1f4f7a" mono="PYI" monoSize={6} title="Python stubs" />
);
export const IconJupyter = (p: IconProps) => (
  // Original mark: three orbiting dots around a centre circle.
  <Frame {...p} title="Jupyter notebook">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#2d2d2d" />
    <ellipse cx="8" cy="8" rx="5" ry="2" fill="none" stroke="#f37726" strokeWidth="1.1" />
    <ellipse cx="8" cy="8" rx="5" ry="2" fill="none" stroke="#f37726" strokeWidth="1.1" transform="rotate(60 8 8)" />
    <ellipse cx="8" cy="8" rx="5" ry="2" fill="none" stroke="#f37726" strokeWidth="1.1" transform="rotate(-60 8 8)" />
    <circle cx="8" cy="8" r="1.2" fill="#f37726" />
  </Frame>
);

// Ruby family
export const IconRuby = (p: IconProps) => (
  <Diamond {...p} fill="#cc342d" mono="RB" title="Ruby" />
);
export const IconErb = (p: IconProps) => (
  <Diamond {...p} fill="#985144" mono="ERB" title="Ruby ERB template" />
);
export const IconCrystal = (p: IconProps) => (
  <Diamond {...p} fill="#1a1a1a" outline="rgba(255,255,255,0.25)" mono="CR" title="Crystal" />
);

// Rust + systems
export const IconRust = (p: IconProps) => (
  // Original mark: a gear ring with an "R" inside — gears are a
  // generic systems-programming visual.
  <Frame {...p} title="Rust">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a1a1a" />
    <circle cx="8" cy="8" r="5" fill="none" stroke="#dea584" strokeWidth="1.2" />
    {/* 6 gear teeth */}
    {Array.from({ length: 6 }).map((_, i) => {
      const a = (i / 6) * Math.PI * 2;
      const x1 = 8 + Math.cos(a) * 5;
      const y1 = 8 + Math.sin(a) * 5;
      const x2 = 8 + Math.cos(a) * 6.4;
      const y2 = 8 + Math.sin(a) * 6.4;
      return (
        <line
          key={i}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="#dea584"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      );
    })}
    <text
      x="8"
      y="10.5"
      textAnchor="middle"
      fontSize={6.5}
      fontWeight={800}
      fontFamily="ui-sans-serif, system-ui, sans-serif"
      fill="#dea584"
    >
      R
    </text>
  </Frame>
);
export const IconGo = (p: IconProps) => (
  // Original mark: a forward arrow with a tail (pointer / "go").
  <Frame {...p} title="Go">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0b1c25" />
    <path
      d="M2.8 7 L8 7 M8 4.5 L11.5 8 L8 11.5 M5 9 L7.5 9"
      fill="none"
      stroke="#00add8"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Frame>
);
export const IconC = (p: IconProps) => (
  <Badge {...p} fill="#00599c" mono="C" monoSize={9} title="C" />
);
export const IconCpp = (p: IconProps) => (
  <Badge {...p} fill="#00599c" mono="C++" monoSize={6.5} title="C++" />
);
export const IconCHeader = (p: IconProps) => (
  <Badge {...p} fill="#3a6791" mono=".h" title="C/C++ header" />
);
export const IconCppHeader = (p: IconProps) => (
  <Badge {...p} fill="#3a6791" mono="HPP" monoSize={6} title="C++ header" />
);
export const IconZig = (p: IconProps) => (
  <Badge {...p} fill="#f7a41d" monoFill="#0e0e0e" mono="Z" title="Zig" />
);
export const IconNim = (p: IconProps) => (
  <Badge {...p} fill="#ffe953" monoFill="#0e0e0e" mono="NIM" monoSize={6} title="Nim" />
);
export const IconV = (p: IconProps) => (
  <Badge {...p} fill="#5d87bf" mono="V" title="V language" />
);
export const IconD = (p: IconProps) => (
  <Badge {...p} fill="#b03931" mono="D" title="D language" />
);

// JVM family
export const IconJava = (p: IconProps) => (
  // Original mark: a steaming "cup" pictogram on a red panel.
  <Frame {...p} title="Java">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#a8141a" />
    <path
      d="M5 7 H11 V11 A1.5 1.5 0 0 1 9.5 12.5 H6.5 A1.5 1.5 0 0 1 5 11 Z"
      fill="#fff"
    />
    <path
      d="M11 8 H12 A1.2 1.2 0 0 1 13.2 9.2 V9.6 A1.2 1.2 0 0 1 12 10.8 H11"
      fill="none"
      stroke="#fff"
      strokeWidth="0.9"
    />
    <path
      d="M7 3 C6.4 4 7.6 4.6 7 5.6 M9 3 C8.4 4 9.6 4.6 9 5.6"
      fill="none"
      stroke="#fff"
      strokeWidth="0.9"
      strokeLinecap="round"
    />
  </Frame>
);
export const IconKotlin = (p: IconProps) => (
  // Original mark: angled bands — a folded ribbon.
  <Frame {...p} title="Kotlin">
    <defs>
      <linearGradient id="kotlin-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#7f52ff" />
        <stop offset="60%" stopColor="#c757bc" />
        <stop offset="100%" stopColor="#e88334" />
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="14" height="14" rx="3" fill="url(#kotlin-grad)" />
    <polygon points="3,3 8,3 3,8" fill="rgba(0,0,0,0.18)" />
    <polygon points="8,3 13,8 13,13 3,13 3,8" fill="none" stroke="rgba(255,255,255,0.18)" />
  </Frame>
);
export const IconScala = (p: IconProps) => (
  <Frame {...p} title="Scala">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e0e0e" />
    <path d="M3 4 Q8 5 13 4 V6 Q8 7 3 6 Z" fill="#de3423" />
    <path d="M3 7 Q8 8 13 7 V9 Q8 10 3 9 Z" fill="#de3423" />
    <path d="M3 10 Q8 11 13 10 V12 Q8 13 3 12 Z" fill="#de3423" />
  </Frame>
);
export const IconGroovy = (p: IconProps) => (
  <Badge {...p} fill="#4a98c9" mono="GVY" monoSize={6} title="Groovy" />
);
export const IconClojure = (p: IconProps) => (
  <Badge {...p} fill="#5881d8" mono="CLJ" monoSize={6} title="Clojure" />
);

// .NET
export const IconCSharp = (p: IconProps) => (
  // Original mark: large "C#" set on purple.
  <Badge {...p} fill="#5a2885" mono="C#" monoSize={7.5} title="C#" />
);
export const IconFSharp = (p: IconProps) => (
  <Badge {...p} fill="#378bba" mono="F#" monoSize={7.5} title="F#" />
);
export const IconVB = (p: IconProps) => (
  <Badge {...p} fill="#005a9e" mono="VB" title="Visual Basic" />
);

// Apple
export const IconSwift = (p: IconProps) => (
  // Original mark: a stylised wing/arrow on orange.
  <Frame {...p} title="Swift">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#fa7343" />
    <path
      d="M3.5 12.5 Q7 10 8.5 7 Q9.5 9 8.5 11.5 Q11 11 12.5 9 Q11 6 8 4 Q5 3.5 3.5 5.5 Q5 6 6.5 7.5 Q5 7 3.5 7.5 Q5.5 8.5 7 9 Q5 9.5 3.5 12.5 Z"
      fill="#fff"
    />
  </Frame>
);
export const IconObjC = (p: IconProps) => (
  <Badge {...p} fill="#438eff" mono="OC" title="Objective-C" />
);
export const IconObjCPlusPlus = (p: IconProps) => (
  <Badge {...p} fill="#438eff" mono="OC+" monoSize={6} title="Objective-C++" />
);

// Functional
export const IconHaskell = (p: IconProps) => (
  // Original mark: stylised lambda on purple.
  <Frame {...p} title="Haskell">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#3c2a4a" />
    <path
      d="M3 4 L6 8 L3 12 M5 8 L8 4 L13 12 M9 9 H13"
      fill="none"
      stroke="#a87bd0"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </Frame>
);
export const IconOCaml = (p: IconProps) => (
  <Badge {...p} fill="#ec6813" mono="ML" title="OCaml" />
);
export const IconErlang = (p: IconProps) => (
  <Badge {...p} fill="#a90533" mono="ERL" monoSize={6} title="Erlang" />
);
export const IconElixir = (p: IconProps) => (
  // Original mark: a teardrop.
  <Frame {...p} title="Elixir">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#3a1e51" />
    <path
      d="M8 2.8 C5 6, 4 9, 6 12 C7 13.5, 9 13.5, 10 12 C12 9, 11 6, 8 2.8 Z"
      fill="#c1a5ff"
    />
  </Frame>
);
export const IconElm = (p: IconProps) => (
  // Original mark: four mosaic squares.
  <Frame {...p} title="Elm">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e1620" />
    <polygon points="2.5,8 8,2.5 13.5,8 8,13.5" fill="#60b5cc" />
    <polygon points="4.5,8 8,4.5 11.5,8 8,11.5" fill="#5fbcd3" />
  </Frame>
);
export const IconReason = (p: IconProps) => (
  <Badge {...p} fill="#dd4b39" mono="RE" title="ReasonML" />
);
export const IconReScript = (p: IconProps) => (
  <Badge {...p} fill="#e6484f" mono="RES" monoSize={6} title="ReScript" />
);
export const IconPureScript = (p: IconProps) => (
  <Badge {...p} fill="#1d222d" outline="rgba(255,255,255,0.22)" mono="PS" title="PureScript" />
);

// Other languages
export const IconPHP = (p: IconProps) => (
  <Badge {...p} fill="#777bb4" mono="PHP" monoSize={6} title="PHP" />
);
export const IconR = (p: IconProps) => (
  <Badge {...p} fill="#276dc3" mono="R" title="R" />
);
export const IconPerl = (p: IconProps) => (
  <Badge {...p} fill="#39457e" mono="PL" title="Perl" />
);
export const IconLua = (p: IconProps) => (
  // Original mark: crescent moon on midnight blue.
  <Frame {...p} title="Lua">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#000080" />
    <circle cx="8" cy="8" r="4" fill="#fff" />
    <circle cx="9.4" cy="7" r="3.5" fill="#000080" />
  </Frame>
);
export const IconDart = (p: IconProps) => (
  <Badge {...p} fill="#0175c2" mono="D" title="Dart" />
);
export const IconJulia = (p: IconProps) => (
  // Original mark: three dots in brand colours.
  <Frame {...p} title="Julia">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a1a1a" />
    <circle cx="5" cy="11" r="2" fill="#cb3c33" />
    <circle cx="11" cy="11" r="2" fill="#9558b2" />
    <circle cx="8" cy="6" r="2" fill="#389826" />
  </Frame>
);
export const IconNix = (p: IconProps) => (
  // Original mark: a six-pointed snowflake.
  <Frame {...p} title="Nix">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0b1c2e" />
    <g stroke="#7eb6f5" strokeWidth="1.1" strokeLinecap="round">
      <line x1="8" y1="2.5" x2="8" y2="13.5" />
      <line x1="3" y1="5" x2="13" y2="11" />
      <line x1="13" y1="5" x2="3" y2="11" />
    </g>
    <circle cx="8" cy="8" r="1.3" fill="#7eb6f5" />
  </Frame>
);
export const IconSolidity = (p: IconProps) => (
  <Diamond {...p} fill="#363636" outline="rgba(255,255,255,0.25)" mono="SOL" title="Solidity" />
);
export const IconTerraform = (p: IconProps) => (
  // Original mark: descending bars (infrastructure layers).
  <Frame {...p} title="Terraform">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a1a2e" />
    <rect x="3" y="3.5" width="4" height="3" fill="#7c4cdb" />
    <rect x="7.5" y="3.5" width="4" height="3" fill="#7c4cdb" opacity="0.7" />
    <rect x="3" y="7" width="4" height="3" fill="#7c4cdb" opacity="0.85" />
    <rect x="3" y="10.5" width="4" height="3" fill="#7c4cdb" opacity="0.55" />
  </Frame>
);
export const IconHCL = (p: IconProps) => (
  <Badge {...p} fill="#5c4ee5" mono="HCL" monoSize={6} title="HCL" />
);
export const IconGraphQL = (p: IconProps) => (
  // Original mark: a triangle inscribed in a circle.
  <Frame {...p} title="GraphQL">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a1024" />
    <circle cx="8" cy="8" r="5" fill="none" stroke="#e535ab" strokeWidth="1" />
    <polygon points="8,3.5 12.5,11 3.5,11" fill="none" stroke="#e535ab" strokeWidth="1" />
    {[
      [8, 3.5],
      [12.5, 11],
      [3.5, 11],
    ].map(([x, y], i) => (
      <circle key={i} cx={x} cy={y} r="1" fill="#e535ab" />
    ))}
  </Frame>
);
export const IconBicep = (p: IconProps) => (
  <Badge {...p} fill="#0072c6" mono="BIC" monoSize={6} title="Bicep" />
);
export const IconPulumi = (p: IconProps) => (
  <Badge {...p} fill="#8a3391" mono="PU" title="Pulumi" />
);

// Shells & terminal
export const IconShell = (p: IconProps) => (
  // Original mark: a terminal window with a prompt caret.
  <Frame {...p} title="Shell script">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e1620" />
    <rect x="2" y="3" width="12" height="10" rx="1" fill="#0a0f17" stroke="#22c55e" strokeWidth="0.7" />
    <path
      d="M4 7 L6 8.5 L4 10 M7 10 H11"
      fill="none"
      stroke="#22c55e"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Frame>
);
export const IconPowerShell = (p: IconProps) => (
  <Frame {...p} title="PowerShell">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#012456" />
    <rect x="2" y="3" width="12" height="10" rx="1" fill="#01183c" />
    <path
      d="M4 6 L7 8 L4 10"
      fill="none"
      stroke="#fff"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <line x1="7.5" y1="10" x2="11" y2="10" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
  </Frame>
);
export const IconBat = (p: IconProps) => (
  <Badge {...p} fill="#5b8cb8" mono="BAT" monoSize={6} title="Windows batch" />
);

// Containers / DevOps
export const IconDocker = (p: IconProps) => (
  // Original mark: stacked containers on a blue panel.
  <Frame {...p} title="Docker">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0b1c2e" />
    <g fill="#1d63ed">
      <rect x="2" y="9" width="2.2" height="2.2" />
      <rect x="4.5" y="9" width="2.2" height="2.2" />
      <rect x="7" y="9" width="2.2" height="2.2" />
      <rect x="9.5" y="9" width="2.2" height="2.2" />
      <rect x="4.5" y="6.5" width="2.2" height="2.2" />
      <rect x="7" y="6.5" width="2.2" height="2.2" />
      <rect x="7" y="4" width="2.2" height="2.2" />
    </g>
    <path d="M12 8 Q14 8 14 10 L12 10" fill="#1d63ed" />
  </Frame>
);
export const IconKubernetes = (p: IconProps) => (
  // Original mark: heptagonal helm wheel.
  <Frame {...p} title="Kubernetes">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0b1c2e" />
    <polygon
      points="8,2.5 13,5 13,11 8,13.5 3,11 3,5"
      fill="none"
      stroke="#326ce5"
      strokeWidth="1.2"
    />
    <circle cx="8" cy="8" r="2.2" fill="none" stroke="#326ce5" strokeWidth="1.1" />
  </Frame>
);
export const IconMakefile = (p: IconProps) => (
  // Original mark: hammer on amber.
  <Frame {...p} title="Makefile">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a1a1a" />
    <rect
      x="3"
      y="3"
      width="6"
      height="3"
      rx="0.6"
      transform="rotate(-25 3 3)"
      fill="#f59e0b"
    />
    <rect
      x="5"
      y="6"
      width="1.4"
      height="8"
      rx="0.5"
      transform="rotate(-25 5 6)"
      fill="#f59e0b"
    />
  </Frame>
);
export const IconGitFile = (p: IconProps) => (
  // Original mark: branching graph on dark.
  <Frame {...p} title="Git">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a1a1a" />
    <g fill="#f05033">
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="4" cy="12" r="1.6" />
      <circle cx="12" cy="8" r="1.6" />
    </g>
    <path
      d="M4 5.5 V10.5 M4 5.5 Q4 8 12 8"
      fill="none"
      stroke="#f05033"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </Frame>
);
export const IconGitHubActions = (p: IconProps) => (
  <Frame {...p} title="GitHub Actions">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a1a1a" />
    <circle cx="8" cy="8" r="4.5" fill="none" stroke="#2088ff" strokeWidth="1.2" />
    <polygon points="6.7,5.5 11,8 6.7,10.5" fill="#2088ff" />
  </Frame>
);
export const IconCI = (p: IconProps) => (
  <Badge {...p} fill="#1e88e5" mono="CI" title="CI configuration" />
);
export const IconAnsible = (p: IconProps) => (
  <Badge {...p} fill="#000" outline="rgba(255,255,255,0.25)" mono="ANS" monoSize={6} title="Ansible" />
);
export const IconHelm = (p: IconProps) => (
  <Badge {...p} fill="#0f1689" mono="HELM" monoSize={5} title="Helm" />
);

// Databases / data
export const IconSQL = (p: IconProps) => (
  // Original mark: a cylinder pictogram on amber.
  <Frame {...p} title="SQL">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0d2233" />
    <g fill="none" stroke="#fbbf24" strokeWidth="1.2">
      <ellipse cx="8" cy="4.5" rx="4.5" ry="1.5" />
      <path d="M3.5 4.5 V11.5 Q3.5 13 8 13 Q12.5 13 12.5 11.5 V4.5" />
      <path d="M3.5 8 Q3.5 9.5 8 9.5 Q12.5 9.5 12.5 8" />
    </g>
  </Frame>
);
export const IconPrisma = (p: IconProps) => (
  // Original mark: an angular monolith.
  <Frame {...p} title="Prisma">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e1e26" />
    <polygon points="8,2.5 12.5,13.5 4.5,13.5" fill="#2dd4bf" />
    <line x1="8" y1="2.5" x2="6" y2="13.5" stroke="#0e1e26" strokeWidth="0.8" />
  </Frame>
);
export const IconMongo = (p: IconProps) => (
  <Badge {...p} fill="#10aa50" mono="MGO" monoSize={6} title="MongoDB" />
);
export const IconRedis = (p: IconProps) => (
  <Badge {...p} fill="#d82c20" mono="RED" monoSize={6} title="Redis" />
);
export const IconDBGeneric = (p: IconProps) => (
  <Frame {...p} title="Database">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a1a1a" />
    <g fill="#fbbf24">
      <ellipse cx="8" cy="4.5" rx="4.5" ry="1.5" />
      <path d="M3.5 4.5 V8 Q3.5 9.5 8 9.5 Q12.5 9.5 12.5 8 V4.5" />
      <path d="M3.5 8 V11.5 Q3.5 13 8 13 Q12.5 13 12.5 11.5 V8" />
    </g>
  </Frame>
);

// Spreadsheets / Office
export const IconCSV = (p: IconProps) => (
  // Original mark: a grid of cells.
  <Frame {...p} title="CSV">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e2a1c" />
    <g fill="none" stroke="#34d399" strokeWidth="0.7">
      <rect x="2.5" y="3.5" width="11" height="9" />
      <line x1="6.2" y1="3.5" x2="6.2" y2="12.5" />
      <line x1="9.8" y1="3.5" x2="9.8" y2="12.5" />
      <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" />
      <line x1="2.5" y1="9.5" x2="13.5" y2="9.5" />
    </g>
  </Frame>
);
export const IconTSV = (p: IconProps) => (
  // Same grid in a cooler tint to distinguish from CSV.
  <Frame {...p} title="TSV">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e2233" />
    <g fill="none" stroke="#60a5fa" strokeWidth="0.7">
      <rect x="2.5" y="3.5" width="11" height="9" />
      <line x1="6.2" y1="3.5" x2="6.2" y2="12.5" />
      <line x1="9.8" y1="3.5" x2="9.8" y2="12.5" />
      <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" />
      <line x1="2.5" y1="9.5" x2="13.5" y2="9.5" />
    </g>
  </Frame>
);
export const IconExcel = (p: IconProps) => (
  <PageGlyph {...p} fill="#107c41" title="Excel spreadsheet"
    accent={
      <g stroke="#fff" strokeWidth="0.9" strokeLinecap="round">
        <line x1="5.5" y1="7" x2="11.5" y2="13" />
        <line x1="11.5" y1="7" x2="5.5" y2="13" />
      </g>
    }
  />
);
export const IconWord = (p: IconProps) => (
  <PageGlyph {...p} fill="#1f6feb" title="Word document"
    accent={
      <text x="8" y="12" textAnchor="middle" fontSize={6.5} fontWeight={800} fill="#fff" fontFamily="ui-sans-serif, system-ui, sans-serif">W</text>
    }
  />
);
export const IconPowerPoint = (p: IconProps) => (
  <PageGlyph {...p} fill="#c24a23" title="PowerPoint presentation"
    accent={
      <text x="8" y="12" textAnchor="middle" fontSize={6.5} fontWeight={800} fill="#fff" fontFamily="ui-sans-serif, system-ui, sans-serif">P</text>
    }
  />
);
export const IconPdf = (p: IconProps) => (
  <PageGlyph {...p} fill="#ef4444" title="PDF document"
    accent={
      <text x="8" y="12" textAnchor="middle" fontSize={5.5} fontWeight={800} fill="#fff" fontFamily="ui-sans-serif, system-ui, sans-serif">PDF</text>
    }
  />
);

// Media
export const IconImage = (p: IconProps) => (
  // Original mark: a sun over mountains inside a frame.
  <Frame {...p} title="Image">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#3f1d52" />
    <rect x="2.5" y="2.5" width="11" height="11" rx="1" fill="#1f1030" stroke="#f0abfc" strokeWidth="0.7" />
    <circle cx="5.5" cy="6" r="1.2" fill="#f0abfc" />
    <polygon points="2.8,12 6.5,8 9,11 11,9 13.2,12" fill="#f0abfc" />
  </Frame>
);
export const IconSVG = (p: IconProps) => (
  // Original mark: vector-path "node" cue.
  <Frame {...p} title="SVG">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#2a1e05" />
    <path
      d="M3 12 Q6 4 13 4"
      fill="none"
      stroke="#fbbf24"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
    <circle cx="3" cy="12" r="1.4" fill="#fbbf24" />
    <circle cx="13" cy="4" r="1.4" fill="#fbbf24" />
  </Frame>
);
export const IconIco = (p: IconProps) => (
  // Original mark: a small "favicon" tile inside a frame.
  <Frame {...p} title="Icon">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1f1604" />
    <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="#fbbf24" />
    <circle cx="8" cy="8" r="1.6" fill="#1f1604" />
  </Frame>
);
export const IconAudio = (p: IconProps) => (
  // Original mark: a play-bar waveform.
  <Frame {...p} title="Audio">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1c1140" />
    <g fill="#c4b5fd">
      <rect x="3" y="6" width="1.4" height="4" rx="0.4" />
      <rect x="5" y="4.5" width="1.4" height="7" rx="0.4" />
      <rect x="7" y="3" width="1.4" height="10" rx="0.4" />
      <rect x="9" y="5" width="1.4" height="6" rx="0.4" />
      <rect x="11" y="6.5" width="1.4" height="3" rx="0.4" />
    </g>
  </Frame>
);
export const IconVideo = (p: IconProps) => (
  // Original mark: play triangle inside a frame.
  <Frame {...p} title="Video">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#2a0f2f" />
    <rect x="2.5" y="2.5" width="11" height="11" rx="1" fill="#1a0820" stroke="#f0abfc" strokeWidth="0.7" />
    <polygon points="6,5.5 11.5,8 6,10.5" fill="#f0abfc" />
  </Frame>
);
export const IconFont = (p: IconProps) => (
  // Original mark: serif "Aa".
  <Frame {...p} title="Font">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e1014" />
    <text
      x="4"
      y="12"
      fontFamily="Georgia, 'Times New Roman', serif"
      fontWeight={700}
      fontSize={11}
      fill="#fde68a"
    >
      A
    </text>
    <text
      x="9.2"
      y="12"
      fontFamily="Georgia, 'Times New Roman', serif"
      fontWeight={700}
      fontStyle="italic"
      fontSize={9}
      fill="#fde68a"
    >
      a
    </text>
  </Frame>
);

// Archives & binaries
export const IconArchive = (p: IconProps) => (
  // Original mark: a stylised box with a zipper.
  <Frame {...p} title="Archive">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#3a2a09" />
    <rect x="2.5" y="2.5" width="11" height="11" rx="1" fill="#f59e0b" />
    <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="#3a2a09" strokeWidth="1.4" />
    {[3.5, 5, 6.5, 8, 9.5, 11, 12.5].map((y, i) => (
      <rect
        key={i}
        x={i % 2 === 0 ? 7.2 : 8}
        y={y}
        width="0.8"
        height="0.7"
        fill="#3a2a09"
      />
    ))}
  </Frame>
);
export const IconLock = (p: IconProps) => (
  // Original mark: a padlock pictogram.
  <Frame {...p} title="Lock file">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a1a1a" />
    <path
      d="M5.5 7 V5.5 A2.5 2.5 0 0 1 10.5 5.5 V7"
      fill="none"
      stroke="#9ca3af"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
    <rect x="4" y="7" width="8" height="6" rx="1" fill="#9ca3af" />
    <circle cx="8" cy="10" r="0.9" fill="#1a1a1a" />
    <rect x="7.6" y="10" width="0.8" height="2" fill="#1a1a1a" />
  </Frame>
);
export const IconKeyFile = (p: IconProps) => (
  <Frame {...p} title="Key">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0c2218" />
    <circle cx="5" cy="8" r="2.5" fill="none" stroke="#facc15" strokeWidth="1.4" />
    <path
      d="M7.2 8 H13 M11 8 V10.5 M13 8 V10.5"
      fill="none"
      stroke="#facc15"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </Frame>
);
export const IconBinary = (p: IconProps) => (
  <Frame {...p} title="Binary">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a1a1a" />
    <text
      x="8"
      y="11.5"
      textAnchor="middle"
      fontSize={9}
      fontWeight={800}
      fontFamily="ui-monospace, SFMono-Regular, monospace"
      fill="#94a3b8"
    >
      01
    </text>
  </Frame>
);
export const IconExe = (p: IconProps) => (
  <Badge {...p} fill="#525252" mono="EXE" monoSize={6} title="Executable" />
);

// Specials / non-source basenames
export const IconReadme = (p: IconProps) => (
  // Original mark: an opened book.
  <Frame {...p} title="README">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e1014" />
    <path
      d="M2 4 Q5 3 8 4 V13 Q5 12 2 13 Z"
      fill="#3b82f6"
    />
    <path
      d="M14 4 Q11 3 8 4 V13 Q11 12 14 13 Z"
      fill="#60a5fa"
    />
    <g stroke="#0e1014" strokeWidth="0.5">
      <line x1="3.5" y1="6" x2="6.5" y2="6" />
      <line x1="3.5" y1="8" x2="6.5" y2="8" />
      <line x1="3.5" y1="10" x2="6.5" y2="10" />
      <line x1="9.5" y1="6" x2="12.5" y2="6" />
      <line x1="9.5" y1="8" x2="12.5" y2="8" />
      <line x1="9.5" y1="10" x2="12.5" y2="10" />
    </g>
  </Frame>
);
export const IconLicense = (p: IconProps) => (
  // Original mark: a sealed scroll.
  <Frame {...p} title="License">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a1306" />
    <path
      d="M3 4 H11 V11 A2 2 0 0 0 13 13 H4 A1 1 0 0 1 3 12 Z"
      fill="#facc15"
      stroke="#92400e"
      strokeWidth="0.6"
    />
    <line x1="5" y1="6.5" x2="9.5" y2="6.5" stroke="#92400e" strokeWidth="0.6" />
    <line x1="5" y1="8.5" x2="9.5" y2="8.5" stroke="#92400e" strokeWidth="0.6" />
    <line x1="5" y1="10.5" x2="8" y2="10.5" stroke="#92400e" strokeWidth="0.6" />
  </Frame>
);
export const IconChangelog = (p: IconProps) => (
  <PageGlyph {...p} fill="#a3e635" title="Changelog"
    accent={
      <g stroke="#3f6212" strokeWidth="0.8" strokeLinecap="round">
        <circle cx="5" cy="7.5" r="0.7" />
        <line x1="6.5" y1="7.5" x2="11" y2="7.5" />
        <circle cx="5" cy="10" r="0.7" />
        <line x1="6.5" y1="10" x2="11" y2="10" />
        <circle cx="5" cy="12.5" r="0.7" />
        <line x1="6.5" y1="12.5" x2="9" y2="12.5" />
      </g>
    }
  />
);
export const IconPackageJson = (p: IconProps) => (
  // Original mark: a parcel / box on red.
  <Frame {...p} title="package.json">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a0a0a" />
    <path d="M3 5 L8 2.5 L13 5 L8 7.5 Z" fill="#cb3837" />
    <path d="M3 5 V11 L8 13.5 V7.5 Z" fill="#a02e2d" />
    <path d="M13 5 V11 L8 13.5 V7.5 Z" fill="#cb3837" />
    <path d="M8 7.5 V13.5" stroke="#1a0a0a" strokeWidth="0.6" />
  </Frame>
);
export const IconLockfile = (p: IconProps) => <IconLock {...p} title="Lock file" />;
export const IconDockerfile = (p: IconProps) => <IconDocker {...p} title="Dockerfile" />;
export const IconCargo = (p: IconProps) => (
  <Badge {...p} fill="#dea584" monoFill="#1a0a00" mono="Cgo" monoSize={5.5} title="Cargo.toml" />
);
export const IconGoMod = (p: IconProps) => (
  <Badge {...p} fill="#00add8" mono="MOD" monoSize={6} title="go.mod" />
);
export const IconPyProject = (p: IconProps) => (
  <Badge {...p} fill="#3776ab" mono="PYP" monoSize={6} title="pyproject.toml" />
);
export const IconRequirements = (p: IconProps) => (
  <Badge {...p} fill="#1e8a4f" mono="PIP" monoSize={6} title="requirements.txt" />
);
export const IconGemfile = (p: IconProps) => (
  <Diamond {...p} fill="#cc342d" mono="GEM" title="Gemfile" />
);
export const IconNpmrc = (p: IconProps) => (
  <Badge {...p} fill="#cb3837" mono=".npm" monoSize={5} title="npmrc" />
);
export const IconNvmrc = (p: IconProps) => (
  <Badge {...p} fill="#5fa04e" mono="NVM" monoSize={6} title="nvmrc" />
);
export const IconEditorConfig = (p: IconProps) => (
  <Badge {...p} fill="#37474f" mono="EDT" monoSize={6} title=".editorconfig" />
);
export const IconPrettier = (p: IconProps) => (
  // Original mark: typographic dots on pink.
  <Frame {...p} title="Prettier">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1a0a18" />
    <g fill="#f9a8d4">
      <circle cx="4" cy="5" r="0.9" />
      <circle cx="6.5" cy="5" r="0.9" />
      <circle cx="9" cy="5" r="0.9" />
      <circle cx="11.5" cy="5" r="0.9" />
      <circle cx="4" cy="8" r="0.9" />
      <circle cx="6.5" cy="8" r="0.9" />
      <circle cx="4" cy="11" r="0.9" />
      <circle cx="6.5" cy="11" r="0.9" />
      <circle cx="9" cy="11" r="0.9" />
    </g>
  </Frame>
);
export const IconESLint = (p: IconProps) => (
  // Original mark: a checkmark on a hex.
  <Frame {...p} title="ESLint">
    <polygon
      points="8,1.5 13.5,5 13.5,11 8,14.5 2.5,11 2.5,5"
      fill="#4b32c3"
    />
    <path
      d="M5 8.5 L7 10.5 L11 6"
      fill="none"
      stroke="#fff"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Frame>
);
export const IconTSConfig = (p: IconProps) => (
  <Badge {...p} fill="#1c3a5f" mono="TS" title="tsconfig.json" accent={
    <circle cx="12" cy="3.5" r="1.3" fill="#fff" />
  } />
);
export const IconJSConfig = (p: IconProps) => (
  <Badge {...p} fill="#5e4f10" monoFill="#fde68a" mono="JS" title="jsconfig.json" accent={
    <circle cx="12" cy="3.5" r="1.3" fill="#fde68a" />
  } />
);
export const IconViteConfig = (p: IconProps) => (
  // Original mark: a lightning silhouette.
  <Frame {...p} title="Vite config">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e0820" />
    <polygon points="9,2 4,9 7.5,9 6,14 12,7 8.5,7 10,2" fill="#bd34fe" />
  </Frame>
);
export const IconWebpack = (p: IconProps) => (
  // Original mark: a wireframe cube.
  <Frame {...p} title="Webpack">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0c1230" />
    <polygon points="8,2.5 13,5 13,11 8,13.5 3,11 3,5" fill="#8dd6f9" opacity="0.85" />
    <polygon points="8,2.5 13,5 8,7.5 3,5" fill="#1c78c0" />
  </Frame>
);
export const IconRollup = (p: IconProps) => (
  <Badge {...p} fill="#ec4a3f" mono="RU" title="Rollup" />
);
export const IconEsbuild = (p: IconProps) => (
  <Badge {...p} fill="#ffcf00" monoFill="#0e0e0e" mono="ESB" monoSize={6} title="esbuild" />
);
export const IconTailwind = (p: IconProps) => (
  // Original mark: two stylised clouds.
  <Frame {...p} title="Tailwind config">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0e1f24" />
    <path
      d="M3 7 C4 4.5, 6 4, 7 6 C8 4.5, 9 5, 10 7 C9 9, 7 8, 6 8.5 C5 9, 4 8.5, 3 7 Z"
      fill="#38bdf8"
    />
    <path
      d="M6 11 C7 8.5, 9 8, 10 10 C11 8.5, 12 9, 13 11 C12 13, 10 12, 9 12.5 C8 13, 7 12.5, 6 11 Z"
      fill="#38bdf8"
    />
  </Frame>
);
export const IconNext = (p: IconProps) => (
  <Badge {...p} fill="#0a0a0a" outline="rgba(255,255,255,0.30)" mono="N" title="Next.js config" />
);
export const IconNuxt = (p: IconProps) => (
  <Badge {...p} fill="#0e6f47" mono="N" title="Nuxt config" />
);
export const IconBabel = (p: IconProps) => (
  <Badge {...p} fill="#f5da55" monoFill="#0e0e0e" mono="BBL" monoSize={6} title="Babel config" />
);
export const IconJest = (p: IconProps) => (
  // Original mark: a target/bullseye.
  <Frame {...p} title="Jest config">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#15121f" />
    <circle cx="8" cy="8" r="5" fill="none" stroke="#c63d4d" strokeWidth="1.1" />
    <circle cx="8" cy="8" r="3" fill="none" stroke="#c63d4d" strokeWidth="1.1" />
    <circle cx="8" cy="8" r="1" fill="#c63d4d" />
  </Frame>
);
export const IconVitest = (p: IconProps) => (
  // Same target but tinted green to distinguish.
  <Frame {...p} title="Vitest config">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#0d1b14" />
    <circle cx="8" cy="8" r="5" fill="none" stroke="#22c55e" strokeWidth="1.1" />
    <circle cx="8" cy="8" r="3" fill="none" stroke="#22c55e" strokeWidth="1.1" />
    <circle cx="8" cy="8" r="1" fill="#22c55e" />
  </Frame>
);
export const IconPlaywright = (p: IconProps) => (
  <Badge {...p} fill="#2d3748" outline="rgba(255,255,255,0.25)" mono="PW" title="Playwright" />
);
export const IconCypress = (p: IconProps) => (
  <Badge {...p} fill="#17202c" outline="rgba(255,255,255,0.25)" mono="CY" title="Cypress" />
);
export const IconCommitLint = (p: IconProps) => (
  <Badge {...p} fill="#7c3aed" mono="CL" title="commitlint" />
);

// File-tree fallback (generic source). Subtle so unrecognised
// types don't shout for attention.
export const IconGenericFile = (p: IconProps) => (
  <PageGlyph {...p} fill="#4b5563" title="File" />
);
export const IconGenericCode = (p: IconProps) => (
  <Frame {...p} title="Source file">
    <rect x="1" y="1" width="14" height="14" rx="3" fill="#1f2937" />
    <text
      x="8"
      y="11"
      textAnchor="middle"
      fontFamily="ui-monospace, SFMono-Regular, monospace"
      fontWeight={700}
      fontSize={7}
      fill="#9ca3af"
    >
      {"</>"}
    </text>
  </Frame>
);
