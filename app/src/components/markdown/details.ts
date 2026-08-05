import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Collapsible sections, stored as markdown.
 *
 * `@tiptap/extension-details` gives us the three nodes and the node view. What
 * it does not give us is the round trip through markdown: it serializes with
 * `createBlockMarkdownSpec`, which belongs to Tiptap v3's own markdown system,
 * and this app stores its content through `tiptap-markdown` instead. Without
 * the spec below the nodes fall through to that library's fallback serializer
 * and — since it runs with `html: false` — a collapsible section would be
 * saved as the literal text `[details]`.
 *
 * The stored shape is the one GitHub renders:
 *
 *     <details>
 *     <summary>Title</summary>
 *
 *     Body, in markdown.
 *
 *     </details>
 *
 * The blank lines are load-bearing. CommonMark ends an HTML block at the first
 * blank line, so the body is parsed as markdown and `rehype-raw` stitches the
 * tags back around it. Without them the body would come out as literal text.
 *
 * Only these two tags are understood. Turning on markdown-it's `html` option
 * would have been one line, but it would also mean that every `<b>` or `<img>`
 * that is plain text in a note today becomes formatting the next time the note
 * is opened — and gets written back that way on save.
 */

// ─── markdown-it ────────────────────────────────────────────────────────────

/**
 * The slice of markdown-it this file touches, declared here rather than
 * imported: the package only arrives transitively through tiptap-markdown, and
 * its `export =` shape doesn't default-import without `esModuleInterop`.
 */
interface MdToken {
  content: string;
  map: [number, number] | null;
  block: boolean;
}

interface BlockState {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  blkIndent: number;
  line: number;
  lineMax: number;
  parentType: string;
  md: { block: { tokenize(state: BlockState, start: number, end: number): void } };
  push(type: string, tag: string, nesting: number): MdToken;
}

type BlockRule = (
  state: BlockState,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean;

interface MarkdownItLike {
  block: {
    ruler: {
      before(before: string, name: string, fn: BlockRule, opts?: { alt?: string[] }): void;
    };
  };
}

const OPEN = /^<details(?:\s[^>]*)?>$/i;
const CLOSE = /^<\/details>$/i;
const SUMMARY = /^<summary(?:\s[^>]*)?>([\s\S]*)<\/summary>$/i;

const lineText = (state: BlockState, line: number) =>
  state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trim();

const detailsRule: BlockRule = (state, startLine, endLine, silent) => {
  if (state.blkIndent > 0) return false;
  if (!OPEN.test(lineText(state, startLine))) return false;

  // Find our own closing tag, counting nested sections on the way.
  let depth = 1;
  let closeLine = -1;
  for (let line = startLine + 1; line < endLine; line++) {
    const text = lineText(state, line);
    if (OPEN.test(text)) {
      depth++;
    } else if (CLOSE.test(text)) {
      depth--;
      if (depth === 0) {
        closeLine = line;
        break;
      }
    }
  }
  // Unclosed: not a section. Leave it to the paragraph rule, which is what
  // renders it as literal text today.
  if (closeLine === -1) return false;
  if (silent) return true;

  // `html_block` tokens are emitted verbatim by markdown-it's renderer, with no
  // regard for its `html` option — that option only gates the *parsing* rule we
  // are standing in for. So the tags reach the DOM without opening the door to
  // any other raw HTML.
  const open = state.push("html_block", "", 0);
  open.content = "<details>\n";
  open.map = [startLine, startLine + 1];
  open.block = true;

  let bodyStart = startLine + 1;
  const summary = SUMMARY.exec(lineText(state, bodyStart));
  const summaryToken = state.push("html_block", "", 0);
  // Already HTML-escaped in the source (the serializer escapes it), so it goes
  // through untouched and the DOM parser turns the entities back into text.
  summaryToken.content = `<summary>${summary ? summary[1] : ""}</summary>\n`;
  summaryToken.map = [bodyStart, bodyStart + 1];
  summaryToken.block = true;
  if (summary) bodyStart++;

  const savedMax = state.lineMax;
  const savedParent = state.parentType;
  state.lineMax = closeLine;
  state.parentType = "root";
  state.md.block.tokenize(state, bodyStart, closeLine);
  state.lineMax = savedMax;
  state.parentType = savedParent;

  const close = state.push("html_block", "", 0);
  close.content = "</details>\n";
  close.map = [closeLine, closeLine + 1];
  close.block = true;

  state.line = closeLine + 1;
  return true;
};

/**
 * tiptap-markdown re-runs every extension's `setup` on each parse, and
 * markdown-it's ruler happily appends the same rule again each time. One flag
 * per parser instance keeps that from piling up on every note switch.
 */
const REGISTERED = "__cacDetailsRule";

function installRule(md: MarkdownItLike) {
  const flagged = md as MarkdownItLike & Record<string, boolean>;
  if (flagged[REGISTERED]) return;
  flagged[REGISTERED] = true;
  md.block.ruler.before("paragraph", "cacDetails", detailsRule, {
    alt: ["paragraph", "blockquote", "list"],
  });
}

/**
 * markdown-it hands us `<details><summary>…</summary><p>…</p></details>`, but
 * `DetailsContent` parses from `div[data-type="detailsContent"]`. Everything
 * after the summary moves into one.
 */
function wrapContent(element: HTMLElement) {
  element.querySelectorAll("details").forEach((details) => {
    if (details.querySelector(':scope > div[data-type="detailsContent"]')) return;

    let summary = details.querySelector(":scope > summary");
    const content = document.createElement("div");
    content.setAttribute("data-type", "detailsContent");
    for (const child of [...details.childNodes]) {
      if (child === summary) continue;
      // Whitespace between tags would land in a node whose content is `block+`.
      if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) continue;
      content.appendChild(child);
    }
    if (!summary) {
      summary = document.createElement("summary");
      details.prepend(summary);
    }
    details.appendChild(content);
  });
}

// ─── Serializing ────────────────────────────────────────────────────────────

interface SerializerState {
  write(content: string): void;
  ensureNewLine(): void;
  renderContent(node: PMNode): void;
  closeBlock(node: PMNode): void;
  text(text: string, escape?: boolean): void;
}

/**
 * A summary is written into an HTML context, so it takes HTML escaping — not
 * markdown's. Escaping it as markdown (`\*`) would show the backslashes to the
 * reader, because the contents of an HTML block are never parsed as markdown.
 */
const escapeHTML = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CollapsibleDetails = Details.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          state.write("<details>");
          state.ensureNewLine();
          state.renderContent(node);
          state.write("</details>");
          state.closeBlock(node);
        },
        parse: {
          setup(markdownit: MarkdownItLike) {
            installRule(markdownit);
          },
          updateDOM(element: HTMLElement) {
            wrapContent(element);
          },
        },
      },
    };
  },
});

const CollapsibleSummary = DetailsSummary.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          state.write(`<summary>${escapeHTML(node.textContent)}</summary>`);
          // Leaves the blank line that lets the body be read as markdown.
          state.closeBlock(node);
        },
      },
    };
  },
});

const CollapsibleContent = DetailsContent.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          state.renderContent(node);
        },
      },
    };
  },
});

/**
 * `persist: false` means the open/closed state lives in a CSS class and never
 * in the document: toggling fires no transaction, so it can't trigger an
 * autosave, and a note always reopens collapsed. That last part is the point —
 * in a long document you expand what you need.
 */
export const collapsibleExtensions = [
  CollapsibleDetails.configure({ persist: false }),
  CollapsibleSummary,
  CollapsibleContent,
];
