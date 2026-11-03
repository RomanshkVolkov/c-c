# Configurar un servidor desde cac: plantillas, versiones y secretos por referencia

Cómo se deja configurado un servidor —qué se le monta, con qué valores y de
dónde salen sus credenciales— sin que esa configuración viva en la carpeta de
quien lo aprovisiona. Decidido el 31-oct-2026; el diseño entero está en cac, en
la página «Diseño · Config de servidores en cac» del espacio Command and
control.

> Contrato estable. Si algo de aquí no coincide con el comportamiento real, es
> un bug del documento o del código.

---

## 1. Quién tiene qué

| Dónde | Qué |
|---|---|
| El repo de Ansible (`infra/ansible` en el monorepo) | El **cómo**: playbooks, roles y, en `cac.playbooks.yml`, el esquema de las variables que pide cada playbook. |
| cac, en la base | El **qué**: las plantillas de la organización y la configuración versionada de cada servidor, con sus defaults. |
| 1Password | Los **valores** de los secretos. Nunca salen de ahí salvo en la máquina de quien aplica, al aplicar. |

## 2. Las piezas

- **Plantilla de servidor** (de una organización, versionada): una lista
  **ordenada** de playbooks del manifiesto —«Swarm con Traefik y Valkey» es
  `[baseline, swarm, valkey]`—, las variables que comparten (versiones,
  imágenes, CIDRs, el email de ACME…), los **nombres** de los secretos que un
  servidor con ella tiene que traer (`requires`) y cuáles de ésos son de cada
  máquina (`perServer`: la contraseña de sudo de un servidor no es la de otro).
- **Config de un servidor** (versionada): la plantilla clavada a una versión,
  las variables propias del servidor (dominio, puerto SSH, llaves autorizadas,
  y lo que pise de la plantilla) y sus secretos como `NOMBRE → op://bóveda/ítem/campo`.
  Guardar crea una versión nueva y nunca pisa la anterior; restaurar es guardar
  una vieja como nueva.
- **La efectiva**: la plantilla con lo del servidor encima, más cómo se entra
  (host, puerto y usuario del registro del servidor), y qué secretos de
  `requires` faltan todavía. La calcula el backend para que la app, el MCP y la
  terminal vean lo mismo.
- **Lo aplicado**: cada ejecución de un playbook lanzada con una versión de la
  config guarda esa versión y una foto de la efectiva (variables y
  referencias). Cambiar la config después no la toca: se puede leer con qué se
  configuró de verdad una máquina.

**Basar un servidor en otro** copia su última config —plantilla, variables y
referencias— menos las `perServer`, y la versión nueva dice de dónde salió.
Sólo entre servidores de la misma organización.

## 3. Los secretos, sólo por referencia

Es el principio, y está construido para que no se pueda romper sin que se note:

- Ningún tipo tiene un campo donde guardar un valor
  (`TestNoSecretTypeCarriesAValue`, `TestProvisioningCarriesNoValues`).
- Una referencia que no es `op://…` ni `op-env://…` se rechaza (`bad-op-ref`):
  casi seguro es el secreto pegado.
- Un secreto disfrazado de variable se rechaza (`secret-in-vars`): por el
  nombre —uno de los `requires` de la plantilla, o uno que termina en
  `_password`, `_token`, `_secret`…— o por la forma, un valor que es una
  referencia.
- Las peticiones son estrictas: un campo que no existe (un `secrets`, un
  `values`) da 400 en vez de descartarse.

## 4. Las rutas

| Método y ruta | Quién | Qué |
|---|---|---|
| `GET /api/v1/servers/{id}/config` | viewer | La actual y la lista de versiones |
| `GET /api/v1/servers/{id}/config/versions/{seq}` | viewer | Una versión |
| `GET /api/v1/servers/{id}/config/effective[?seq=N]` | viewer | La efectiva, de la actual o de la N |
| `PUT /api/v1/servers/{id}/config` | admin | Guarda una versión nueva (`basedOnServerId` para copiar de otro) |
| `GET /api/v1/organizations/{id}/server-templates` | viewer | Las plantillas, cada una con su última versión |
| `POST /api/v1/organizations/{id}/server-templates` | admin | Crea una plantilla con su versión 1 |
| `GET /api/v1/organizations/{id}/server-templates/{tplId}` | viewer | Una plantilla con todas sus versiones |
| `PUT /api/v1/organizations/{id}/server-templates/{tplId}` | admin | Guarda una versión nueva |
| `POST /api/v1/servers/{id}/provisioning-runs` | member | Abre una ejecución; con `configSeq`, guarda lo aplicado. Con un token, sólo con `requestId` de una petición autorizada |
| `GET /api/v1/servers/{id}/provisioning-requests[/{rqid}]` | viewer | Las peticiones de ejecución, o una |
| `POST /api/v1/servers/{id}/provisioning-requests` | member | Pide aplicar un playbook (`risk`, `verify`, `rollback`, `configSeq`, `reason`) |
| `PUT /api/v1/servers/{id}/provisioning-requests/{rqid}/check` | member | El ensayo, una vez; cac lo evalúa |
| `POST /api/v1/servers/{id}/provisioning-requests/{rqid}/decision` | admin, **en persona** | Aprobar o rechazar. Ningún token llega |

## 5. Con un agente (MCP)

Un token con el permiso **`servers:manage`** («Configurar servidores» en
Connect Claude Code) guarda configs y plantillas:

| Herramienta | Qué hace |
|---|---|
| `get_server_config` | La versión actual (o la `seq`), la efectiva y la lista de versiones |
| `set_server_config` | Guarda una versión nueva; por defecto combina con la actual por clave |
| `list_server_templates` / `get_server_template` | Las plantillas de la org, y una con sus versiones |
| `set_server_template` | Crea una plantilla, o guarda una versión nueva de una |
| `list_provisioning_runs` | Lo que se le aplicó a un servidor, con la foto de cada ejecución |

**Lo que no hace, a propósito:** aplicar. Un agente **pide**
(`request_provisioning`) y lee cómo va (`get_provisioning_request`); la
ejecución corre en la terminal de una persona, con su 1Password, y sólo con
una autorización. Tampoco cambia cómo se entra al servidor (host, usuario,
puerto), que es la ficha del servidor, ni toca ningún valor de un secreto.

## 6. Pedir una ejecución: el protocolo

Decisión 4d28f4ab (jose, 31-oct-2026), que sustituye a «un token configura, una
persona aplica». **Se sigue siempre, también en un servidor de pruebas**: allí
es un simulacro, y no se relaja nada.

Cada playbook del manifiesto declara su `risk` —`read` (no cambia nada),
`change` o `destructive`— y los que cambian nombran su `verify` (un playbook de
lectura) y su `rollback` (otro playbook, o `manual`).

| Paso | Quién | Qué |
|---|---|---|
| 1 · Ensayo | quien pide (`cac provision request`, `request_provisioning` o «Ensayar» en la app) | `--check --diff` en su máquina; la salida, tachada |
| 2 · Evaluación | cac | Banderas: un host que no es uno, una lectura que cambiaría algo, tocar SSH o el firewall fuera de `baseline`, un ensayo fallido, lo destructivo |
| 3 · Aprobación | una persona en la app | Ve el ensayo y las banderas. Una roja se reconoce a propósito; lo destructivo se confirma escribiendo el nombre del servidor |
| 4 · Ejecución | `cac provision run --grant`, o «Correr ahora» en la bandeja de la app | Autorización de un solo uso, 15 minutos, atada a playbook + servidor + versión de la config |
| 5 · Verificación | el mismo `run` (o la app, después de correr) | Corre su `verify`; si falla, propone el `rollback` como otra petición (nunca corre solo) y avisa |
| 6 · Registro | cac | Cada paso con quién y cuándo, en la petición y en las ejecuciones |

**Sólo una lectura con un ensayo limpio va pre-autorizada.** Ninguna
configuración ni ningún token cambia eso. Si aun así una ejecución autorizada
como lectura cambia algo, su recap la delata al cerrar y la petición queda
`violated`.

**Una ejecución que no llega a arrancar Ansible no gasta la autorización.**
Si la app o la CLI mueren antes de lanzar `ansible-playbook` (1Password no
contestó, el venv, el inventario), el servidor no se tocó: cierran la
ejecución con `notStarted` y cac devuelve la petición a `approved` con la
misma autorización (o la deja «verificando» si era la verificación), para
correrla otra vez sin ensayar ni aprobar de nuevo. Antes, un rechazo de
1Password en el primer segundo obligaba a rehacer todo (jose, 3-nov-2026). Y
`op read` insiste tres veces, con dos segundos entre medias, cuando 1Password
rechaza la conexión: suele contestar a la segunda. Lo vigilan
`handler.TestARunThatNeverStartedKeepsTheGrant`,
`provision_cli::tests::a_run_that_never_started_says_so`,
`op_retry_tests::a_refused_1password_is_asked_again_but_nothing_else_is` y
`ServerProvision.test.tsx` («una que muere antes de arrancar Ansible»).

**En la app también.** Con un manifiesto v2, «Aplicar» ya no aplica: ensaya y
deja la petición, igual que un agente. Una persona no se salta el protocolo
por estar en persona; sólo la aprobación tiene que ser suya. (Un manifiesto
v1, sin `risk`, sigue aplicando directo con su confirmación.)

Lo vigilan `handler.TestAnAgentAsksAndOnlyAPersonApproves` (y sus hermanas en
`provisioning_request_test.go`), `domain.TestOnlyACleanReadIsPreAuthorized`,
`middleware.TestATokenConfiguresButNeverDeploys` (decidir no se abre a un
token) y, en la app, `provision_cli::tests::a_request_only_ever_dry_runs`,
`ansible::tests::the_app_rehearses_through_the_check_parameter`, `ServerConfig.test.tsx` («aplicar es ensayar y pedir») y
`mcp::tests::the_server_config_tools_configure_but_never_apply`.
