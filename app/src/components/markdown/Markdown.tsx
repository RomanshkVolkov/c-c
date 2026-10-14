import { slugify } from "@/lib/headings";
import { useT } from "@/lib/i18n";
import { useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import MermaidDiagram from "@/components/markdown/MermaidDiagram";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { openExternal } from "@/lib/platform";
import { ImageOff, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { attachmentPath, isPdfAttachment, mediaSrc, openAttachment } from "@/lib/media";
import Lightbox from "@/components/Lightbox";
import PdfPreview from "@/components/PdfPreview";
import PdfCard from "@/components/PdfCard";
import RepoInclude from "@/components/docs/RepoInclude";
import { matchRepoBlobUrl } from "@/lib/repo-links";

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
/**
 * Deja pasar el esquema `cac:`, y nada más que eso.
 *
 * react-markdown vacía por defecto el `href` de cualquier protocolo que no
 * reconoce, y `cac:` es uno de los nuestros: es como este repo apunta a algo de
 * dentro desde dentro de un cuerpo (`domain/mention.go`, `domain/refs.go`). Sin
 * esta excepción el enlace llega con `href=""`, así que `onInternalLink` no ve
 * nada que reclamar y el clic se cae a la rama de los adjuntos — que es donde
 * estaban cayendo ya las menciones, calladamente, desde que se escribieron.
 *
 * El resto sigue pasando por el transformador de siempre: esto **añade** un
 * esquema inerte, no abre la puerta a `javascript:`.
 */
function urlTransform(url: string): string {
  return url.startsWith("cac:") ? url : defaultUrlTransform(url);
}

/**
 * El texto de un bloque ```mermaid, o null si el `<pre>` es otra cosa. Del
 * árbol (hast) y no de los hijos ya pintados: ahí la clase del lenguaje está
 * sin ambigüedad en el `<code>` de dentro.
 */
export function mermaidSource(node: unknown): string | null {
  const pre = node as { children?: { tagName?: string; properties?: { className?: unknown }; children?: { value?: string }[] }[] } | undefined;
  const code = pre?.children?.find((c) => c.tagName === "code");
  const clases = code?.properties?.className;
  const lista = Array.isArray(clases) ? clases.map(String) : typeof clases === "string" ? clases.split(" ") : [];
  if (!lista.includes("language-mermaid")) return null;
  const texto = (code?.children ?? []).map((c) => c.value ?? "").join("");
  return texto.replace(/\n$/, "");
}

/**
 * Si un párrafo no es más que un enlace a un .md en GitHub, su URL. Lo que se
 * pega solo en su línea es lo que se quiere ver entero; un enlace en mitad de
 * una frase es una referencia, y se queda como enlace.
 */
export function loneLink(node: unknown): string | null {
  const p = node as { children?: { type: string; tagName?: string; value?: string; properties?: { href?: unknown } }[] } | undefined;
  const kids = (p?.children ?? []).filter((c) => !(c.type === "text" && !c.value?.trim()));
  if (kids.length !== 1 || kids[0].tagName !== "a") return null;
  const href = kids[0].properties?.href;
  return typeof href === "string" && matchRepoBlobUrl(href) ? href : null;
}

export default function Markdown({
  children,
  className,
  onInternalLink,
  allowHtml = false,
  imageSrc,
  includes = false,
}: {
  /**
   * Reescribe el `src` de una imagen antes de pedirla: un .md del repo pide
   * las suyas relativas a su ruta (ver `repoImageSrc`).
   */
  imageSrc?: (src: string) => string | null;
  /**
   * Un párrafo que sólo es la URL de GitHub de un .md de un repo de la org se
   * pinta con su contenido (el «include» de Confluence; ver `RepoInclude`).
   * Sólo en documentación, y nunca dentro de un include.
   */
  includes?: boolean;
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
  const { t } = useT();
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);
  const [pdf, setPdf] = useState<{ url: string; fileName: string } | null>(null);

  return (
    <div className={cn("md-body text-sm leading-relaxed", className)}>
      {zoomed && <Lightbox {...zoomed} onClose={() => setZoomed(null)} />}
      {pdf && <PdfPreview {...pdf} onClose={() => setPdf(null)} />}
      <ReactMarkdown
        urlTransform={urlTransform}
        remarkPlugins={[remarkGfm]}
        // Order matters: raw HTML is parsed first, then stripped down to the
        // allowlist. Skipping the sanitizer would hand every pasted <script> a
        // home.
        rehypePlugins={allowHtml ? [rehypeRaw, [rehypeSanitize, noteSchema]] : []}
        components={{
          // Los encabezados llevan ancla, con **la misma** función que usa el
          // índice de un documento: si cada uno calculara su slug, el índice
          // apuntaría a anclas que no existen. Inofensivo donde no se usa —
          // una tarea o una nota se quedan con un atributo de más.
          h2: ({ children }) => (
            <h2 id={slugify(String(children))}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 id={slugify(String(children))}>{children}</h3>
          ),
          // Links must not navigate the webview away from the app; hand them to
          // the OS browser instead.
          a: ({ href, children }) => {
            // A file reads differently from a link to somewhere: it downloads
            // and opens in another program. Marking it says so before it's
            // clicked, instead of leaving a PDF looking like a web address.
            const isFile = !!href && !!attachmentPath(href);
            const label = children?.toString() ?? "file";
            const isPdf = isPdfAttachment(href, label);
            // Un PDF adjunto se ve como tarjeta con su primera página, como en
            // Slack, y no como un enlace con su nombre.
            if (isPdf && href) {
              return <PdfCard url={href} fileName={label} onOpen={() => setPdf({ url: href, fileName: label })} />;
            }
            return (
              <a
                href={href}
                title={isPdf ? t("common:last.preview") : isFile ? t("common:last.openWithSystem") : undefined}
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
                    if (target) openExternal(target).catch(() => window.open(target, "_blank"));
                  });
                }}
                className="text-primary underline decoration-primary/40 hover:decoration-primary"
              >
                {isFile && <Paperclip className="mr-0.5 inline size-3 align-[-0.1em]" />}
                {children}
              </a>
            );
          },
          // Un bloque ```mermaid se dibuja (ver `MermaidDiagram`); el resto
          // de bloques de código siguen como siempre.
          pre: ({ children, node, ...rest }) => {
            const codigo = mermaidSource(node);
            if (codigo !== null) return <MermaidDiagram source={codigo} />;
            return <pre {...rest}>{children}</pre>;
          },
          // Capped at max-h-80 so a screenshot doesn't push the rest of the
          // comment off the screen; clicking it lifts that cap.
          ...(includes
            ? {
                p: ({ children, node, ...rest }) => {
                  const href = loneLink(node);
                  if (href) return <RepoInclude href={href}>{children}</RepoInclude>;
                  // Con lo que traiga (un `<p align="center">` de un README).
                  return <p {...rest}>{children}</p>;
                },
              }
            : {}),
          img: ({ src, alt, width, height }) => (
            <Imagen
              src={mediaSrc(typeof src === "string" ? (imageSrc ? (imageSrc(src) ?? undefined) : src) : undefined)}
              alt={alt ?? ""}
              width={width}
              height={height}
              onZoom={setZoomed}
            />
          ),
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

/**
 * Una imagen del texto, y qué se enseña cuando ya no está.
 *
 * Un `<img>` que no carga sale como un icono roto: no dice qué falta, ni que
 * faltaba a propósito, ni que alguien lo borró. Y donde más se ve es en un
 * reporte, que es el artefacto que se lee meses después.
 *
 * El fallo se detecta al cargar y no antes porque no hay forma de saberlo antes:
 * la única prueba de que un adjunto sigue existiendo es pedirlo.
 */
function Imagen({
  src,
  alt,
  width,
  height,
  onZoom,
}: {
  src?: string;
  alt: string;
  /** Los de un `<img width=…>` de un README: quien lo escribió eligió el tamaño. */
  width?: number | string;
  height?: number | string;
  onZoom: (v: { src: string; alt: string }) => void;
}) {
  const { t } = useT();
  const [roto, setRoto] = useState(false);

  if (!src || roto) {
    return (
      <span className="my-2 inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">
        <ImageOff className="size-3.5 shrink-0" />
        {/* El texto alternativo si lo hay: quien escribió «captura del error»
            dejó ahí la única pista de qué se perdió. */}
        {alt ? t("common:last.imageGoneNamed", { name: alt }) : t("common:last.imageGone")}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading="lazy"
      onError={() => setRoto(true)}
      onClick={(e) => {
        // Dentro de un enlace (una insignia, un logo que lleva a su web), el
        // clic es del enlace, no de ampliarla.
        if ((e.target as HTMLElement).closest("a")) return;
        onZoom({ src, alt });
      }}
      className={cn(
        "my-2 cursor-zoom-in rounded-md border object-contain",
        // Con tamaño puesto a mano, ése manda; sin él, el tope de siempre.
        width || height ? "max-w-full" : "max-h-80",
        // Una imagen en un enlace va en línea y sin marco: es una insignia o
        // un logo, y una fila de ellas tiene que quedar en una fila.
        "[a_&]:my-0 [a_&]:inline [a_&]:cursor-pointer [a_&]:rounded-none [a_&]:border-0 [a_&]:align-middle",
      )}
    />
  );
}
