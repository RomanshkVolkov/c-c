import { useId } from "react";

/**
 * The product's mark, and the mark with its name beside it.
 *
 * Until now the app had no brand anywhere: the window icon was the text "C&C",
 * the webview's favicon was still Vite's default, and the login screen said
 * `CAC` in a plain heading. This is the one place that changes.
 *
 * Three racks and not the five of the source artwork, deliberately. The mark
 * appears at ~24px in the collapsed sidebar and at 32px in the taskbar, and
 * five racks with their vents turn to mush at that size. Sharing one drawing
 * between the app icon and the UI is also worth more than matching a PNG: a
 * person sees both at once.
 */

/** The racks alone: no background, so it sits on whatever surface it's given. */
export function BrandMark({ className }: { className?: string }) {
  // Two of these can be on screen at once (sidebar and login), and duplicate
  // ids in a document make the second mask resolve to the first.
  const vents = useId();

  return (
    <svg
      viewBox="202 220 620 560"
      className={className}
      role="img"
      aria-label="Command & Control"
    >
      <mask id={vents}>
        <rect x="202" y="220" width="620" height="560" fill="#fff" />
        {/* Black is a hole: the vents let the surface behind show through, so
            the mark works on any background instead of needing a variant per
            theme. */}
        <g fill="#000">
          <rect x="234" y="464" width="106" height="28" rx="14" />
          <rect x="234" y="520" width="106" height="28" rx="14" />
          <rect x="234" y="652" width="106" height="28" rx="14" />
          <rect x="234" y="708" width="106" height="28" rx="14" />

          <rect x="459" y="364" width="106" height="28" rx="14" />
          <rect x="459" y="420" width="106" height="28" rx="14" />
          <rect x="459" y="652" width="106" height="28" rx="14" />
          <rect x="459" y="708" width="106" height="28" rx="14" />

          <rect x="684" y="264" width="106" height="28" rx="14" />
          <rect x="684" y="320" width="106" height="28" rx="14" />
          <rect x="684" y="652" width="106" height="28" rx="14" />
          <rect x="684" y="708" width="106" height="28" rx="14" />
        </g>
      </mask>

      {/* currentColor, so the racks follow the text colour of wherever this is
          placed and one file serves light and dark. */}
      <g fill="currentColor" mask={`url(#${vents})`}>
        <rect x="202" y="420" width="170" height="360" rx="24" />
        <rect x="427" y="320" width="170" height="460" rx="24" />
        <rect x="652" y="220" width="170" height="560" rx="24" />
      </g>

      {/* The accent stays literal: it is the one thing that must not change
          with the theme, and it is what carries the meaning of the mark. */}
      <g fill="#DC2921">
        <rect x="230" y="575" width="564" height="30" />
        <rect x="247" y="550" width="80" height="80" />
        <rect x="472" y="550" width="80" height="80" />
        <rect x="697" y="550" width="80" height="80" />
      </g>
    </svg>
  );
}

/**
 * Mark plus name. The name is real text rather than paths inside the SVG: an
 * `.svg` loaded as an image never sees the app's `@font-face`, so a baked
 * wordmark would silently render in a system font. As text it uses the Inter
 * that is already loaded, stays selectable, and scales with the surrounding
 * type.
 *
 * `em` sizing throughout means the caller sets one font size and the whole
 * lockup follows.
 */
export function Brand({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-[0.6em] ${className ?? ""}`}>
      <BrandMark className="h-[1.9em] w-auto shrink-0" />
      <div className="leading-none">
        <div className="text-[1.05em] font-extrabold tracking-[-0.02em]">COMMAND</div>
        {/* The source lockup tracked this line so wide it came out broader than
            COMMAND, which left the block bottom-heavy; and "AND" carried the
            same weight as "CONTROL", so it read as three equal words. */}
        <div className="mt-[0.28em] text-[0.5em] font-medium tracking-[0.28em] text-muted-foreground">
          <span className="opacity-55">AND</span> CONTROL
        </div>
      </div>
    </div>
  );
}
