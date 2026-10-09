import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import i18next from "i18next";

/**
 * La clave del plugin, fuera del cierre y exportada, como la de `#`: hay que
 * poder preguntar desde fuera si el menú está abierto (`haySugerenciaAbierta`).
 */
export const PAGE_MENU_KEY = new PluginKey("pageMenu");

/**
 * `[[` — enlazar una página de la documentación, como en Confluence o Notion.
 *
 * Lo que convierte un montón de páginas en una wiki: escribir `[[Ner` y elegir
 * «Nereus» deja un enlace normal (`[Nereus](/tasks?doc=…&page=…)`) que se abre
 * dentro de la app y que la página enlazada cuenta en «Referenciado desde».
 * Se guarda como un enlace de markdown corriente, no como una sintaxis propia:
 * así lo lee igual un agente por MCP, el visor de GitHub o cualquier editor.
 *
 * A diferencia de `#`, aquí sí se busca fuera de lo que hay en memoria: una
 * página de otro documento es justo lo que se quiere enlazar, y quien escribe
 * en una wiki no sabe en qué nodo vive cada cosa. Por eso `links` puede ser
 * asíncrono (ver `useDocLinkSource`).
 *
 * Escrito contra el DOM por lo mismo que `#` y `/`.
 */

export interface DocLinkRef {
  /** Único en la lista: el enlace mismo vale. */
  href: string;
  title: string;
  /** Dónde vive, para distinguir dos «Arquitectura» de dos nodos. */
  where?: string;
}

class Popup {
  readonly el: HTMLDivElement;
  private items: DocLinkRef[] = [];
  private selected = 0;
  private onPick: (item: DocLinkRef) => void = () => {};

  constructor() {
    this.el = document.createElement("div");
    this.el.className =
      "fixed z-50 max-h-72 w-80 overflow-auto rounded-md border bg-popover p-1 " +
      "text-popover-foreground shadow-md";
    this.el.setAttribute("role", "listbox");
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  update(items: DocLinkRef[], onPick: (item: DocLinkRef) => void) {
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
      empty.textContent = i18next.t("work:docs.noPagesMatch");
      this.el.appendChild(empty);
      return;
    }
    this.items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.setAttribute("role", "option");
      row.className =
        "flex w-full flex-col rounded px-2 py-1.5 text-left text-sm " +
        (i === this.selected ? "bg-accent text-accent-foreground" : "text-foreground");
      const title = document.createElement("span");
      title.className = "truncate";
      title.textContent = item.title;
      row.append(title);
      if (item.where) {
        const where = document.createElement("span");
        where.className = "truncate text-xs text-muted-foreground";
        where.textContent = item.where;
        row.append(where);
      }
      // mousedown, no click: el clic quita el foco al editor antes y se pierde
      // el rango que la inserción necesita.
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

  current(): DocLinkRef | undefined {
    return this.items[this.selected];
  }

  destroy() {
    this.el.remove();
  }
}

export interface PageMenuOptions {
  /** Se lee al disparar, no al montar: el árbol cambia con el editor abierto. */
  links: (query: string) => DocLinkRef[] | Promise<DocLinkRef[]>;
}

export const PageMenu = Extension.create<PageMenuOptions>({
  name: "pageMenu",

  addOptions() {
    return { links: () => [] };
  },

  addProseMirrorPlugins() {
    const getLinks = (q: string) => this.options.links(q);
    return [
      Suggestion<DocLinkRef>({
        editor: this.editor,
        // Clave propia: dos `Suggestion` con la de por defecto tumban el
        // editor entero (ver `card-menu.ts`).
        pluginKey: PAGE_MENU_KEY,
        char: "[[",
        // Los títulos llevan espacios: «[[Owner View» tiene que seguir siendo
        // la misma búsqueda después del espacio.
        allowSpaces: true,
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: async ({ query }) => (await getLinks(query)).slice(0, 20),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              { type: "text", text: props.title, marks: [{ type: "link", attrs: { href: props.href } }] },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: () => {
          let popup: Popup | null = null;
          // Se reengancha en cada actualización: un `command` viejo apunta a
          // un rango viejo y borraría otro trozo del texto.
          let pick: (item: DocLinkRef) => void = () => {};

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
