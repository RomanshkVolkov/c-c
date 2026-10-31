# Atajos para correr infra/ansible desde la terminal. La app corre lo mismo
# desde la pestaña Provisioning (cac.playbooks.yml).
#
#   make setup            # .venv + Ansible + collections (una vez)
#   make test             # ping a todos
#   make swarm            # Swarm + Traefik (lee el token con `op run`)
#   make swarm-verify / swarm-down / k8s / k8s-verify / k8s-down
#
# LIMIT=gstd limita los hosts.

VENV     := .venv
PLAYBOOK := $(VENV)/bin/ansible-playbook
GALAXY   := $(VENV)/bin/ansible-galaxy
LIMIT    ?=
LIMITARG := $(if $(LIMIT),--limit=$(LIMIT),)
# Los secretos llegan como variables de entorno sólo a este proceso; `op run`
# además tacha sus valores de la salida.
WITH_SECRETS := op run --env-file=secrets.env --

.DEFAULT_GOAL := help
.PHONY: help setup syntax test swarm swarm-verify swarm-down k8s k8s-verify k8s-down

help: ## Esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}'

setup: ## Crea el .venv e instala Ansible y las collections
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install --quiet --upgrade pip
	$(VENV)/bin/pip install --quiet "ansible-core>=2.20,<2.21"
	$(GALAXY) collection install -r requirements.yml -p ./collections

syntax: ## --syntax-check de todos los playbooks
	@for p in playbooks/*.yml; do $(PLAYBOOK) --syntax-check $$p || exit 1; done

test: ## Probar conexión
	$(PLAYBOOK) playbooks/test.yml $(LIMITARG)

swarm: ## Swarm + Traefik + whoami
	$(WITH_SECRETS) $(PLAYBOOK) playbooks/swarm-site.yml $(LIMITARG)

swarm-verify: ## Verificar Swarm
	$(PLAYBOOK) playbooks/swarm-verify.yml $(LIMITARG)

swarm-down: ## Desmontar Swarm y Docker (destructivo)
	$(PLAYBOOK) playbooks/swarm-teardown.yml $(LIMITARG)

k8s: ## Kubernetes con kubeadm como pixel-vps
	$(WITH_SECRETS) $(PLAYBOOK) playbooks/k8s-site.yml $(LIMITARG)

k8s-verify: ## Verificar Kubernetes
	$(PLAYBOOK) playbooks/k8s-verify.yml $(LIMITARG)

k8s-down: ## Desmontar Kubernetes (destructivo)
	$(PLAYBOOK) playbooks/k8s-teardown.yml $(LIMITARG)
