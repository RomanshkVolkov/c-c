import { beforeEach, describe, expect, it, vi } from "vitest";

import { adoptServerLocale, chooseLocale } from "@/lib/locale-sync";
import { useLocaleStore } from "@/store/locale.store";
import { api } from "@/lib/api";

/**
 * El idioma va y viene entre la máquina y el servidor.
 *
 * Lo que se prueba aquí no es la traducción sino **el viaje**: que elegir se
 * cuente allá, que entrar se entere de lo que hay allá, y que ninguna de las
 * dos cosas se coma a la otra. Un fallo aquí no se ve —la interfaz queda en el
 * idioma correcto en esta máquina— y aparece días después en otra.
 */

vi.mock("@/lib/api", () => ({ api: { patch: vi.fn(() => Promise.resolve({})) } }));

describe("elegir idioma", () => {
  beforeEach(() => {
    useLocaleStore.setState({ preference: "system", resolved: "en" });
    vi.mocked(api.patch).mockClear();
  });

  it("se aplica aquí en el acto, sin esperar a la red", () => {
    void chooseLocale("es");
    expect(useLocaleStore.getState().resolved).toBe("es");
  });

  it("y se le cuenta al servidor", () => {
    void chooseLocale("es");
    expect(api.patch).toHaveBeenCalledWith("/api/v1/auth/locale", { locale: "es" });
  });

  // «system» no existe en el servidor: no sabe qué ordenador tienes. Lo que
  // significa es «no he elegido», y eso es una columna vacía.
  it("«el del sistema» viaja como vacío, no como la palabra", () => {
    void chooseLocale("system");
    expect(api.patch).toHaveBeenCalledWith("/api/v1/auth/locale", { locale: "" });
  });

  /**
   * Sin esto, quedarse sin red al pulsar el botón dejaría la aplicación en el
   * idioma viejo y con un error que quien mira no puede arreglar.
   *
   * Se afirma que **la promesa no rechaza**, y no que la llamada no lance. Lo
   * segundo era lo que ponía aquí antes y no probaba nada: quitarle el `catch`
   * deja la promesa rechazada sin lanzar de forma síncrona, y ni Node ni
   * vitest levantan ese rechazo dentro de jsdom. Lo cazó una mutación, y por
   * eso `chooseLocale` devuelve la promesa en vez de tragársela.
   */
  it("un fallo de red no deshace la elección ni se enseña", async () => {
    vi.mocked(api.patch).mockRejectedValueOnce(new Error("sin red"));
    await expect(chooseLocale("es")).resolves.toBeUndefined();
    expect(useLocaleStore.getState().resolved).toBe("es");
  });
});

describe("entrar en la aplicación", () => {
  beforeEach(() => useLocaleStore.setState({ preference: "en", resolved: "en" }));

  // Lo que dice el servidor lo eligió esta misma persona, quizá en otra
  // máquina; lo de aquí puede ser de antes.
  it("adopta el idioma que trae la sesión", () => {
    adoptServerLocale({ id: "u", username: "ana", locale: "es" });
    expect(useLocaleStore.getState().preference).toBe("es");
  });

  it("una sesión sin idioma vuelve al del sistema", () => {
    adoptServerLocale({ id: "u", username: "ana" });
    expect(useLocaleStore.getState().preference).toBe("system");
  });

  it("sin sesión no toca nada", () => {
    adoptServerLocale(null);
    expect(useLocaleStore.getState().preference).toBe("en");
  });

  // `setPreference` reinicia el catálogo. Llamarlo en cada refresco de sesión
  // repintaría la aplicación entera sin que nada haya cambiado.
  it("y si ya coincide no reinicia el catálogo", () => {
    const espia = vi.spyOn(useLocaleStore.getState(), "setPreference");
    adoptServerLocale({ id: "u", username: "ana", locale: "en" });
    expect(espia).not.toHaveBeenCalled();
    espia.mockRestore();
  });
});
