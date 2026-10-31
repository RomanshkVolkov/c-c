# Atajos para correr infra/ansible desde la terminal. La app corre lo mismo
# desde la pestaña Provisioning del servidor.
#
#   make setup                     # .venv + Ansible + collections (una vez)
#   make plan     SERVER=gstd P=swarm   # qué se correría y qué falta en cac
#   make test     SERVER=gstd      # ping
#   make baseline SERVER=gstd      # etapa 1: usuario, SSH, firewall
#   make swarm    SERVER=gstd      # etapa 2: Swarm + Traefik
#   make swarm-verify / swarm-down / k8s / k8s-verify / k8s-down  SERVER=…
#
# Todo pasa por `cac provision`, el mismo binario de la app: lee la config del
# servidor de cac (dominio, puertos, versiones y DÓNDE está cada secreto en
# 1Password), genera el inventario, lee los secretos con `op` y apunta la
# ejecución en cac. Necesita CAC_TOKEN (un token personal con servers:manage) y
# 1Password desbloqueado. Ningún valor pasa por aquí.

VENV     := .venv
GALAXY   := $(VENV)/bin/ansible-galaxy
PLAYBOOK := $(VENV)/bin/ansible-playbook
# El binario de la app (`cac`); en un AppImage, su ruta.
CAC      ?= cac
SERVER   ?=
P        ?=

need_server = $(if $(SERVER),,$(error falta SERVER=<nombre o id del servidor en cac>))
provision   = $(call need_server)$(CAC) provision run --server '$(SERVER)' --playbook $(1) --folder .

.DEFAULT_GOAL := help
.PHONY: help setup syntax plan test baseline swarm swarm-verify swarm-down k8s k8s-verify k8s-down

help: ## Esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}'

setup: ## Crea el .venv e instala Ansible y las collections
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install --quiet --upgrade pip
	$(VENV)/bin/pip install --quiet "ansible-core>=2.20,<2.21" passlib
	$(GALAXY) collection install -r requirements.yml -p ./collections

# Con un inventario de mentira: el de verdad lo genera cac al correr, y
# ansible.cfg sólo deja el plugin yaml (que lee .json).
syntax: ## --syntax-check de todos los playbooks
	@inv=$$(mktemp --suffix=.json); \
	echo '{"all":{"hosts":{"x":{}},"children":{"swarm":{"hosts":{"x":{}}},"k8s_control_plane":{"hosts":{"x":{}}}}}}' > $$inv; \
	for p in playbooks/*.yml; do $(PLAYBOOK) -i $$inv --syntax-check $$p >/dev/null || { rm -f $$inv; exit 1; }; done; \
	rm -f $$inv; echo "sintaxis ok"

plan: ## Qué se correría con la config de cac, y qué le falta (P=<playbook>)
	$(call need_server)$(CAC) provision plan --server '$(SERVER)' --playbook $(or $(P),$(error falta P=<playbook>)) --folder .

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
