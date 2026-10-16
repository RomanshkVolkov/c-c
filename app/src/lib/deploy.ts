/**
 * Las piezas puras del despliegue: lo que se deduce de un servicio para
 * prellenar su registro, y cómo se enseña una imagen.
 */

/** La primera versión del agente que despliega (`domain.AgentVersionDeploys`). */
export const AGENT_VERSION_DEPLOYS = 3;

/** La primera que corre migraciones antes del deploy (`domain.AgentVersionMigrates`). */
export const AGENT_VERSION_MIGRATES = 4;

/** La primera que construye la imagen en el servidor (`domain.AgentVersionBuilds`). */
export const AGENT_VERSION_BUILDS = 6;

/**
 * La versión del agente que instala esta app (la de `swarm-manage/VERSION`, la
 * misma que la imagen de `agent_install.rs`; lo vigila `deploy.test.ts`). Es
 * a la que llega un servidor al pulsar «Update agent».
 */
export const AGENT_VERSION_LATEST = 7;

/** El agente nuevo ya habló: de qué versión venía y en cuál está. */
export type AgentUpdateOutcome = { from: number; to: number };

/**
 * Si el agente nuevo ya habló. Instalar acuña una identidad nueva, que tumba
 * la del agente viejo: desde entonces, un latido nuevo sólo puede ser del
 * nuevo. Por eso basta con que `agentSeenAt` cambie respecto a lo que había
 * antes de instalar, sin comparar relojes de dos máquinas.
 */
export function agentUpdateOutcome(
  before: { agentSeenAt?: string; agentVersion?: number },
  now: { agentSeenAt?: string; agentVersion?: number },
): AgentUpdateOutcome | null {
  if (!now.agentSeenAt || now.agentSeenAt === before.agentSeenAt) return null;
  return { from: before.agentVersion ?? 0, to: now.agentVersion ?? 0 };
}

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

/**
 * El puente de los Docker secrets al entorno, para el Dockerfile de un
 * servicio: cada `/run/secrets/NOMBRE` se exporta como `NOMBRE` si no viene ya
 * en el entorno, y `exec "$@"` deja que el mismo contenedor corra la app o el
 * job de migraciones. Es el que escribió Boaty (14-oct-2026); RRHH tenía otro,
 * y cada repo Node/Prisma lo reinventaba.
 */
export const SECRETS_ENTRYPOINT_SNIPPET = `# Docker secrets → entorno (cac). Va en la imagen final, antes de USER.
RUN printf '%s\\n' \\
  '#!/bin/sh' \\
  'for f in /run/secrets/*; do' \\
  '  [ -f "$f" ] || continue' \\
  '  n=\${f##*/}' \\
  '  case $n in *[!A-Za-z0-9_]*) continue;; esac' \\
  '  printenv "$n" > /dev/null || export "$n=$(cat "$f")"' \\
  'done' \\
  'exec "$@"' \\
  > /usr/local/bin/docker-entrypoint && chmod 755 /usr/local/bin/docker-entrypoint
ENTRYPOINT ["docker-entrypoint"]`;

/**
 * Cruza los build args de un Dockerfile con los secrets del servicio. Uno que
 * ya está como secret de la app (`runtime`) pasa a `both`: lo pide el build y
 * lo usa la app. Uno que falta se añade como `build`, sin referencia, para que
 * se la pongan. Lo demás no se toca.
 */
export function mergeBuildArgs<T extends { name: string; opRef: string; usage?: "runtime" | "build" | "both" }>(
  rows: T[],
  args: string[],
): { rows: T[]; added: number; promoted: number } {
  let added = 0;
  let promoted = 0;
  const wanted = new Set(args);
  const next = rows.map((r) => {
    if (wanted.has(r.name.trim()) && (r.usage ?? "runtime") === "runtime") {
      promoted++;
      return { ...r, usage: "both" as const };
    }
    return r;
  });
  const have = new Set(rows.map((r) => r.name.trim()));
  for (const a of args) {
    if (!have.has(a)) {
      added++;
      next.push({ name: a, opRef: "", usage: "build" } as T);
    }
  }
  return { rows: next, added, promoted };
}
