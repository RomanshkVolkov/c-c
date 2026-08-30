import "i18next";

import type channel from "@/locales/en/channel.json";
import type chat from "@/locales/en/chat.json";
import type common from "@/locales/en/common.json";
import type org from "@/locales/en/org.json";
import type errors from "@/locales/en/errors.json";
import type nav from "@/locales/en/nav.json";
import type notifications from "@/locales/en/notifications.json";
import type work from "@/locales/en/work.json";

/**
 * Las claves del catálogo, con tipos.
 *
 * Esto convierte el modo de fallo característico de traducir una aplicación
 * —`t("boton.gaurdar")` con una errata pinta la clave y sigue, sin error, sin
 * traza y sin romper ninguna prueba— en **un error de compilación**.
 *
 * Se declara sobre el catálogo **inglés** porque es el idioma base: el
 * castellano se mantiene a la par con una prueba, pero el inglés define qué
 * claves existen. Quien añada una frase la añade ahí primero, y el compilador se
 * encarga del resto.
 *
 * Es también la respuesta a por qué no hizo falta cambiar de librería. La
 * garantía que dan las soluciones que compilan los mensajes se consigue aquí con
 * una declaración, y sin renunciar a cambiar de idioma **sin recargar la
 * ventana** — que en esta app puede tener una llamada de voz abierta.
 */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof common;
      nav: typeof nav;
      notifications: typeof notifications;
      work: typeof work;
      channel: typeof channel;
      chat: typeof chat;
      org: typeof org;
      errors: typeof errors;
    };
    // Sin `null`: una clave que existe siempre devuelve texto, y quien la use no
    // tiene que defenderse de un valor que no puede llegar.
    returnNull: false;
  }
}
