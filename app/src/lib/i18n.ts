import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import enCommon from "@/locales/en/common.json";
import enNav from "@/locales/en/nav.json";
import enNotifications from "@/locales/en/notifications.json";
import enWork from "@/locales/en/work.json";
import esCommon from "@/locales/es/common.json";
import esNav from "@/locales/es/nav.json";
import esNotifications from "@/locales/es/notifications.json";
import esWork from "@/locales/es/work.json";
import type { Locale } from "@/store/locale.store";

/**
 * El catálogo, y la única forma de arrancarlo.
 *
 * Los ficheros van **importados**, no cargados por red: esto es una aplicación
 * de escritorio que se empaqueta entera, y pedir un JSON por HTTP sólo añadiría
 * una pantalla en blanco mientras llega, con su modo de fallo propio cuando no
 * llegue.
 *
 * El inglés es el idioma base y el de reserva: es en el que está escrito el
 * producto, así que es el único que se sabe completo. Una clave que falte en
 * castellano sale en inglés — feo, pero legible, que es mejor que un hueco.
 */

/** El inglés manda: si una clave no está aquí, no está en ninguna parte. */
const recursos = {
  en: { common: enCommon, nav: enNav, notifications: enNotifications, work: enWork },
  es: { common: esCommon, nav: esNav, notifications: esNotifications, work: esWork },
} as const;

/**
 * Una clave que no existe **tiene que doler**, y sólo en desarrollo.
 *
 * Es el modo de fallo característico de esto: `t("boton.gaurdar")` con una
 * errata no lanza, no avisa y no rompe ninguna prueba — pinta la propia clave y
 * sigue. En producción eso es lo correcto (una etiqueta rara es mejor que una
 * pantalla caída); en desarrollo es la forma de que nadie se entere hasta que lo
 * vea un cliente.
 */
function avisarDeClaveAusente(idiomas: readonly string[], ns: string, clave: string) {
  if (import.meta.env.PROD) return;
  console.error(`i18n: falta «${ns}:${clave}» en ${idiomas.join(", ")}`);
}

/**
 * Arranca el catálogo en el idioma que se le diga.
 *
 * El idioma **entra por parámetro** y no se lee del store: el store importa
 * `applyLocale` de aquí, así que leerlo desde aquí cerraría un ciclo entre los
 * dos módulos. Con un ciclo, quién queda a medio evaluar depende de quién se
 * importe primero — y eso cambia entre la aplicación y las pruebas, que es la
 * peor clase de diferencia.
 */
export function initI18n(lng: Locale = "en") {
  if (i18next.isInitialized) return i18next;

  void i18next.use(initReactI18next).init({
    resources: recursos,
    lng,
    fallbackLng: "en",
    defaultNS: "common",
    ns: ["common", "nav", "notifications", "work"],
    // Sin escapado: React ya escapa todo lo que pinta, y volver a hacerlo aquí
    // convierte un apóstrofo en `&#39;` dentro de la propia frase.
    interpolation: { escapeValue: false },
    saveMissing: !import.meta.env.PROD,
    missingKeyHandler: (idiomas, ns, clave) => avisarDeClaveAusente(idiomas, ns, clave),
    // Silencio salvo lo que se avisa arriba a propósito.
    debug: false,
  });

  return i18next;
}

/** Cambia el idioma de la interfaz. Lo llama el store, no las pantallas. */
export function applyLocale(locale: Locale) {
  if (i18next.isInitialized && i18next.language !== locale) {
    void i18next.changeLanguage(locale);
  }
}

export default i18next;
