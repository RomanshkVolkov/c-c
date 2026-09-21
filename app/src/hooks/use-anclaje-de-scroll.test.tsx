import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useState } from "react";

import { useAnclajeDeScroll } from "@/hooks/use-anclaje-de-scroll";

afterEach(cleanup);

/**
 * Un hilo se lee desde abajo, **y también al volver a él**.
 *
 * Esto salió de usarlo: cambiar a la pestaña de multimedia y volver a la
 * conversación dejaba el hilo por el principio, como una lista cualquiera. La
 * caja se desmonta al cambiar de pestaña, pero el hook **no** —vive en el
 * componente de arriba—, así que el efecto que ancla depende de `items`, que en
 * ese viaje no cambia. No corría nadie.
 */

/** Una caja con alto medible: jsdom da cero si no se le dice. */
function medir(el: HTMLElement, alto: number, visible: number) {
  Object.defineProperty(el, "scrollHeight", { value: alto, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: visible, configurable: true });
}

function Hilo({ montada, alto = 1000 }: { montada: boolean; alto?: number }) {
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
      data-testid="caja"
      onScroll={enScroll}
      ref={(el) => {
        if (el) medir(el, alto, 200);
        caja(el);
      }}
    />
  );
}

describe("el anclaje del hilo", () => {
  it("al montar, empieza abajo", () => {
    const { getByTestId } = render(<Hilo montada />);
    expect(getByTestId("caja").scrollTop).toBe(1000);
  });

  /**
   * **El que importa**: salir a otra pestaña y volver.
   *
   * El mutante que mata: devolver la ref de objeto. Con ella, la caja nueva se
   * engancha sin que nadie la coloque y el hilo aparece por el principio —
   * exactamente lo que se reportó.
   */
  it("al volver de otra pestaña, sigue abajo", () => {
    const { rerender, getByTestId, queryByTestId } = render(<Hilo montada />);
    expect(getByTestId("caja").scrollTop).toBe(1000);

    rerender(<Hilo montada={false} />);
    expect(queryByTestId("caja")).toBeNull();

    rerender(<Hilo montada />);
    expect(getByTestId("caja").scrollTop).toBe(1000);
  });

  /**
   * Y si te habías ido a leer hacia arriba, **al volver no te devuelve abajo**.
   *
   * Es la otra mitad de la regla: el ancla respeta dónde estabas. Sin esto, ir
   * a multimedia a mirar una imagen y volver te sacaría del sitio que estabas
   * leyendo.
   */
  it("pero si estabas leyendo arriba, te deja donde estabas", () => {
    const { rerender, getByTestId } = render(<Hilo montada />);
    const el = getByTestId("caja");

    // Subir: el `onScroll` del componente real actualiza el testigo; aquí se
    // provoca igual que lo haría el navegador.
    el.scrollTop = 300;
    el.dispatchEvent(new Event("scroll"));

    rerender(<Hilo montada={false} />);
    rerender(<Hilo montada />);
    expect(getByTestId("caja").scrollTop).toBe(300);
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
    const { rerender, getByTestId } = render(<Hilo montada alto={1000} />);
    expect(getByTestId("caja").scrollTop).toBe(1000);

    rerender(<Hilo montada={false} alto={1000} />);
    // Mientras no mirabas, llegaron mensajes.
    rerender(<Hilo montada alto={2500} />);

    expect(getByTestId("caja").scrollTop).toBe(2500);
  });
});
