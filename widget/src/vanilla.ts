// Vanilla fallback for non-React sites. Ship as a single widget.js and drop in:
//   <script src="https://cac.guz-studio.dev/widget.js" data-project-key="pk_…"></script>
// Auto-mounts a launcher + form from the script tag's data-* attributes. No peer
// deps, buffers in memory only, no eval/inline — the site only needs to add the
// ingest origin to connect-src.
import { createReporter, type Reporter } from "./core";
import type { WidgetConfig } from "./types";

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
    theme: { color: el?.dataset.color ?? "#2563eb", position },
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

function mount(cfg: WidgetConfig, reporter: Reporter) {
  const color = cfg.theme?.color ?? "#2563eb";
  const side = cfg.theme?.position === "bottom-left" ? { left: "20px" } : { right: "20px" };

  const btn = el("button", {
    position: "fixed",
    bottom: "20px",
    ...side,
    zIndex: "2147483000",
    width: "48px",
    height: "48px",
    borderRadius: "999px",
    border: "none",
    background: color,
    color: "#fff",
    cursor: "pointer",
    fontSize: "20px",
    boxShadow: "0 4px 14px rgba(0,0,0,.25)",
  }, { textContent: "🐞", title: "Report a bug" });
  btn.setAttribute("aria-label", "Report a bug");

  btn.onclick = () => openForm(cfg, reporter, color);
  document.body.appendChild(btn);
}

function openForm(_cfg: WidgetConfig, reporter: Reporter, color: string) {
  const files: File[] = [];

  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    zIndex: "2147483001",
    background: "rgba(0,0,0,.4)",
    display: "grid",
    placeItems: "center",
    fontFamily: "system-ui, sans-serif",
  });
  const close = () => overlay.remove();
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };

  const card = el("div", {
    background: "#fff",
    color: "#18181b",
    borderRadius: "12px",
    width: "min(440px, 92vw)",
    padding: "20px",
    boxShadow: "0 10px 40px rgba(0,0,0,.3)",
  });
  card.onpaste = (e) => {
    const imgs = Array.from((e as ClipboardEvent).clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    for (const f of imgs) if (files.length < 5) files.push(f);
    if (imgs.length) attachInfo.textContent = `${files.length} image(s) attached`;
  };

  const fieldStyle: Partial<CSSStyleDeclaration> = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: "8px",
    border: "1px solid #d4d4d8",
    fontSize: "14px",
    boxSizing: "border-box",
    marginBottom: "10px",
  };

  const title = el("input", fieldStyle, { placeholder: "What went wrong?" });
  const desc = el("textarea", { ...fieldStyle, resize: "vertical" } as Partial<CSSStyleDeclaration>, { rows: 3, placeholder: "Steps, expected vs actual…" });
  const email = el("input", fieldStyle, { placeholder: "Your email (optional)" });

  const fileInput = el("input", { display: "none" }, { type: "file", accept: "image/*", multiple: true });
  fileInput.onchange = () => {
    for (const f of Array.from(fileInput.files ?? [])) if (files.length < 5) files.push(f);
    attachInfo.textContent = `${files.length} image(s) attached`;
  };
  const attachLabel = el("label", { fontSize: "13px", color: "#52525b", cursor: "pointer", display: "block", marginBottom: "10px" }, { textContent: "📎 Attach screenshots (or paste)" });
  attachLabel.appendChild(fileInput);
  attachLabel.onclick = () => fileInput.click();
  const attachInfo = el("div", { fontSize: "12px", color: "#52525b", marginBottom: "10px" });

  const err = el("p", { color: "#dc2626", fontSize: "13px", margin: "0 0 10px" });

  const submit = el("button", {
    padding: "8px 14px",
    borderRadius: "8px",
    border: "none",
    background: color,
    color: "#fff",
    cursor: "pointer",
  }, { textContent: "Send report" });
  const cancel = el("button", {
    padding: "8px 14px",
    borderRadius: "8px",
    border: "1px solid #d4d4d8",
    background: "#fff",
    cursor: "pointer",
    marginRight: "8px",
  }, { textContent: "Cancel" });
  cancel.onclick = close;

  submit.onclick = async () => {
    if (!title.value.trim()) return;
    submit.textContent = "Sending…";
    (submit as HTMLButtonElement).disabled = true;
    err.textContent = "";
    try {
      await reporter.submit({
        title: title.value.trim(),
        description: desc.value.trim(),
        reporterEmail: email.value.trim() || undefined,
        images: files,
      });
      card.innerHTML = '<p style="text-align:center;padding:24px 0">✅ Thanks — report sent.</p>';
      setTimeout(close, 1400);
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
      submit.textContent = "Send report";
      (submit as HTMLButtonElement).disabled = false;
    }
  };

  const heading = el("h2", { margin: "0 0 12px", fontSize: "16px" }, { textContent: "Report a bug" });
  const actions = el("div", { display: "flex", justifyContent: "flex-end", marginTop: "4px" });
  actions.append(cancel, submit);
  card.append(heading, title, desc, email, attachLabel, attachInfo, err, actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  title.focus();
}

// Auto-init on load.
const cfg = readConfig();
if (cfg) {
  const reporter = createReporter(cfg);
  if (document.body) mount(cfg, reporter);
  else window.addEventListener("DOMContentLoaded", () => mount(cfg, reporter));
}
