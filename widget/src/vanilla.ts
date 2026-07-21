// Vanilla fallback for non-React sites. Ship as a single widget.js and drop in:
//   <script src="https://cac.guz-studio.dev/widget.js" data-project-key="pk_…"></script>
// Auto-mounts a launcher + two-tab modal (Report / My reports) from the script
// tag's data-* attributes. No peer deps, telemetry buffers in memory only, no
// eval/inline — the site only needs to add the ingest origin to connect-src.
import { createReporter, type Reporter } from "./core";
import { getStrings, type Locale, type Strings } from "./i18n";
import type { ReporterReport, WidgetConfig } from "./types";

const BUG_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>`;

const STATUS_COLOR: Record<string, string> = {
  pending: "#f59e0b",
  in_progress: "#3b82f6",
  resolved: "#10b981",
  closed: "#9ca3af",
};

const POLL_MS = 15_000; // open-thread live refresh
const UNREAD_POLL_MS = 60_000; // background unread-badge check (visibility-gated)

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

const FIELD: Partial<CSSStyleDeclaration> = {
  width: "100%",
  padding: "9px 11px",
  borderRadius: "10px",
  border: "1px solid #e4e4e7",
  fontSize: "14px",
  boxSizing: "border-box",
};

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
  const badge = el("span", {
    position: "absolute",
    top: "-4px",
    right: "-4px",
    minWidth: "20px",
    height: "20px",
    padding: "0 5px",
    borderRadius: "999px",
    background: "#ef4444",
    color: "#fff",
    fontSize: "11px",
    fontWeight: "700",
    display: "none",
    placeItems: "center",
    boxShadow: "0 1px 4px rgba(0,0,0,.3)",
    boxSizing: "border-box",
  });
  btn.appendChild(badge);

  const refreshBadge = () => {
    reporter
      .unreadCount()
      .then((n) => {
        badge.textContent = n > 99 ? "99+" : String(n);
        badge.style.display = n > 0 ? "grid" : "none";
      })
      .catch(() => {});
  };

  btn.onclick = () => openModal(reporter, color, t, refreshBadge);
  document.body.appendChild(btn);

  // Background unread check: infrequent + visible-only (never a background load).
  refreshBadge();
  setInterval(() => {
    if (!document.hidden) refreshBadge();
  }, UNREAD_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshBadge();
  });
}

function openModal(reporter: Reporter, color: string, t: Strings, refreshBadge: () => void) {
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
    width: "min(440px, 92svw)",
    maxHeight: "86svh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 20px 60px rgba(0,0,0,.35)",
    overflow: "hidden",
  });

  const tabs = el("div", { display: "flex", borderBottom: "1px solid #f0f0f2" });
  const body = el("div", { padding: "20px", overflowY: "auto" });

  const tabStyle = (active: boolean): Partial<CSSStyleDeclaration> => ({
    flex: "1",
    padding: "10px 0",
    fontSize: "13px",
    cursor: "pointer",
    border: "none",
    background: "none",
    borderBottom: active ? `2px solid ${color}` : "2px solid transparent",
    color: active ? "#18181b" : "#71717a",
    fontWeight: active ? "600" : "400",
  });
  const tabReport = el("button", tabStyle(true), { textContent: t.tabReport });
  const tabMine = el("button", tabStyle(false), { textContent: t.tabMine });

  const show = (which: "report" | "mine") => {
    Object.assign(tabReport.style, tabStyle(which === "report"));
    Object.assign(tabMine.style, tabStyle(which === "mine"));
    body.innerHTML = "";
    if (which === "report") renderForm(body, reporter, color, t, () => show("mine"));
    else renderMine(body, reporter, color, t, refreshBadge);
  };
  tabReport.onclick = () => show("report");
  tabMine.onclick = () => show("mine");

  tabs.append(tabReport, tabMine);
  card.append(tabs, body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  show("report");
}

function renderForm(root: HTMLElement, reporter: Reporter, color: string, t: Strings, onSent: () => void) {
  const files: File[] = [];
  const wrap = el("div", { display: "flex", flexDirection: "column", gap: "10px" });
  wrap.onpaste = (e) => {
    const imgs = Array.from((e as ClipboardEvent).clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    for (const f of imgs) if (files.length < 5) files.push(f);
    if (imgs.length) attachInfo.textContent = `${files.length} ${t.imagesAttached}`;
  };

  const title = el("input", FIELD, { placeholder: t.titlePlaceholder });
  const desc = el("textarea", { ...FIELD, resize: "vertical" } as Partial<CSSStyleDeclaration>, { rows: 3, placeholder: t.descPlaceholder });
  const fileInput = el("input", { display: "none" }, { type: "file", accept: "image/*", multiple: true });
  fileInput.onchange = () => {
    for (const f of Array.from(fileInput.files ?? [])) if (files.length < 5) files.push(f);
    attachInfo.textContent = `${files.length} ${t.imagesAttached}`;
  };
  const attachLabel = el("label", { fontSize: "13px", color: "#52525b", cursor: "pointer" }, { textContent: `📎 ${t.attach}` });
  attachLabel.appendChild(fileInput);
  attachLabel.onclick = () => fileInput.click();
  const attachInfo = el("div", { fontSize: "12px", color: "#52525b" });
  const err = el("p", { color: "#dc2626", fontSize: "13px", margin: "0" });
  const submit = el("button", { padding: "9px 15px", borderRadius: "10px", border: "none", background: color, color: "#fff", cursor: "pointer", alignSelf: "flex-end" }, { textContent: t.send });

  submit.onclick = async () => {
    if (!title.value.trim()) return;
    submit.textContent = t.sending;
    (submit as HTMLButtonElement).disabled = true;
    err.textContent = "";
    try {
      await reporter.submit({ title: title.value.trim(), description: desc.value.trim(), images: files });
      root.innerHTML = `<p style="text-align:center;padding:24px 0;margin:0">✅ ${t.thanks}</p>`;
      setTimeout(onSent, 900);
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
      submit.textContent = t.send;
      (submit as HTMLButtonElement).disabled = false;
    }
  };

  wrap.append(title, desc, attachLabel, attachInfo, err, submit);
  root.appendChild(wrap);
  title.focus();
}

function renderMine(root: HTMLElement, reporter: Reporter, color: string, t: Strings, refreshBadge: () => void) {
  const list = reporter.myReports();
  if (list.length === 0) {
    root.appendChild(el("p", { color: "#71717a", fontSize: "13px", textAlign: "center", padding: "24px 0", margin: "0" }, { textContent: t.mineEmpty }));
    return;
  }
  const wrap = el("div", { display: "flex", flexDirection: "column", gap: "8px" });
  for (const r of list) {
    const item = el("button", { textAlign: "left", border: "1px solid #e4e4e7", borderRadius: "10px", padding: "10px", background: "#fff", cursor: "pointer" });
    item.innerHTML = `<div style="font-size:11px;color:#a1a1aa;font-family:monospace">${escapeHtml(r.folio)}</div><div style="font-size:14px;margin-top:2px">${escapeHtml(r.title)}</div>`;
    item.onclick = () => {
      root.innerHTML = "";
      renderThread(root, reporter, color, t, r.id, refreshBadge);
    };
    wrap.appendChild(item);
  }
  root.appendChild(wrap);
}

async function renderThread(root: HTMLElement, reporter: Reporter, color: string, t: Strings, id: string, refreshBadge: () => void) {
  const wrap = el("div", { display: "flex", flexDirection: "column", gap: "12px" });
  const back = el("button", { alignSelf: "flex-start", border: "none", background: "none", color: "#71717a", cursor: "pointer", fontSize: "13px", padding: "0" }, { textContent: t.back });
  back.onclick = () => {
    reporter.markSeen(id);
    refreshBadge();
    root.innerHTML = "";
    renderMine(root, reporter, color, t, refreshBadge);
  };
  wrap.appendChild(back);
  root.appendChild(wrap);

  let report: ReporterReport;
  try {
    report = await reporter.viewReport(id);
  } catch (e) {
    wrap.appendChild(el("p", { color: "#dc2626", fontSize: "13px" }, { textContent: e instanceof Error ? e.message : String(e) }));
    return;
  }
  reporter.markSeen(id); // opening clears this report's unread
  refreshBadge();

  const header = el("div", {});
  header.innerHTML = `<div style="font-size:11px;color:#a1a1aa;font-family:monospace">${escapeHtml(report.folio)}</div>`;
  const titleRow = el("div", { display: "flex", alignItems: "center", gap: "8px", marginTop: "3px" });
  const statusEl = el("span", { fontSize: "11px", padding: "2px 8px", borderRadius: "999px", color: "#fff" });
  titleRow.append(el("span", { fontSize: "15px", fontWeight: "600" }, { textContent: report.title }), statusEl);
  header.appendChild(titleRow);
  wrap.appendChild(header);

  if (report.images.length > 0) {
    const gallery = el("div", { display: "flex", flexWrap: "wrap", gap: "6px" });
    gallery.innerHTML = report.images.map((im) => thumb(im.url, im.fileName, 72)).join("");
    wrap.appendChild(gallery);
  }

  bindZoom(wrap);

  const thread = el("div", { display: "flex", flexDirection: "column", gap: "8px" });
  wrap.appendChild(thread);

  // Repaints status + messages only (leaves the composer/typed text untouched).
  const paint = (rep: ReporterReport) => {
    statusEl.textContent = (t as unknown as Record<string, string>)[`status_${rep.status}`] ?? rep.status;
    statusEl.style.background = STATUS_COLOR[rep.status] ?? "#9ca3af";
    thread.innerHTML = "";
    for (const c of rep.comments) {
      if (c.author === "system") {
        thread.appendChild(el("p", { fontSize: "12px", color: "#a1a1aa", fontStyle: "italic", margin: "0" }, { textContent: c.body }));
        continue;
      }
      const mine = c.author === "you";
      const bubble = el("div", {
        alignSelf: mine ? "flex-end" : "flex-start",
        maxWidth: "85%",
        background: mine ? color : "#f4f4f5",
        color: mine ? "#fff" : "#18181b",
        padding: "8px 11px",
        borderRadius: "12px",
        fontSize: "13px",
      });
      const imgsHtml = (c.images ?? []).map((im) => thumb(im.url, im.fileName)).join("");
      bubble.innerHTML =
        `<div style="font-size:10px;opacity:.7;margin-bottom:2px">${mine ? t.authorYou : t.authorTeam}</div>${escapeHtml(c.body)}` +
        (imgsHtml ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${imgsHtml}</div>` : "");
      thread.appendChild(bubble);
    }
  };
  paint(report);

  // Live updates without a refresh: poll messages only, visible-only, and
  // self-clean once the thread leaves the DOM (back / modal closed).
  const iv = setInterval(async () => {
    if (!document.body.contains(thread)) {
      clearInterval(iv);
      return;
    }
    if (document.hidden) return;
    try {
      paint(await reporter.viewReport(id));
      reporter.markSeen(id);
    } catch {
      /* ignore */
    }
  }, POLL_MS);

  if (report.status !== "closed") {
    const files: File[] = [];
    const composer = el("div", { display: "flex", flexDirection: "column", gap: "6px" });
    composer.onpaste = (e) => {
      const imgs = Array.from((e as ClipboardEvent).clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      for (const f of imgs) if (files.length < 5) files.push(f);
      if (imgs.length) info.textContent = `${files.length} ${t.imagesAttached}`;
    };
    const info = el("div", { fontSize: "12px", color: "#71717a" });
    const row = el("div", { display: "flex", gap: "8px" });
    const input = el("input", FIELD, { placeholder: t.replyPlaceholder });
    const fileInput = el("input", { display: "none" }, { type: "file", accept: "image/*", multiple: true });
    fileInput.onchange = () => {
      for (const f of Array.from(fileInput.files ?? [])) if (files.length < 5) files.push(f);
      info.textContent = `${files.length} ${t.imagesAttached}`;
    };
    const attach = el("button", { padding: "9px 12px", borderRadius: "10px", border: "1px solid #e4e4e7", background: "#fff", cursor: "pointer" }, { textContent: "📎", title: t.attach });
    attach.onclick = () => fileInput.click();
    const send = el("button", { padding: "9px 15px", borderRadius: "10px", border: "none", background: color, color: "#fff", cursor: "pointer" }, { textContent: t.reply });
    const doReply = async () => {
      if (!input.value.trim() && files.length === 0) return;
      (send as HTMLButtonElement).disabled = true;
      try {
        await reporter.reply(id, input.value.trim(), files);
        root.innerHTML = "";
        renderThread(root, reporter, color, t, id, refreshBadge);
      } catch {
        (send as HTMLButtonElement).disabled = false;
      }
    };
    send.onclick = doReply;
    input.onkeydown = (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        e.preventDefault();
        doReply();
      }
    };
    row.append(input, attach, fileInput, send);
    composer.append(info, row);
    wrap.appendChild(composer);
  }
}

function openLightbox(url: string) {
  const ov = el("div", {
    position: "fixed",
    inset: "0",
    zIndex: "2147483003",
    background: "rgba(0,0,0,.85)",
    display: "grid",
    placeItems: "center",
    cursor: "zoom-out",
    padding: "24px",
  });
  ov.appendChild(el("img", { maxWidth: "95svw", maxHeight: "95svh", objectFit: "contain", borderRadius: "8px" }, { src: url }));
  ov.onclick = () => ov.remove();
  document.body.appendChild(ov);
}

// Delegated: any <img data-full> opens the lightbox.
function bindZoom(container: HTMLElement) {
  container.addEventListener("click", (e) => {
    const full = (e.target as HTMLElement).dataset?.full;
    if (full) openLightbox(full);
  });
}

function thumb(url: string, alt: string, size = 64): string {
  return `<img data-full="${encodeURI(url)}" src="${encodeURI(url)}" alt="${escapeHtml(alt)}" loading="lazy" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:8px;border:1px solid rgba(0,0,0,.1);cursor:zoom-in"/>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Auto-init on load.
const cfg = readConfig();
if (cfg) {
  const reporter = createReporter(cfg);
  const t = getStrings(cfg.locale);
  if (document.body) mount(cfg, reporter, t);
  else window.addEventListener("DOMContentLoaded", () => mount(cfg, reporter, t));
}
