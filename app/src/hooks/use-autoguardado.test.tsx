import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutoguardado } from "@/hooks/use-autoguardado";

/**
 * Un autoguardado sólo vale si no pierde nada.
 *
 * Los dos fallos que tiene esta clase de código no se ven mirándolo: lo que se
 * escribe **mientras** viaja un guardado, y dos guardados que llegan al revés.
 * Los dos pierden texto en silencio, que es la peor forma de perderlo.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Un guardado que se puede resolver a mano, para poner dos en el aire. */
function guardadoControlado() {
  const enviados: string[] = [];
  let soltar: (() => void) | null = null;
  const guardar = vi.fn(async (t: string) => {
    enviados.push(t);
    await new Promise<void>((res) => {
      soltar = res;
    });
  });
  return { guardar, enviados, terminar: () => soltar?.() };
}

describe("el autoguardado", () => {
  it("espera a que se deje de escribir, y manda una sola vez", async () => {
    const guardar = vi.fn(async () => {});
    const { rerender } = renderHook(({ t }) => useAutoguardado(t, guardar, true), {
      initialProps: { t: "" },
    });
    rerender({ t: "h" });
    rerender({ t: "ho" });
    rerender({ t: "hol" });
    expect(guardar).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(guardar).toHaveBeenCalledTimes(1);
    expect(guardar).toHaveBeenCalledWith("hol");
  });

  /**
   * El fallo que se lleva el trabajo de alguien.
   *
   * Se escribe, sale un guardado, y mientras viaja se sigue escribiendo. Si al
   * volver nadie mira si cambió algo, esas pulsaciones no se guardan nunca —
   * porque el temporizador ya disparó y no va a volver a disparar.
   */
  it("lo escrito mientras viajaba un guardado sale detrás", async () => {
    const { guardar, enviados, terminar } = guardadoControlado();
    const { rerender } = renderHook(({ t }) => useAutoguardado(t, guardar, true), {
      initialProps: { t: "" },
    });
    rerender({ t: "uno" });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(enviados).toEqual(["uno"]);

    // Sigue escribiendo con el primero todavía en el aire.
    rerender({ t: "uno y dos" });
    await act(async () => {
      terminar();
    });
    expect(enviados).toEqual(["uno", "uno y dos"]);
  });

  // Dos peticiones a la vez llegan en cualquier orden, y la más vieja puede
  // llegar la última: pisaría lo nuevo con lo viejo.
  it("nunca hay dos guardados en el aire", async () => {
    const { guardar, enviados, terminar } = guardadoControlado();
    const { rerender } = renderHook(({ t }) => useAutoguardado(t, guardar, true), {
      initialProps: { t: "" },
    });
    rerender({ t: "uno" });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    rerender({ t: "dos" });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(enviados).toEqual(["uno"]);
    await act(async () => {
      terminar();
    });
    expect(enviados).toEqual(["uno", "dos"]);
  });

  // Cerrar el editor y perder el último segundo es el fallo que el autoguardado
  // venía a quitar.
  it("al apagarse guarda lo que quedaba sin esperar al temporizador", async () => {
    const guardar = vi.fn(async () => {});
    const { rerender } = renderHook(
      ({ t, on }) => useAutoguardado(t, guardar, on),
      { initialProps: { t: "", on: true } },
    );
    rerender({ t: "a medias", on: true });
    await act(async () => {
      rerender({ t: "a medias", on: false });
    });
    expect(guardar).toHaveBeenCalledWith("a medias");
  });

  // Al apagarse se guarda sin esperar al temporizador, y esa llamada se salta
  // el filtro del efecto: sin la guarda de dentro, cerrar un documento que sólo
  // se leyó escribiría una versión idéntica en el historial de todo el mundo.
  it("apagarse sin haber tocado nada no manda nada", async () => {
    const guardar = vi.fn(async () => {});
    const { rerender } = renderHook(
      ({ t, on }) => useAutoguardado(t, guardar, on),
      { initialProps: { t: "lo que ya había", on: true } },
    );
    await act(async () => {
      rerender({ t: "lo que ya había", on: false });
    });
    expect(guardar).not.toHaveBeenCalled();
  });

  it("un texto que no cambió no se manda", async () => {
    const guardar = vi.fn(async () => {});
    const { rerender } = renderHook(({ t }) => useAutoguardado(t, guardar, true), {
      initialProps: { t: "ya estaba" },
    });
    rerender({ t: "ya estaba" });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(guardar).not.toHaveBeenCalled();
  });

  it("un fallo del servidor se nota, y no se da por guardado", async () => {
    const guardar = vi.fn(async () => {
      throw new Error("sin red");
    });
    const { result, rerender } = renderHook(({ t }) => useAutoguardado(t, guardar, true), {
      initialProps: { t: "" },
    });
    rerender({ t: "algo" });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.estado).toBe("error");
  });

  /**
   * Adoptar mientras un guardado viaja.
   *
   * El guardado vuelve y apunta lo que mandó como «lo confirmado», pisando lo
   * que se acaba de adoptar. Entonces el hook cree que hay cambios sin guardar y
   * manda el texto nuevo por su cuenta — que al cambiar de pestaña significaba
   * escribir una sección encima de otra.
   */
  it("un guardado que vuelve tarde no pisa lo que llegó de fuera", async () => {
    const { guardar, enviados, terminar } = guardadoControlado();
    const { result, rerender } = renderHook(({ t }) => useAutoguardado(t, guardar, true), {
      initialProps: { t: "" },
    });
    rerender({ t: "lo que escribí" });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(enviados).toEqual(["lo que escribí"]);

    // Llega texto de fuera con el guardado todavía en el aire.
    act(() => result.current.adoptar("otra cosa"));
    rerender({ t: "otra cosa" });
    await act(async () => {
      terminar();
      vi.advanceTimersByTime(5000);
    });
    expect(enviados).toEqual(["lo que escribí"]);
  });

  // Restaurar una versión cambia el texto sin que nadie escriba: sin adoptarlo,
  // el hook lo tomaría por una edición y lo volvería a guardar.
  it("adoptar un texto de fuera no dispara un guardado", async () => {
    const guardar = vi.fn(async () => {});
    const { result, rerender } = renderHook(({ t }) => useAutoguardado(t, guardar, true), {
      initialProps: { t: "viejo" },
    });
    act(() => result.current.adoptar("restaurado"));
    rerender({ t: "restaurado" });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(guardar).not.toHaveBeenCalled();
  });
});
