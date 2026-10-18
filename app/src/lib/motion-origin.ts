/**
 * Desde dónde nace lo que se abre: el punto donde se hizo clic.
 *
 * Es lo que da a una ventana de macOS su sensación de «sale de ahí»: abrir
 * una app crece desde su icono del Dock, no del centro de la pantalla. Aquí,
 * un diálogo o el detalle de una tarea crecen desde el botón o la tarjeta que
 * se pulsó (jose, 18-oct-2026: «me gustan mucho las de Apple cuando abres
 * cosas»).
 *
 * Se recuerda el último `pointerdown` de toda la ventana, en captura y
 * pasivo: no se entera nadie más y no frena el clic. Si lo que se abre no
 * viene de un clic reciente (un atajo de teclado, un enlace), nace del centro.
 */
let last: { x: number; y: number; at: number } | null = null;

if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      last = { x: e.clientX, y: e.clientY, at: performance.now() };
    },
    { capture: true, passive: true },
  );
}

/** Más viejo que esto no es «lo que se acaba de pulsar». */
const FRESH_MS = 1500;

function recent() {
  return last && performance.now() - last.at < FRESH_MS ? last : null;
}

/** Para algo que ocupa toda la ventana desde (0, 0): el punto tal cual. */
export function viewportOrigin(): string {
  const p = recent();
  return p ? `${p.x}px ${p.y}px` : "50% 50%";
}

/**
 * Para algo centrado en la ventana (un diálogo): el punto respecto a su
 * propio centro, que es el de la ventana.
 */
export function centeredOrigin(): string {
  const p = recent();
  if (!p) return "50% 50%";
  return `calc(50% + ${Math.round(p.x - window.innerWidth / 2)}px) calc(50% + ${Math.round(p.y - window.innerHeight / 2)}px)`;
}

/**
 * Un `ref` que fija el origen en el elemento cuando aparece en el DOM, que es
 * cuando se abre: el componente puede existir desde antes (un diálogo
 * cerrado), y calcularlo entonces cogería un clic viejo. Se fija una vez; si
 * se recalculara, se movería a mitad de animación.
 */
export function originRef(kind: "viewport" | "centered") {
  return (el: HTMLElement | null) => {
    if (el && !el.style.getPropertyValue("--motion-origin")) {
      el.style.setProperty("--motion-origin", kind === "viewport" ? viewportOrigin() : centeredOrigin());
    }
  };
}

/** Para las pruebas: olvida el último clic. */
export function forgetPointer() {
  last = null;
}
