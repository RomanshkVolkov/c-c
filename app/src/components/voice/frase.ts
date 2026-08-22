/**
 * «Marta está» / «Marta y Luis están» / «Marta, Luis y Elena están».
 *
 * Se escribe a mano y no con `Intl.ListFormat` porque el verbo va pegado a la
 * lista: con una persona es singular y con dos ya no, y `ListFormat` une los
 * nombres pero no sabe nada del verbo que viene detrás. Devolver la frase
 * entera evita el clásico «1 people are talking».
 */
export function quienHabla(nombres: string[]): string {
  if (nombres.length === 0) return "";
  if (nombres.length === 1) return `${nombres[0]} is`;
  return `${nombres.slice(0, -1).join(", ")} and ${nombres[nombres.length - 1]} are`;
}
