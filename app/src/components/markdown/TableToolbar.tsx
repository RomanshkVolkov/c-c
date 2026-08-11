import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import {
  ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, ArrowDownToLine,
  Columns3, Rows3, Trash2, Heading,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Table controls, shown while the cursor is inside one.
 *
 * They act on the cell you're in rather than on a column you hover: a floating
 * bar anchored to the table is far less fragile than per-column handles, and
 * "add a column after this one" is unambiguous when "this one" is where you're
 * already typing.
 *
 * **Merging cells is deliberately absent**, though Tiptap offers it. Markdown
 * has no colspan, so a merged table is flattened on save — the data survives
 * (see ./table.ts) but the merge doesn't. Offering the button would be
 * inviting people to build something that quietly changes the moment they save.
 * The rule this editor follows is not to offer what the storage can't hold.
 */

export default function TableToolbar({ editor }: { editor: Editor }) {
  const Btn = ({
    icon: Icon,
    label,
    onClick,
    destructive,
  }: {
    icon: typeof Columns3;
    label: string;
    onClick: () => void;
    destructive?: boolean;
  }) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      // mousedown, not click: a click blurs the editor first and the commands
      // below act on the selection, which by then is gone.
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={cn(
        "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground",
        destructive && "hover:text-destructive",
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );

  return (
    <BubbleMenu
      editor={editor}
      // Only inside a table, and only in the editor — a read-only surface has
      // nothing to act on.
      shouldShow={({ editor: e }) => e.isEditable && e.isActive("table")}
      className="flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-md"
    >
      <Columns3 className="mx-1 size-3 text-muted-foreground/60" />
      <Btn icon={ArrowLeftToLine} label="Column before"
        onClick={() => editor.chain().focus().addColumnBefore().run()} />
      <Btn icon={ArrowRightToLine} label="Column after"
        onClick={() => editor.chain().focus().addColumnAfter().run()} />
      <Btn icon={Trash2} label="Delete column" destructive
        onClick={() => editor.chain().focus().deleteColumn().run()} />

      <span className="mx-1 h-4 w-px bg-border" />

      <Rows3 className="mx-1 size-3 text-muted-foreground/60" />
      <Btn icon={ArrowUpToLine} label="Row above"
        onClick={() => editor.chain().focus().addRowBefore().run()} />
      <Btn icon={ArrowDownToLine} label="Row below"
        onClick={() => editor.chain().focus().addRowAfter().run()} />
      <Btn icon={Trash2} label="Delete row" destructive
        onClick={() => editor.chain().focus().deleteRow().run()} />

      <span className="mx-1 h-4 w-px bg-border" />

      {/* Markdown always writes a header row, so this is really "should the
          first row read as a heading" — worth having, since a table pasted
          without one otherwise promotes its first row of data. */}
      <Btn icon={Heading} label="Toggle header row"
        onClick={() => editor.chain().focus().toggleHeaderRow().run()} />
      <Btn icon={Trash2} label="Delete table" destructive
        onClick={() => editor.chain().focus().deleteTable().run()} />
    </BubbleMenu>
  );
}
