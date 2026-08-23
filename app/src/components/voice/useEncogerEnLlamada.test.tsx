import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useReducer } from "react";
import { act, cleanup, render } from "@testing-library/react";

/**
 * Encoger la interfaz mientras la sala ocupa la pantalla.
 *
 * Lo que se prueba no es que encoja —eso es la parte fácil— sino las dos reglas
 * que deciden si la función es útil o molesta: que **devuelva lo que había** en
 * vez de abrir, y que **suelte el mando** si la tocas tú. Una implementación
 * ingenua pasa la primera prueba y falla las otras dos.
 */

const { estado } = vi.hoisted(() => ({
  estado: { current: {} as Record<string, unknown> },
}));

vi.mock("@/store/voice.store", () => ({
  useVoice: (sel?: (s: Record<string, unknown>) => unknown) =>
    sel ? sel(estado.current) : estado.current,
}));

// Un doble del contexto de shadcn con el mismo contrato —`open` y `setOpen`—
// pero gobernable desde la prueba. El de verdad arrastra el proveedor entero,
// un `matchMedia` y una cookie, y ninguno de los tres dice nada sobre la regla
// que se está comprobando.
const suscritos = new Set<() => void>();
const rail = { open: true, setOpen: (v: boolean) => void v };
vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => rail,
}));

const { useEncogerEnLlamada } = await import("./useEncogerEnLlamada");

/**
 * Un componente mínimo que sólo existe para llamar al hook.
 *
 * Se apunta al doble del rail para repintarse cuando `open` cambie. Sin esto el
 * banco de pruebas miente: el `setOpen` del hook movería el valor sin que nadie
 * volviera a pintar, el efecto no correría con el estado nuevo, y pasarían
 * pruebas que en la app fallarían. El `useSidebar` de verdad guarda `open` en
 * un estado de React y repinta.
 */
function Sonda({ spaceId }: { spaceId: string | null }) {
  const [, repintar] = useReducer((n: number) => n + 1, 0);
  suscritos.add(repintar);
  useEffect(() => () => void suscritos.delete(repintar), [repintar]);
  const encogido = useEncogerEnLlamada(spaceId);
  return <div data-testid="aside" data-encogido={String(encogido)} />;
}

const enLaSala = (extra: Record<string, unknown> = {}) => {
  estado.current = {
    escenario: true,
    estado: "dentro",
    spaceId: "esp-1",
    compartiendo: false,
    pantalla: null,
    ...extra,
  };
};

/** Pinta y devuelve un `volverAPintar` que refleja los cambios de estado. */
function montar(spaceId: string | null = "esp-1") {
  const r = render(<Sonda spaceId={spaceId} />);
  return {
    encogido: () => r.container.querySelector("[data-testid=aside]")?.getAttribute("data-encogido"),
    repintar: () => act(() => void r.rerender(<Sonda spaceId={spaceId} />)),
  };
}

afterEach(() => {
  cleanup();
  rail.open = true;
  rail.setOpen = (v: boolean) => void v;
});

/** Conecta el doble para que `setOpen` mueva `open` **y repinte**, como el real. */
function railVivo(inicial: boolean) {
  rail.open = inicial;
  rail.setOpen = (v: boolean) => {
    rail.open = v;
    suscritos.forEach((f) => f());
  };
}

/** Mover el rail a mano, como haría un clic en el trigger. */
const aMano = (v: boolean) => act(() => rail.setOpen(v));

describe("encoger en llamada", () => {
  it("con la sala en pantalla se encoge la columna y se cierra el rail", () => {
    railVivo(true);
    enLaSala();
    const v = montar();
    expect(v.encogido()).toBe("true");
    expect(rail.open).toBe(false);
  });

  // Minimizar es la salida en un clic: sigues en la llamada y recuperas la
  // navegación. Sin esto, encoger sería una imposición y no una comodidad.
  it("minimizar devuelve la interfaz sin colgar la llamada", () => {
    railVivo(true);
    enLaSala();
    const v = montar();
    expect(rail.open).toBe(false);

    enLaSala({ escenario: false });
    v.repintar();
    expect(v.encogido()).toBe("false");
    expect(rail.open).toBe(true);
  });

  it("fuera de la sala no se toca nada", () => {
    railVivo(true);
    enLaSala({ estado: "fuera" });
    const v = montar();
    expect(v.encogido()).toBe("false");
    expect(rail.open).toBe(true);
  });

  it("una llamada en otro espacio no toca esta pantalla", () => {
    railVivo(true);
    enLaSala({ spaceId: "esp-9" });
    const v = montar();
    expect(v.encogido()).toBe("false");
    expect(rail.open).toBe(true);
  });

  it("al salir, el rail vuelve a estar abierto", () => {
    railVivo(true);
    enLaSala();
    const v = montar();
    expect(rail.open).toBe(false);

    enLaSala({ escenario: false });
    v.repintar();
    expect(rail.open).toBe(true);
    expect(v.encogido()).toBe("false");
  });

  // El caso que delata la implementación ingenua: quien lo tenía colapsado a
  // propósito no debe encontrárselo abierto al dejar de compartir.
  it("si el rail ya estaba colapsado, se queda colapsado al salir", () => {
    railVivo(false);
    enLaSala();
    const v = montar();
    expect(rail.open).toBe(false);

    enLaSala({ escenario: false });
    v.repintar();
    expect(rail.open).toBe(false);
  });

  // La prueba anterior no bastaba, y el mutante lo demostró: si el rail ya
  // estaba abierto, «restaurar abierto» y «no tocar nada» dan el mismo
  // resultado. La diferencia sólo se ve cuando tu **última** decisión manual no
  // coincide con lo que había al empezar — abres y vuelves a cerrar.
  it("una vez que lo tocas, manda tu última decisión y no la que había", () => {
    railVivo(true);
    enLaSala();
    const v = montar();
    expect(rail.open).toBe(false);

    // Lo abres a mano…
    aMano(true);
    // …y lo vuelves a cerrar.
    aMano(false);

    enLaSala({ escenario: false });
    v.repintar();
    // Sin soltar el mando, aquí lo habría abierto: era el estado de partida.
    expect(rail.open).toBe(false);
  });

  // La renuncia dura lo que dura esa llamada, no la sesión entera. Sin
  // esto, tocar el rail una vez desactivaría la función para siempre — y nadie
  // relacionaría las dos cosas.
  it("a la siguiente llamada vuelve a encoger, aunque en la anterior lo tocaras", () => {
    railVivo(true);
    enLaSala();
    const v = montar();
    aMano(true); // tomas el mando
    expect(rail.open).toBe(true);

    enLaSala({ escenario: false });
    v.repintar();
    expect(rail.open).toBe(true);

    // Segunda vuelta: esto vuelve a mandar.
    enLaSala();
    v.repintar();
    expect(rail.open).toBe(false);
  });

  // Si lo abres tú a mano, esto se aparta: ni lo vuelve a cerrar mientras
  // compartes, ni te lo cierra al terminar.
  it("abrirlo a mano durante la llamada suelta el mando", () => {
    railVivo(true);
    enLaSala();
    const v = montar();
    expect(rail.open).toBe(false);

    aMano(true);
    expect(rail.open).toBe(true);

    enLaSala({ escenario: false });
    v.repintar();
    expect(rail.open).toBe(true);
  });
});
