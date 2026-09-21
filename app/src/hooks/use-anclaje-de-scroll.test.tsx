import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { useAnclajeDeScroll } from "@/hooks/use-anclaje-de-scroll";

/**
 * Las tres reglas de un hilo, sin abrir la aplicación.
 *
 * Lo que separa un chat de una lista cualquiera es dónde te deja cuando la lista
 * cambia, y eso no se puede comprobar mirando el HTML: hay que fingir un
 * elemento con altura. jsdom da 0 en todo lo de layout, así que `scrollHeight` y
 * `clientHeight` se definen a mano.
 *
 * El fallo que motivó esto no se veía en ninguna prueba porque el elemento nunca
 * llegaba a desbordar — la culpa estaba en el armazón, no aquí — y eso hacía que
 * `scrollTop = scrollHeight` fuera un no-op silencioso.
 */

const ALTO_VISIBLE = 500;

/** jsdom da 0 en todo lo de layout, así que la caja se mide a mano. */
function medir(el: HTMLElement, alto: number, arriba: number) {
  Object.defineProperty(el, "scrollHeight", { value: alto, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: ALTO_VISIBLE, configurable: true });
  el.scrollTop = arriba;
}

type Anclaje = ReturnType<typeof useAnclajeDeScroll<string>>;

/** Guarda el hook fuera de React para poder llamarlo desde la prueba. */
const api: { current: Anclaje | null } = { current: null };

function Hilo({ items }: { items: string[] }) {
  const h = useAnclajeDeScroll({
    items,
    hayMas: true,
    cargando: false,
    cargarAnteriores: () => {},
  });
  api.current = h;
  return <div ref={h.caja} onScroll={h.enScroll} data-testid="caja" />;
}

describe("el anclaje de un hilo", () => {
  // Cada prueba monta lo suyo: sin esto se acumulan las cajas de las anteriores
  // y `getByTestId` encuentra varias.
  beforeEach(() => {
    cleanup();
    api.current = null;
    vi.restoreAllMocks();
  });

  it("si estabas abajo, te quedas abajo cuando llega algo", () => {
    const r = render(<Hilo items={["a"]} />);
    const caja = r.getByTestId("caja");
    // Al fondo: 1000 de alto, 500 visibles, scroll en 500.
    medir(caja, 1000, 500);
    act(() => {
      api.current!.enScroll();
    });
    medir(caja, 1400, 500);
    r.rerender(<Hilo items={["a", "b"]} />);
    expect(caja.scrollTop).toBe(1400);
  });

  /**
   * El que hace usable leer hacia atrás.
   *
   * Sin esto, cualquier mensaje que llegue mientras lees historia te arranca de
   * donde estás — que es justamente lo que hacía imposible leer un canal con
   * movimiento.
   */
  it("si estabas leyendo arriba, no te mueve, y avisa", () => {
    const r = render(<Hilo items={["a"]} />);
    const caja = r.getByTestId("caja");
    medir(caja, 2000, 100); // muy arriba
    act(() => {
      api.current!.enScroll();
    });
    medir(caja, 2400, 100);
    r.rerender(<Hilo items={["a", "b"]} />);

    expect(caja.scrollTop).toBe(100);
    expect(api.current!.hayNuevos).toBe(true);
  });

  it("y la píldora te baja al final y se apaga", () => {
    const r = render(<Hilo items={["a"]} />);
    const caja = r.getByTestId("caja");
    medir(caja, 2000, 100);
    act(() => {
      api.current!.enScroll();
    });
    r.rerender(<Hilo items={["a", "b"]} />);
    act(() => {
      api.current!.alFinal();
    });
    expect(caja.scrollTop).toBe(2000);
    expect(api.current!.hayNuevos).toBe(false);
  });

  // Un margen, no igualdad exacta: con subpíxeles «abajo» casi nunca cuadra al
  // píxel y el hilo dejaría de seguir la conversación sin motivo aparente.
  it("«abajo» admite unos píxeles de margen", () => {
    const r = render(<Hilo items={["a"]} />);
    const caja = r.getByTestId("caja");
    medir(caja, 1000, 490); // a 10 px del fondo
    act(() => {
      api.current!.enScroll();
    });
    medir(caja, 1400, 490);
    r.rerender(<Hilo items={["a", "b"]} />);
    expect(caja.scrollTop).toBe(1400);
  });
});

// ─── La regla 4: salir a otra pestaña y volver ───────────────────────────────
//
// Añadido después, con su propio armazón: éstas montan y desmontan el nodo de
// verdad, que es lo único que reproduce el fallo.

import { useState } from "react";

/** Una caja con alto medible: jsdom da cero si no se le dice. */
function medirCaja(el: HTMLElement, alto: number) {
  Object.defineProperty(el, "scrollHeight", { value: alto, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 200, configurable: true });
}

function HiloQueSeDesmonta({ montada, alto = 1000 }: { montada: boolean; alto?: number }) {
  const [items] = useState([1, 2, 3]);
  const { caja, enScroll } = useAnclajeDeScroll({
    items,
    hayMas: false,
    cargando: false,
    cargarAnteriores: () => {},
  });
  if (!montada) return <p>otra pestaña</p>;
  return (
    <div
      data-testid="hilo"
      onScroll={enScroll}
      ref={(el) => {
        if (el) medirCaja(el, alto);
        caja(el);
      }}
    />
  );
}

describe("el anclaje al volver de otra pestaña", () => {
  beforeEach(cleanup);

  it("al montar, empieza abajo", () => {
    const { getByTestId } = render(<HiloQueSeDesmonta montada />);
    expect(getByTestId("hilo").scrollTop).toBe(1000);
  });

  /**
   * **El que importa**: salir a otra pestaña y volver.
   *
   * El mutante que mata: devolver la ref de objeto. Con ella, la caja nueva se
   * engancha sin que nadie la coloque y el hilo aparece por el principio —
   * exactamente lo que se reportó.
   */
  it("al volver de otra pestaña, sigue abajo", () => {
    const { rerender, getByTestId, queryByTestId } = render(<HiloQueSeDesmonta montada />);
    expect(getByTestId("hilo").scrollTop).toBe(1000);

    rerender(<HiloQueSeDesmonta montada={false} />);
    expect(queryByTestId("hilo")).toBeNull();

    rerender(<HiloQueSeDesmonta montada />);
    expect(getByTestId("hilo").scrollTop).toBe(1000);
  });

  /**
   * Y si te habías ido a leer hacia arriba, **al volver no te devuelve abajo**.
   *
   * Es la otra mitad de la regla: el ancla respeta dónde estabas. Sin esto, ir
   * a multimedia a mirar una imagen y volver te sacaría del sitio que estabas
   * leyendo.
   */
  it("pero si estabas leyendo arriba, te deja donde estabas", () => {
    const { rerender, getByTestId } = render(<HiloQueSeDesmonta montada />);
    const el = getByTestId("hilo");

    // Subir: el `onScroll` del componente real actualiza el testigo; aquí se
    // provoca igual que lo haría el navegador.
    el.scrollTop = 300;
    el.dispatchEvent(new Event("scroll"));

    rerender(<HiloQueSeDesmonta montada={false} />);
    rerender(<HiloQueSeDesmonta montada />);
    expect(getByTestId("hilo").scrollTop).toBe(300);
  });

  /**
   * Y si llegaron mensajes mientras estabas fuera, vuelves al final **nuevo**.
   *
   * Es el caso que distingue «recordar el desplazamiento» de «anclar al
   * final», y el que pasa de verdad: te vas a mirar una imagen, el hilo crece,
   * y volver al número viejo te dejaría a mitad de camino mirando un hueco.
   *
   * El mutante que mata: restaurar siempre la posición guardada.
   */
  it("si el hilo creció mientras no mirabas, vuelves al final nuevo", () => {
    const { rerender, getByTestId } = render(<HiloQueSeDesmonta montada alto={1000} />);
    expect(getByTestId("hilo").scrollTop).toBe(1000);

    rerender(<HiloQueSeDesmonta montada={false} alto={1000} />);
    // Mientras no mirabas, llegaron mensajes.
    rerender(<HiloQueSeDesmonta montada alto={2500} />);

    expect(getByTestId("hilo").scrollTop).toBe(2500);
  });
});
