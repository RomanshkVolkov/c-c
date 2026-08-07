import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X, ExternalLink, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { mediaSrc, openAttachment } from "@/lib/media";

/**
 * A PDF, rendered inside the app.
 *
 * WebKitGTK — the webview on Linux — has no built-in PDF viewer, unlike Chrome,
 * so an `<iframe>` shows nothing. pdf.js draws the pages onto canvases itself,
 * which is the only way this works on the platform cac actually runs on.
 *
 * The library is ~350 kB gzipped, so it's behind a dynamic import: it reaches
 * disk once, the first time someone opens a PDF, and never weighs on startup.
 *
 * Bytes come from `mediaSrc()`, which in the app is a `cacmedia://` URL whose
 * handler adds the Authorization header in Rust. pdf.js fetches it like any
 * other URL and never sees a credential.
 */
export default function PdfPreview({
  url,
  fileName,
  onClose,
}: {
  url: string;
  fileName: string;
  onClose: () => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState(0);
  const [current, setCurrent] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Stop the drawer underneath from closing on the same keystroke.
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    // The loading task, not the document: `destroy()` lives there and is what
    // tears down the worker thread. Leaking one per PDF opened would be quiet
    // and expensive.
    let task: { destroy: () => Promise<void> } | null = null;

    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        // The worker ships as a separate file; Vite hashes it and gives us the
        // final URL. Without this pdf.js tries to guess a path and fails.
        const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

        const src = mediaSrc(url);
        if (!src) throw new Error("no source");
        const loading = pdfjs.getDocument({ url: src });
        task = loading;
        const loaded = await loading.promise;
        if (cancelled) return;
        setPages(loaded.numPages);

        const box = holder.current;
        if (!box) return;
        box.replaceChildren();
        for (let n = 1; n <= loaded.numPages; n++) {
          const page = await loaded.getPage(n);
          if (cancelled) return;
          // devicePixelRatio, or the pages are soft on a HiDPI screen.
          const scale = 1.5 * (window.devicePixelRatio || 1);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = `${viewport.width / (window.devicePixelRatio || 1)}px`;
          canvas.style.maxWidth = "100%";
          canvas.className = "mx-auto mb-3 rounded bg-white shadow-lg";
          canvas.dataset.page = String(n);
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          box.appendChild(canvas);
          await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url]);

  // Which page is on screen, for the counter. Cheap: only the visible canvases
  // report, and only while the preview is open.
  useEffect(() => {
    const box = holder.current;
    if (!box || !pages) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).map((e) => Number((e.target as HTMLElement).dataset.page));
        if (visible.length) setCurrent(Math.min(...visible));
      },
      { root: box, threshold: 0.3 },
    );
    for (const c of box.querySelectorAll("canvas")) io.observe(c);
    return () => io.disconnect();
  }, [pages]);

  const scrollToPage = (n: number) => {
    const target = holder.current?.querySelector<HTMLElement>(`canvas[data-page="${n}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85">
      <header className="flex shrink-0 items-center gap-2 px-4 py-2 text-sm text-white">
        <span className="truncate">{fileName}</span>
        {pages > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-white/70">
            <button
              className="rounded p-0.5 hover:bg-white/20 disabled:opacity-30"
              disabled={current <= 1}
              onClick={() => scrollToPage(current - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </button>
            {current} / {pages}
            <button
              className="rounded p-0.5 hover:bg-white/20 disabled:opacity-30"
              disabled={current >= pages}
              onClick={() => scrollToPage(current + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </button>
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* The escape hatch: printing, filling a form, anything a canvas
              can't do is still one click away. */}
          <Button
            size="sm"
            variant="ghost"
            className="text-white hover:bg-white/20 hover:text-white"
            onClick={() => openAttachment(url, fileName).catch(() => {})}
          >
            <ExternalLink className="mr-1 size-3.5" /> Open with system
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="text-white hover:bg-white/20 hover:text-white"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div ref={holder} className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {error ? (
          <p className="mt-16 text-center text-sm text-white/80">
            Couldn't display this PDF ({error}). Try opening it with your system.
          </p>
        ) : pages === 0 ? (
          <p className="mt-16 flex items-center justify-center gap-2 text-sm text-white/80">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
