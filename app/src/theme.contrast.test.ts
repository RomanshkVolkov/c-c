import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every colour you read text in, against every surface it sits on.
 *
 * This exists because the failure is silent. The light palette used to clear
 * AA by 0.03 in places — `primary-foreground` on the `primary` fill was 4.51
 * against a 4.5 minimum — and nothing anywhere said so. Lighten a surface a
 * shade one afternoon and the app stops being readable for someone, with no
 * error, no warning and no way to notice from the outside.
 *
 * The values are read out of index.css rather than duplicated here: a copy
 * would drift, and a drifted copy of "is this readable" is worse than none.
 */

// A path, not import.meta.url: the test runs in jsdom, where the module URL
// isn't a file: URL and readFileSync refuses it.
const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");

/** WCAG 2.1 asks 4.5:1 for normal text. The palette is set to 5.5 so that a
 *  later tweak has somewhere to go before it breaks anything. */
const AA_NORMAL = 4.5;

type RGB = [number, number, number];

function oklchToRgb(L: number, C: number, hDeg: number): RGB {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.089484177 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((u) => {
    const c = Math.max(0, Math.min(1, u));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  }) as RGB;
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
}

function parseColor(value: string): RGB | null {
  const v = value.trim();
  if (v.startsWith("#")) return hexToRgb(v);
  const m = v.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  return m ? oklchToRgb(+m[1], +m[2], +m[3]) : null;
}

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: RGB, bg: RGB): number {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Tokens from one block of index.css — `:root` for light, `.dark` for dark. */
function tokens(selector: string): Record<string, RGB> {
  const start = css.indexOf(selector + " {");
  if (start < 0) throw new Error(`no ${selector} block in index.css`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, RGB> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const rgb = parseColor(m[2]);
    if (rgb) out[m[1]] = rgb;
  }
  return out;
}

/** Which foregrounds are read against which surfaces. */
const PAIRS: [fg: string, bg: string][] = [
  ["foreground", "background"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "sidebar"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["sidebar-foreground", "sidebar"],
  ["accent-foreground", "accent"],
  ["secondary-foreground", "secondary"],
  // A fill and the label on it — the pair that was at 4.51.
  ["primary-foreground", "primary"],
  ["sidebar-primary-foreground", "sidebar-primary"],
  // Colour used as text, on the surfaces text sits on.
  ["primary", "background"],
  ["primary", "card"],
  ["destructive", "background"],
  ["destructive", "card"],
  ["success", "background"],
  ["success", "card"],
  ["warning", "background"],
  ["warning", "card"],
  ["error", "background"],
  ["info", "background"],
];

describe.each([
  ["light", ":root"],
  ["dark", ".dark"],
])("%s theme", (_name, selector) => {
  const t = tokens(selector);

  it.each(PAIRS)("%s on %s clears AA for normal text", (fg, bg) => {
    // A pair naming a token this theme doesn't define is a typo in the list,
    // not a pass — say so instead of skipping quietly.
    expect(t[fg], `${fg} missing from ${selector}`).toBeDefined();
    expect(t[bg], `${bg} missing from ${selector}`).toBeDefined();
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
