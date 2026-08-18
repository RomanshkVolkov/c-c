import { Extension } from "@tiptap/react";
import { haySugerenciaAbierta } from "@/components/markdown/suggestion-open";

/**
 * Enter manda; Shift+Enter salta de línea.
 *
 * Es lo que espera cualquiera que haya usado un chat, y sin ello mandar un
 * mensaje corto pedía soltar el teclado para ir a por el botón.
 *
 * Dos cosas que no hace, a propósito:
 *
 * - **No manda con un menú de sugerencias abierto.** Mientras se elige a
 *   alguien con `@`, una tarjeta con `#` o un bloque con `/`, Enter es de ese
 *   menú; mandar ahí publicaría el mensaje con el `@ana` a medio escribir.
 * - **No manda dentro de una lista, una cita o un bloque de código.** Ahí Enter
 *   continúa la estructura, que es justo por lo que alguien la empezó. Quien
 *   quiera cerrar el mensaje tiene el botón, o sale del bloque y da Enter.
 */
export const EnviarConEnter = Extension.create<{ onSubmit: () => void }>({
  name: "enviarConEnter",

  addOptions() {
    return { onSubmit: () => {} };
  },

  addKeyboardShortcuts() {
    return {
      "Shift-Enter": () => this.editor.commands.setHardBreak(),
      Enter: () => {
        if (haySugerenciaAbierta(this.editor)) return false;
        // `false` deja pasar el Enter al comportamiento de siempre.
        if (
          this.editor.isActive("listItem") ||
          this.editor.isActive("taskItem") ||
          this.editor.isActive("blockquote") ||
          this.editor.isActive("codeBlock")
        ) {
          return false;
        }
        if (this.editor.isEmpty) return true; // nada que mandar, y sin párrafo de más
        this.options.onSubmit();
        return true;
      },
    };
  },
});
