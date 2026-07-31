import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import { mediaSrc, openAttachment } from "@/lib/media";

/**
 * Read-only markdown. Used wherever stored markdown is displayed (task
 * descriptions, comments, report bodies) so authoring and reading agree on one
 * format.
 *
 * Raw HTML is not enabled: the content comes from users and rendering their HTML
 * inside the app's own webview would be an XSS foothold with access to Tauri's
 * IPC. GFM covers what the editor can produce anyway.
 */
export default function Markdown({
  children,
  className,
  onInternalLink,
}: {
  children: string;
  className?: string;
  /**
   * Handles an href before it falls through to the attachment/browser paths
   * below. Return true to say "handled, stop here". Used by notes to route a
   * `[Title](/notes/<id>)` link to `navigate()` instead of the OS browser —
   * kept as a prop rather than importing react-router here, since this
   * component is shared by reports and tasks too.
   */
  onInternalLink?: (href: string) => boolean;
}) {
  return (
    <div className={cn("md-body text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links must not navigate the webview away from the app; hand them to
          // the OS browser instead.
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (!href) return;
                if (onInternalLink?.(href)) return;
                // Attachments are downloaded by Rust (with the header) and opened
                // by the OS; external links go straight to the browser.
                openAttachment(href, children?.toString() ?? "file").catch(() => {
                  const target = mediaSrc(href);
                  if (target) openUrl(target).catch(() => window.open(target, "_blank"));
                });
              }}
              className="text-primary underline decoration-primary/40 hover:decoration-primary"
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <img
              src={mediaSrc(typeof src === "string" ? src : undefined)}
              alt={alt ?? ""}
              loading="lazy"
              className="my-2 max-h-80 rounded-md border object-contain"
            />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
