import { useEffect, useMemo, useRef, useState } from "react";
import { createReporter, type Reporter } from "./core";
import { getStrings, fmt } from "./i18n";
import type { WidgetConfig } from "./types";

const POSITIONS = {
  "bottom-right": { bottom: 24, right: 24 },
  "bottom-left": { bottom: 24, left: 24 },
} as const;

function BugGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m8 2 1.88 1.88" />
      <path d="M14.12 3.88 16 2" />
      <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
      <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
      <path d="M12 20v-9" />
      <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
      <path d="M6 13H2" />
      <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
      <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
      <path d="M22 13h-4" />
      <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
    </svg>
  );
}

/**
 * ReportWidget — drop-in launcher + report form for React/Next sites. Installs
 * telemetry breadcrumbs on mount; the button opens a form that attaches page
 * context, screenshots and telemetry, then POSTs to the ingest endpoint. The
 * reporter's identity is expected to come from `context()` (the host app's
 * session) rather than asking for an email.
 */
export function ReportWidget(cfg: WidgetConfig) {
  const reporterRef = useRef<Reporter | null>(null);
  const [open, setOpen] = useState(false);

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
          position: "fixed",
          ...pos,
          zIndex: 2147483000,
          display: "grid",
          placeItems: "center",
          width: 52,
          height: 52,
          borderRadius: 16,
          border: "none",
          background: `linear-gradient(135deg, ${color}, ${shade(color, -18)})`,
          color: "#fff",
          cursor: "pointer",
          boxShadow: "0 6px 20px rgba(0,0,0,.22)",
          transition: "transform .15s ease, box-shadow .15s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = "translateY(-2px)";
          e.currentTarget.style.boxShadow = "0 10px 26px rgba(0,0,0,.28)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = "";
          e.currentTarget.style.boxShadow = "0 6px 20px rgba(0,0,0,.22)";
        }}
      >
        <BugGlyph />
      </button>
      {open && reporterRef.current && (
        <ReportForm reporter={reporterRef.current} color={color} t={t} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function ReportForm({
  reporter,
  color,
  t,
  onClose,
}: {
  reporter: Reporter;
  color: string;
  t: ReturnType<typeof getStrings>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");

  const tel = useMemo(() => reporter.telemetry(), [reporter]);

  const addFiles = (list: FileList | File[]) => {
    const imgs = Array.from(list).filter((f) => f.type.startsWith("image/"));
    setFiles((prev) => [...prev, ...imgs].slice(0, 5));
  };

  const send = async () => {
    if (!title.trim()) return;
    setState("sending");
    setError("");
    try {
      await reporter.submit({ title: title.trim(), description: description.trim(), images: files });
      setState("done");
      setTimeout(onClose, 1400);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const field: React.CSSProperties = {
    width: "100%",
    padding: "9px 11px",
    borderRadius: 10,
    border: "1px solid #e4e4e7",
    fontSize: 14,
    boxSizing: "border-box",
    outlineColor: color,
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483001,
        background: "rgba(15,15,20,.45)",
        backdropFilter: "blur(2px)",
        display: "grid",
        placeItems: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onPaste={(e) => addFiles(e.clipboardData.files)}
        style={{
          background: "#fff",
          color: "#18181b",
          borderRadius: 16,
          width: "min(440px, 92vw)",
          padding: 22,
          fontFamily: "system-ui, -apple-system, sans-serif",
          boxShadow: "0 20px 60px rgba(0,0,0,.35)",
        }}
      >
        {state === "done" ? (
          <p style={{ textAlign: "center", padding: "28px 0", margin: 0, fontSize: 15 }}>✅ {t.thanks}</p>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
              <span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 9, background: color, color: "#fff" }}>
                <BugGlyph size={17} />
              </span>
              <h2 style={{ margin: 0, fontSize: 16 }}>{t.title}</h2>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input style={field} placeholder={t.titlePlaceholder} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
              <textarea style={{ ...field, resize: "vertical" }} placeholder={t.descPlaceholder} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
              <label style={{ fontSize: 13, color: "#52525b", cursor: "pointer" }}>
                📎 {t.attach}
                <input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
              </label>
              {files.length > 0 && (
                <div style={{ fontSize: 12, color: "#52525b" }}>
                  {files.length} {t.imagesAttached}
                </div>
              )}
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
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                <button type="button" onClick={onClose} style={{ padding: "9px 15px", borderRadius: 10, border: "1px solid #e4e4e7", background: "#fff", cursor: "pointer" }}>
                  {t.cancel}
                </button>
                <button type="button" onClick={send} disabled={state === "sending" || !title.trim()} style={{ padding: "9px 15px", borderRadius: 10, border: "none", background: color, color: "#fff", cursor: "pointer", opacity: state === "sending" || !title.trim() ? 0.6 : 1 }}>
                  {state === "sending" ? t.sending : t.send}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Darken/lighten a #rrggbb hex by pct (negative = darker) for the gradient. */
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
