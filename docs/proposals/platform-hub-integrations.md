# Proposal — Platform hub: servers tipo Kubernetes como agregador de integraciones

**Status:** Borrador (2026-07-24). Redefine el `ServerType: kubernetes` de cac: en
vez de gestionar k8s a mano (como el módulo Docker Swarm actual), un server k8s es
un **hub de plataforma/observabilidad** — un entorno registrado que agrupa
herramientas (Grafana, pgAdmin, dashboards, rutas del gateway…) y da **acceso
autenticado de un clic brokerado por cac**.

## Contexto

- Hoy `ServerType` tiene `docker-swarm` (implementado: agente `swarm-manage` vía
  `docker.sock`, stats/services/logs) y `kubernetes` (**solo enum, sin nada
  detrás** — registrar un server así crea un record inservible porque las
  pantallas asumen swarm).
- No queremos reimplementar un "gestor de k8s". Queremos que un server k8s sea la
  **puerta única y autenticada** a las herramientas del cluster.

### Cluster real de referencia (Dwit) — auditado 2026-07-24
- **Red/gateway:** Cilium + **Envoy Gateway (Gateway API, no Ingress)**. Las
  `HTTPRoute` son el mapa de hostnames públicos.
- **Datos:** **CNPG** (operador Postgres), **Valkey** (Redis-compat), cert-manager
  (TLS de todos los hosts), MetalLB, azurefile CSI.
- **Servicios públicos ya expuestos (HTTPRoutes):** `cac.guz-studio.dev`,
  `pgadmin.guz-studio.dev` (**pgAdmin**), `traefik.guz-studio.dev`,
  `image-service.dwitmexico.com`, `teleton.dwitsites.com`, `pixel-*`,
  `api.guz-studio.dev`, etc. (~10).
- **Observabilidad:** **no hay** Grafana/Prometheus/Loki/ArgoCD.
- **Hallazgo:** `image-service-gateway` está `PROGRAMMED=Unknown` sin address —
  ejemplo exacto de lo que el hub debería resaltar.

## Objetivo

Que abrir un server k8s en cac muestre: (1) un **directorio de accesos** (cada
herramienta/hostname como tile con link autenticado brokerado por cac), (2) la
**salud del cluster** (nodes, workloads, certs, CNPG, estado de gateways/rutas),
y (3) la capacidad de **configurar/desplegar** piezas que faltan (Grafana).

## Modelo de datos

```
server_integrations
  id            uuid pk
  server_id     uuid fk → servers(id)   // el server tipo kubernetes
  org_id        uuid                    // denormalizado, reusa el scoping por org
  kind          varchar   // 'grafana' | 'pgadmin' | 'argocd' | 'k8s-dashboard' |
                          // 'traefik' | 'prometheus' | 'generic' | 'gateway-route'
  name          varchar
  url           text                    // hostname/endpoint de la herramienta
  auth_method   varchar   // 'none' | 'proxy-header' | 'jwt' | 'basic' | 'bearer'
  secret        bytea                   // AES-GCM (token/creds) — nunca al frontend
  created_at, updated_at
```

Además, parte del hub es **auto-descubierto** (no se persiste): rutas del Gateway
API y salud del cluster se leen en vivo vía SSH/kubectl.

## Fases

### Fase 1 (A+B) — directorio + salud, **cero despliegue**
Todo read-only vía el SSH que cac ya usa (agente/`ssh_run` del módulo swarm):
- **A. Directorio de rutas:** leer `gateways` + `httproutes` (Gateway API) →
  tile por hostname con **link** + estado (`programmed`, address, cert asociado).
  Resalta rutas/gateways rotos (p.ej. `image-service-gateway` sin address).
- **B. Salud del cluster:** nodes, workloads por namespace, **certificados de
  cert-manager (expiración)**, **clusters CNPG** (estado/backups), Valkey, estado
  de gateways. Un "k8s dashboard lite".

### Fase 2 (C) — configurador de Grafana (el grande)
Como no existe observabilidad, cac la **provisiona**:
- Desplegar Grafana + Prometheus (Helm vía SSH/kubectl).
- Cablear datasources: Prometheus, Loki (si se añade), el Postgres CNPG, Valkey.
- Configurar SSO (`auth.proxy` o `auth.jwt`) para el acceso brokerado.
- Provisioning opcional de dashboards/folders.

### Fase D (paralela) — tiles de herramientas existentes
`pgAdmin` y `Traefik` (ya tienen hostname) → tile + acceso brokerado (cac gestiona
su login). Cualquier web interna como `kind: generic`.

## Mecanismo de "link autenticado a través de cac" (decisión clave)

- **B1 — reverse-proxy en el backend de cac:** `/servers/{id}/integrations/{k}/proxy/*`
  valida el JWT de cac e inyecta la auth (p.ej. `X-WEBAUTH-USER` para Grafana
  `auth.proxy`) → la herramienta te loguea sola. Requiere que cac alcance por red
  a la herramienta (las de Dwit son **públicas con TLS**, así que sí) y configurar
  su SSO para confiar en cac.
- **B2 — broker desde el app (SSH tunnel):** el desktop hace port-forward al
  service in-cluster e inyecta auth localmente. Para lo **privado** (kubectl,
  CNPG, servicios sin ingress). Consistente con el módulo swarm.
- **B3 — redirect con token efímero:** cac mintea un token corto y redirige. Simple
  pero limitado para login full-UI.

**Recomendación:** **B1** para lo público (Grafana/pgAdmin/Traefik con `auth.proxy`),
**B2** para lo interno (kubectl/CNPG). Empezar por links directos + estado (Fase 1),
luego auth brokerada.

## Seguridad
- `server_integrations.secret` cifrado AES-GCM (reusa el patrón KEK existente);
  jamás al frontend.
- Scoping por org (reusa el trabajo de superadmin/roles): ver/gestionar
  integraciones sigue el rol del caller en la org del server.
- El proxy valida siempre el JWT de cac antes de brokear.

## No-goals (v1)
- Gestión completa de k8s (apply/scale/delete de workloads). El hub **enlaza y
  observa**, no reemplaza kubectl.
- Multi-cluster kubeconfig. Un server = un entorno alcanzable por SSH/red.

## Decisiones abiertas
- ¿cac puede configurar el SSO de Grafana (`auth.proxy`/JWT, requiere admin), o
  solo guardamos un token y lo inyectamos?
- Fase 1: ¿auto-descubrir TODAS las HTTPRoutes, o una allowlist curada por server?
- ¿El proxy B1 vive en el backend (en el cluster Dwit) o preferimos B2 (desktop)
  para no exponer un proxy con credenciales en el server compartido?
