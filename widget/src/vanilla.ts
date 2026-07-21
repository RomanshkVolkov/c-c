// Vanilla fallback for non-React sites. Ship as a single widget.js and drop in:
//   <script src="https://cac.guz-studio.dev/widget.js" data-project-key="pk_…"></script>
// Auto-mounts a launcher + form from the script tag's data-* attributes. No peer
// deps, buffers in memory only, no eval/inline — the site only needs to add the
// ingest origin to connect-src.
import { createReporter, type Reporter } from "./core";
import { getStrings, type Locale, type Strings } from "./i18n";
import type { WidgetConfig } from "./types";

const BUG_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>`;

function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const r = clamp((n >> 16) + Math.round((255 * pct) / 100));
  const g = clamp(((n >> 8) & 0xff) + Math.round((255 * pct) / 100));
  const b = clamp((n & 0xff) + Math.round((255 * pct) / 100));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function readConfig(): WidgetConfig | null {
  const el = document.currentScript as HTMLScriptElement | null;
  const key = el?.dataset.projectKey;
  if (!key) {
    console.warn("[report-widget] missing data-project-key");
    return null;
  }
  const position = el?.dataset.position === "bottom-left" ? "bottom-left" : "bottom-right";
  return {
    projectKey: key,
    endpoint: el?.dataset.endpoint,
    locale: (el?.dataset.locale as Locale) || undefined,
    theme: { color: el?.dataset.color ?? "#4f46e5", position },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  props: Partial<HTMLElementTagNameMap[K]> = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  Object.assign(node, props);
  return node;
}

function mount(cfg: WidgetConfig, reporter: Reporter, t: Strings) {
  const color = cfg.theme?.color ?? "#4f46e5";
  const side = cfg.theme?.position === "bottom-left" ? { left: "24px" } : { right: "24px" };

  const btn = el(
    "button",
    {
      position: "fixed",
      bottom: "24px",
      ...side,
      zIndex: "2147483000",
      display: "grid",
      placeItems: "center",
      width: "52px",
      height: "52px",
      borderRadius: "16px",
      border: "none",
      background: `linear-gradient(135deg, ${color}, ${shade(color, -18)})`,
      color: "#fff",
      cursor: "pointer",
      boxShadow: "0 6px 20px rgba(0,0,0,.22)",
      transition: "transform .15s ease, box-shadow .15s ease",
    },
    { innerHTML: BUG_SVG, title: t.launch }
  );
  btn.setAttribute("aria-label", t.launch);
  btn.onmouseenter = () => {
    btn.style.transform = "translateY(-2px)";
    btn.style.boxShadow = "0 10px 26px rgba(0,0,0,.28)";
  };
  btn.onmouseleave = () => {
    btn.style.transform = "";
    btn.style.boxShadow = "0 6px 20px rgba(0,0,0,.22)";
  };
  btn.onclick = () => openForm(reporter, color, t);
  document.body.appendChild(btn);
}

function openForm(reporter: Reporter, color: string, t: Strings) {
  const files: File[] = [];

  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    zIndex: "2147483001",
    background: "rgba(15,15,20,.45)",
    display: "grid",
    placeItems: "center",
    fontFamily: "system-ui, -apple-system, sans-serif",
  });
  const close = () => overlay.remove();
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };

  const card = el("div", {
    background: "#fff",
    color: "#18181b",
    borderRadius: "16px",
    width: "min(440px, 92vw)",
    padding: "22px",
    boxShadow: "0 20px 60px rgba(0,0,0,.35)",
  });
  card.onpaste = (e) => {
    const imgs = Array.from((e as ClipboardEvent).clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    for (const f of imgs) if (files.length < 5) files.push(f);
    if (imgs.length) attachInfo.textContent = `${files.length} ${t.imagesAttached}`;
  };

  const fieldStyle: Partial<CSSStyleDeclaration> = {
    width: "100%",
    padding: "9px 11px",
    borderRadius: "10px",
    border: "1px solid #e4e4e7",
    fontSize: "14px",
    boxSizing: "border-box",
    marginBottom: "10px",
  };

  const title = el("input", fieldStyle, { placeholder: t.titlePlaceholder });
  const desc = el("textarea", { ...fieldStyle, resize: "vertical" } as Partial<CSSStyleDeclaration>, { rows: 3, placeholder: t.descPlaceholder });

  const fileInput = el("input", { display: "none" }, { type: "file", accept: "image/*", multiple: true });
  fileInput.onchange = () => {
    for (const f of Array.from(fileInput.files ?? [])) if (files.length < 5) files.push(f);
    attachInfo.textContent = `${files.length} ${t.imagesAttached}`;
  };
  const attachLabel = el("label", { fontSize: "13px", color: "#52525b", cursor: "pointer", display: "block", marginBottom: "10px" }, { textContent: `📎 ${t.attach}` });
  attachLabel.appendChild(fileInput);
  attachLabel.onclick = () => fileInput.click();
  const attachInfo = el("div", { fontSize: "12px", color: "#52525b", marginBottom: "10px" });

  const err = el("p", { color: "#dc2626", fontSize: "13px", margin: "0 0 10px" });

  const submit = el("button", { padding: "9px 15px", borderRadius: "10px", border: "none", background: color, color: "#fff", cursor: "pointer" }, { textContent: t.send });
  const cancel = el("button", { padding: "9px 15px", borderRadius: "10px", border: "1px solid #e4e4e7", background: "#fff", cursor: "pointer", marginRight: "8px" }, { textContent: t.cancel });
  cancel.onclick = close;

  submit.onclick = async () => {
    if (!title.value.trim()) return;
    submit.textContent = t.sending;
    (submit as HTMLButtonElement).disabled = true;
    err.textContent = "";
    try {
      await reporter.submit({ title: title.value.trim(), description: desc.value.trim(), images: files });
      card.innerHTML = `<p style="text-align:center;padding:28px 0;margin:0;font-size:15px">✅ ${t.thanks}</p>`;
      setTimeout(close, 1400);
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
      submit.textContent = t.send;
      (submit as HTMLButtonElement).disabled = false;
    }
  };

  const heading = el("h2", { margin: "0 0 14px", fontSize: "16px" }, { textContent: t.title });
  const actions = el("div", { display: "flex", justifyContent: "flex-end", marginTop: "4px" });
  actions.append(cancel, submit);
  card.append(heading, title, desc, attachLabel, attachInfo, err, actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  title.focus();
}

// Auto-init on load.
const cfg = readConfig();
if (cfg) {
  const reporter = createReporter(cfg);
  const t = getStrings(cfg.locale);
  if (document.body) mount(cfg, reporter, t);
  else window.addEventListener("DOMContentLoaded", () => mount(cfg, reporter, t));
}
