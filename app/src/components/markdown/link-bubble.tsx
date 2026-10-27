import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorState, type Editor } from "@tiptap/react";
import { ExternalLink, Pencil, Unlink } from "lucide-react";

import { useT } from "@/lib/i18n";

/**
 * La burbuja de un enlace: Abrir, Editar, Quitar.
 *
 * Desde el 27-oct-2026 un clic en un enlace lo abre (ver `linkClickAction`),
 * así que editarlo necesita otra puerta. Es la de Notion: sale al pasar el
 * ratón por encima, y también cuando el cursor llega a un enlace con el
 * teclado, que es como se edita sin ratón.
 *
 * La del teclado sale sólo si se ha llegado con el teclado: el cursor se queda
 * en un enlace por mil razones (al cargar, al volver a una nota), y una
 * burbuja que aparece sola, lejos del ratón, parece un fallo.
 *
 * Por un portal al `body`, con posición fija: dentro del editor la recortaría
 * cualquier contenedor con scroll.
 */

/** Lo que aguanta la burbuja al salir del enlace: da tiempo a llegar a ella. */
const HIDE_DELAY_MS = 250;

export interface LinkBubbleProps {
  editor: Editor;
  onOpen: (href: string, label: string) => void;
  onEdit: () => void;
}

interface Hovered {
  anchor: HTMLAnchorElement;
  href: string;
}

export default function LinkBubble({ editor, onOpen, onEdit }: LinkBubbleProps) {
  const { t } = useT();
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [byKeyboard, setByKeyboard] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sólo tocan refs y estado: estables, para que el efecto de abajo no se
  // vuelva a enganchar en cada render.
  const keep = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);
  const hideSoon = useCallback(() => {
    keep();
    hideTimer.current = setTimeout(() => setHovered(null), HIDE_DELAY_MS);
  }, [keep]);

  useEffect(() => {
    const dom = editor.view.dom;
    const over = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement)?.closest?.("a");
      const href = anchor?.getAttribute("href");
      if (!anchor || !href || !dom.contains(anchor)) return;
      keep();
      setHovered({ anchor, href });
    };
    const out = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.("a")) hideSoon();
    };
    const key = (e: KeyboardEvent) => {
      if (/^(Arrow|Home$|End$|Page)/.test(e.key)) setByKeyboard(true);
    };
    const pointer = () => setByKeyboard(false);
    dom.addEventListener("mouseover", over);
    dom.addEventListener("mouseout", out);
    dom.addEventListener("keydown", key);
    dom.addEventListener("mousedown", pointer);
    dom.addEventListener("blur", pointer);
    return () => {
      dom.removeEventListener("mouseover", over);
      dom.removeEventListener("mouseout", out);
      dom.removeEventListener("keydown", key);
      dom.removeEventListener("mousedown", pointer);
      dom.removeEventListener("blur", pointer);
      keep();
    };
  }, [editor, keep, hideSoon]);

  // Con el teclado: el cursor (sin selección) dentro de un enlace, y el editor
  // con el foco. Cualquier otra cosa la apaga.
  const caret = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed || !ed.isFocused || !ed.state.selection.empty || !ed.isActive("link")) return null;
      return {
        from: ed.state.selection.from,
        href: (ed.getAttributes("link").href as string | undefined) ?? "",
      };
    },
    equalityFn: (a, b) => a?.from === b?.from && a?.href === b?.href,
  });

  let target: { href: string; label: string; rect: { left: number; top: number; bottom: number } } | null = null;
  if (hovered && hovered.anchor.isConnected) {
    const r = hovered.anchor.getBoundingClientRect();
    target = { href: hovered.href, label: hovered.anchor.textContent?.trim() ?? "", rect: r };
  } else if (byKeyboard && caret?.href) {
    let rect = { left: 0, top: 0, bottom: 0 };
    try {
      rect = editor.view.coordsAtPos(caret.from);
    } catch {
      // jsdom no sabe medir; la burbuja sale arriba a la izquierda y sirve igual.
    }
    target = { href: caret.href, label: "", rect };
  }
  if (!target) return null;
  const { href, label, rect } = target;

  /**
   * Pone el cursor en el enlace que se señala. Lo que viene después (quitar,
   * o `promptForLink`) extiende la selección al enlace entero.
   */
  const selectLink = () => {
    const chain = editor.chain().focus();
    if (hovered?.anchor.isConnected) chain.setTextSelection(editor.view.posAtDOM(hovered.anchor, 0) + 1);
    return chain;
  };

  const above = rect.top > 48;
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 260)),
    top: above ? rect.top - 4 : rect.bottom + 4,
    transform: above ? "translateY(-100%)" : undefined,
  };

  const btn =
    "motion-press flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground";

  return createPortal(
    <div
      role="toolbar"
      data-link-bubble=""
      className="motion-pop-in fixed z-50 flex max-w-[260px] items-center gap-0.5 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md"
      style={style}
      onMouseEnter={keep}
      onMouseLeave={hideSoon}
      // Que pulsarla no le quite el foco ni la selección al editor.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className={btn} title={href} onClick={() => { setHovered(null); onOpen(href, label); }}>
        <ExternalLink className="size-3" />
        <span className="max-w-[9rem] truncate">{t("common:editor.openLink")}</span>
      </button>
      <span className="h-4 w-px bg-border" />
      <button
        type="button"
        className={btn}
        aria-label={t("common:editor.editLink")}
        title={t("common:editor.editLink")}
        onClick={() => {
          selectLink().run();
          setHovered(null);
          onEdit();
        }}
      >
        <Pencil className="size-3" />
      </button>
      <button
        type="button"
        className={btn}
        aria-label={t("common:editor.removeLink")}
        title={t("common:editor.removeLink")}
        onClick={() => {
          selectLink().unsetLink().run();
          setHovered(null);
        }}
      >
        <Unlink className="size-3" />
      </button>
    </div>,
    document.body,
  );
}
