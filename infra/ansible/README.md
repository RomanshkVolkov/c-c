# infra/ansible — lo que cac sabe aprovisionar

Playbooks para dejar un servidor listo desde cero, por etapas:

1. **Configuración básica** (`server-baseline`): usuario de operación
   (`infra_devops`) con sus llaves y sudo con contraseña; SSH sólo por llave,
   sin root y en otro puerto (`ssh_port`); ufw con sólo ese puerto, y fail2ban.
   Si el SSH nuevo no contesta después del cambio, se deshace solo.
2. **Lo que corre encima**, uno de dos:
   - **Swarm + Traefik**: lo que cac ya sabe desplegar (agente `swarm-manage`).
   - **Kubernetes con kubeadm**, replicando pixel-vps: containerd, Cilium,
     MetalLB, Envoy Gateway y cert-manager (CNPG con `install_cnpg: true`).

Los dos emiten un certificado wildcard `*.<base_domain>` por reto DNS en
Cloudflare, y dejan un `whoami.<base_domain>` como prueba de humo.

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
- **Versiones de Kubernetes y addons = las de pixel-vps** (los defaults de
  `k8s` en `cac.playbooks.yml`, que pasan a su plantilla),
  para ensayar aquí sus upgrades antes que en producción. Diferencia a
  propósito: el pool de pods es `10.244.0.0/16`; el de pixel-vps (`10.0.0.0/8`,
  el de Cilium por defecto) se solapa con la red de Services.
- **Los secrets de Swarm llevan su versión en el nombre** (HMAC del valor con
  una clave que sólo vive en el servidor, `/etc/cac/secret-hmac.key`): rotar el
  token es cambiarlo en 1Password y volver a correr `make swarm SERVER=…`.
