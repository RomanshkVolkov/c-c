/**
 * Las frases de los errores, a partir de su etiqueta de código.
 *
 * Módulo propio y no un rincón del cliente HTTP porque tiene **dos** clientes:
 * las respuestas de la API y lo que devuelve el motor de voz del proceso de
 * Rust. Viviendo dentro de `api.ts`, el store de voz tenía que importar el
 * cliente entero — y las pruebas que lo simulan se caían por una función que ni
 * siquiera usan.
 */

import i18next from "i18next";

import errorsEn from "@/locales/en/errors.json";

/** Los códigos que esta versión sabe traducir. Es el catálogo, no una copia. */
const ERROR_CODES = errorsEn;

/**
 * El error del servidor, dicho en el idioma de quien lo lee.
 *
 * **La etiqueta de código es la clave del catálogo.** `inbox-other-org` ya
 * viajaba en cada respuesta, el contrato público ya declara la frase como
 * decorativa, y el cliente ya leía las dos cosas por separado — así que no hizo
 * falta tocar ni una de las quinientas llamadas del servidor.
 *
 * Se traduce **aquí y no en el servidor** a propósito. Un error es efímero: se
 * enseña en el acto y muere con la respuesta, al revés que una fila de la
 * bandeja, que se escribe una vez y se lee meses después. Traducirlo en el
 * cliente además funciona contra servidores ya desplegados y cambia de idioma
 * al instante al cambiar la preferencia, sin ida y vuelta.
 *
 * Una etiqueta que no esté en el catálogo se queda con **la frase del
 * servidor**, no con la etiqueta cruda: un servidor más nuevo puede inventar un
 * código que esta versión no conoce, y «Error: widget-exploded» es peor que la
 * frase en inglés que ese servidor ya mandó.
 *
 * La pertenencia se comprueba contra el catálogo inglés y no preguntándole a
 * i18next si devolvió la clave. Lo segundo es una heurística —una traducción
 * que se pareciera a su clave la rompería— y además no deja tipar nada: el
 * código viene del cable, así que es `string`, y `t()` no acepta `string`. El
 * `in` es lo que hace honesto el estrechamiento.
 *
 * Exportada para poder probarla: es la única parte de este camino que se puede
 * comprobar sin montar un servidor, y las dos ramas —la conocida y la que no—
 * son justo donde esto se equivoca.
 */
export function phraseFor(codigo: string, delServidor: string): string {
  if (!(codigo in ERROR_CODES)) return delServidor;
  return i18next.t(`errors:${codigo as keyof typeof ERROR_CODES}`);
}
