# Atajos para correr infra/ansible desde la terminal. La app corre lo mismo
# desde la pestaña Provisioning del servidor.
#
#   make setup                          # .venv + Ansible + collections (una vez)
#   make plan     SERVER=gstd P=swarm   # qué se correría y qué falta en cac
#   make test     SERVER=gstd           # pide `test` (y su ensayo)
#   make swarm    SERVER=gstd           # pide la etapa 2: Swarm + Traefik
#   make baseline / swarm-verify / swarm-down / k8s / k8s-verify / k8s-down / cnpg / cnpg-verify / valkey / valkey-verify / runner / runner-verify / cac-secrets / cac-secrets-verify  SERVER=…
#   make run      SERVER=gstd GRANT=<id> # corre una petición autorizada, y su verify
#
# Nada se aplica sin el protocolo (decisión 4d28f4ab): cada atajo **pide**,
# corre el ensayo (`--check --diff`, no cambia nada) y cac lo evalúa. Sólo una
# lectura limpia queda autorizada en el acto; lo demás lo aprueba una persona
# en la app, también en un servidor de pruebas. Con la autorización, `make run`.
#
# Todo pasa por `cac provision`, el mismo binario de la app: lee la config del
# servidor de cac, genera el inventario, lee los secretos con `op` y apunta
# todo en cac. Necesita CAC_TOKEN (un token personal con servers:manage) y
# 1Password desbloqueado. Ningún valor pasa por aquí.

VENV     := .venv
GALAXY   := $(VENV)/bin/ansible-galaxy
PLAYBOOK := $(VENV)/bin/ansible-playbook
# El binario de la app (`cac`); en un AppImage, su ruta.
CAC      ?= cac
SERVER   ?=
P        ?=
GRANT    ?=
REASON   ?=

need_server = $(if $(SERVER),,$(error falta SERVER=<nombre o id del servidor en cac>))
provision   = $(call need_server)$(CAC) provision request --server '$(SERVER)' --playbook $(1) --reason '$(REASON)' --folder .

.DEFAULT_GOAL := help
.PHONY: help setup syntax plan run test baseline swarm swarm-verify swarm-down k8s k8s-verify k8s-down cnpg cnpg-verify valkey valkey-verify runner runner-verify cac-secrets cac-secrets-verify

help: ## Esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}'

setup: ## Crea el .venv e instala Ansible y las collections
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install --quiet --upgrade pip
	$(VENV)/bin/pip install --quiet "ansible-core>=2.20,<2.21" passlib
	$(GALAXY) collection install -r requirements.yml -p ./collections --force

# Con un inventario de mentira: el de verdad lo genera cac al correr, y
# ansible.cfg sólo deja el plugin yaml (que lee .json).
syntax: ## --syntax-check de todos los playbooks
	@inv=$$(mktemp --suffix=.json); \
	echo '{"all":{"hosts":{"x":{}},"children":{"swarm":{"hosts":{"x":{}}},"k8s_control_plane":{"hosts":{"x":{}}}}}}' > $$inv; \
	for p in playbooks/*.yml; do $(PLAYBOOK) -i $$inv --syntax-check $$p >/dev/null || { rm -f $$inv; exit 1; }; done; \
	rm -f $$inv; echo "sintaxis ok"

plan: ## Qué se correría con la config de cac, y qué le falta (P=<playbook>)
	$(call need_server)$(CAC) provision plan --server '$(SERVER)' --playbook $(or $(P),$(error falta P=<playbook>)) --folder .

run: ## Corre una petición autorizada y su verify (GRANT=<id>)
	$(call need_server)$(CAC) provision run --server '$(SERVER)' --grant $(or $(GRANT),$(error falta GRANT=<id de la petición>)) --folder .

test: ## Probar conexión
	$(call provision,test)

baseline: ## Etapa 1: usuario de operación, SSH endurecido, firewall
	$(call provision,baseline)

swarm: ## Swarm + Traefik + whoami
	$(call provision,swarm)

swarm-verify: ## Verificar Swarm
	$(call provision,swarm-verify)

swarm-down: ## Desmontar Swarm y Docker (destructivo)
	$(call provision,swarm-teardown)

k8s: ## Kubernetes con kubeadm como pixel-vps
	$(call provision,k8s)

k8s-verify: ## Verificar Kubernetes
	$(call provision,k8s-verify)

k8s-down: ## Desmontar Kubernetes (destructivo)
	$(call provision,k8s-teardown)

cnpg: ## Postgres con CloudNativePG encima de k8s (backups a S3)
	$(call provision,cnpg)

cnpg-verify: ## Verificar Postgres
	$(call provision,cnpg-verify)

valkey: ## Valkey (el bus de cac-service) encima de k8s
	$(call provision,valkey)

valkey-verify: ## Verificar Valkey
	$(call provision,valkey-verify)

runner: ## Runner de GitHub Actions (ARC) encima de k8s
	$(call provision,runner)

runner-verify: ## Verificar el runner
	$(call provision,runner-verify)

cac-secrets: ## Los secretos de cac desde 1Password
	$(call provision,cac-secrets)

cac-secrets-verify: ## Verificar los secretos de cac
	$(call provision,cac-secrets-verify)
