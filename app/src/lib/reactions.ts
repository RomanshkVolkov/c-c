/**
 * Reacciones: un emoji sobre un mensaje (backend: `domain/reaction.go`).
 *
 * Lo comparten el canal y los directos —y más adelante el chat de la llamada—,
 * así que la cuenta optimista vive aquí una vez y no en cada store.
 */

export interface Reaction {
  emoji: string;
  count: number;
  /** Si está el mío: se pinta marcado y pulsarlo lo quita. */
  mine: boolean;
  /** Quiénes, en el orden en que reaccionaron. */
  names: string[];
}

/**
 * El juego que se acepta, en el orden del selector. **El mismo que el
 * servidor** (`domain.ReactionEmojis`), que rechaza cualquier otro con un 400;
 * `reactions.test.ts` lo compara con el fichero de Go.
 */
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👀", "✅", "🙏", "🔥"] as const;

/**
 * Las reacciones de un mensaje tras poner (`on`) o quitar la mía, sin esperar
 * al servidor. Un emoji que se queda a cero desaparece; uno nuevo va al final,
 * que es donde lo pondrá el servidor (por orden del primero).
 */
export function applyReaction(list: Reaction[] | undefined, emoji: string, on: boolean, me: string): Reaction[] {
  const actual = list ?? [];
  const i = actual.findIndex((r) => r.emoji === emoji);
  if (on) {
    if (i >= 0 && actual[i].mine) return actual;
    if (i < 0) return [...actual, { emoji, count: 1, mine: true, names: [me] }];
    return actual.map((r, j) =>
      j === i ? { ...r, count: r.count + 1, mine: true, names: [...r.names, me] } : r,
    );
  }
  if (i < 0 || !actual[i].mine) return actual;
  const r = actual[i];
  if (r.count <= 1) return actual.filter((_, j) => j !== i);
  // Se quita **un** nombre igual al mío: mi nombre puede coincidir con el de
  // otra persona, y la lista exacta la trae el servidor en la siguiente lectura.
  const k = r.names.lastIndexOf(me);
  const names = k >= 0 ? r.names.filter((_, j) => j !== k) : r.names.slice(0, -1);
  return actual.map((x, j) => (j === i ? { ...x, count: x.count - 1, mine: false, names } : x));
}
