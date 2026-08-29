import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Elegir idioma, y qué significa «el del sistema».
 *
 * La parte con criterio es el fallback: qué se hace cuando el ordenador pide un
 * idioma que no tenemos. Contestar con un catálogo a medias sería peor que
 * contestar en inglés, que al menos está entero.
 */

vi.mock("@/lib/i18n", () => ({ applyLocale: vi.fn() }));

const { useLocaleStore } = await import("@/store/locale.store");
const { applyLocale } = await import("@/lib/i18n");

/** Finge qué idiomas pide el sistema operativo. */
const sistemaHabla = (...etiquetas: string[]) => {
  Object.defineProperty(navigator, "languages", { value: etiquetas, configurable: true });
};

beforeEach(() => {
  vi.mocked(applyLocale).mockClear();
  sistemaHabla("en-US");
  useLocaleStore.setState({ preference: "system", resolved: "en" });
});

describe("el idioma del sistema", () => {
  it("se usa cuando la preferencia es «system»", () => {
    sistemaHabla("es-MX");
    useLocaleStore.getState().apply();
    expect(useLocaleStore.getState().resolved).toBe("es");
  });

  // `es-MX`, `es-419` y `es-ES` son el mismo catálogo. Mantener uno por región
  // sería prometer una diferencia que no existe.
  it("da igual la región: sólo cuenta el idioma", () => {
    for (const etiqueta of ["es-MX", "es-419", "es-ES", "es"]) {
      sistemaHabla(etiqueta);
      useLocaleStore.getState().apply();
      expect(useLocaleStore.getState().resolved).toBe("es");
    }
  });

  // El caso con criterio: un catálogo a medias se lee peor que uno entero en
  // otro idioma.
  it("un idioma que no tenemos cae al inglés, no a medias", () => {
    sistemaHabla("fr-FR");
    useLocaleStore.getState().apply();
    expect(useLocaleStore.getState().resolved).toBe("en");
  });

  // El navegador ofrece una lista en orden de preferencia; se respeta.
  it("se coge el primero de la lista que sepamos hablar", () => {
    sistemaHabla("fr-FR", "es-MX", "en-US");
    useLocaleStore.getState().apply();
    expect(useLocaleStore.getState().resolved).toBe("es");
  });
});

describe("elegir uno a mano", () => {
  it("gana sobre el del sistema", () => {
    sistemaHabla("es-MX");
    useLocaleStore.getState().setPreference("en");
    expect(useLocaleStore.getState().resolved).toBe("en");
  });

  it("y volver a «system» devuelve el mando al ordenador", () => {
    sistemaHabla("es-MX");
    useLocaleStore.getState().setPreference("en");
    useLocaleStore.getState().setPreference("system");
    expect(useLocaleStore.getState().resolved).toBe("es");
  });
});

describe("lo que se entera del cambio", () => {
  // El catálogo se entera por aquí y sólo por aquí: una pantalla llamando a
  // `changeLanguage` por su cuenta dejaría el store diciendo una cosa y la
  // interfaz enseñando otra.
  it("el catálogo cambia con la preferencia", () => {
    useLocaleStore.getState().setPreference("es");
    expect(applyLocale).toHaveBeenCalledWith("es");
  });

  // Los lectores de pantalla eligen la voz por aquí; sin esto leerían el
  // castellano con pronunciación inglesa.
  it("y el documento dice en qué idioma está", () => {
    useLocaleStore.getState().setPreference("es");
    expect(document.documentElement.lang).toBe("es");
  });
});
