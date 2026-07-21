import { useEffect, useMemo, useRef, useState } from "react";
import { createReporter, type Reporter } from "./core";
import { getStrings, fmt, type Strings } from "./i18n";
import type { ReporterReport, WidgetConfig } from "./types";
import type { StoredReport } from "./storage";

const POSITIONS = {
  "bottom-right": { bottom: 24, right: 24 },
  "bottom-left": { bottom: 24, left: 24 },
} as const;

const STATUS_COLOR: Record<string, string> = {
  pending: "#f59e0b",
  in_progress: "#3b82f6",
  resolved: "#10b981",
  closed: "#9ca3af",
};

function BugGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m8 2 1.88 1.88" /><path d="M14.12 3.88 16 2" /><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
      <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" /><path d="M12 20v-9" />
      <path d="M6.53 9C4.6 8.8 3 7.1 3 5" /><path d="M6 13H2" /><path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
      <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" /><path d="M22 13h-4" /><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
    </svg>
  );
}

export function ReportWidget(cfg: WidgetConfig) {
  const reporterRef = useRef<Reporter | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"report" | "mine">("report");

  useEffect(() => {
    const reporter = createReporter(cfg);
    reporterRef.current = reporter;
    return () => reporter.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.projectKey, cfg.endpoint]);

  const color = cfg.theme?.color ?? "#4f46e5";
  const pos = POSITIONS[cfg.theme?.position ?? "bottom-right"];
  const t = getStrings(cfg.locale);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t.launch}
        title={t.launch}
        style={{
          position: "fixed", ...pos, zIndex: 2147483000, display: "grid", placeItems: "center",
          width: 52, height: 52, borderRadius: 16, border: "none",
          background: `linear-gradient(135deg, ${color}, ${shade(color, -18)})`, color: "#fff",
          cursor: "pointer", boxShadow: "0 6px 20px rgba(0,0,0,.22)", transition: "transform .15s ease, box-shadow .15s ease",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 10px 26px rgba(0,0,0,.28)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = "0 6px 20px rgba(0,0,0,.22)"; }}
      >
        <BugGlyph />
      </button>
      {open && reporterRef.current && (
        <Modal reporter={reporterRef.current} color={color} t={t} tab={tab} setTab={setTab} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function Modal({ reporter, color, t, tab, setTab, onClose }: {
  reporter: Reporter; color: string; t: Strings;
  tab: "report" | "mine"; setTab: (v: "report" | "mine") => void; onClose: () => void;
}) {
  const tabBtn = (key: "report" | "mine"): React.CSSProperties => ({
    flex: 1, padding: "8px 0", fontSize: 13, cursor: "pointer", border: "none", background: "none",
    borderBottom: tab === key ? `2px solid ${color}` : "2px solid transparent",
    color: tab === key ? "#18181b" : "#71717a", fontWeight: tab === key ? 600 : 400,
  });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 2147483001, background: "rgba(15,15,20,.45)", backdropFilter: "blur(2px)", display: "grid", placeItems: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", color: "#18181b", borderRadius: 16, width: "min(440px, 92vw)", maxHeight: "86vh", display: "flex", flexDirection: "column", fontFamily: "system-ui, -apple-system, sans-serif", boxShadow: "0 20px 60px rgba(0,0,0,.35)", overflow: "hidden" }}>
        <div style={{ display: "flex", borderBottom: "1px solid #f0f0f2" }}>
          <button type="button" style={tabBtn("report")} onClick={() => setTab("report")}>{t.tabReport}</button>
          <button type="button" style={tabBtn("mine")} onClick={() => setTab("mine")}>{t.tabMine}</button>
        </div>
        <div style={{ padding: 20, overflowY: "auto" }}>
          {tab === "report" ? (
            <NewReportForm reporter={reporter} color={color} t={t} onSent={() => setTab("mine")} />
          ) : (
            <MyReports reporter={reporter} color={color} t={t} />
          )}
        </div>
      </div>
    </div>
  );
}

const field: React.CSSProperties = { width: "100%", padding: "9px 11px", borderRadius: 10, border: "1px solid #e4e4e7", fontSize: 14, boxSizing: "border-box" };

function NewReportForm({ reporter, color, t, onSent }: { reporter: Reporter; color: string; t: Strings; onSent: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const tel = useMemo(() => reporter.telemetry(), [reporter]);

  const addFiles = (list: FileList | File[]) => setFiles((prev) => [...prev, ...Array.from(list).filter((f) => f.type.startsWith("image/"))].slice(0, 5));

  const send = async () => {
    if (!title.trim()) return;
    setState("sending"); setError("");
    try {
      await reporter.submit({ title: title.trim(), description: description.trim(), images: files });
      setState("done");
      setTimeout(onSent, 900);
    } catch (e) {
      setState("error"); setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (state === "done") return <p style={{ textAlign: "center", padding: "24px 0", margin: 0 }}>✅ {t.thanks}</p>;

  return (
    <div onPaste={(e) => addFiles(e.clipboardData.files)} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <input style={field} placeholder={t.titlePlaceholder} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <textarea style={{ ...field, resize: "vertical" }} placeholder={t.descPlaceholder} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      <label style={{ fontSize: 13, color: "#52525b", cursor: "pointer" }}>
        📎 {t.attach}
        <input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
      </label>
      {files.length > 0 && <div style={{ fontSize: 12, color: "#52525b" }}>{files.length} {t.imagesAttached}</div>}
      <details style={{ fontSize: 12, color: "#71717a" }}>
        <summary style={{ cursor: "pointer" }}>{t.whatSent}</summary>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          <li>{t.ctxPage}</li>
          <li>{fmt(t.ctxErrors, { e: tel.errors?.length ?? 0, c: tel.console?.length ?? 0 })}</li>
          <li>{fmt(t.ctxNet, { n: tel.network?.length ?? 0, v: tel.nav?.length ?? 0 })}</li>
          <li>{t.ctxShots} {files.length ? `(${files.length})` : `(${t.none})`}</li>
        </ul>
      </details>
      {state === "error" && <p style={{ color: "#dc2626", fontSize: 13, margin: 0 }}>{error}</p>}
      <button type="button" onClick={send} disabled={state === "sending" || !title.trim()} style={{ padding: "9px 15px", borderRadius: 10, border: "none", background: color, color: "#fff", cursor: "pointer", opacity: state === "sending" || !title.trim() ? 0.6 : 1, alignSelf: "flex-end" }}>
        {state === "sending" ? t.sending : t.send}
      </button>
    </div>
  );
}

function StatusBadge({ status, t }: { status: string; t: Strings }) {
  const label = (t as unknown as Record<string, string>)[`status_${status}`] ?? status;
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, color: "#fff", background: STATUS_COLOR[status] ?? "#9ca3af" }}>{label}</span>;
}

function MyReports({ reporter, color, t }: { reporter: Reporter; color: string; t: Strings }) {
  const [list] = useState<StoredReport[]>(() => reporter.myReports());
  const [selected, setSelected] = useState<string | null>(null);

  if (selected) return <ReportThread reporter={reporter} color={color} t={t} id={selected} onBack={() => setSelected(null)} />;

  if (list.length === 0) return <p style={{ color: "#71717a", fontSize: 13, textAlign: "center", padding: "24px 0", margin: 0 }}>{t.mineEmpty}</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {list.map((r) => (
        <button key={r.id} onClick={() => setSelected(r.id)} style={{ textAlign: "left", border: "1px solid #e4e4e7", borderRadius: 10, padding: 10, background: "#fff", cursor: "pointer" }}>
          <div style={{ fontSize: 11, color: "#a1a1aa", fontFamily: "monospace" }}>{r.folio}</div>
          <div style={{ fontSize: 14, marginTop: 2 }}>{r.title}</div>
        </button>
      ))}
    </div>
  );
}

function ReportThread({ reporter, color, t, id, onBack }: { reporter: Reporter; color: string; t: Strings; id: string; onBack: () => void }) {
  const [report, setReport] = useState<ReporterReport | null>(null);
  const [err, setErr] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    reporter.viewReport(id).then(setReport).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [reporter, id]);

  const sendReply = async () => {
    if (!body.trim()) return;
    setSending(true);
    try {
      setReport(await reporter.reply(id, body.trim()));
      setBody("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <button type="button" onClick={onBack} style={{ alignSelf: "flex-start", border: "none", background: "none", color: "#71717a", cursor: "pointer", fontSize: 13, padding: 0 }}>{t.back}</button>
      {err && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      {report && (
        <>
          <div>
            <div style={{ fontSize: 11, color: "#a1a1aa", fontFamily: "monospace" }}>{report.folio}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{report.title}</span>
              <StatusBadge status={report.status} t={t} />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {report.comments.map((c, i) =>
              c.author === "system" ? (
                <p key={i} style={{ fontSize: 12, color: "#a1a1aa", fontStyle: "italic", margin: 0 }}>{c.body}</p>
              ) : (
                <div key={i} style={{ alignSelf: c.author === "you" ? "flex-end" : "flex-start", maxWidth: "85%", background: c.author === "you" ? color : "#f4f4f5", color: c.author === "you" ? "#fff" : "#18181b", padding: "8px 11px", borderRadius: 12, fontSize: 13 }}>
                  <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}>{c.author === "you" ? t.authorYou : t.authorTeam}</div>
                  {c.body}
                </div>
              )
            )}
          </div>
          {report.status !== "closed" && (
            <div style={{ display: "flex", gap: 8 }}>
              <input style={field} placeholder={t.replyPlaceholder} value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendReply(); } }} />
              <button type="button" onClick={sendReply} disabled={sending || !body.trim()} style={{ padding: "9px 15px", borderRadius: 10, border: "none", background: color, color: "#fff", cursor: "pointer", opacity: sending || !body.trim() ? 0.6 : 1 }}>{t.reply}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

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
