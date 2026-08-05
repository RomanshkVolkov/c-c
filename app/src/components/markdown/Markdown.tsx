import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import { mediaSrc, openAttachment } from "@/lib/media";

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
  return (
    <div className={cn("md-body text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Order matters: raw HTML is parsed first, then stripped down to the
        // allowlist. Skipping the sanitizer would hand every pasted <script> a
        // home.
        rehypePlugins={allowHtml ? [rehypeRaw, [rehypeSanitize, noteSchema]] : []}
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
