import { EXIT_MS } from "@/lib/use-presence";

/**
 * Quita del DOM un elemento creado a mano (los menús del editor), dándole
 * antes su salida: `data-closing` lo lleva a la animación de
 * `[data-closing]` en index.css, y al acabar se quita. Es `usePresence` para
 * lo que no pinta React.
 *
 * Con movimiento reducido, o si no está a la vista, se quita en el acto.
 */
export function removeWithExit(el: HTMLElement) {
  const reduced =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || el.style.display === "none" || !el.isConnected) {
    el.remove();
    return;
  }
  el.setAttribute("data-closing", "");
  setTimeout(() => el.remove(), EXIT_MS);
}
