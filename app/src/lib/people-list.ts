/**
 * Una lista de personas, unida como la uniría cada idioma.
 *
 * «Marta», «Marta y Luis», «Marta, Luis y Elena» — y en inglés con su propia
 * coma antes del «and». Lo hace `Intl.ListFormat`, que ya sabe dónde va cada
 * separador en cada idioma.
 *
 * **Devuelve sólo la lista, nunca media frase.** Antes esto entregaba «Marta
 * está» para que la vista le pegara el verbo detrás, porque el verbo concuerda
 * con cuántos son. Funcionaba en inglés y en castellano por casualidad: en
 * cuanto un idioma ponga el verbo delante, o le cambie la forma por otra razón,
 * una frase partida por la mitad no hay manera de arreglarla desde el catálogo.
 * Ahora la frase entera vive en el catálogo con su plural, y aquí sólo se
 * resuelve la lista.
 */

const uniones = new Map<string, Intl.ListFormat>();

export function joinNames(names: string[], lng: string): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];

  let f = uniones.get(lng);
  if (!f) {
    // `conjunction` es «y», no «o»: son las personas que están, todas a la vez.
    f = new Intl.ListFormat(lng, { style: "long", type: "conjunction" });
    uniones.set(lng, f);
  }
  return f.format(names);
}
