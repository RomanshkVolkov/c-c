import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { attachmentPath, mediaSrc, openAttachment } from "@/lib/media";
import PdfPreview from "@/components/PdfPreview";

/**
 * Read-only markdown. Used wherever stored markdown is displayed (task
 * descriptions, comments, report bodies) so authoring and reading agree on one
 * format.
 *
 * Raw HTML is off by default, and that default is load-bearing: a report's
 * description and comments are written by whoever hits the widget — people
 * outside the company — and rendering their HTML inside the app's own webview
 * would be an XSS foothold next to Tauri's IPC.
 *
 * `allowHtml` opts in, and only notes use it: they are private and written by
 * their owner. Even there the HTML goes through a sanitizer, because "I wrote
 * it" stops being true the moment content is pasted in from somewhere else —
 * a migration from another tool, for instance.
 */

// Collapsible sections are the reason allowHtml exists: markdown has no toggle,
// but <details>/<summary> is the standard way to write one and survives a round
// trip through the file, so exporting a note to .md keeps them.
const noteSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
};
export default function Markdown({
  children,
  className,
  onInternalLink,
  allowHtml = false,
}: {
  children: string;
  className?: string;
  /** Render a sanitized subset of raw HTML — collapsible sections. Notes only. */
  allowHtml?: boolean;
  /**
   * Handles an href before it falls through to the attachment/browser paths
   * below. Return true to say "handled, stop here". Used by notes to route a
   * `[Title](/notes/<id>)` link to `navigate()` instead of the OS browser —
   * kept as a prop rather than importing react-router here, since this
   * component is shared by reports and tasks too.
   */
  onInternalLink?: (href: string) => boolean;
}) {
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);
  const [pdf, setPdf] = useState<{ url: string; fileName: string } | null>(null);

  return (
    <div className={cn("md-body text-sm leading-relaxed", className)}>
      {zoomed && <Lightbox {...zoomed} onClose={() => setZoomed(null)} />}
      {pdf && <PdfPreview {...pdf} onClose={() => setPdf(null)} />}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Order matters: raw HTML is parsed first, then stripped down to the
        // allowlist. Skipping the sanitizer would hand every pasted <script> a
        // home.
        rehypePlugins={allowHtml ? [rehypeRaw, [rehypeSanitize, noteSchema]] : []}
        components={{
          // Links must not navigate the webview away from the app; hand them to
          // the OS browser instead.
          a: ({ href, children }) => {
            // A file reads differently from a link to somewhere: it downloads
            // and opens in another program. Marking it says so before it's
            // clicked, instead of leaving a PDF looking like a web address.
            const isFile = !!href && !!attachmentPath(href);
            const label = children?.toString() ?? "file";
            const isPdf = isFile && /\.pdf(\?|$)/i.test(`${label} ${href}`);
            return (
              <a
                href={href}
                title={isPdf ? "Preview" : isFile ? "Open with your system" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  if (!href) return;
                  if (onInternalLink?.(href)) return;
                  // A PDF stays in the app; everything else goes out to the OS,
                  // which knows what to do with it and we don't.
                  if (isPdf) {
                    setPdf({ url: href, fileName: label });
                    return;
                  }
                  // Attachments are downloaded by Rust (with the header) and opened
                  // by the OS; external links go straight to the browser.
                  openAttachment(href, label).catch(() => {
                    const target = mediaSrc(href);
                    if (target) openUrl(target).catch(() => window.open(target, "_blank"));
                  });
                }}
                className="text-primary underline decoration-primary/40 hover:decoration-primary"
              >
                {isFile && <Paperclip className="mr-0.5 inline size-3 align-[-0.1em]" />}
                {children}
              </a>
            );
          },
          // Capped at max-h-80 so a screenshot doesn't push the rest of the
          // comment off the screen; clicking it lifts that cap.
          img: ({ src, alt }) => {
            const resolved = mediaSrc(typeof src === "string" ? src : undefined);
            return (
              <img
                src={resolved}
                alt={alt ?? ""}
                loading="lazy"
                onClick={() => resolved && setZoomed({ src: resolved, alt: alt ?? "" })}
                className="my-2 max-h-80 cursor-zoom-in rounded-md border object-contain"
              />
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/**
 * The full-size view of one image.
 *
 * Portalled to `document.body` on purpose: a `fixed` overlay rendered in place
 * would be trapped by any ancestor with a transform or its own scroll — and
 * comments live inside exactly that kind of drawer.
 */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
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

  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-6"
    >
      <img
        src={src}
        alt={alt}
        className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
      />
    </div>,
    document.body,
  );
}
