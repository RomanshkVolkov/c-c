import { create } from "zustand";
import { persist } from "zustand/middleware";

import { applyLocale } from "@/lib/i18n";

/**
 * En qué idioma se lee la aplicación.
 *
 * Calcado de `theme.store.ts`, que resuelve la misma forma de problema: una
 * preferencia con tres estados donde el tercero —«el del sistema»— no es un
 * valor sino una pregunta al entorno.
 *
 * Se guarda **también en el servidor** (`User.Locale`), y por dos motivos que no
 * son el obvio: para que te siga entre máquinas, y sobre todo para que el
 * servidor pueda escribir **en tu idioma** lo que guarda para ti. Una
 * notificación es una fila por destinatario; sin saber quién la va a leer, se
 * queda congelada en el idioma de quien la provocó.
 *
 * Aquí se persiste además en local por una razón práctica: la interfaz se pinta
 * antes de que la sesión conteste, y arrancar en inglés para saltar al
 * castellano medio segundo después es peor que tardar en enterarse de un cambio
 * hecho en otra máquina.
 */
export type LocalePreference = "system" | "en" | "es";

/** Los idiomas que existen de verdad. `system` se resuelve a uno de éstos. */
export type Locale = "en" | "es";

export const LOCALES: Locale[] = ["en", "es"];

interface LocaleState {
  preference: LocalePreference;
  /** El que se está usando ahora, una vez resuelto «system». */
  resolved: Locale;
  setPreference: (p: LocalePreference) => void;
  /** Vuelve a resolver; se llama al arrancar y al rehidratar. */
  apply: () => void;
}

/**
 * Qué idioma pide el sistema operativo.
 *
 * Se mira sólo el prefijo: `es-MX`, `es-419` y `es-ES` son el mismo catálogo, y
 * mantener uno por región sería prometer una diferencia que no existe. Lo que sí
 * cambia por región —fechas, números— lo resuelve `Intl` con el locale completo
 * del sistema, no con esto.
 */
function delSistema(): Locale {
  if (typeof navigator === "undefined") return "en";
  for (const etiqueta of navigator.languages ?? [navigator.language]) {
    const base = etiqueta?.split("-")[0];
    if (base && (LOCALES as string[]).includes(base)) return base as Locale;
  }
  // Inglés cuando el sistema pide algo que no tenemos: es el idioma en el que
  // está escrito el catálogo, así que es el único que se sabe completo.
  return "en";
}

function resolve(preference: LocalePreference): Locale {
  return preference === "system" ? delSistema() : preference;
}

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set, get) => ({
      // «system» por defecto: quien no ha elegido nada probablemente quiere lo
      // que ya tiene puesto en su ordenador.
      preference: "system",
      resolved: "en",

      apply: () => {
        const resolved = resolve(get().preference);
        // Que el documento lo diga: los lectores de pantalla lo usan para elegir
        // la voz, y sin esto leerían el castellano con pronunciación inglesa.
        if (typeof document !== "undefined") {
          document.documentElement.lang = resolved;
        }
        // El catálogo se entera aquí y sólo aquí: una pantalla que llamara a
        // `changeLanguage` por su cuenta dejaría el store diciendo una cosa y la
        // interfaz enseñando otra.
        applyLocale(resolved);
        set({ resolved });
      },

      setPreference: (preference) => {
        set({ preference });
        get().apply();
      },
    }),
    {
      name: "cac-locale",
      partialize: (s) => ({ preference: s.preference }),
      onRehydrateStorage: () => (state) => state?.apply(),
    },
  ),
);
