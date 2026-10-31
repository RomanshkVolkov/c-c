# infra/ansible — lo que cac sabe aprovisionar

Playbooks para dejar un servidor listo desde cero, en dos sabores:

- **Swarm + Traefik**: lo que cac ya sabe desplegar (agente `swarm-manage`).
- **Kubernetes con kubeadm**, replicando pixel-vps: containerd, Cilium, MetalLB,
  Envoy Gateway y cert-manager (CNPG con `install_cnpg: true`).

Los dos emiten un certificado wildcard `*.<base_domain>` por reto DNS en
Cloudflare, y dejan un `whoami.<base_domain>` como prueba de humo. Se corren
desde la terminal o desde la pestaña **Provisioning** del servidor en la app,
que lee `cac.playbooks.yml`. El primer servidor es `gstd` (VPS de pruebas).

## Desde la terminal

```sh
make setup          # .venv con ansible-core y las collections (una vez)
make test           # ping a todos
make swarm          # Swarm + Traefik + whoami
make swarm-verify   # nodo, servicios y whoami por HTTPS con cert válido
make swarm-down     # DESTRUCTIVO: quita los stacks, el Swarm y Docker
make k8s            # Kubernetes (después de swarm-down)
make k8s-verify
make k8s-down       # DESTRUCTIVO
```

`LIMIT=gstd` limita los hosts. Para aplicar sólo una parte del Swarm:
`.venv/bin/ansible-playbook playbooks/swarm-site.yml --tags docker,swarm`.

Los que necesitan el token (`swarm`, `k8s`) lo leen con `op run` de
`secrets.env`, que guarda **referencias** de 1Password, no valores. 1Password
tiene que estar desbloqueado.

## Desde la app

Servidores → el servidor → **Provisioning** → carpeta: esta (`infra/ansible`).
La app usa el `.venv` de aquí (corre `make setup` antes), lee de 1Password lo
que el manifiesto marca con `from: op://…`, lo pasa en un fichero `0600` y lo
tacha de la salida. A cac sólo le llegan nombres y el PLAY RECAP.

`secrets.env` y `cac.playbooks.yml` tienen que nombrar las mismas referencias:
lo comprueba `ansible::tests::the_infra_ansible_manifest_is_one_the_app_can_run`
(`app/src-tauri/src/ansible.rs`), junto con que cada playbook exista.

## Lo que pide de fuera

| Qué | Dónde |
|---|---|
| Alias SSH del servidor (`ansible_host` en `inventory/hosts.yml`) | `~/.ssh/config` de quien lo corre |
| Token de Cloudflare con Zone → DNS → Edit y Zone → Zone → Read **sólo** sobre la zona | 1Password, `op://Private/cloudflare guz-studio.dev dns/credential` |
| `deploy_public_key` (opcional): crea `infra_devops` con esa llave | variable extra |

## Un servidor nuevo

1. Su alias en `~/.ssh/config` y una entrada en `inventory/hosts.yml`, en el
   grupo `swarm` o `k8s_control_plane`.
2. `inventory/host_vars/<nombre>.yml` con `public_ip`, `dns_zone` y `base_domain`.
3. `make test`, y después el sabor que toque.

## Lo que hay que saber

- **Los puertos que publica Docker se saltan ufw**: sus reglas de iptables van
  antes. El firewall del rol `base` protege el host, no lo que expone un stack.
- **Swarm y Kubernetes no conviven** en la misma máquina: los dos quieren el
  80/443 y su propio containerd. Se pasa de uno a otro con el teardown.
- **El 6443 no se abre**: el clúster se opera con `kubectl` en el servidor, por
  SSH, como pixel-vps.
- **Versiones de Kubernetes y addons = las de pixel-vps** (`group_vars/all.yml`),
  para ensayar aquí sus upgrades antes que en producción. Diferencia a
  propósito: el pool de pods es `10.244.0.0/16`; el de pixel-vps (`10.0.0.0/8`,
  el de Cilium por defecto) se solapa con la red de Services.
- **Los secrets de Swarm llevan su versión en el nombre** (HMAC del valor con
  una clave que sólo vive en el servidor, `/etc/cac/secret-hmac.key`): rotar el
  token es cambiarlo en 1Password y volver a correr `make swarm`.
