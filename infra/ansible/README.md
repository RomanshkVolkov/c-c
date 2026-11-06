# infra/ansible — lo que cac sabe aprovisionar

Playbooks para dejar un servidor listo desde cero, por etapas:

1. **Configuración básica** (`server-baseline`): usuario de operación
   (`infra_devops`) con sus llaves y sudo con contraseña; SSH sólo por llave,
   sin root y en otro puerto (`ssh_port`); ufw con sólo ese puerto, y fail2ban.
   Si el SSH nuevo no contesta después del cambio, se deshace solo.
2. **Lo que corre encima**, uno de dos:
   - **Swarm + Traefik**: lo que cac ya sabe desplegar (agente `swarm-manage`).
   - **Kubernetes con kubeadm**, replicando pixel-vps: containerd, Cilium,
     MetalLB, Envoy Gateway, cert-manager, `local-path` y metrics-server.
3. **Lo que trae secretos propios**, cada uno su playbook encima de k8s:
   **Postgres con CloudNativePG** (`cnpg`: operador + plugin barman-cloud, un
   clúster `postgres` de una instancia en `data`, WAL archivado y backup
   diario a S3; ver `infra/terraform/cnpg-backups`) y **Valkey** (`valkey`:
   el bus de cac-service, imagen oficial fijada por digest, contraseña desde
   1Password, AOF en un PVC, sin Sentinel) y el **runner de GitHub Actions**
   (`runner`: ARC con un scale set registrado por una GitHub App, un pod por
   job; la imagen y el uso están en `g-studio-labs/actions-runner`). Para la
   org de un cliente, **`runner-isolated`** encima de `runner`: su scale set en
   `arc-runners-<nombre>`, sin Docker privilegiado (modo kubernetes de ARC: un
   job con `container:`/`services:` es un pod sin privilegios), Pod Security
   `baseline`, una política de Cilium que sólo le deja salir a internet, al DNS
   y al API, y una cuota. Su verify lanza un pod que tiene que llegar a internet
   y no a Postgres, Valkey ni cac.

Los dos emiten un certificado wildcard `*.<base_domain>` por reto DNS en
Cloudflare, y dejan un `whoami.<base_domain>` como prueba de humo. En
Kubernetes, además, **un certificado por zona** (`certificates`: cada entrada
es su propio `Certificate` con `<d>` y `*.<d>`, todos en el listener https),
nunca uno compartido con una lista de hosts como el de pixel-vps: un dominio
nuevo de la zona no toca ningún certificado, y como DNS-01 no mira a dónde
apunta el DNS, el wildcard de una zona se emite **antes** de mudar un
servicio. `certificates` no crea registros DNS (eso es sólo `base_domain`).
Las rutas (`HTTPRoute`) entran desde cualquier namespace; `livekit_turn_host`
añade el listener TLS del TURN en el 443 y `firewall_udp_ports` abre lo UDP.

## El repo tiene el cómo; cac, el qué

Aquí sólo hay playbooks, roles y, en `cac.playbooks.yml`, lo que pide cada
playbook (sus variables, con defaults, y el **nombre** de cada secreto). La
config de cada servidor vive en cac, versionada: su plantilla (una secuencia
de estos playbooks, `[baseline, swarm]`), sus variables (`base_domain`,
`ssh_port`, `ops_authorized_keys`…) y **dónde** está cada secreto en
1Password (`OPS_PASSWORD → op://…`). No hay inventario ni referencias en el
repo: se genera un inventario de un solo host en cada ejecución. Ver
[docs/integrations/provisioning.md](../../docs/integrations/provisioning.md).

## Desde la app

Servidores → el servidor → **Provisioning**: su config (plantilla, variables,
secretos por referencia, versiones) y, con esta carpeta elegida, el botón de
cada playbook. La app usa el `.venv` de aquí (corre `make setup` antes), lee
los secretos de 1Password en Rust, los pasa en un fichero `0600` y los tacha de
la salida. A cac le llegan la versión de la config, lo aplicado (variables y
referencias) y el PLAY RECAP; nunca un valor.

## Desde la terminal

```sh
make setup                        # .venv con ansible-core y las collections (una vez)
make plan SERVER=gstd P=swarm     # qué se correría, y qué le falta a la config en cac
make test SERVER=gstd             # pide `test` (ping): lectura, va pre-autorizada si su ensayo sale limpio
make baseline SERVER=gstd         # pide la etapa 1
make swarm SERVER=gstd            # pide Swarm + Traefik + whoami
make swarm-verify SERVER=gstd     # pide la verificación: nodo, servicios, whoami por HTTPS
make swarm-down SERVER=gstd       # pide el desmontaje (DESTRUCTIVO)
make k8s SERVER=gstd              # pide Kubernetes (después de swarm-down)
make k8s-verify SERVER=gstd
make k8s-down SERVER=gstd         # DESTRUCTIVO
make run SERVER=gstd GRANT=<id>   # corre una petición autorizada, y después su verify
```

**gstd es producción desde el 5-nov-2026**: corre cac (página «gstd ·
Kubernetes de G Studio» en cac). Los ejemplos de arriba muestran la forma;
en gstd ya no se piden `swarm`, `swarm-down` ni `k8s-down`. Se piden `k8s`,
`cnpg`, `valkey`, `runner` y `cac-secrets` cuando cambia su config.

**Ningún atajo aplica nada: pide** (decisión 4d28f4ab). Cada uno abre una
petición en cac, corre el ensayo (`--check --diff`, que no cambia nada) y cac
lo evalúa: un solo host, nada que toque SSH o el firewall fuera de `baseline`.
Sólo una lectura (`risk: read`) con un ensayo limpio queda autorizada en el
acto; un `change` lo aprueba una persona en la app (Servidores → Provisioning →
Peticiones) y un `destructive`, además, escribiendo el nombre del servidor.
**También en un servidor de pruebas**: allí es un simulacro del mismo
protocolo. La autorización es de un solo uso, caduca a los 15 minutos y vale
sólo para ese playbook y esa versión de la config; `make run` la gasta, corre
el `verify` del playbook y, si falla, propone su `rollback` (que es otra
petición: no corre solo).

Todo pasa por `cac provision` (el binario de la app; `CAC=/ruta/al/AppImage`
si no está en el PATH): la misma receta que el botón. Necesita `CAC_TOKEN`, un
token personal con **`servers:manage`**, y 1Password desbloqueado, que pide la
huella para cada secreto: el último candado, que ninguna política quita.

## Un servidor nuevo

1. Registrarlo en cac (Servidores → nuevo) con su IP, `root` y el 22.
2. Su config: «basado en» otro servidor o en una plantilla, y lo propio
   (`base_domain`, `ssh_port`, `ops_authorized_keys`, `public_ip`). Su
   contraseña de sudo, generada en 1Password, como `OPS_PASSWORD`: no se copia
   al basarse en otro (`perServer`).
3. `make plan SERVER=<nombre> P=baseline` y, si no falta nada, `make baseline`
   (la primera vez entra como root por el 22); con la aprobación, `make run`.
4. En cac, cambiar el puerto y el usuario del servidor a `ssh_port` /
   `infra_devops`. Después, la etapa 2.

**La huella SSH.** El inventario generado usa la IP del servidor y Ansible
comprueba su huella: la primera vez, `ssh-keyscan -p <puerto> <IP> >>
~/.ssh/known_hosts` (lo corre quien aplica), o pon `ansible_host` en la config
con un alias de tu `~/.ssh/config`.

## Lo que hay que saber

- **El SSH tiene `limit` en ufw**: más de seis conexiones en 30 s desde la
  misma IP se rechazan («Connection refused») durante unos segundos. Ansible
  reutiliza una conexión (ControlPersist), pero una ráfaga de `ssh` a mano lo
  dispara. fail2ban es otra cosa: banea una hora tras cinco fallos de login.
- **Ubuntu 24.04 arranca sshd por socket** (`ssh.socket`), que ignora un
  `Port` nuevo hasta regenerarse. La etapa 1 lo apaga y deja el `ssh.service`
  de siempre.
- **La configuración de sshd va en `00-cac-hardening.conf`**: sshd se queda
  con el primer valor que lee, y `50-cloud-init.conf` deja
  `PasswordAuthentication yes`.

- **Los puertos que publica Docker se saltan ufw**: sus reglas de iptables van
  antes. El firewall del rol `base` protege el host, no lo que expone un stack.
- **Swarm y Kubernetes no conviven** en la misma máquina: los dos quieren el
  80/443 y su propio containerd. Se pasa de uno a otro con el teardown.
- **El 6443 no se abre**: el clúster se opera con `kubectl` en el servidor, por
  SSH, como pixel-vps.
- **El mismo menor de Kubernetes que pixel-vps (1.35) y los addons en su
  última versión** (los defaults de `k8s` en `cac.playbooks.yml`, que pasan a
  su plantilla). Una subida se ensaya en un servidor de pruebas antes que en
  gstd, que ya es producción. Cada addon soporta una lista cerrada de menores de k8s; la tabla
  vive en la prueba `ansible::tests::every_addon_supports_the_kubernetes_minor`
  y una versión fuera de ella no compila la app. Diferencias a propósito: el
  pool de pods es `10.244.0.0/16` (el de pixel-vps, `10.0.0.0/8`, se solapa con
  la red de Services); el usuario de operación tiene kubeconfig y opera sin
  sudo; hay `StorageClass` por defecto (`local-path`) y `metrics-server`.
- **Los secrets de Swarm llevan su versión en el nombre** (HMAC del valor con
  una clave que sólo vive en el servidor, `/etc/cac/secret-hmac.key`): rotar el
  token es cambiarlo en 1Password y volver a correr `make swarm SERVER=…`.
- **Subir Envoy Gateway no sube los CRD de Gateway API**: Helm instala los de
  un chart la primera vez y nunca más. Con los viejos, el controlador no vigila
  `TCPRoute` y el TURN de LiveKit no se engancha, sin ningún error (gstd,
  5-nov-2026). El rol aplica los del chart cuando no coinciden y reinicia el
  controlador, y `k8s-verify` lo comprueba
  (`ansible::tests::the_gateway_api_crds_follow_the_envoy_gateway_chart`).
- **Los UDP de LiveKit los abre `k8s`** (rol `base`, `firewall_udp_ports`), no
  `baseline`.
