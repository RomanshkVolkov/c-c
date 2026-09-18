"""La claqueta: un participante que hace sonar y brillar **el mismo instante**.

    uv run python tools/clapper.py sala-de-medir --seconds 60

Mide lo único que la fase 0 no podía medir con una persona delante: si
`FileInfo.started_at` sirve de ancla para pegar audio y vídeo. Pedirle a alguien
que diga «tres» al ver un reloj no vale — su tiempo de reacción es del mismo
orden que la medida que se busca, así que el resultado mide a la persona.

Aquí la fuente es una máquina. Este participante publica dos pistas —micro y
pantalla— movidas por el mismo reloj: cada pocos segundos suelta a la vez un
pitido y un destello blanco. En el origen la diferencia es cero **por
construcción**; lo que quede al otro lado, después de grabar cada pista con su
propio egress y alinearlas por `started_at`, es el error del ancla.

Publica desde una máquina de fuera y no desde el clúster, que es lo que hace el
navegador de una persona: el camino incluye red, jitter buffer y SFU. Lo que no
incluye es la captura del sistema operativo, que es retardo del cliente y no de
la grabación.

La prueba de verdad se hace con `egress_tracks.py --stagger`: si los dos egress
arrancan con segundos de diferencia y el desfase medido **no se mueve**, el
ancla es buena. Se midió así, y no se movió.

**Es una herramienta de medir, no parte del producto**: se va con la fase 0.
"""

import argparse
import asyncio
import datetime
import math
import os
import time

from livekit import api, rtc

IDENTITY = "sync-clapper"

SAMPLE_RATE = 48000
CHUNK = SAMPLE_RATE // 100  # 10 ms
TONE_HZ = 1000.0
BEEP_MS = 60
# El destello dura más que el pitido a propósito: la pantalla se codifica a
# muchos menos fotogramas por segundo de los que tiene el audio muestras, y un
# blanco de 60 ms se cuela entre dos fotogramas sin dejar rastro. Los dos
# **empiezan a la vez**, que es lo único que la medida usa.
FLASH_MS = 240

WIDTH, HEIGHT = 640, 360
FPS = 20

# El primer golpe tarda a propósito: quien lanza los egress necesita margen para
# descubrir las dos pistas y arrancarlas antes de que suene nada.
FIRST_CLAP_S = 12.0
EVERY_S = 6.0


def within_clap(t: float, ms: float = BEEP_MS) -> bool:
    """¿Cae este instante (segundos desde el origen) dentro de un golpe?"""
    if t < FIRST_CLAP_S:
        return False
    return (t - FIRST_CLAP_S) % EVERY_S < ms / 1000.0


def clap_times(seconds: float) -> list[float]:
    t, out = FIRST_CLAP_S, []
    while t < seconds:
        out.append(t)
        t += EVERY_S
    return out


# Los dos trozos de audio se calculan una vez: dentro del bucle no hay tiempo
# para senos. El tono arranca y acaba en cero (60 ms son 60 ciclos exactos de
# 1 kHz), así que el golpe no trae un chasquido propio que confunda la medida.
_SILENCE = bytes(CHUNK * 2)
_TONE = b"".join(
    int(20000 * math.sin(2 * math.pi * TONE_HZ * i / SAMPLE_RATE)).to_bytes(
        2, "little", signed=True
    )
    for i in range(CHUNK)
)


def audio_frame(payload: bytes) -> rtc.AudioFrame:
    return rtc.AudioFrame(
        data=payload, sample_rate=SAMPLE_RATE, num_channels=1,
        samples_per_channel=CHUNK,
    )


def video_frame(white: bool, index: int) -> rtc.VideoFrame:
    """Negro con una barra que se mueve, o todo blanco en el golpe.

    La barra existe para que el codificador **siga emitiendo**: una pantalla
    inmóvil se codifica en cuatro paquetes y el destello llegaría con el retardo
    de despertar al encoder, que no es lo que se quiere medir. Una pantalla
    compartida de verdad tampoco está nunca del todo quieta.
    """
    luma = bytearray(
        b"\xff" * (WIDTH * HEIGHT) if white else b"\x10" * (WIDTH * HEIGHT)
    )
    if not white:
        x = (index * 16) % (WIDTH - 32)
        for row in range(HEIGHT):
            start = row * WIDTH + x
            luma[start : start + 32] = b"\xa0" * 32
    chroma = b"\x80" * (WIDTH * HEIGHT // 2)
    return rtc.VideoFrame(WIDTH, HEIGHT, rtc.VideoBufferType.I420, bytes(luma) + chroma)


async def publish_audio(source: rtc.AudioSource, seconds: float) -> None:
    for i in range(int(seconds * 100)):
        await source.capture_frame(
            audio_frame(_TONE if within_clap(i / 100.0) else _SILENCE)
        )


async def publish_video(source: rtc.VideoSource, origin: float, seconds: float) -> None:
    for i in range(int(seconds * FPS)):
        delay = origin + i / FPS - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
        source.capture_frame(video_frame(within_clap(i / FPS, FLASH_MS), i))


async def main() -> None:
    ap = argparse.ArgumentParser(prog="clapper")
    ap.add_argument("room")
    ap.add_argument("--seconds", type=float, default=60.0)
    # Una cámara que nadie va a mirar, publicada a propósito.
    #
    # Es lo que prueba **en vivo** que el grabador descarta el vídeo de cara: con
    # dobles se comprueba que la función dice que no, pero que el SFU emita
    # `CAMERA` con ese nombre exacto y que el reloj lo vea sólo lo contesta un
    # LiveKit de verdad. Y a esta claqueta le cuesta una pista negra.
    # Sin pantalla: la llamada de sólo voz, que es la que tiene que salir como
    # `.m4a` en vez de como un vídeo con un rectángulo negro.
    ap.add_argument("--no-screen", action="store_true",
                    help="no publica pantalla compartida")
    ap.add_argument("--camera", action="store_true",
                    help="publica también una pista de cámara, que el grabador debe descartar")
    args = ap.parse_args()

    url = os.environ["LIVEKIT_URL"]
    token = (
        api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
        .with_identity(IDENTITY)
        .with_name("Claqueta")
        .with_ttl(datetime.timedelta(minutes=10))
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=args.room,
                can_publish=True,
                can_subscribe=False,
                can_publish_data=False,
            )
        )
        .to_jwt()
    )

    room = rtc.Room()
    await room.connect(url, token, rtc.RoomOptions(auto_subscribe=False))
    print(f"conectado a {args.room} como {IDENTITY}", flush=True)

    audio_source = rtc.AudioSource(SAMPLE_RATE, 1)
    video_source = rtc.VideoSource(WIDTH, HEIGHT)
    await room.local_participant.publish_track(
        rtc.LocalAudioTrack.create_audio_track("clap-audio", audio_source),
        rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
    )
    if not args.no_screen:
        await room.local_participant.publish_track(
            rtc.LocalVideoTrack.create_video_track("clap-video", video_source),
            # `video_encoding` explícito: sin él el SDK elige el preajuste de
            # pantalla compartida y publica a **5 fps**, con lo que un destello
            # corto se cae entre dos fotogramas. No es un defecto —una pantalla
            # quieta no necesita más—, pero aquí la resolución temporal *es* la
            # medida. Sin simulcast por lo mismo: una capa, una verdad.
            rtc.TrackPublishOptions(
                source=rtc.TrackSource.SOURCE_SCREENSHARE,
                simulcast=False,
                video_encoding=rtc.VideoEncoding(max_framerate=FPS, max_bitrate=1_500_000),
            ),
        )
    publicadas = "micro" + ("" if args.no_screen else " + pantalla")
    if args.camera:
        camera_source = rtc.VideoSource(320, 180)
        await room.local_participant.publish_track(
            rtc.LocalVideoTrack.create_video_track("clap-camera", camera_source),
            rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_CAMERA, simulcast=False),
        )
        # Basta con que exista y emita algo: lo que se mide es que el grabador
        # **no** le abra un egress, no lo que se ve en ella.
        camera_source.capture_frame(
            rtc.VideoFrame(320, 180, rtc.VideoBufferType.I420,
                           bytes(b"\x40" * (320 * 180) + b"\x80" * (320 * 180 // 2)))
        )
        publicadas += " + cámara"
    print("publicadas: " + publicadas, flush=True)

    origin = time.monotonic()
    wall = time.time()
    print(f"origen (epoch): {wall:.6f}", flush=True)
    for t in clap_times(args.seconds):
        print(f"  golpe programado: +{t:.3f} s  →  epoch {wall + t:.6f}", flush=True)

    try:
        await asyncio.gather(
            publish_audio(audio_source, args.seconds),
            publish_video(video_source, origin, args.seconds),
        )
    finally:
        await room.disconnect()
        print("claqueta fuera", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
