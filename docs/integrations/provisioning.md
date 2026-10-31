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
| `POST /api/v1/servers/{id}/provisioning-runs` | member | Abre una ejecución; con `configSeq`, guarda lo aplicado |

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

**Lo que no hace, a propósito:** correr un playbook. Abrir una ejecución
(`provisioning-runs`) está fuera del alcance de cualquier token: un agente
configura, una persona aplica desde la app (o con su 1Password desde su
terminal). Lo vigila `middleware.TestATokenConfiguresButNeverDeploys`. Tampoco
cambia cómo se entra al servidor (host, usuario, puerto), que es la ficha del
servidor, ni toca ningún valor de un secreto.
