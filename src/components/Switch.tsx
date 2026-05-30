/**
 * Switch — the one canonical on/off control.
 *
 * Before this lived here there were two incompatible toggles in the AI panel
 * with mismatched sizes, knob colours and animation strategies. That's the
 * sort of inconsistency that makes a dark-theme editor feel uncared-for.
 *
 * Design notes (Pointer Noir):
 *  - Track 32×18 with a 1px inset ring so the knob doesn't disappear into
 *    the noir-canvas background when "off".
 *  - Knob is a solid white circle with a soft shadow; high contrast against
 *    both accent and ridge backgrounds.
 *  - Animation uses translateX (compositor-only) for buttery 60fps motion.
 *  - Focus ring uses noir-accent at 35% alpha so it reads on every neighbour.
 *
 * Use `<Switch checked={...} onChange={...} label="…" />` and forget about
 * the geometry.
 */

import { forwardRef } from "@/lib/preactSignalCompat";

export type SwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible label. Required when the visual is not paired with a label. */
  label?: string;
  /** Size variant. "sm" suits row densely-packed lists, "md" suits prominent
   *  toggles like the runtime card. */
  size?: "sm" | "md";
  className?: string;
};

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, disabled, label, size = "sm", className = "" },
  ref,
) {
  const dims =
        size === "md"
      ? {
          track: "h-5 w-9",
          knob: "h-4 w-4",
          // Travel: track width 36 - knob 16 - padding 2*2 = 16px
          on: "translate-x-[16px]",
        }
      : {
          track: "h-[18px] w-8",
          knob: "h-[14px] w-[14px]",
          // Travel: track width 32 - knob 14 - padding 2*2 = 14px
          on: "translate-x-[14px]",
        };

  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={[
        "relative inline-flex shrink-0 items-center rounded-full",
        "border border-noir-line/70",
        "transition-colors duration-150 ease-out",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-noir-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-noir-panel",
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
        checked
          ? "bg-noir-accent border-noir-accent shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
          : "bg-noir-ridge/70 hover:bg-noir-ridge",
        dims.track,
        className,
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "absolute left-[2px] top-1/2 -translate-y-1/2",
          "rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.45)]",
          "transition-transform duration-150 ease-out will-change-transform",
          dims.knob,
          checked ? dims.on : "translate-x-0",
        ].join(" ")}
      />
    </button>
  );
});
