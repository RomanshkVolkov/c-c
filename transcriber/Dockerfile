# Imagen del spike de la fase 0: un cliente de WebRTC y nada más.
#
# El modelo NO está aquí. En la fase 1 se hornea en su propia capa
# (`Dockerfile.model`) porque pesa dos gigas y cambia una vez al año; meterlo
# ahora haría que cada intento del spike arrastrase esa descarga sin usarla.
FROM python:3.12-slim

# `livekit` trae binarios propios (el runtime de WebRTC en Rust) y necesita
# certificados para el TURN/TLS del SFU.
#
# `ffmpeg` sólo en la imagen del montador: son unos 200 MB que ni el spike ni el
# banco de pruebas usan para nada.
ARG WITH_FFMPEG=0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && if [ "$WITH_FFMPEG" = "1" ]; then apt-get install -y --no-install-recommends ffmpeg; fi \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml ./
COPY transcriber/ ./transcriber/
COPY tools/ ./tools/

# Vacío para la imagen del spike, `[stt]` para la del banco de pruebas, `[mux]`
# para el montador. El modelo pesa dos gigas y el spike no lo usa: pagar esa
# descarga en cada intento de medir si llega el media sería pagarla para nada.
ARG EXTRAS=""
RUN uv pip install --system --no-cache ".${EXTRAS}"

# Sin argumentos por defecto: la sala la pone quien lanza el trabajo. El
# montador entra por otra puerta (`python -m transcriber.mux`), que es la que
# pone su Deployment.
ENTRYPOINT ["python", "-m", "transcriber"]
