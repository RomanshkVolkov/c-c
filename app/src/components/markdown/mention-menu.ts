import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";

/**
 * La clave del plugin, fuera del cierre a propósito.
 *
 * Exportada porque hay que poder preguntar desde fuera si este menú está
 * abierto: el compositor manda con Enter, y mientras se está eligiendo aquí,
 * Enter es de este menú y no del mensaje. Ver `haySugerenciaAbierta`.
 */
export const MENTION_MENU_KEY = new PluginKey("mentionMenu");

/**
 * `@` — name somebody you work with.
 *
 * Only colleagues are offered: people who share the organization this is being
 * written in. That is enforced on the server too (the search takes an orgId and
 * refuses one you don't belong to, and mentions are re-checked against
 * membership when the message is saved) — this list is a convenience, not the
 * boundary.
 *
 * Written against the DOM for the same reason as the `/` and `#` menus: a
 * portal would mean threading a React root through an extension that isn't a
 * component.
 */

export interface PersonRef {
  id: string;
  username: string;
}

/**
 * The link a mention becomes.
 *
 * A scheme of our own rather than a path like `/users/<id>`: a real path would
 * collide with a route somebody adds later, and would be followed by anything
 * that treats the markdown as ordinary text.
 */
export function mentionHref(id: string): string {
  return `cac:user/${id}`;
}

/**
 * Parses one back, so the renderer can tell a mention from any other link.
 *
 * Matched against the exact prefix `mentionHref` writes, and the id pinned to a
 * uuid — the same shape the server parses (domain/mention.go), which this must
 * agree with or a mention will render as a chip and notify nobody.
 */
export function userIdFromHref(href: string): string | null {
  const prefix = "cac:user/";
  if (!href.startsWith(prefix)) return null;
  const id = href.slice(prefix.length);
  // Pinned to a uuid, like the server's own parser: a body is free text and
  // "anything after the slash" is not a rule worth guessing at.
  return /^[0-9a-fA-F-]{36}$/.test(id) ? id : null;
}

function matching(people: PersonRef[], query: string): PersonRef[] {
  const q = query.toLowerCase().trim();
  const hits = q ? people.filter((p) => p.username.toLowerCase().includes(q)) : people;
  return hits.slice(0, 20);
}

class Popup {
  readonly el: HTMLDivElement;
  private items: PersonRef[] = [];
  private selected = 0;
  private onPick: (card: PersonRef) => void = () => {};

  constructor() {
    this.el = document.createElement("div");
    this.el.className =
      "fixed z-50 max-h-72 w-72 overflow-auto rounded-md border bg-popover p-1 " +
      "text-popover-foreground shadow-md";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  update(items: PersonRef[], onPick: (card: PersonRef) => void) {
    this.items = items;
    this.onPick = onPick;
    this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
    this.render();
  }

  private render() {
    this.el.replaceChildren();
    if (this.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "px-2 py-1.5 text-sm text-muted-foreground";
      // Says which board, because "no results" on an unrelated list reads as a
      // broken picker rather than the wrong board being open.
      empty.textContent = "Nobody in this organization matches";
      this.el.appendChild(empty);
      return;
    }
    this.items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm " +
        (i === this.selected ? "bg-accent text-accent-foreground" : "text-foreground");
      const at = document.createElement("span");
      at.className = "font-mono text-xs text-muted-foreground";
      at.textContent = "@";
      const name = document.createElement("span");
      name.className = "truncate";
      name.textContent = item.username;
      row.append(at, name);
      // mousedown, not click: a click blurs the editor first and loses the
      // range the insertion needs.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.onPick(item);
      });
      this.el.appendChild(row);
    });
  }

  place(rect: DOMRect | null) {
    if (!rect) {
      this.el.style.display = "none";
      return;
    }
    this.el.style.display = "";
    const height = this.el.offsetHeight;
    const below = window.innerHeight - rect.bottom;
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

  current(): PersonRef | undefined {
    return this.items[this.selected];
  }

  destroy() {
    this.el.remove();
  }
}

export interface MentionMenuOptions {
  /** Read at trigger time: who is on the team can change under a mounted editor. */
  people: () => PersonRef[];
}

export const MentionMenu = Extension.create<MentionMenuOptions>({
  name: "mentionMenu",

  addOptions() {
    return { people: () => [] };
  },

  addProseMirrorPlugins() {
    const getPeople = () => this.options.people();
    return [
      Suggestion<PersonRef>({
        editor: this.editor,
        // A key of its own. Suggestion defaults to the plugin key
        // `suggestion$`, so two of these in one editor are "different
        // instances of a keyed plugin" and ProseMirror refuses the whole
        // state — taking the editor, and the screen it was on, with it.
        // Nothing caught it until a composer offered @ and another trigger
        // together.
        pluginKey: MENTION_MENU_KEY,
        char: "@",
        // A code block is where somebody actually types an email address or a
        // shell variable; `@` at the start of a line is ordinary prose, so
        // unlike `#` there is no markdown meaning to protect here.
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => matching(getPeople(), query),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              {
                type: "text",
                text: `@${props.username}`,
                marks: [{ type: "link", attrs: { href: mentionHref(props.id) } }],
              },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: () => {
          let popup: Popup | null = null;
          // Rebound on every update: a stale `command` closes over an old range
          // and would delete the wrong slice of text.
          let pick: (item: PersonRef) => void = () => {};

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
