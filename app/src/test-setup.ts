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
