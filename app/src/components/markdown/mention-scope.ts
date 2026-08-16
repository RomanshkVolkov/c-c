/**
 * Where the `@` picker may be offered.
 *
 * Naming a colleague inside something a client reads puts a teammate's name in
 * front of somebody it was never meant for — and the person typing has no way
 * to notice, because the picker looks identical either way. So the extension
 * simply isn't loaded there and `@` stays an ordinary character.
 *
 * A function rather than a condition inline in JSX so the rule has one home,
 * and somewhere to be tested.
 */
export function mentionsAllowed(clientReads: boolean, commentInternal: boolean): boolean {
  return !clientReads || commentInternal;
}
