"""Junta las pistas en una conversación. Puro: entra datos, sale datos.

La diarización —quién dijo qué— sale **gratis** en este diseño y es la razón de
que sea éste: cada persona tiene su propia pista, así que el hablante no se
adivina, se sabe. Lo único que queda es ordenar por tiempo y coser lo que el VAD
partió.

Este módulo no sabe de LiveKit ni de Whisper, y por eso sobrevive aunque la
captura acabe siendo por Egress en vez de por bot.
"""

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace

# Dos trozos de la misma persona separados por menos de esto son una frase que
# el VAD partió al respirar, no dos intervenciones. Un segundo es largo para una
# pausa dentro de una frase y corto para un turno de palabra.
MAX_GAP_MS = 1000


@dataclass(frozen=True)
class Segment:
    start_ms: int
    end_ms: int
    speaker_user_id: str
    text: str
    confidence: float

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)


def _join(a: Segment, b: Segment) -> Segment:
    """Cose dos trozos del mismo hablante en uno."""
    texts = [t for t in (a.text.strip(), b.text.strip()) if t]
    # `max` y no `b.end_ms`: un segmento puede quedar contenido dentro del
    # anterior, y entonces el final bueno es el del que llegaba más lejos.
    end_ms = max(a.end_ms, b.end_ms)
    # Confianza pesada por duración. La media a secas dejaría que un «sí» de
    # tres décimas con mala confianza arrastrase a una frase de veinte segundos.
    weight_a, weight_b = a.duration_ms, b.duration_ms
    total = weight_a + weight_b
    confidence = (
        (a.confidence * weight_a + b.confidence * weight_b) / total
        if total
        else (a.confidence + b.confidence) / 2
    )
    return replace(a, end_ms=end_ms, text=" ".join(texts), confidence=confidence)


def _stitch(segments: Iterable[Segment]) -> list[Segment]:
    """Une los consecutivos de **una** pista con hueco < `MAX_GAP_MS`."""
    out: list[Segment] = []
    for segment in sorted(segments, key=lambda s: (s.start_ms, s.end_ms)):
        if out and segment.start_ms - out[-1].end_ms < MAX_GAP_MS:
            out[-1] = _join(out[-1], segment)
        else:
            out.append(segment)
    return out


def merge_segments(tracks: Mapping[str, Sequence[Segment]]) -> list[Segment]:
    """Todas las pistas en una sola línea de tiempo.

    Coser va **dentro de cada pista y antes de mezclar**, no sobre la lista ya
    ordenada. Si se hiciera después, que dos frases de Ana se unan o no
    dependería de si Bob dijo algo en medio, y eso no es asunto de Ana.

    **Los solapes se conservan.** Dos personas hablando a la vez son dos
    segmentos que se pisan en el tiempo, y así tiene que quedar: recortarlos
    inventaría un turno de palabra que no ocurrió.
    """
    merged: list[Segment] = []
    for identity, segments in tracks.items():
        # El hablante lo pone la pista, no el modelo. `identity` es la de
        # LiveKit, que es el userId.
        owned = [replace(s, speaker_user_id=identity) for s in segments]
        merged.extend(_stitch(owned))
    # Desempate por hablante y final para que dos ejecuciones sobre lo mismo den
    # exactamente lo mismo: un transcript que baila entre reintentos es un
    # transcript en el que no se confía.
    return sorted(merged, key=lambda s: (s.start_ms, s.speaker_user_id, s.end_ms))
