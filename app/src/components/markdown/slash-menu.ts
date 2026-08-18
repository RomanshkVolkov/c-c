import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";

/**
 * La clave del plugin, fuera del cierre a propósito.
 *
 * Exportada porque hay que poder preguntar desde fuera si este menú está
 * abierto: el compositor manda con Enter, y mientras se está eligiendo aquí,
 * Enter es de este menú y no del mensaje. Ver `haySugerenciaAbierta`.
 */
export const SLASH_MENU_KEY = new PluginKey("slashMenu");

/**
 * The `/` command menu: pick a block instead of remembering its markdown.
 *
 * Every command here produces a node markdown can express. That is the rule
 * that decides what gets offered — anything richer would be silently lost the
 * next time the document is serialized, which is worse than not offering it.
 *
 * Written against the DOM rather than React: the popup is a list and a bit of
 * positioning, and a portal would mean threading a React root through an
 * extension that isn't a component.
 */

interface Command {
  title: string;
  hint: string;
  /** Extra words that should match this command while typing. */
  keywords?: string[];
  /** Skip the command when the editor's schema has no node for it. */
  needs?: string;
  run: (editor: Editor, range: Range) => void;
}

const COMMANDS: Command[] = [
  {
    title: "Heading 1",
    hint: "#",
    keywords: ["title", "h1"],
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 1 }).run(),
  },
  {
    title: "Heading 2",
    hint: "##",
    keywords: ["h2"],
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 2 }).run(),
  },
  {
    title: "Heading 3",
    hint: "###",
    keywords: ["h3"],
    run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 3 }).run(),
  },
  {
    title: "Bullet list",
    hint: "-",
    keywords: ["ul", "unordered"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    hint: "1.",
    keywords: ["ol", "ordered"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: "Checklist",
    hint: "- [ ]",
    keywords: ["todo", "task"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    title: "Quote",
    hint: ">",
    keywords: ["blockquote", "cite"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    title: "Code block",
    hint: "```",
    keywords: ["fence", "snippet"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    title: "Table",
    hint: "3×3",
    keywords: ["grid", "rows", "columns"],
    needs: "table",
    run: (e, r) =>
      e.chain().focus().deleteRange(r)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    title: "Collapsible section",
    hint: "<details>",
    keywords: ["toggle", "fold", "expand", "accordion"],
    needs: "details",
    run: (e, r) => e.chain().focus().deleteRange(r).setDetails().run(),
  },
];

function matching(editor: Editor, query: string): Command[] {
  const q = query.toLowerCase().trim();
  return COMMANDS.filter((c) => {
    if (c.needs && !editor.schema.nodes[c.needs]) return false;
    if (!q) return true;
    return (
      c.title.toLowerCase().includes(q) ||
      (c.keywords ?? []).some((k) => k.startsWith(q))
    );
  });
}

/** The popup, kept as plain DOM so the extension owns its whole lifecycle. */
class Popup {
  readonly el: HTMLDivElement;
  private items: Command[] = [];
  private selected = 0;
  private onPick: (command: Command) => void = () => {};

  constructor() {
    this.el = document.createElement("div");
    this.el.className =
      "fixed z-50 max-h-72 w-60 overflow-auto rounded-md border bg-popover p-1 " +
      "text-popover-foreground shadow-md";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  update(items: Command[], onPick: (command: Command) => void) {
    this.items = items;
    this.onPick = onPick;
    // Clamp rather than reset: narrowing the query shouldn't jump the
    // highlight back to the top while the same command is still listed.
    this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
    this.render();
  }

  private render() {
    this.el.replaceChildren();
    this.items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm " +
        (i === this.selected ? "bg-accent text-accent-foreground" : "text-foreground");
      const title = document.createElement("span");
      title.textContent = item.title;
      const hint = document.createElement("span");
      hint.className = "font-mono text-xs text-muted-foreground";
      hint.textContent = item.hint;
      row.append(title, hint);
      // mousedown, not click: a click would first blur the editor and lose the
      // selection the command needs.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.onPick(item);
      });
      this.el.appendChild(row);
    });
  }

  place(rect: DOMRect | null) {
    if (!rect || this.items.length === 0) {
      this.el.style.display = "none";
      return;
    }
    this.el.style.display = "";
    const height = this.el.offsetHeight;
    const below = window.innerHeight - rect.bottom;
    // Flip above the caret when there isn't room under it.
    const top = below < height + 8 ? Math.max(8, rect.top - height - 4) : rect.bottom + 4;
    this.el.style.top = `${top}px`;
    this.el.style.left = `${Math.min(rect.left, window.innerWidth - this.el.offsetWidth - 8)}px`;
  }

  move(delta: number) {
    if (this.items.length === 0) return;
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    this.render();
    this.el.children[this.selected]?.scrollIntoView({ block: "nearest" });
  }

  current(): Command | undefined {
    return this.items[this.selected];
  }

  destroy() {
    this.el.remove();
  }
}

export const SlashMenu = Extension.create({
  name: "slashMenu",

  addProseMirrorPlugins() {
    return [
      Suggestion<Command>({
        editor: this.editor,
        // A key of its own. Suggestion defaults to the plugin key
        // `suggestion$`, so two of these in one editor are "different
        // instances of a keyed plugin" and ProseMirror refuses the whole
        // state — taking the editor, and the screen it was on, with it.
        // Nothing caught it until a composer offered / and another trigger
        // together.
        pluginKey: SLASH_MENU_KEY,
        char: "/",
        // A code block is where someone actually types paths and regexes.
        allow: ({ state, range }) =>
          !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => matching(this.editor, query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let popup: Popup | null = null;
          // Rebound on every update: the plugin hands out a fresh `command`
          // closed over the current range, and running a stale one would
          // delete the wrong slice of text.
          let pick: (item: Command) => void = () => {};

          return {
            onStart: (props) => {
              pick = (item) => props.command(item);
              popup = new Popup();
              popup.update(props.items, pick);
              popup.place(props.clientRect?.() ?? null);
            },
            onUpdate: (props) => {
              pick = (item) => props.command(item);
              popup?.update(props.items, pick);
              popup?.place(props.clientRect?.() ?? null);
            },
            onKeyDown: ({ event }) => {
              if (!popup) return false;
              if (event.key === "Escape") {
                popup.destroy();
                popup = null;
                return true;
              }
              if (event.key === "ArrowDown") {
                popup.move(1);
                return true;
              }
              if (event.key === "ArrowUp") {
                popup.move(-1);
                return true;
              }
              if (event.key === "Enter") {
                const item = popup.current();
                if (!item) return false;
                pick(item);
                return true;
              }
              return false;
            },
            onExit: () => {
              popup?.destroy();
              popup = null;
            },
          };
        },
      }),
    ];
  },
});
