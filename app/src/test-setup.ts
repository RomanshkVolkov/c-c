import { initI18n } from "@/lib/i18n";

/**
 * Lo que jsdom no trae y la app da por hecho.
 *
 * Va en un `setupFiles` y no en cada prueba porque no es una decisión de
 * ninguna prueba: es un hueco del entorno. `matchMedia` existe en cualquier
 * navegador y el sidebar lo consulta para saber si está en pantalla estrecha,
 * así que sin esto cualquier pantalla montada dentro del armazón revienta con
 * un `TypeError` que no dice nada de lo que se estaba comprobando — y el
 * arreglo se copia y pega de un fichero de pruebas al siguiente.
 *
 * Devuelve siempre `matches: false`, es decir «pantalla ancha». Es lo que
 * quieren las pruebas que no hablan de responsive; la que quiera probar el
 * comportamiento estrecho tendrá que sobrescribirlo, y hacerlo a propósito es
 * justo lo correcto.
 */
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  });
}

/**
 * `scrollIntoView` tampoco está en jsdom.
 *
 * Cualquier lista que se mantenga pegada al fondo —el chat de la sala, el hilo
 * de un canal— lo llama tras pintar, y sin esto la prueba falla con un
 * `is not a function` que no dice nada de lo que se estaba comprobando.
 *
 * Un no-op basta: lo que se prueba nunca es que el navegador haya hecho
 * scroll, sino lo que se pintó.
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

/**
 * Las pruebas se leen en inglés, pase lo que pase.
 *
 * Cientos de aserciones buscan texto literal —`getByText("Save")`— y el idioma
 * de la interfaz sale del sistema cuando nadie ha elegido. Sin fijarlo aquí, la
 * suite entera pasaría en una máquina en inglés y se caería en una en
 * castellano, que es el peor fallo posible: no dice nada de lo que se estaba
 * probando y depende de quién la ejecute.
 *
 * El inglés y no otro porque es el idioma base del catálogo — el único que se
 * sabe completo. Una prueba que quiera comprobar el castellano tiene que
 * cambiarlo a propósito, y hacerlo a propósito es justo lo correcto.
 *
 * También fija el locale de `Intl`: las fechas y las horas se formatean con el
 * del sistema, así que una aserción sobre «9:00» o «05:00 PM» tiene el mismo
 * problema. Ver `lib/horas.test.ts`, que ya lo sortea leyendo la hora como
 * número en vez de como texto.
 */
Object.defineProperty(navigator, "languages", {
  value: ["en-US"],
  configurable: true,
});
Object.defineProperty(navigator, "language", {
  value: "en-US",
  configurable: true,
});

/**
 * Y el catálogo arrancado, o `t()` devuelve la clave.
 *
 * Sin esto, una pantalla traducida pinta `notifications:tab.talk` donde debería
 * poner «Talk», y cada prueba que busque texto se cae con un mensaje que habla
 * de otra cosa. Arranca en inglés por lo mismo que arriba: es el idioma en el
 * que están escritas las aserciones.
 */
initI18n();
