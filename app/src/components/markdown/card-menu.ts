import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";

/**
 * `#` — cite a card from the board you're looking at.
 *
 * This is the reason the chat lives inside cac instead of being a Slack
 * channel: a message that names a card links to it, and the card opens beside
 * the conversation. Without it this would be a worse Slack.
 *
 * Only the cards already in memory are offered, deliberately. The board the
 * person is looking at is the one they are talking about, and searching every
 * list in the org would mean an endpoint, a debounce, and a picker that lists
 * cards from a client the message has nothing to do with.
 *
 * Written against the DOM for the same reason as the `/` menu: a portal would
 * mean threading a React root through an extension that isn't a component.
 */

export interface CardRef {
  id: string;
  seq: number;
  title: string;
}

/** The link a citation becomes. Deep-linking already understands `?task=`. */
export function cardHref(id: string): string {
  return `/tasks?task=${id}`;
}

/**
 * Parses one back, so the renderer can tell a citation from any other link.
 *
 * Matched against the exact prefix `cardHref` writes, not "ends in /tasks":
 * the looser check claimed `https://example.com/tasks?task=1` too, and a
 * perfectly good external link somebody pasted stopped opening the browser and
 * started opening an empty drawer instead. Anything that isn't our own relative
 * citation must fall through untouched.
 */
export function taskIdFromHref(href: string): string | null {
  const prefix = "/tasks?";
  if (!href.startsWith(prefix)) return null;
  const id = new URLSearchParams(href.slice(prefix.length)).get("task");
  return id || null;
}

function matching(cards: CardRef[], query: string): CardRef[] {
  const q = query.toLowerCase().trim();
  const hits = q
    ? cards.filter(
        (c) => String(c.seq).startsWith(q) || c.title.toLowerCase().includes(q),
      )
    : cards;
  // A long board would otherwise render a popup taller than the window.
  return hits.slice(0, 20);
}

class Popup {
  readonly el: HTMLDivElement;
  private items: CardRef[] = [];
  private selected = 0;
  private onPick: (card: CardRef) => void = () => {};

  constructor() {
    this.el = document.createElement("div");
    this.el.className =
      "fixed z-50 max-h-72 w-72 overflow-auto rounded-md border bg-popover p-1 " +
      "text-popover-foreground shadow-md";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  update(items: CardRef[], onPick: (card: CardRef) => void) {
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
      empty.textContent = "No cards match on the open board";
      this.el.appendChild(empty);
      return;
    }
    this.items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm " +
        (i === this.selected ? "bg-accent text-accent-foreground" : "text-foreground");
      const seq = document.createElement("span");
      seq.className = "font-mono text-xs text-muted-foreground";
      seq.textContent = `#${item.seq}`;
      const title = document.createElement("span");
      title.className = "truncate";
      title.textContent = item.title;
      row.append(seq, title);
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

  current(): CardRef | undefined {
    return this.items[this.selected];
  }

  destroy() {
    this.el.remove();
  }
}

export interface CardMenuOptions {
  /** Read at trigger time, not at build time: the board changes under it. */
  cards: () => CardRef[];
}

export const CardMenu = Extension.create<CardMenuOptions>({
  name: "cardMenu",

  addOptions() {
    return { cards: () => [] };
  },

  addProseMirrorPlugins() {
    const getCards = () => this.options.cards();
    return [
      Suggestion<CardRef>({
        editor: this.editor,
        // A key of its own. Suggestion defaults to the plugin key
        // `suggestion$`, so two of these in one editor are "different
        // instances of a keyed plugin" and ProseMirror refuses the whole
        // state — taking the editor, and the screen it was on, with it.
        // Nothing caught it until a composer offered # and another trigger
        // together.
        pluginKey: new PluginKey("cardMenu"),
        char: "#",
        // `#` at the start of a line is a heading in markdown, and taking it
        // over would break the one shortcut everybody already knows. A citation
        // is written mid-sentence anyway.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code) return false;
          return $from.parentOffset > 0;
        },
        items: ({ query }) => matching(getCards(), query),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              {
                type: "text",
                text: `#${props.seq} ${props.title}`,
                marks: [{ type: "link", attrs: { href: cardHref(props.id) } }],
              },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: () => {
          let popup: Popup | null = null;
          // Rebound on every update: a stale `command` closes over an old range
          // and would delete the wrong slice of text.
          let pick: (item: CardRef) => void = () => {};

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
