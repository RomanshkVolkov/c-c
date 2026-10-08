#!/usr/bin/env bash
# El relé TURN por el 443 (W3, 8-oct-2026): lo que hay que tocar del Gateway y
# del certificado compartidos, que **no viven en ningún repo** — se crearon a
# mano en el VPS y los usan otros proyectos.
#
# Por eso esto **parchea** (JSON patch, sólo añade) y nunca hace `apply` del
# objeto entero: la anotación `last-applied` de los dos ya no coincide con lo
# que hay vivo (`tools.guz-studio.dev` entró con un parche), y un `apply`
# borraría lo que otro añadió.
#
# Idempotente: si ya está, no lo vuelve a añadir. Se corre en el VPS:
#   ssh dwit_kb 'bash -s' < infra/k8s/turn-setup.sh
#
# Antes, a mano y por este orden (ver `docs/voz.md` §6 bis):
#   1. DNS: `turn.guz-studio.dev` → 154.53.49.30, **DNS-only** en Cloudflare.
#      Tiene que resolver antes del paso de abajo: el certificado se valida por
#      HTTP01, y si un nombre falla, cert-manager no emite el nuevo (el viejo
#      sigue valiendo, así que no rompe nada, pero tampoco avanza).
#   2. `sudo ufw allow 3478/udp` (TURN por UDP).
set -euo pipefail

HOST=turn.guz-studio.dev

# Se pregunta al DNS **público** y no al resolvedor del VPS: es lo que mira
# Let's Encrypt, y el del VPS guarda las respuestas negativas un buen rato (le
# pasó a este nombre el 8-oct). Y tiene que ser **la IP del Gateway**: con el
# proxy de Cloudflare puesto resolvería a Cloudflare, el reto HTTP01 iría por
# ahí, y TURN —que no es HTTP— no pasaría nunca.
GATEWAY_IP=$(kubectl get gateway gateway-api -n default -o jsonpath='{.status.addresses[0].value}')
publica=$(curl -fsS -H 'accept: application/dns-json' \
  "https://cloudflare-dns.com/dns-query?name=$HOST&type=A" \
  | python3 -c 'import json,sys; print(" ".join(a["data"] for a in json.load(sys.stdin).get("Answer",[]) if a.get("type")==1))')
if [ "$publica" != "$GATEWAY_IP" ]; then
  echo "✗ $HOST resuelve a «$publica» y tiene que ser $GATEWAY_IP (DNS-only, sin proxy)." >&2
  exit 1
fi

# 1. El nombre en el certificado compartido.
if kubectl get certificate traefik-cert -n default -o jsonpath='{.spec.dnsNames}' | grep -q "\"$HOST\""; then
  echo "· el certificado ya incluye $HOST"
else
  kubectl patch certificate traefik-cert -n default --type=json \
    -p "[{\"op\":\"add\",\"path\":\"/spec/dnsNames/-\",\"value\":\"$HOST\"}]"
  echo "→ esperando a que cert-manager emita el certificado con $HOST…"
  kubectl wait certificate traefik-cert -n default --for=condition=Ready --timeout=300s
fi
kubectl get secret secret-tls -n default -o jsonpath='{.data.tls\.crt}' | base64 -d \
  | openssl x509 -noout -ext subjectAltName | grep -q "$HOST" \
  || { echo "✗ el secreto todavía no lleva $HOST" >&2; exit 1; }

# 2. El listener del Gateway: TLS en el 443, sólo para ese nombre, terminado
#    por Envoy y hacia un TCPRoute. Comparte puerto con el `https` de los demás
#    dominios: Envoy Gateway pone HTTPS y TLS en el mismo «cubo» y sólo choca si
#    se repite hostname (leído en `validate.go` de v1.6.2), y el `https` no
#    lleva ninguno.
if kubectl get gateway gateway-api -n default -o jsonpath='{.spec.listeners[*].name}' | grep -qw turn-tls; then
  echo "· el Gateway ya tiene el listener turn-tls"
else
  kubectl patch gateway gateway-api -n default --type=json -p '[{"op":"add","path":"/spec/listeners/-","value":{
    "name":"turn-tls","port":443,"protocol":"TLS","hostname":"turn.guz-studio.dev",
    "tls":{"mode":"Terminate","certificateRefs":[{"group":"","kind":"Secret","name":"secret-tls","namespace":"default"}]},
    "allowedRoutes":{"namespaces":{"from":"Same"},"kinds":[{"group":"gateway.networking.k8s.io","kind":"TCPRoute"}]}}}]'
fi

# 3. Que ningún listener quedó en conflicto. Si alguno lo está, se deshace el
#    nuestro en el acto: el 443 sirve a diecisiete rutas de varios proyectos.
sleep 5
estado=$(kubectl get gateway gateway-api -n default \
  -o jsonpath='{range .status.listeners[*]}{.name}{" "}{range .conditions[*]}{.type}={.status}{","}{end}{"\n"}{end}')
echo "$estado"
if echo "$estado" | grep -E "Conflicted=True|Programmed=False|Accepted=False" >/dev/null; then
  echo "✗ un listener quedó mal: se quita turn-tls" >&2
  i=$(kubectl get gateway gateway-api -n default -o json \
    | python3 -c 'import json,sys; ls=json.load(sys.stdin)["spec"]["listeners"]; print([l["name"] for l in ls].index("turn-tls"))')
  kubectl patch gateway gateway-api -n default --type=json -p "[{\"op\":\"remove\",\"path\":\"/spec/listeners/$i\"}]"
  exit 1
fi
echo "✓ listo. Falta desplegar el backend (5-livekit.yaml y el TCPRoute de 6-livekit-route.yaml)."
