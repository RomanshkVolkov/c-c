import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TableMap } from "@tiptap/pm/tables";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Tables that always survive being saved.
 *
 * tiptap-markdown ships a table serializer that gives up on anything markdown
 * can't express — a merged cell, a cell with two blocks — and writes the
 * literal text `[table]` in its place. The whole table, gone, silently.
 *
 * Markdown genuinely can't hold a `colspan`, so something has to be lost. The
 * choice made here is to lose *the merge* and keep *the data*: the grid is
 * flattened to a rectangle, the merged cell's content lands in its first
 * position, and the cells it covered come out empty.
 *
 * Nothing in the UI creates a merged cell — no command is offered — so this is
 * for tables pasted in from elsewhere. It's a safety net, not a feature.
 */

interface SerializerState {
  out: string;
  write(content: string): void;
  ensureNewLine(): void;
  renderInline(node: PMNode): void;
  closeBlock(node: PMNode): void;
}

/**
 * Renders one cell, escaping any pipe it contains.
 *
 * A `|` inside a cell ends the column early and shifts every value after it
 * into the wrong header — a corruption that reads as real data, which is worse
 * than an obvious break. Post-processing the slice we just wrote is the only
 * hook available: the serializer has no "render to a string" of its own.
 */
function renderCell(state: SerializerState, cell: PMNode | null | undefined) {
  if (!cell || !cell.firstChild || !cell.textContent.trim()) return;
  const start = state.out.length;
  state.renderInline(cell.firstChild);
  const written = state.out.slice(start);
  if (written.includes("|")) {
    state.out = state.out.slice(0, start) + written.replace(/\|/g, "\\|");
  }
}

const MarkdownTable = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          // TableMap resolves the real grid: every covered position points back
          // at the cell that spans it. Walking rows and children directly would
          // mis-align a row that has fewer cells because one of them spans two.
          const map = TableMap.get(node);
          const seen = new Set<number>();

          for (let row = 0; row < map.height; row++) {
            state.write("| ");
            for (let col = 0; col < map.width; col++) {
              if (col) state.write(" | ");
              const pos = map.map[row * map.width + col];
              // Already emitted: this position is covered by a span, so the
              // content stays where it first appeared and this cell is blank.
              if (seen.has(pos)) continue;
              seen.add(pos);
              renderCell(state, node.nodeAt(pos));
            }
            state.write(" |");
            state.ensureNewLine();
            if (row === 0) {
              state.write(`| ${Array.from({ length: map.width }, () => "---").join(" | ")} |`);
              state.ensureNewLine();
            }
          }
          state.closeBlock(node);
        },
        parse: {
          // markdown-it handles it: GFM tables are on by default.
        },
      },
    };
  },
});

/**
 * One paragraph per cell, not `block+`.
 *
 * A markdown table row is a single line, so a cell holding two blocks can't be
 * written down. Narrowing the schema means the editor can't produce that state
 * at all — pressing Enter inside a cell used to, and took the table with it.
 */
export const tableExtensions = [
  MarkdownTable,
  TableRow,
  TableHeader.extend({ content: "paragraph" }),
  TableCell.extend({ content: "paragraph" }),
];
