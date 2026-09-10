# Imagen del spike de la fase 0: un cliente de WebRTC y nada más.
#
# El modelo NO está aquí. En la fase 1 se hornea en su propia capa
# (`Dockerfile.model`) porque pesa dos gigas y cambia una vez al año; meterlo
# ahora haría que cada intento del spike arrastrase esa descarga sin usarla.
FROM python:3.12-slim

# `livekit` trae binarios propios (el runtime de WebRTC en Rust) y necesita
# certificados para el TURN/TLS del SFU.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml ./
COPY transcriber/ ./transcriber/
RUN uv pip install --system --no-cache .

# Sin argumentos por defecto: la sala la pone quien lanza el trabajo.
ENTRYPOINT ["python", "-m", "transcriber"]
