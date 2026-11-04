#!/usr/bin/env bash
# Despliega cac en el clúster donde corre (gstd), desde el runner `gstd`: los
# manifiestos de backend/k8s en $NS y un rollout que tiene que terminar.
#
# Sin secretos: no los lee ni los escribe. Los pone el playbook `cac-secrets`
# de infra/ansible desde 1Password (ítem «cac prod»), pedido y aprobado en cac
# como cualquier cambio del servidor; GitHub y el runner no ven ninguno. Aquí
# sólo se comprueba que estén, para que un clúster sin ellos falle diciendo por
# qué en vez de dejar pods en CreateContainerConfigError.
#
# Tampoco el namespace, los permisos del runner ni los de clúster de cac-hub
# (0-rbac-cluster.yaml): ésos los pone un admin, porque el runner no puede
# darse permisos a sí mismo.
set -euo pipefail

NS="${NS:-cac}"
DIR="$(cd "$(dirname "$0")" && pwd)"

kubectl get namespace "$NS" >/dev/null
if ! kubectl -n "$NS" get secret cac-secret cac-valkey livekit-secret recordings-mux-secret -o name >/dev/null; then
  echo "faltan los Secrets de cac en $NS: pide el playbook cac-secrets en cac (Servidores → Provisioning)" >&2
  exit 1
fi

# Los manifiestos, sin 1-secrets.yaml (es un ejemplo vacío) ni
# 0-rbac-cluster.yaml (de clúster: lo aplica un admin).
for f in 0-rbac.yaml 2-deployment.yaml 3-service.yaml 4-http-route.yaml \
         5-livekit.yaml 6-livekit-route.yaml 7-livekit-egress.yaml; do
  kubectl apply --server-side --force-conflicts -n "$NS" -f "$DIR/$f"
done

# `:latest` no cambia de etiqueta: sin el restart el pod seguiría con la imagen
# vieja y los Secrets de antes. Y el rollout tiene que terminar: un pod nuevo
# que no arranca es un despliegue fallido, aunque los viejos sigan sirviendo.
kubectl -n "$NS" rollout restart deployment/cac-service
kubectl -n "$NS" rollout status deployment/cac-service --timeout=180s
