/**
 * Las piezas puras del despliegue: lo que se deduce de un servicio para
 * prellenar su registro, y cómo se enseña una imagen.
 */

/** El repositorio de una imagen, sin tag ni digest. El `:` de un puerto no es un tag. */
export function repoFromImage(image: string): string {
  const sinDigest = image.split("@")[0];
  const slash = sinDigest.lastIndexOf("/");
  const colon = sinDigest.lastIndexOf(":");
  return colon > slash ? sinDigest.slice(0, colon) : sinDigest;
}

/** El entorno por el sufijo del stack (`beta-api-prod` → `prod`), si lo trae. */
export function guessEnvironment(stack: string): string {
  const m = /-(prod|production|dev|develop|staging|stage|test|qa)$/i.exec(stack);
  return m ? m[1].toLowerCase() : "";
}

/** El nombre del servicio sin el prefijo de su stack (`api-prod_app` → `app`). */
export function shortServiceName(service: string, stack: string): string {
  return service.startsWith(`${stack}_`) ? service.slice(stack.length + 1) : service;
}

/** La referencia corta de una imagen, para una fila: el tag, sin el digest. */
export function shortRef(image: string): string {
  if (!image) return "—";
  const sinDigest = image.split("@")[0];
  const slash = sinDigest.lastIndexOf("/");
  const colon = sinDigest.lastIndexOf(":");
  return colon > slash ? sinDigest.slice(colon + 1) : "latest";
}

/** Un sha de git, corto o entero. El backend lo vuelve a comprobar. */
export function isSha(s: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(s);
}
