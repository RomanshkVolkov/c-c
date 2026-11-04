#!/usr/bin/env bash
# Despliega cac en el clúster donde corre (gstd), desde el runner `gstd`, con
# los secretos en el entorno: el workflow lo llama bajo
# `op run --environment <cac prod> -- backend/k8s/deploy.sh`, así que cada
# variable del Environment «cac prod» de 1Password llega aquí como variable de
# entorno y en ningún otro sitio (ni en GitHub ni en la línea de comandos).
#
# Lo que hace: los Secrets de cac en $NS (por stdin, construidos con jq desde
# $ENV: ningún valor pasa por argv), los manifiestos de backend/k8s en $NS, y
# un rollout que tiene que terminar.
#
# Lo que no hace: el namespace, los permisos del runner y los de clúster de
# cac-hub (0-rbac-cluster.yaml). Ésos los pone un admin (el playbook `runner`
# y un `kubectl apply` único): el runner no puede darse permisos a sí mismo.
set -euo pipefail

NS="${NS:-cac}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# Los mismos que lleva cac-secret en pixel-vps (backend.yml, job deploy).
CAC_SECRET_KEYS=(
  DATABASE_URL JWT_SECRET_ACCESS JWT_SECRET_REFRESH
  IMAGE_SERVICE_URL IMAGE_SERVICE_CERT_CN IMAGE_SERVICE_API_KEY
  REPORTS_MEDIA_BUCKET REPORTS_MEDIA_REGION REPORTS_MEDIA_ACCESS_KEY_ID REPORTS_MEDIA_SECRET_ACCESS_KEY
  BACKUPS_BUCKET BACKUPS_REGION BACKUPS_PREFIX BACKUPS_ACCESS_KEY_ID BACKUPS_SECRET_ACCESS_KEY
  EMAIL_REGION EMAIL_FROM EMAIL_CONFIGURATION_SET EMAIL_ACCESS_KEY_ID EMAIL_SECRET_ACCESS_KEY
  INGEST_KEY_SECRET REPORTS_KEK REPORT_TOKEN_SECRET
  LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET RECORDINGS_MUX_KEY
  GITHUB_APP_SLUG GITHUB_WEBHOOK_SECRET GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY
  VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
)
OTHER_KEYS=(VALKEY_ADDR VALKEY_PASSWORD RECORDINGS_MUX_ACCESS_KEY_ID RECORDINGS_MUX_SECRET_ACCESS_KEY)

# Sin una variable el backend arrancaría a medias (sin correo, sin backups) y
# nadie lo notaría: se para antes de tocar nada. Sólo se dicen los nombres.
missing=()
for k in "${CAC_SECRET_KEYS[@]}" "${OTHER_KEYS[@]}"; do
  [ -n "${!k:-}" ] || missing+=("$k")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "faltan en el Environment: ${missing[*]}" >&2
  exit 1
fi

kubectl get namespace "$NS" >/dev/null

# Un Secret desde $ENV. `--server-side` para que el valor no quede en claro en
# la anotación last-applied-configuration.
apply_secret() {
  jq -n "$@" | kubectl apply --server-side --force-conflicts -n "$NS" -f -
}

keys_json=$(printf '%s\n' "${CAC_SECRET_KEYS[@]}" | jq -R . | jq -s .)
apply_secret --argjson keys "$keys_json" '{
  apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: {name: "cac-secret"},
  stringData: ($ENV | with_entries(select(.key as $k | $keys | index($k))))
}'

# El bus de eventos compartido entre réplicas: el Valkey de `data`.
apply_secret '{
  apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: {name: "cac-valkey"},
  stringData: {VALKEY_ADDR: $ENV.VALKEY_ADDR, VALKEY_PASSWORD: $ENV.VALKEY_PASSWORD}
}'

# El que lee el propio LiveKit, en su formato «clave: secreto».
apply_secret '{
  apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: {name: "livekit-secret"},
  stringData: {LIVEKIT_KEYS: ($ENV.LIVEKIT_API_KEY + ": " + $ENV.LIVEKIT_API_SECRET)}
}'

# El del montador: sus llaves de AWS son de otro usuario de IAM, que lee las
# pistas y sube el montaje pero no borra nada.
apply_secret --arg url "http://cac-service.$NS.svc.cluster.local:8081" '{
  apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: {name: "recordings-mux-secret"},
  stringData: {
    CAC_INTERNAL_URL: $url,
    RECORDINGS_MUX_KEY: $ENV.RECORDINGS_MUX_KEY,
    RECORDINGS_BUCKET: $ENV.REPORTS_MEDIA_BUCKET,
    AWS_DEFAULT_REGION: $ENV.REPORTS_MEDIA_REGION,
    AWS_ACCESS_KEY_ID: $ENV.RECORDINGS_MUX_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: $ENV.RECORDINGS_MUX_SECRET_ACCESS_KEY
  }
}'

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
