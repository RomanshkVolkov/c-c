/**
 * Cómo se llama alguien en pantalla.
 *
 * El usuario es el **identificador**: lo que se escribe tras una arroba, lo que
 * se busca en el selector, lo que no cambia. El nombre es cómo se le llama. En
 * una lista de gente, «rvolkov» donde cabe «Romanshk Volkov» hace que la
 * pantalla se lea como una tabla de la base de datos.
 *
 * Aquí, y no un `?? u.username` repartido por dieciocho sitios, porque la regla
 * del respaldo tiene que ser una: nadie está obligado a poner su nombre, y el
 * sitio diecinueve se olvidará de contemplarlo.
 *
 * **Dónde no se usa**, que es la mitad de la decisión: donde el usuario *es* el
 * dato. Una mención `@rvolkov`, el selector donde escribes para buscar, y el
 * campo de usuario al crear una cuenta. Cambiar ésos no sería mejorar la
 * lectura, sería enseñar otra cosa.
 */
export function nombreDe(persona: { name?: string | null; username: string }): string {
  const n = persona.name?.trim();
  return n || persona.username;
}

/** Las iniciales para un avatar, del nombre si lo hay. */
export function inicialesDe(persona: { name?: string | null; username: string }): string {
  return nombreDe(persona).slice(0, 2).toUpperCase();
}
