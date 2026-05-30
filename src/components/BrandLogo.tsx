import { useId } from "@/lib/preactSignalCompat";
import { POINTER_MARK_PATH } from "@/lib/brandLogo";

type BrandLogoProps = {
  className?: string;
  title?: string;
  decorative?: boolean;
  /** @deprecated Pointer's UI mark is intentionally glowless and crisp. */
  glow?: boolean;
};

function svgA11y(title: string | undefined, decorative: boolean | undefined) {
  if (decorative) {
    return { "aria-hidden": true as const, role: undefined };
  }
  return { role: "img" as const, "aria-label": title ?? "Pointer" };
}

function useSvgIds(prefix: string) {
  const raw = useId().replace(/:/g, "");
  return {
    gradient: `${prefix}-gradient-${raw}`,
  };
}

export function PointerMarkSvg({
  className,
  title = "Pointer",
  decorative = false,
}: BrandLogoProps) {
  const ids = useSvgIds("pointer-mark");
  const a11y = svgA11y(title, decorative);

  return (
    <svg
      viewBox="84 112 292 292"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="geometricPrecision"
      {...a11y}
    >
      {!decorative && title ? <title>{title}</title> : null}
      <defs>
        <linearGradient
          id={ids.gradient}
          x1="126"
          y1="149"
          x2="349"
          y2="354"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--pn-accent-hot)" />
          <stop offset="0.58" stopColor="var(--pn-accent)" />
          <stop offset="1" stopColor="var(--pn-accent-soft)" />
        </linearGradient>
      </defs>
      <path
        d={POINTER_MARK_PATH}
        fill={`url(#${ids.gradient})`}
        fillRule="evenodd"
      />
    </svg>
  );
}

export function PointerWordmarkSvg({
  className,
  title = "Pointer",
  decorative = false,
}: BrandLogoProps) {
  const ids = useSvgIds("pointer-wordmark");
  const a11y = svgA11y(title, decorative);

  return (
    <svg
      viewBox="0 0 860 330"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="geometricPrecision"
      textRendering="geometricPrecision"
      {...a11y}
    >
      {!decorative && title ? <title>{title}</title> : null}
      <defs>
        <linearGradient
          id={ids.gradient}
          x1="86"
          y1="59"
          x2="956"
          y2="275"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--pn-accent-hot)" />
          <stop offset="0.55" stopColor="var(--pn-accent)" />
          <stop offset="1" stopColor="var(--pn-accent-soft)" />
        </linearGradient>
      </defs>
      <g>
        <PointerMarkGlyph gradientId={ids.gradient} />
        <text
          x="346"
          y="232"
          fill={`url(#${ids.gradient})`}
          fontFamily="'SF Pro Rounded', 'Avenir Next', Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          fontSize="152"
          fontWeight="740"
          letterSpacing="0"
        >
          pointer
        </text>
      </g>
    </svg>
  );
}

function PointerMarkGlyph({ gradientId }: { gradientId: string }) {
  return (
    <path
      d={POINTER_MARK_PATH}
      transform="translate(-26 -85)"
      fill={`url(#${gradientId})`}
      fillRule="evenodd"
    />
  );
}
