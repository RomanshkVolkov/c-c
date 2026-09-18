"""Decide **cómo** se monta una grabación. Puro: entran datos, sale una orden.

Todo lo que puede salir mal en el montaje se decide aquí —qué pista va cuánto
desplazada, si hay vídeo o sólo voz, qué lienzo, qué extensión— y aquí es donde
se muta. `mux.py` sólo baja ficheros, ejecuta lo que esto diga y sube el
resultado.

# De qué vive el desplazamiento

De `FileInfo.started_at`, el instante en que cada egress empezó a escribir. No
del reloj del backend: los egress de una misma llamada arrancan con segundos de
diferencia entre ellos —medido, hasta 5,8 s— y aun así sus `started_at` alinean
las pistas dentro de 73 ms. Con el reloj del backend, no.

# Y de que el hueco del silencio se conserve

Opus con DTX no manda paquetes mientras nadie habla, así que la duda era si el
`.ogg` se encogía y desalineaba todo lo que viniera detrás. Se midió: **no se
encoge** —un valle de 17 dB de quince segundos y el fichero seguía midiendo lo
que duró la llamada—. `aresample=async=1:first_pts=0` se queda de todas formas,
como cinturón: rellena con silencio cualquier hueco que sí llegue a aparecer.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field

# Las fuentes que este módulo sabe montar. Es la misma lista que el backend
# usa para decidir qué grabar, repetida a propósito: si alguna vez llega una
# cámara por error —porque alguien la añadió allí y no aquí—, se ignora en vez
# de acabar en el vídeo. Defensa en profundidad, y hay una prueba que lo exige.
MICROPHONE = "MICROPHONE"
SCREEN_SHARE = "SCREEN_SHARE"
SCREEN_SHARE_AUDIO = "SCREEN_SHARE_AUDIO"
AUDIO_SOURCES = (MICROPHONE, SCREEN_SHARE_AUDIO)
VIDEO_SOURCES = (SCREEN_SHARE,)

# Diez fotogramas por segundo y CRF 18.
#
# El CRF lo eligió jose: «sin pérdida perceptible». **El ahorro real son los
# fotogramas**: una pantalla compartida está casi quieta, y a 10 fps el texto
# pequeño se lee igual —comprobado leyendo un identificador de once cifras de
# un fotograma suelto—. Medido en la fase 0: 130 MB por hora de reunión, contra
# los 3,6 GB/hora de componer en vivo.
DEFAULT_FPS = 10
DEFAULT_CRF = 18
# Un fotograma clave cada cinco segundos, para que buscar en el vídeo sea
# inmediato en vez de tener que decodificar desde el principio.
KEYFRAME_EVERY_S = 5

# El tope del lienzo. La resolución la pone quien comparte —se han visto
# 1920×1080 y 960×540 en dos tomas seguidas—, así que el lienzo se calcula por
# grabación; esto sólo evita que una pantalla enorme dispare el coste.
MAX_WIDTH, MAX_HEIGHT = 1920, 1080

AUDIO_BITRATE = "96k"


@dataclass(frozen=True)
class Track:
    """Una pista ya grabada, tal como la dejó Egress."""

    source: str
    path: str
    # Nanosegundos Unix, de `FileInfo`. **No del reloj del backend.**
    started_at_ns: int
    ended_at_ns: int = 0
    width: int = 0
    height: int = 0

    @property
    def is_audio(self) -> bool:
        return self.source in AUDIO_SOURCES

    @property
    def is_video(self) -> bool:
        return self.source in VIDEO_SOURCES


@dataclass(frozen=True)
class Plan:
    argv: list[str]
    output_name: str
    content_type: str
    has_screen: bool
    # Los desplazamientos aplicados, en milisegundos, para poder enseñarlos en
    # el registro cuando algo salga torcido.
    offsets_ms: dict[str, int] = field(default_factory=dict)


class NothingToMux(Exception):
    """No hay ni una pista de audio utilizable. No es un fallo del montaje."""


def _offset_ms(track: Track, zero_ns: int) -> int:
    """Cuánto se desplaza esta pista respecto del principio de la grabación."""
    # Nunca negativo: si una pista dijera haber empezado antes del cero, el cero
    # estaría mal calculado y un `adelay` negativo no existe.
    return max(0, round((track.started_at_ns - zero_ns) / 1_000_000))


def _duration_s(tracks: Sequence[Track], zero_ns: int) -> float:
    """Cuánto dura la grabación, del cero al último fichero que cerró.

    Sale de `ended_at`, que viene de `FileInfo` igual que el ancla. Devuelve
    cero si alguna pista no lo trae: entonces manda `-shortest`, que corta
    cuando se acaba el audio.
    """
    ends = [t.ended_at_ns for t in tracks if t.ended_at_ns]
    if len(ends) != len(tracks) or not ends:
        return 0.0
    return max(0.0, (max(ends) - zero_ns) / 1_000_000_000)


def _canvas(videos: Sequence[Track]) -> tuple[int, int]:
    """El lienzo: el mayor de los que haya, con tope."""
    width = max((t.width for t in videos if t.width), default=0) or 1280
    height = max((t.height for t in videos if t.height), default=0) or 720
    return min(width, MAX_WIDTH), min(height, MAX_HEIGHT)


def plan(
    tracks: Sequence[Track],
    first_media_at_ns: int = 0,
    *,
    fps: int = DEFAULT_FPS,
    crf: int = DEFAULT_CRF,
    workdir: str = ".",
) -> Plan:
    """La orden de ffmpeg, entera, en una sola invocación."""
    # Sólo lo que este módulo sabe montar. Una cámara que se colara se queda
    # fuera aquí, aunque el backend la hubiera guardado.
    audios = [t for t in tracks if t.is_audio]
    videos = [t for t in tracks if t.is_video]
    if not audios:
        raise NothingToMux("no audio tracks")

    # El cero de la línea de tiempo. Se acepta de fuera porque el backend ya lo
    # calculó al reconciliar, pero si no viene se deduce: es el `started_at` más
    # temprano de todas las pistas, vídeo incluido.
    zero = first_media_at_ns or min(t.started_at_ns for t in tracks)

    argv: list[str] = ["ffmpeg", "-hide_banner", "-nostdin", "-y"]
    for t in audios + videos:
        argv += ["-i", t.path]

    offsets: dict[str, int] = {}
    filters: list[str] = []
    labels: list[str] = []
    for i, t in enumerate(audios):
        off = _offset_ms(t, zero)
        offsets[t.path] = off
        # `aresample=async=1:first_pts=0` rellena con silencio los huecos que
        # el DTX o un mute pudieran dejar, para que la duración sea la de pared
        # y no la de los paquetes que llegaron. `adelay` coloca la pista donde
        # de verdad empezó.
        chain = f"[{i}:a]aresample=async=1:first_pts=0"
        if off:
            chain += f",adelay={off}:all=1"
        chain += f"[a{i}]"
        filters.append(chain)
        labels.append(f"[a{i}]")

    if len(labels) == 1:
        # Con una sola pista no hay nada que mezclar, pero el limitador se
        # queda: una voz sola también puede saturar.
        filters.append(f"{labels[0]}alimiter=limit=0.95[aout]")
    else:
        # `normalize=0` a propósito: `amix` divide el volumen entre el número de
        # entradas, así que con cuatro personas todo el mundo suena a la cuarta
        # parte y la grabación sale inaudible. El limitador es el que evita que
        # se sature cuando hablan dos a la vez.
        filters.append(
            "".join(labels)
            + f"amix=inputs={len(labels)}:duration=longest:normalize=0"
            + ",alimiter=limit=0.95[aout]"
        )

    maps = ["-map", "[aout]"]
    if videos:
        width, height = _canvas(videos)
        # Lienzo negro y cada trozo de pantalla encima, en su sitio. Es lo que
        # permite que alguien comparta a mitad de la reunión, o que dos personas
        # compartan por turnos: cada segmento entra donde le toca y el resto del
        # tiempo se ve negro en vez de congelado.
        #
        # **`d=` no es opcional.** `color` es una fuente infinita: sin decirle
        # cuánto dura, y con `eof_action=pass` para que el lienzo sobreviva al
        # final de cada pantalla, ffmpeg no para nunca. Se probó sin ello sobre
        # una grabación de tres minutos: quince minutos de CPU, cincuenta megas
        # de fichero y subiendo.
        duration_s = _duration_s(tracks, zero)
        canvas = f"color=black:s={width}x{height}:r={fps}"
        if duration_s:
            canvas += f":d={duration_s:.3f}"
        filters.append(canvas + "[canvas]")
        previous = "[canvas]"
        for n, t in enumerate(sorted(videos, key=lambda v: v.started_at_ns)):
            idx = len(audios) + videos.index(t)
            off = _offset_ms(t, zero)
            offsets[t.path] = off
            filters.append(
                f"[{idx}:v]setpts=PTS-STARTPTS+{off / 1000:.3f}/TB,"
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black[v{n}]"
            )
            out = "[vout]" if n == len(videos) - 1 else f"[ov{n}]"
            # `eof_action=pass`: cuando un segmento se acaba, el lienzo sigue.
            # Sin esto, el vídeo terminaría con la primera pantalla que se
            # cierre aunque la reunión siguiera.
            filters.append(f"{previous}[v{n}]overlay=eof_action=pass:shortest=0{out}")
            previous = out
        maps = ["-map", "[vout]"] + maps

    argv += ["-filter_complex", ";".join(filters)] + maps

    if videos:
        argv += [
            "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
            "-crf", str(crf), "-r", str(fps), "-g", str(fps * KEYFRAME_EVERY_S),
            "-pix_fmt", "yuv420p",
        ]
        name, content_type = "final.mp4", "video/mp4"
    else:
        # Sin pantalla no se fabrica un vídeo con una imagen fija: cuesta
        # codificarlo y no aporta nada. Sale un `.m4a` y la app pinta `<audio>`.
        argv += ["-vn"]
        name, content_type = "final.m4a", "audio/mp4"

    argv += ["-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "1"]
    # `-shortest` como cinturón del `d=` del lienzo: si alguna pista no trajo
    # `ended_at` no se puede calcular la duración, y sin esto el montaje se
    # quedaría codificando negro para siempre.
    argv += ["-shortest"]
    # `+faststart` **siempre**: sin él el índice del mp4 queda al final del
    # fichero y el reproductor tiene que descargarlo entero antes de empezar.
    # Con una reunión de una hora eso es la diferencia entre ver y esperar.
    argv += ["-movflags", "+faststart", f"{workdir.rstrip('/')}/{name}"]

    return Plan(
        argv=argv,
        output_name=name,
        content_type=content_type,
        has_screen=bool(videos),
        offsets_ms=offsets,
    )
