# La GitHub App de cac

Una sola App de GitHub para todas las orgs de cac. Cada org la instala en sus
cuentas de GitHub, enlaza cada repo a un espacio, y desde ahí **los commits y
PRs que nombran una tarea dejan una línea en ella**.

Lo que llega de GitHub sólo comenta: nunca crea, mueve ni cierra una tarea. Las
líneas son **internas**: aunque la tarea la vea un cliente, sus mensajes de
commit no van a su hilo.

---

## 1. Registrar la App (una vez, la hace quien administra cac)

En GitHub → Settings → Developer settings → GitHub Apps → New GitHub App:

| Campo | Valor |
|---|---|
| Homepage URL | `https://cac.guz-studio.dev` |
| Setup URL | `https://cac.guz-studio.dev/webhooks/github/setup` |
| Redirect on update | ✔ (para que reinstalar también vuelva a cac) |
| Webhook URL | `https://cac.guz-studio.dev/webhooks/github` |
| Webhook secret | uno largo y aleatorio (va abajo, como `CAC_GITHUB_WEBHOOK_SECRET`) |
| Permisos de repositorio | Metadata: read · Contents: read · Pull requests: read · Actions: read · Deployments: read and write |
| Eventos | Push · Pull request · Workflow run (los de instalación llegan siempre) |
| Dónde se puede instalar | Any account |

Y en el repo de cac (Settings → Secrets and variables → Actions):

- variable `CAC_GITHUB_APP_SLUG`: el slug de la App, el de su URL pública
  (`github.com/apps/<slug>`);
- secret `CAC_GITHUB_WEBHOOK_SECRET`: el mismo secreto del webhook.

`backend.yml` los mete en `cac-secret` en el siguiente despliegue. Sin los dos,
todo lo de GitHub contesta `503 github-off` y la app lo dice en la pestaña.

Para que la App **escriba** en GitHub (sección 5), dos más:

- variable `CAC_GITHUB_APP_ID`: el App ID, en la página de la App;
- secret `CAC_GITHUB_APP_PRIVATE_KEY`: una llave privada generada ahí mismo
  (Private keys → Generate), **en una sola línea** con los saltos escritos
  como `\n`:

  ```sh
  awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' cac.private-key.pem
  ```

Sin ellas, la App comenta en las tareas y no escribe en GitHub.

## 2. Conectar una org

Ajustes de la organización → GitHub → «Conectar GitHub» (admin). Se abre el
navegador en la página de instalación de la App; al terminar, GitHub vuelve a
la Setup URL y cac ata la instalación a la org.

- La vuelta lleva un `state` firmado que dice de qué org es, y caduca a los
  10 minutos. Sin él no se ata nada.
- **Una instalación se ata una sola vez.** Si ya es de otra org de cac, la
  página lo dice y no se la lleva.

Los repos que la instalación deja ver aparecen en la pestaña, **sin enlazar**.
Un repo sin enlazar no comenta nada; así empieza cada uno.

**Al enlazar un repo a un espacio** (o cambiar «#12 a secas»), cac trae sus PRs
abiertas —las 100 más recientes— y las pasa por el mismo camino que un evento
`opened`: las que nombran una tarea, o salen de una rama con su número, quedan
en su panel con su línea en el hilo. Sin esto, un repo con veinte PRs en marcha
dejaba los paneles vacíos hasta el siguiente push de cada una. Lee con el token
de la instalación (`GET /repos/{repo}/pulls`); no pide permisos nuevos.

## 3. Nombrar una tarea

En el mensaje de un commit, o en el título o el cuerpo de una PR:

| Escrito | Nombra |
|---|---|
| `proteus-12` | la tarea interna 12 del espacio con la clave `proteus`, desde cualquier repo de la org. **La forma de nombrar una tarea** (cac#203). |
| `cac#12` | la tarea 12 del espacio enlazado. La forma de antes: se sigue entendiendo. |
| `#12` | lo mismo, sólo si el repo tiene «#12 a secas» encendido. En GitHub `#12` es el issue o la PR 12 del propio repo, por eso viene apagado. |
| `acme-7` | el folio 7 del proyecto `acme`, como lo ve el cliente. |

**O en el nombre de la rama** (8-oct-2026), la convención de Jira con las claves
de cac. Una rama enlaza a la tarea sus commits y su PR sin escribir nada en el
mensaje:

| Rama | Nombra |
|---|---|
| `proteus-12-login`, `feature/proteus-12` | la tarea interna 12 del espacio `proteus` |
| `feature/PROTEUS-12` | **nada en cac**: en mayúsculas es la clave de Jira, que numera por su lado |
| `cac-12-login`, `feature/CAC-12`, `fix_cac-12` | la tarea 12 del espacio enlazado |
| `feature/acme-7-fix` | el folio 7 de `acme` |
| `feature-beta-api-7` | el folio 7 de `feature-beta-api`, `beta-api` o `api`: el primero que exista |
| `12-login` | la tarea 12, sólo con «#12 a secas» (es lo que genera «Create branch» desde un issue) |
| `cac12`, `v1.2`, `main` | nada |

Sin distinguir mayúsculas, salvo la clave de un espacio, que sólo cuenta en
minúsculas. `cac` como slug está reservado al número del espacio.

**La clave de un espacio** sale de su nombre al crearlo: minúsculas, sin
acentos, kebab-case, y cada trozo empieza por letra («Dwit México» →
`dwit-mexico`). Es única en la org, también frente a los slugs de los proyectos
de cliente; si choca, lleva una letra detrás (`proteus-b`). No cambia al
renombrar el espacio. Se cambia a mano en el menú del espacio, y la anterior se
sigue aceptando. `get_task` y el detalle de la tarea en la app dan la
referencia lista (`ref`). Un proyecto de cliente no puede tener de slug la
clave de un espacio de su org, ni al revés.

Sólo se busca dentro de la org del repo, y el número, sólo en su espacio. Una
referencia que no resuelve se descarta sin más. Como mucho diez tareas por
texto y veinte commits por push.

## 4. Qué se escribe

**En el panel «Desarrollo» de la tarea** (desde el 8-oct-2026), a la manera del
de Jira: las ramas, las PRs con su estado (abierta, borrador, fusionada,
cerrada) y los commits. Se mantiene al día con cada entrega; una entrega vieja
que llega tarde no deshace un estado más nuevo (la guarda es el `updated_at` de
la PR). Una rama borrada se queda, marcada como borrada.

**En el hilo**, sólo lo que cuenta que el trabajo empezó y que llegó:

- **Commit nombrado en el mensaje**: `` `abc1234` [primera línea](enlace) · @autor · owner/repo ``.
  Una vez por commit y tarea. Un commit enlazado **sólo por la rama** no
  escribe en el hilo: cada push a la rama de una tarea llenaría su hilo de
  líneas que el panel ya enseña.
- **PR**: una línea al enlazarse (`PR #3 opened: …`) y otra al fusionarse
  (`PR #3 merged: …`). Los cambios de estado de en medio sólo se ven en el
  panel.

Una reentrega de GitHub no duplica nada.

**Eventos de la App.** `push` y `pull_request` bastan. Opcionalmente, `Create` y
`Delete` cubren una rama creada o borrada desde la web de GitHub sin push. Son
eventos, no permisos: añadirlos no obliga a nadie a reinstalar.

**A mano.** Una PR que no nombra la tarea ni sale de su rama se enlaza pegando
su URL en el panel («Enlazar una PR»), o con `link_pull_request` del MCP. El
repo tiene que ser de la org de la tarea —uno que su App ve—: pegar la URL de
un repo ajeno no sirve para leerlo con el token de otra. Queda con `via:
manual` y una línea `PR #9 linked: …` en el hilo.

**API.**
- `GET /api/v1/tasks/{id}/git` (también va dentro del detalle de la tarea, campo
  `git`, que es lo que lee `get_task` del MCP).
- `POST /api/v1/tasks/{id}/git/prs` con `{url}`: miembro de la org de la tarea
  (un lector no; 404 a quien no es de la org). Con un token, `tasks:write`.
  Errores: `not-a-pull-url` (400), `repo-not-in-org` (422), `pr-not-found` (502),
  `github-off` (503).
- Evento `task:git` cuando cambia algo.

## 5. Lo que la App escribe en GitHub

Por servicio, en su diálogo de deploy → «Aviso del CI»: el **repo de GitHub**
(`owner/repo`) y, si se quiere, el **workflow que publica la imagen**
(`prod.yml`). El repo tiene que ser uno de los que ve la instalación de la org.

- **Cada deploy es un Deployment de GitHub** del commit desplegado, en el
  entorno del servicio, y sigue su estado: `in_progress` cuando el agente lo
  recoge, `success` o `failure` al acabar. Uno que caduca porque el agente dejó
  de contestar acaba en `failure`, no se queda «en curso» para siempre. Se ve
  en la pestaña Environments del repo.
- **Un deploy que sale bien avisa a las tareas que trae**: las que nombran los
  commits de entre lo que había y lo nuevo (como mucho 50) reciben
  `` deploy `abc1234` → prod · api ``. Interna y una vez por deploy.
- **El workflow que publica la imagen, cuando acaba bien, cuenta como el aviso
  del CI** (el del `curl` de [deploys.md](deploys.md)): apunta el build y, en
  modo Desplegar, lo despliega. Otro workflow del repo, o ése fallado, no
  cuenta. Con esto el paso del `curl` sobra.

**Tags cortos.** GitHub avisa siempre con el sha entero. Si el CI etiqueta la
imagen con el corto (`git rev-parse --short=7`, como RRHH), el servicio lo
lleva marcado (`shortTags`; la app lo deduce de la imagen que corre al
registrarlo o al guardar su repo) y cac apunta y despliega el tag corto. En
GitHub el Deployment va con el sha entero, que cac resuelve.

Nada de esto frena un deploy: lo que se cuenta a GitHub va aparte, y si GitHub
no contesta, el deploy sigue igual.

## 6. La actividad: todos los runs, no sólo el que publica

Desde la R9 (4-oct-2026), **cada `workflow_run` de un repo de la org** queda
apuntado en cac, venga del workflow que venga y acabe como acabe: quién lo
disparó, en qué rama, de qué commit, cómo va y cómo terminó. Un repo que la
instalación deja ver pero que ninguna org ha atado no apunta nada.

- GitHub manda tres webhooks por intento (`requested`, `in_progress`,
  `completed`) y los tres actualizan **la misma fila**. Un re-run es otra fila
  (mismo id de run, otro intento). Si una entrega llega tarde, no deshace una
  posterior: un `in_progress` rezagado nunca vuelve a poner «en curso» un run
  que ya terminó.
- Se ve en **Actividad** (`/activity`), mezclado por tiempo con los deploys de
  cac. Filtros: `?repo=owner/repo` y `?deployable=<id>` (los runs del repo del
  servicio que son de su workflow de build, o todos los del repo si no tiene
  workflow puesto; y sus deploys). Un run enseña los deploys que disparó, y un
  deploy, de qué run viene.
- **Suena en la campana al terminar**, a toda la org, plegado por repo
  («dwit/api (4)»), con el interruptor «CI y deploys». Y cada deploy que acaba
  —bien, mal o caducado— también, a todos menos a quien lo pidió. Ver
  [`notifications.md`](../notifications.md).
- No hay mapa entre el login de GitHub y el usuario de cac: a quien hizo el
  push le llega el aviso de su propio CI.

La API: `GET /api/v1/organizations/{id}/activity?repo=&deployableId=&limit=&before=&beforeId=`
(cualquiera de la org). Paginación por cursor: `before` es el `at` de la última
entrada vista (RFC 3339) y `beforeId` su id; `hasMore` dice si queda más.

Eventos y permisos de la App **no cambian**: `Workflow run` y `Actions: read`
ya estaban desde la sección 1.

## 7. Los .md del repo, en Documentación (docs as code)

Un repo atado a un espacio enseña en Documentación **todos sus ficheros
markdown**, bajo ese espacio y por carpetas, como hace Confluence con un repo.
Son de **sólo lectura**: el repo es la fuente, y se editan allí, con una PR.

- **Qué entra:** `.md` y `.markdown`, salvo los que estén en una carpeta que
  empiece por punto (`.github` incluida: sus plantillas son formularios, no
  documentación) o en `node_modules`, `vendor`, `dist`, `build` o `target`.
  Como mucho 1000 ficheros por repo.
- **Qué no entra, desde el repo:** un `.cacignore` en la raíz, con la sintaxis
  de `.gitignore` (`#`, `!`, `/` al final para carpetas, `/` para anclar, `*`,
  `?`, `**`). Una diferencia: manda la última regla que case, también bajo una
  carpeta ignorada, así que `docs/` y luego `!docs/guia.md` deja la guía.
  Cambiarlo surte efecto en el siguiente push.

  ```gitignore
  CHANGELOG.md
  packages/**/README.md
  /drafts
  ```
- **De qué rama:** la rama por defecto del repo. Un push a otra rama no los
  toca.
- **Cuándo se ponen al día:**
  - al atar el repo a un espacio, o al encender sus docs, se copian enteros;
  - con cada push a la rama por defecto, cac pide el árbol del repo y baja
    sólo los ficheros cuyo sha cambió (si el árbol es el mismo, no baja nada);
  - con el botón «Sincronizar» de la org
    (`POST /api/v1/organizations/{id}/github/repos/{repoId}/docs/sync`), por si
    se perdió un webhook.
- **Quién lo cambió:** cada fichero guarda el último commit que lo tocó (autor,
  fecha, mensaje), sacado del propio webhook de push, que trae los ficheros de
  cada commit. No cuesta ni una petición a GitHub. Por eso la copia inicial no
  lo sabe: se sabe desde el primer push que toque cada fichero.
- **En vivo:** cuando un push cambia algún `.md`, el backend publica
  `repo-docs:changed` a la org, y la app vuelve a pedir sólo lo de ese repo:
  el panel, el fichero abierto y los includes que lo citan.
- **Si GitHub corta el árbol** (repos enormes) o hay más de 1000, el repo queda
  `truncated`: se guarda lo que cupo y no se borra nada.
- **Apagar los docs** del repo (`showDocs: false` en su PATCH) o desatarlo
  borra la copia.

Las rutas de lectura, para cualquiera de la org del espacio:

| Ruta | Qué da |
|---|---|
| `GET /api/v1/repo-docs?spaceId=` | los repos del espacio con sus ficheros (sin cuerpo) |
| `GET /api/v1/repo-docs/{id}` | un fichero, con su cuerpo y su URL en GitHub |
| `GET /api/v1/repo-docs/lookup?orgId=&repo=owner/name&path=` | el fichero que nombra una URL de GitHub (`…/blob/<rama>/<ruta>`), sólo de un repo de esa org |
| `GET /api/v1/repo-docs/raw/{repoId}?path=` | una imagen del repo, para un repo privado; **sólo imágenes** (png, jpg, gif, webp, svg) y nunca con `..` |

**En la app:**
- **Los enlaces** de un `.md` se resuelven contra su ruta, como en GitHub: un
  `../deploy.md` que está copiado se abre en cac; cualquier otra ruta relativa
  va a su página en GitHub. Las imágenes relativas se piden a cac.
- **La URL de GitHub de un `.md`** pegada en cualquier sitio de cac (un doc, el
  chat) se abre en cac si está copiado, y si no, en GitHub.
- **El «include» de Confluence:** pegada **sola en su línea** de un documento o
  de una página, esa URL se ve con el contenido del fichero debajo, al día con
  el repo. El markdown guardado sigue siendo la URL, así que en GitHub, en el
  editor y por MCP se lee un enlace corriente.

Los permisos de la App **no cambian**: `Contents: read` ya estaba desde la
sección 1, y el evento `Push` también.
