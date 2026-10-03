/**
 * Las piezas puras del despliegue: lo que se deduce de un servicio para
 * prellenar su registro, y cómo se enseña una imagen.
 */

/** La primera versión del agente que despliega (`domain.AgentVersionDeploys`). */
export const AGENT_VERSION_DEPLOYS = 3;

/** La primera que corre migraciones antes del deploy (`domain.AgentVersionMigrates`). */
export const AGENT_VERSION_MIGRATES = 4;

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

/**
 * El paso que un repo añade a su workflow para avisar a cac, tras publicar la
 * imagen. Es lo único que cambia en su CI, y un repo sin él sigue igual.
 *
 * El sha tiene que ser el mismo con el que se etiqueta la imagen: cac
 * despliega `imageRepo:sha` y no otra cosa. `-f` pone el paso en rojo con una
 * llave que no vale; un aviso que llega con otro deploy en curso contesta 200
 * y no lo pone.
 */
export function ciNoticeStep(url: string, shortSha = false): string {
  // Con tags cortos se manda el corto: `$GITHUB_SHA` es siempre el entero, y
  // cac desplegaría un tag que no existe.
  const sha = shortSha ? "$SHORT_SHA" : "$GITHUB_SHA";
  return [
    "      - name: Notify cac",
    "        run: |",
    ...(shortSha ? ["          SHORT_SHA=$(git rev-parse --short=7 HEAD)"] : []),
    `          curl -fsS -X POST ${url} \\`,
    "            -H \"X-Deploy-Key: ${{ secrets.CAC_DEPLOY_KEY }}\" \\",
    "            -H \"Content-Type: application/json\" \\",
    `            -d "{\\"sha\\":\\"${sha}\\",\\"ref\\":\\"$GITHUB_REF\\",\\"actor\\":\\"$GITHUB_ACTOR\\",\\"runUrl\\":\\"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\\"}"`,
  ].join("\n");
}

/**
 * Si el servicio se etiqueta con el sha corto: lo dice la imagen que corre
 * (`…:abc1234`). Siete u ocho caracteres hex de tag = corto.
 */
export function usesShortSha(image: string): boolean {
  const tag = image.split("@")[0].split("/").pop()?.split(":")[1] ?? "";
  return /^[0-9a-f]{7,8}$/.test(tag);
}
