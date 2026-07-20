import { useEffect, useMemo, useRef, useState } from "react";
import { createReporter, type Reporter } from "./core";
import type { WidgetConfig } from "./types";

const POSITIONS = {
  "bottom-right": { bottom: 20, right: 20 },
  "bottom-left": { bottom: 20, left: 20 },
} as const;

/**
 * ReportWidget — drop-in launcher + report form for React/Next sites. Installs
 * telemetry breadcrumbs on mount; the button opens a form that attaches page
 * context, screenshots, telemetry and the opt-in snapshot, then POSTs to the
 * ingest endpoint.
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

  const color = cfg.theme?.color ?? "#2563eb";
  const pos = POSITIONS[cfg.theme?.position ?? "bottom-right"];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Report a bug"
        style={{
          position: "fixed",
          ...pos,
          zIndex: 2147483000,
          width: 48,
          height: 48,
          borderRadius: 999,
          border: "none",
          background: color,
          color: "#fff",
          cursor: "pointer",
          boxShadow: "0 4px 14px rgba(0,0,0,.25)",
          fontSize: 20,
        }}
      >
        🐞
      </button>
      {open && reporterRef.current && (
        <ReportForm
          reporter={reporterRef.current}
          color={color}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ReportForm({
  reporter,
  color,
  onClose,
}: {
  reporter: Reporter;
  color: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");

  const preview = useMemo(() => reporter.telemetry(), [reporter]);

  const addFiles = (list: FileList | File[]) => {
    const imgs = Array.from(list).filter((f) => f.type.startsWith("image/"));
    setFiles((prev) => [...prev, ...imgs].slice(0, 5));
  };

  const send = async () => {
    if (!title.trim()) return;
    setState("sending");
    setError("");
    try {
      await reporter.submit({
        title: title.trim(),
        description: description.trim(),
        reporterEmail: email.trim() || undefined,
        images: files,
      });
      setState("done");
      setTimeout(onClose, 1400);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const field: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid #d4d4d8",
    fontSize: 14,
    boxSizing: "border-box",
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483001,
        background: "rgba(0,0,0,.4)",
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
          borderRadius: 12,
          width: "min(440px, 92vw)",
          padding: 20,
          fontFamily: "system-ui, sans-serif",
          boxShadow: "0 10px 40px rgba(0,0,0,.3)",
        }}
      >
        {state === "done" ? (
          <p style={{ textAlign: "center", padding: "24px 0" }}>✅ Thanks — report sent.</p>
        ) : (
          <>
            <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Report a bug</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input style={field} placeholder="What went wrong?" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
              <textarea style={{ ...field, resize: "vertical" }} placeholder="Steps, expected vs actual…" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
              <input style={field} placeholder="Your email (optional, for updates)" value={email} onChange={(e) => setEmail(e.target.value)} />
              <label style={{ fontSize: 13, color: "#52525b", cursor: "pointer" }}>
                📎 Attach screenshots (or paste)
                <input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
              </label>
              {files.length > 0 && (
                <div style={{ fontSize: 12, color: "#52525b" }}>{files.length} image(s) attached</div>
              )}
              <details style={{ fontSize: 12, color: "#71717a" }}>
                <summary style={{ cursor: "pointer" }}>What will be sent?</summary>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  <li>Page URL, browser, screen size</li>
                  <li>{preview.errors.length} JS error(s), {preview.console.length} console log(s)</li>
                  <li>{preview.network.length} failed request(s), {preview.nav.length} navigation(s)</li>
                  <li>Your screenshots {files.length ? `(${files.length})` : "(none)"}</li>
                </ul>
              </details>
              {state === "error" && <p style={{ color: "#dc2626", fontSize: 13, margin: 0 }}>{error}</p>}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                <button type="button" onClick={onClose} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d4d4d8", background: "#fff", cursor: "pointer" }}>
                  Cancel
                </button>
                <button type="button" onClick={send} disabled={state === "sending" || !title.trim()} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: color, color: "#fff", cursor: "pointer", opacity: state === "sending" || !title.trim() ? 0.6 : 1 }}>
                  {state === "sending" ? "Sending…" : "Send report"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
