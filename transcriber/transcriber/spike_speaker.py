"""El suplente del humano: un bot que **sí** publica audio.

Existe por una sola razón: el spike mide segundos de audio recibido, y el audio
no existe si nadie lo publica. En producción quien publica es el navegador de
una persona; en el spike no hay personas, así que algo tiene que hacer ese papel.

# Por qué esto no contradice «el grabador no habla»

El grabador entra a la llamada **real de un cliente**. Si su credencial pudiera
publicar, un fallo del worker podría meter audio en la reunión de otro. Por eso
`token.mint` pone `can_publish=False` y hay un guardián que lo vigila.

Este de aquí no es un segundo grabador: es el suplente del humano. Identidad
distinta, token distinto, sala de usar y tirar. Y en la misma prueba **el
grabador sigue sin poder publicar** — que es justo lo que la hace válida:
demuestra que un token de sólo escucha recibe media a través del camino
pod↔SFU, que es lo que se va a desplegar.

# Y muere con el spike

Este módulo no lo importa el worker, y se borra con `token.py` cuando el backend
acuñe los tokens de verdad. Lo que **no** se borra es el guardián que impide que
`mint` acabe pudiendo publicar: ver `tests/test_token.py`.
"""

import asyncio
import datetime
import logging
import math

from livekit import api, rtc

log = logging.getLogger("speaker")

SPEAKER_IDENTITY = "spike-speaker"

# 48 kHz mono: lo que espera `AudioSource`. El grabador lo remuestrea a 16 kHz
# por su cuenta, que es parte de lo que la prueba comprueba.
SAMPLE_RATE = 48000
CHANNELS = 1
# Trozos de 10 ms, que es el latido natural de una pista de voz.
SAMPLES_PER_CHUNK = SAMPLE_RATE // 100
TONE_HZ = 440.0


def mint_speaker(
    api_key: str, api_secret: str, room: str, ttl: datetime.timedelta
) -> str:
    """Un token que publica. **Sólo para el spike.**"""
    grants = api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_subscribe=False,  # no necesita oír a nadie: sólo hablar
        can_publish_data=False,
    )
    return (
        api.AccessToken(api_key, api_secret)
        .with_identity(SPEAKER_IDENTITY)
        .with_name("Altavoz de prueba")
        .with_ttl(ttl)
        .with_grants(grants)
        .to_jwt()
    )


def _tone(frame_index: int) -> rtc.AudioFrame:
    """Un trozo de seno continuo entre llamadas.

    Continuo a propósito: si cada trozo empezara en cero habría un chasquido
    cada 10 ms, y el VAD de la fase 1 lo tomaría por habla entrecortada. Aquí
    daría igual, pero el emisor se queda y conviene que emita algo honesto.
    """
    data = bytearray()
    base = frame_index * SAMPLES_PER_CHUNK
    for i in range(SAMPLES_PER_CHUNK):
        t = (base + i) / SAMPLE_RATE
        muestra = int(12000 * math.sin(2 * math.pi * TONE_HZ * t))
        data += int(muestra).to_bytes(2, "little", signed=True)
    return rtc.AudioFrame(
        data=bytes(data),
        sample_rate=SAMPLE_RATE,
        num_channels=CHANNELS,
        samples_per_channel=SAMPLES_PER_CHUNK,
    )


async def speak(url: str, token: str, seconds: float) -> None:
    """Entra a la sala, publica un tono y se va."""
    room = rtc.Room()
    await room.connect(url, token, rtc.RoomOptions(auto_subscribe=False))
    log.info("conectado como %s", SPEAKER_IDENTITY)

    source = rtc.AudioSource(SAMPLE_RATE, CHANNELS)
    track = rtc.LocalAudioTrack.create_audio_track("spike", source)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )
    log.info("publicando un tono de %g Hz", TONE_HZ)

    try:
        for i in range(int(seconds * 100)):
            await source.capture_frame(_tone(i))
    except asyncio.CancelledError:
        pass
    finally:
        await room.disconnect()
