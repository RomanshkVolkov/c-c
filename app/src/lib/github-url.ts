/**
 * Sólo se abre lo que es de GitHub: el enlace lo escribió GitHub, pero la regla
 * no cuesta nada. Lo usan la actividad del CI y el panel «Desarrollo» de una
 * tarea, que pinta enlaces llegados por webhook.
 */
export function isGitHubUrl(u: string): boolean {
  return u.startsWith("https://github.com/");
}
