import type { Editor } from "@tiptap/react";
import { MENTION_MENU_KEY } from "@/components/markdown/mention-menu";
import { CARD_MENU_KEY } from "@/components/markdown/card-menu";
import { SLASH_MENU_KEY } from "@/components/markdown/slash-menu";

/**
 * ¿Hay un menú de sugerencias abierto ahora mismo?
 *
 * Existe por el Enter del compositor. Mientras se elige a alguien con `@`, una
 * tarjeta con `#` o un bloque con `/`, Enter pertenece a ese menú: mandar el
 * mensaje ahí dentro sería mandarlo a medio escribir, con el `@ana` sin
 * resolver.
 *
 * Se pregunta explícitamente y no se confía en el orden de los plugins.
 * ProseMirror llama a los `handleKeyDown` en el orden en que están montados y
 * el primero que devuelve `true` gana, así que *funciona* si los menús van
 * antes — pero eso depende de cómo el gestor de extensiones de Tiptap ordene
 * atajos y plugins, que es un detalle interno suyo. Un mensaje enviado a medias
 * por un cambio de versión no lo detectaría nadie hasta verlo publicado.
 */
export function haySugerenciaAbierta(editor: Editor): boolean {
  return [MENTION_MENU_KEY, CARD_MENU_KEY, SLASH_MENU_KEY].some((k) => {
    const estado = k.getState(editor.state) as { active?: boolean } | undefined;
    return !!estado?.active;
  });
}
