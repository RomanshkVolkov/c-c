# Proposal — Platform hub: servers tipo Kubernetes como agregador de integraciones

**Status:** Diseño afinado (2026-07-24). Redefine el `ServerType: kubernetes` de
cac: en vez de gestionar k8s a mano (como el módulo Docker Swarm), un server k8s
es un **hub de plataforma/observabilidad** — un entorno que agrupa herramientas
(Grafana, pgAdmin, rutas del gateway…) con **acceso autenticado de un clic
brokerado por cac**.

## Contexto

- Hoy `ServerType` tiene `docker-swarm` (implementado: agente `swarm-manage` vía
  `docker.sock`) y `kubernetes` (**solo enum, sin nada detrás** — registrar un
  server así crea un record inservible porque las pantallas asumen swarm).
- No queremos reimplementar un gestor de k8s. Queremos la **puerta única y
  autenticada** a las herramientas del cluster.

### Cluster real de referencia (Dwit) — auditado 2026-07-24

- **Red/gateway:** Cilium + **Envoy Gateway (Gateway API, no Ingress)**. Las
  `HTTPRoute` son el mapa de hostnames públicos (~10: cac, pgadmin, traefik,
  image-service, teleton, pixel-*, api.guz-studio.dev…).
- **Datos:** **CNPG** (operador Postgres), **Valkey**, cert-manager, MetalLB.
- **Observabilidad:** no hay Grafana/Prometheus/Loki/ArgoCD.
- **Hallazgos del audit:** `image-service-gateway` está `PROGRAMMED=Unknown` sin
  address (ejemplo de lo que el hub debe resaltar). El pod de cac corre con el
  ServiceAccount `default` **sin RBAC** (hoy no puede leer nada del API server).

## La pieza que ordena todo el diseño

**cac-service ya corre DENTRO del cluster objetivo.** Consecuencias:

1. **Nada de SSH ni agentes para el cluster #1**: un ServiceAccount read-only le
   da al backend acceso al API server in-cluster (`rest.InClusterConfig()`).
2. **El proxy no expone nada nuevo**: el backend alcanza cualquier `ClusterIP`
   nativamente; el path de proxy queda detrás del TLS + JWT ya existentes de
   `cac.guz-studio.dev`. Las herramientas privadas ni siquiera necesitan
   HTTPRoute pública.
3. SSH/tunnel desde el desktop queda **solo** como modo futuro multi-cluster.

## Decisiones (antes abiertas — resueltas)

1. **¿cac configura el SSO de Grafana?** → **Sí, porque cac lo despliega.** Al
   nacer por Helm, cac controla `grafana.ini` desde el día cero: `auth.proxy`
   habilitado, confiando **solo** en peticiones que llegan por el proxy de cac
   con un header-secret compartido (generado y guardado cifrado). No hay
   problema de "pedir permiso a un Grafana ajeno". Para herramientas que no
   desplegamos (pgAdmin) **no** se intenta SSO en v1: tile + **credential
   vault** (usuario/clave cifrados, botón copiar).
2. **¿Auto-descubrir todas las HTTPRoutes o allowlist?** → **Todas.** Es
   read-only y ya está scopeado por org (el server k8s pertenece a una org;
   solo sus miembros lo ven). Curación = un botón "ocultar tile" persistido por
   server (lista de hidden), no una allowlist que haya que mantener a mano.
3. **¿Proxy en backend (B1) o desktop (B2)?** → **B1 en backend.** Al estar
   in-cluster no expone superficie nueva y los secretos jamás salen del backend.
   B2 (SSH port-forward desde el app) se pospone a multi-cluster.

## Arquitectura

### Acceso al cluster: `accessMode` en el server

```
servers                       // columna nueva
  access_mode  varchar        // 'in-cluster' (v1) | 'ssh' (futuro multi-cluster)
```

`in-cluster`: el backend usa su ServiceAccount. Solo puede haber un server así
por despliegue de cac (validado). `ssh` queda definido pero sin implementar.

### RBAC (manifest en `backend/k8s/`)

ServiceAccount `cac-hub` + ClusterRole **read-only** enlazado, con:
- core: `nodes`, `namespaces`, `pods`, `services`, `events`
- apps: `deployments`, `statefulsets`, `daemonsets`
- `gateway.networking.k8s.io`: `gateways`, `httproutes`
- `cert-manager.io`: `certificates`
- `postgresql.cnpg.io`: `clusters`, `backups`

El deployment de cac pasa a `serviceAccountName: cac-hub`. **Ningún verbo de
escritura** — el hub observa; el deploy de Grafana (Fase 3) se ejecuta desde el
desktop del admin (vía SSH, como hoy), no desde el backend.

### Backend (client-go, endpoints org-scoped como todo lo demás)

```
GET /api/v1/servers/{id}/k8s/overview    // nodes (estado/versión), workloads por ns
GET /api/v1/servers/{id}/k8s/routes      // gateways + httproutes + cert por hostname
GET /api/v1/servers/{id}/k8s/datastores  // clusters CNPG (fase/backups), valkey
```

Respuestas cacheadas ~15s en memoria (el hub no debe martillar el API server).
Autorización: mismo patrón del módulo servers (membership de la org, superadmin
bypass, viewer=read — aquí todo es read).

### Integraciones (Fase 2)

```
server_integrations
  id, server_id, org_id
  kind         varchar   // 'grafana' | 'pgadmin' | 'generic' | ...
  name, url    text      // url interna (ClusterIP/svc) o pública
  auth_method  varchar   // 'none' | 'proxy-header' | 'vault'
  secret       bytea     // AES-GCM (patrón KEK existente); nunca al frontend
  hidden       bool      // curación de tiles
```

CRUD org-admin/superadmin; tiles visibles según rol.

### Proxy autenticado (Fase 2)

`/api/v1/servers/{id}/integrations/{iid}/proxy/*`:
- Valida sesión cac. El webview no siempre puede mandar `Authorization` en
  assets/navegación → **cookie de sesión de proxy firmada HMAC de corta vida**,
  minted en el primer hit con `?token=` (reusa el patrón de las signed URLs del
  image proxy).
- Reenvía **solo** a la URL registrada en la integración (anti-SSRF: nada de
  URLs arbitrarias), inyectando la auth del lado servidor (p.ej.
  `X-WEBAUTH-USER: <username-cac>` + header-secret para Grafana).
- Subpath: solo para herramientas que soportan servirse bajo prefijo. Grafana sí
  (`serve_from_sub_path`, y lo configuramos nosotros). pgAdmin **no se proxea**
  en v1 (assets rompen bajo prefijo ajeno) → tile con link directo + vault.

### UI

`ServerManage` ramifica por `server.type`: `kubernetes` → página **Hub** con
tres bloques: **Tiles** (integraciones + rutas descubiertas, con estado y
ocultar), **Salud** (nodes/certs/CNPG/gateways, resaltando rojo lo roto),
**Datastores**. Swarm queda intacto.

## Fases

1. **F1 — leer y mostrar (cero despliegue):** columna `access_mode` + manifest
   RBAC + 3 endpoints read-only + página Hub con tiles de rutas y salud. Valor
   inmediato: el directorio de ~10 servicios + certs + el gateway roto visible.
2. **F2 — integraciones + proxy:** tabla `server_integrations`, CRUD, proxy
   autenticado con cookie firmada, vault de credenciales (pgAdmin/Traefik).
3. **F3 — configurador Grafana:** deploy Helm (desde el desktop admin, SSH) con
   `grafana.ini` pre-cableado (`auth.proxy` + header-secret + subpath),
   datasources (Prometheus si se instala, CNPG vía secret read-only, Valkey) y
   la integración creada automáticamente → "Open Grafana" abre ya logueado.
4. **F4 (futuro) — multi-cluster:** `access_mode: ssh` con tunnel desde el app.

## No-goals

- Gestión de k8s (apply/scale/delete). El hub **observa y enlaza**.
- Escritura desde el backend al cluster (el RBAC no tiene verbos de escritura).
- SSO para herramientas que cac no despliega (v1: vault, no SSO).
