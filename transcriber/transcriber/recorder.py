"""El bot: entra a la sala, se suscribe al audio y cuenta lo que llega.

En la fase 0 esto es todo lo que hace, y es a propósito: la única incógnita del
plan es si el media de WebRTC llega desde un pod hasta la IP externa que anuncia
el SFU. Contar segundos de audio es la forma más pequeña de contestar que sí —
si llegan muestras, ICE negoció.

Lo que ya está en su forma definitiva y no se toca en la fase 1: suscribirse a
mano (nunca vídeo), el remuestreo a 16 kHz mono por el propio SDK, y llevar la
cuenta por **identidad** y no por pista, porque salir y volver de la sala tiene
que caer en el mismo sitio.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field

from livekit import rtc

log = logging.getLogger("recorder")

SAMPLE_RATE = 16000
CHANNELS = 1


@dataclass
class TrackTally:
    """Lo que se sabe del audio de una persona."""

    identity: str
    samples: int = 0
    frames: int = 0
    # Segundos desde que el bot entró hasta la primera muestra suya. Es la
    # medida que contesta la pregunta del spike: si es `None`, no llegó nada.
    first_frame_after: float | None = None

    @property
    def seconds(self) -> float:
        return self.samples / SAMPLE_RATE


@dataclass
class Report:
    """El resultado del spike, en números que se pegan en `docs/transcripcion.md`."""

    connected_after: float | None = None
    wall_seconds: float = 0.0
    tallies: dict[str, TrackTally] = field(default_factory=dict)
    # Cada cambio de estado de la conexión, con su marca. Un ICE que sufre se ve
    # aquí antes que en ningún otro sitio.
    states: list[tuple[float, str]] = field(default_factory=list)

    @property
    def audio_seconds(self) -> float:
        return sum(t.seconds for t in self.tallies.values())

    def got_audio(self, min_seconds: float) -> bool:
        """La puerta: alguna pista tiene que traer audio de verdad.

        Se mira por pista y no el total, porque diez pistas con medio segundo
        cada una son diez saludos de ICE y ninguna conversación.
        """
        return any(t.seconds >= min_seconds for t in self.tallies.values())


class Recorder:
    def __init__(self, url: str, token: str) -> None:
        self._url = url
        self._token = token
        self._room = rtc.Room()
        self._report = Report()
        self._started = 0.0
        self._pumps: set[asyncio.Task] = set()
        self._wire()

    # ── el reloj del trabajo ────────────────────────────────────────────────
    #
    # Todo se mide contra el instante en que arrancamos, no contra el reloj de
    # pared: lo que interesa es «cuánto tardó», no «a qué hora fue».
    def _since_start(self) -> float:
        return time.monotonic() - self._started

    def _wire(self) -> None:
        room = self._room

        @room.on("connection_state_changed")
        def _(state: rtc.ConnectionState) -> None:
            self._report.states.append((self._since_start(), str(state)))
            log.info("estado de conexión: %s", state)

        @room.on("track_published")
        def _(
            publication: rtc.RemoteTrackPublication,
            participant: rtc.RemoteParticipant,
        ) -> None:
            self._want(publication, participant)

        @room.on("track_subscribed")
        def _(
            track: rtc.Track,
            publication: rtc.RemoteTrackPublication,
            participant: rtc.RemoteParticipant,
        ) -> None:
            if track.kind != rtc.TrackKind.KIND_AUDIO:
                return
            task = asyncio.create_task(self._pump(track, participant.identity))
            self._pumps.add(task)
            task.add_done_callback(self._pumps.discard)

        @room.on("participant_connected")
        def _(participant: rtc.RemoteParticipant) -> None:
            log.info("entra %s", participant.identity)
            for publication in participant.track_publications.values():
                self._want(publication, participant)

    def _want(
        self,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        """Suscribe audio y **sólo** audio.

        La suscripción es manual (`auto_subscribe=False`) para que el vídeo no
        llegue a pedirse nunca. Des-suscribirse después ya sería tarde: habría
        viajado un frame.
        """
        if publication.kind != rtc.TrackKind.KIND_AUDIO:
            return
        log.info("pido el audio de %s", participant.identity)
        publication.set_subscribed(True)

    async def _pump(self, track: rtc.Track, identity: str) -> None:
        tally = self._report.tallies.setdefault(identity, TrackTally(identity))
        stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=CHANNELS)
        try:
            async for event in stream:
                if tally.first_frame_after is None:
                    tally.first_frame_after = self._since_start()
                    log.info(
                        "primera muestra de %s a los %.2f s",
                        identity,
                        tally.first_frame_after,
                    )
                tally.frames += 1
                tally.samples += event.frame.samples_per_channel
        finally:
            await stream.aclose()

    async def run(self, seconds: float) -> Report:
        self._started = time.monotonic()
        await self._room.connect(
            self._url,
            self._token,
            rtc.RoomOptions(auto_subscribe=False),
        )
        self._report.connected_after = self._since_start()
        log.info("conectado a los %.2f s", self._report.connected_after)

        # Quien ya estaba dentro no dispara `participant_connected`.
        for participant in self._room.remote_participants.values():
            for publication in participant.track_publications.values():
                self._want(publication, participant)

        try:
            await asyncio.sleep(seconds)
        finally:
            self._report.wall_seconds = self._since_start()
            for task in list(self._pumps):
                task.cancel()
            await self._room.disconnect()
        return self._report
