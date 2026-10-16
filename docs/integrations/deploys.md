# Desplegar desde cac: el aviso del CI

Cómo un repo que ya despliega con su propio CI pasa a que despliegue cac, sin
tener que hacerlo de golpe. GitHub sigue probando y construyendo la imagen; lo
que cambia es quién la pone en el servidor, y eso se decide por servicio y
cuando uno quiera.

> Contrato estable. Si algo de aquí no coincide con el comportamiento real, es
> un bug del documento o del código.

---

## 1. Los pasos, y qué se toca en cada uno

| Paso | Dónde | Qué cambia en el repo |
|---|---|---|
| 1. El servidor tiene el agente v3 | Servidores → «Update agent» | nada |
| 2. Registrar el servicio | Servicios → Deploy → «Registrar» | nada |
| 3. El CI avisa, en modo **Apuntar** | Deploy → «Acuñar llave» | un paso al final del workflow y el secret `CAC_DEPLOY_KEY` |
| 4. Pasar a modo **Desplegar** | Deploy → «Cuando el CI avisa» | quitar los pasos que despliegan por ssh |

Hasta el paso 3 incluido, el CI sigue desplegando igual que hoy: registrar un
servicio no toca el servidor, y en modo Apuntar cac sólo lleva la lista de las
versiones publicadas. Desde el paso 2 ya se puede desplegar un commit o volver
atrás a mano desde cac.

El agente actualiza el servicio con `service update` sobre la API de Docker,
**nunca** con `stack deploy`, así que un stack que creó el CI no se recrea y
conserva sus labels, redes y secrets. Por eso los pasos 3 y 4 pueden convivir
con un `prod.yml` a medio migrar.

## 2. La llave

Una por servicio registrado, en la cabecera `X-Deploy-Key`:

```
X-Deploy-Key: dk_...
```

- La acuña un **admin** de la org y se enseña **una vez**. De ella se guarda
  sólo un HMAC.
- Acuñar otra tumba la anterior en el momento.
- La llave es del servicio y el cuerpo no dice a cuál va: **no hay forma de
  desplegar otro servicio con ella**, ni de la misma org.
- Una llave que no casa (o sin cabecera) es un `401 invalid-deploy-key`, sin más
  detalle.
- 60 avisos por hora por servicio; el 61 es un `429 rate-limited`.

## 3. El paso del workflow

Después del paso que publica la imagen:

```yaml
      - name: Notify cac
        run: |
          curl -fsS -X POST https://cac.guz-studio.dev/ingest/v1/deploys \
            -H "X-Deploy-Key: ${{ secrets.CAC_DEPLOY_KEY }}" \
            -H "Content-Type: application/json" \
            -d "{\"sha\":\"$GITHUB_SHA\",\"ref\":\"$GITHUB_REF\",\"actor\":\"$GITHUB_ACTOR\",\"runUrl\":\"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\"}"
```

La app enseña este mismo paso al acuñar la llave, listo para copiar.

**El sha tiene que ser el tag de la imagen.** cac despliega `imageRepo:sha` y
nada más: no hay campo de imagen en el aviso, justamente para que una llave
filtrada no pueda desplegar una imagen de otro sitio. Si el workflow etiqueta con
el sha corto, manda el corto.

## 4. La respuesta

```json
{ "success": true, "data": { "build": { ... }, "deploy": "queued", "reason": "", "deployment": { ... } } }
```

| `deploy` | HTTP | Qué pasó |
|---|---|---|
| `recorded` | 200 | Modo Apuntar: el build queda en la lista y no se despliega nada. |
| `queued` | 202 | Modo Desplegar: el agente lo recogerá en su siguiente pregunta (segundos). |
| `exists` | 200 | Ya había un deploy de ese commit por aviso del CI (un reintento): no se duplica. |
| `skipped` | 200 | No se pudo encolar ahora; `reason` dice por qué. El build sí queda. |

Los `reason` de un `skipped`:

- `deploy-in-flight`: ya hay otro deploy del servicio en cola o en curso. Pasa
  con dos commits seguidos. El segundo queda en la lista y se despliega desde ahí.
- `agent-too-old`: el agente del servidor no sabe desplegar. Hay que
  reinstalarlo.

Un `skipped` **no pone el CI en rojo** a propósito: rojo diría que algo del
repo está roto, y no lo está. El resultado del deploy se ve en cac, con su
log en vivo y quién lo pidió («el CI»).

El mismo sha dos veces es un build y, como mucho, un deploy: los reintentos del
workflow no despliegan dos veces.

El cuerpo **no puede decir de qué run viene**: el enlace entre un deploy y su
`workflow_run` (`workflowRunId` en el deploy, para la Actividad) lo pone sólo la
[GitHub App](github.md); un `workflowRunId` en este cuerpo se descarta.

## 5. Migraciones

En el diálogo de deploy del servicio, «Migraciones»: un comando de una línea
(`npx prisma migrate deploy`, `bun run migrate`…) que corre **antes de cada
deploy**, con la imagen nueva.

- Corre como un **job de Swarm** de un solo disparo copiado del servicio: las
  mismas redes, secrets (`/run/secrets/…`), entorno y restricciones, así que
  llega a la base igual que la app. Sin sus puertos, sus labels (Traefik no lo
  ve) ni su healthcheck, y sin reintentos.
- Su salida va al log del deploy. El job se borra al acabar, salga como salga.
- **Si falla** (código distinto de 0, o Swarm no puede colocarlo), el servicio
  **no se toca** y el deploy cuenta como fallido. Tiene un tope de 15 minutos.
- Hace falta el agente v4 («Update agent»). A uno anterior no se le encola un
  deploy de un servicio con migraciones —lo desplegaría sin migrar—, y un
  aviso del CI en ese caso queda apuntado con el motivo `agent-cannot-migrate`.

## 6. Una rama por servicio

Cada servicio dice qué rama despliega (Deploy → «Rama y build»). Un aviso del
CI, un `workflow_run` o un push de **otra** rama no lo toca: el aviso contesta
`skipped` con el motivo `other-branch` y no deja ni la versión apuntada. Así
prod (`main`) y test (`staging`) pueden compartir repo, workflow y paso de
aviso, cada uno con su servicio y su llave. Sin rama, como antes: cualquiera.

El `ref` que manda el `curl` es el que se compara (`$GITHUB_REF`, con
`refs/heads/`). Un aviso sin `ref` sólo vale para un servicio sin rama.

## 7. Construir en el servidor, sin CI

Para cuando no hay minutos de Actions, o no se quiere depender de ellos. En
«Rama y build», «Construir en el servidor»: un **push** a la rama del servicio,
que llega por la [GitHub App](github.md), hace que el servidor construya la
imagen de ese commit y la despliegue. No hay paso de aviso ni llave que guardar
en el repo.

- **Hace falta:** la GitHub App con el repo, el repo del servicio puesto
  (`owner/name`), y el agente **v6** («Update agent»). A uno anterior no se le
  encola un build: contesta `agent-cannot-build`.
- **Qué hace el servidor:** un job de Swarm con la imagen oficial `docker:cli`
  (trae buildx) construye en el Docker del host. BuildKit clona **el commit
  exacto** con el token de la App, que dura una hora y sólo lee el repo, y
  nunca aparece en un comando ni en un log. La imagen se queda en el servidor,
  sin registro, y se despliega como siempre (migraciones incluidas).
- **Carpeta y Dockerfile:** la carpeta del repo desde la que se construye
  (`boat` en un monorepo; vacía = la raíz) y el Dockerfile **dentro de esa
  carpeta** (vacío = `Dockerfile`).
- **El log** del deploy lleva el final de la salida del build, que es donde está
  el error, y un «sigue construyendo» cada minuto. Un deploy con build tiene 45
  minutos antes de darse por perdido; el build en sí, 40.
- **Un solo nodo:** una imagen construida en el host sólo existe en ese nodo.
  En un swarm de varios nodos el agente lo rechaza; para eso hará falta un
  registro.
- **En modo Apuntar**, el push sólo deja la versión en la lista, como el aviso
  de un CI.

### Los build args

Lo que un Dockerfile recibe con `ARG` (`NEXT_PUBLIC_*`, y en un Next con
prerender, `DATABASE_URL`) sale de los **secrets del servicio**, en la pestaña
Secrets, marcados «el build» o «los dos»:

- **la app**: va al servicio en marcha, como `/run/secrets/NOMBRE` (lo de
  siempre);
- **el build**: sólo al job que construye, como build arg. No se cuelga del
  servicio;
- **los dos**: a los dos. Es el caso de `DATABASE_URL` en un Next que
  prerenderiza páginas con datos de la base.

Se rotan con el mismo botón que los demás: los valores salen de 1Password en
tu máquina y llegan al servidor por ssh. El backend sólo sabe sus nombres. En
el job van del fichero al entorno y como `--build-arg NOMBRE`, sin valor, así
que nunca salen en la línea de comandos.

> **Los secrets por referencia no son build args por sí solos.** Si el servicio
> sigue construyendo en su CI, lo que entra por `--build-arg` sigue viniendo
> del CI. Construyendo en el servidor, viene de aquí.

**No hace falta sacar `DATABASE_URL` del build** de un Next que prerenderiza
(páginas de `generateStaticParams`, `"use cache"`): sin ella el build falla o,
peor, publica páginas vacías, y eso se nota en el SEO. Construyendo en el
servidor, la base se alcanza desde ahí con la misma URL.

Para un repo nuevo, mejor `RUN --mount=type=secret,id=NOMBRE` que `ARG`: así el
valor no queda en el historial de la imagen. El job monta cada build arg
también como secret de BuildKit con su nombre.

### Leer los secrets desde la app

Los secrets llegan como ficheros. Este bloque, en la imagen final del
Dockerfile, los exporta como variables si el entorno no las trae ya, y
`exec "$@"` deja que la misma imagen corra la app o el job de migraciones (está
también en la pestaña Secrets, para copiarlo):

```dockerfile
RUN printf '%s\n' \
  '#!/bin/sh' \
  'for f in /run/secrets/*; do' \
  '  [ -f "$f" ] || continue' \
  '  n=${f##*/}' \
  '  case $n in *[!A-Za-z0-9_]*) continue;; esac' \
  '  printenv "$n" > /dev/null || export "$n=$(cat "$f")"' \
  'done' \
  'exec "$@"' \
  > /usr/local/bin/docker-entrypoint && chmod 755 /usr/local/bin/docker-entrypoint
ENTRYPOINT ["docker-entrypoint"]
```

## 8. Configurarlo con un agente (MCP)

Dejar listo un servicio a mano —repo, rama, build en el servidor, Dockerfile y
la lista de secrets con su referencia de 1Password— es mucho rato en la página
Despliegue (jose, 16-oct-2026, con Boaty). El MCP de cac lo hace por ti con un
token que lleve el permiso **`deploys:manage`** («Configurar despliegues» en
Connect Claude Code):

| Herramienta | Qué hace |
|---|---|
| `list_servers` | Los servidores, para el `serverId`. |
| `list_deployables` | Los servicios de un servidor, para el `deployableId`. |
| `get_deploy_config` | La configuración entera de uno: lo de arriba, sus secrets **por nombre** con su `opRef` y uso, y los build args del Dockerfile. |
| `create_deployable` | Registrar un servicio. |
| `update_deploy_config` | Cambiar sólo lo que se pide. La ruta pide la fila entera, y la herramienta rellena el resto con lo que ya hay. |
| `set_secret_refs` | Los secrets por nombre. Por defecto **combina por nombre**; `remove` quita y `replace` sustituye la lista. |

**Lo que no hace, a propósito:**
- **Desplegar ni volver atrás.** Un token configura; una persona aprieta el
  botón. Tampoco borra un servicio ni saca la llave del CI. Lo vigila
  `middleware.TestATokenConfiguresButNeverDeploys`.
- **Cambiar el comando de migraciones.** Es un `sh -c` que corre en el
  servidor: con un token, el handler contesta 403 `migrate-needs-a-person`.
  Lo vigila `handler.TestAMigrationCommandNeedsAPerson`.
- **Tocar el valor de un secret.** Por aquí sólo viajan nombres y referencias.
  Los valores los lee de 1Password el botón «Rotar en el servidor» de la app.

## 9. Lo que no hace (todavía)

- Con la [GitHub App](github.md) instalada y el workflow que publica la imagen
  puesto en el servicio, este paso **sobra**: el final de ese workflow cuenta
  como el aviso. Y cada deploy aparece en GitHub como un Deployment.
- Los secrets del servicio siguen siendo los que ya tenga el servicio. Los
  secrets gestionados por cac piden el modo Desplegar, porque un `stack deploy`
  del CI los tiraría.
