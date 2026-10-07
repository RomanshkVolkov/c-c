import { fireEvent, screen } from "@testing-library/react";

/**
 * Elige una opción en un desplegable de la app (`Picker`, `Select`), como lo
 * hace una persona: abrirlo, pasar el ratón por la opción y hacer clic. Sin el
 * paso del ratón no elige: base-ui sólo acepta el clic sobre una opción
 * resaltada, y una prueba no «pasa por encima» si no se lo dice. Sustituye al
 * `fireEvent.change` de un `<select>` nativo.
 */
export async function pick(trigger: HTMLElement, option: string | RegExp): Promise<void> {
  fireEvent.click(trigger);
  const op = await screen.findByRole("option", { name: option });
  fireEvent.mouseMove(op);
  fireEvent.click(op);
}
