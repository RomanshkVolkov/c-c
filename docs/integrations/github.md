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
| Permisos de repositorio | Metadata: read · Contents: read · Pull requests: read |
| Eventos | Push · Pull request (los de instalación llegan siempre) |
| Dónde se puede instalar | Any account |

Y en el repo de cac (Settings → Secrets and variables → Actions):

- variable `CAC_GITHUB_APP_SLUG`: el slug de la App, el de su URL pública
  (`github.com/apps/<slug>`);
- secret `CAC_GITHUB_WEBHOOK_SECRET`: el mismo secreto del webhook.

`backend.yml` los mete en `cac-secret` en el siguiente despliegue. Sin los dos,
todo lo de GitHub contesta `503 github-off` y la app lo dice en la pestaña.

La llave privada de la App **todavía no hace falta**: instalar, recibir los
webhooks y comentar sólo piden el slug y el secreto. Hará falta para escribir de
vuelta en GitHub (los Deployments), que es la R6.

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

## 3. Nombrar una tarea

En el mensaje de un commit, o en el título o el cuerpo de una PR:

| Escrito | Nombra |
|---|---|
| `cac#12` | la tarea 12 del espacio enlazado. Siempre. |
| `#12` | lo mismo, sólo si el repo tiene «#12 a secas» encendido. En GitHub `#12` es el issue o la PR 12 del propio repo, por eso viene apagado. |
| `acme-7` | el folio 7 del proyecto `acme`, como lo ve el cliente. |

Sólo se busca dentro de la org del repo, y el número, sólo en su espacio. Una
referencia que no resuelve se descarta sin más. Como mucho diez tareas por
texto y veinte commits por push.

## 4. Qué se escribe

- **Commit**: `` `abc1234` [primera línea](enlace) · @autor · owner/repo ``.
  Una vez por commit y tarea: el mismo commit en otro push (un merge, otra rama)
  no repite.
- **PR**: `PR #3 opened|merged|closed|reopened: [título](enlace) · @autor · owner/repo`.
  Etiquetas, revisiones y ediciones no se cuentan.

Una reentrega de GitHub no duplica nada.
