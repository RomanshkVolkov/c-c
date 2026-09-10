"""Transcribir, y tirar lo que el modelo se inventó.

Whisper alucina sobre el silencio: cuando no hay voz, rellena. Y una pista por
persona es, casi toda ella, silencio — la persona calla mientras hablan los
demás. Sin filtro, el transcript se llena de créditos de subtítulos y de bucles.

Aquí sólo está la parte pura, que es la que puede equivocarse en silencio. El
modelo se enchufa en la fase 1, y `faster_whisper` **no se importa arriba** a
propósito: dos gigas de dependencia no pueden ser el precio de correr las
pruebas de una función que compara números.
"""

import re
import unicodedata

# El silencio se detecta por las dos a la vez, no por una. Un `or` aquí se lleva
# por delante habla real: una frase corta y clara puede tener `no_speech_prob`
# alto, y una frase larga entre ruido puede tener `avg_logprob` malo. Alucinar
# es ser las dos cosas.
NO_SPEECH_MAX = 0.6
AVG_LOGPROB_MIN = -1.0

# Más de cuatro repeticiones seguidas del mismo grupo de palabras. Cuatro es
# énfasis humano («no, no, no, no»); cinco es el modelo enganchado.
MAX_NGRAM_REPEATS = 4
LONGEST_NGRAM = 4

# Corta a propósito. Cada entrada que se añade es habla real que se puede perder.
KNOWN_ARTIFACTS = (
    "subtitulos realizados por",
    "subtitulado por",
    "amara.org",
    "subtitles by",
    "thanks for watching",
    "gracias por ver",
)

# Qué parte del segmento tiene que ser artefacto para tirarlo. Alguien puede
# *mencionar* «gracias por ver el vídeo» dentro de una frase de verdad; lo que
# se tira es el segmento que no es mucho más que el artefacto.
#
# Se mide como proporción y no como «cuántas palabras sobran», y eso fue un
# fallo medido: con «que sobren tres» la alucinación más famosa de Whisper
# —«Subtítulos realizados por la comunidad de Amara.org»— pasaba el filtro,
# porque alrededor de cada trozo de la denylist sobran palabras de sobra. Lo
# que la delata es que casi todo el segmento es denylist.
ARTIFACT_COVERAGE_MIN = 0.6


def _normalize(text: str) -> str:
    """Minúsculas, sin tildes y con los espacios juntos.

    Sin tildes porque el modelo no es constante con ellas: escribe «Subtítulos»
    y «Subtitulos» según le da, y una denylist que dependa de eso falla la mitad
    de las veces.
    """
    flat = unicodedata.normalize("NFD", text.lower())
    flat = "".join(c for c in flat if unicodedata.category(c) != "Mn")
    return " ".join(flat.split())


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text)


def _is_silence(no_speech_prob: float, avg_logprob: float) -> bool:
    return no_speech_prob > NO_SPEECH_MAX and avg_logprob < AVG_LOGPROB_MIN


def _is_known_artifact(text: str) -> bool:
    """Qué proporción del segmento cubren, entre todos, los artefactos conocidos.

    Entre todos y no el más largo: la frase de Amara está cosida de dos trozos
    de la denylist con relleno en medio, y por separado ninguno la delata.
    """
    flat = _normalize(text)
    total = len(_words(flat))
    if not total:
        return False
    rest = flat
    for artifact in KNOWN_ARTIFACTS:
        rest = rest.replace(artifact, " ")
    covered = total - len(_words(rest))
    return covered / total >= ARTIFACT_COVERAGE_MIN


def _longest_run(words: list[str], size: int) -> int:
    """Cuántas veces seguidas se repite el grupo más repetido de ese tamaño."""
    longest = 0
    for start in range(len(words) - size + 1):
        gram = words[start : start + size]
        run, at = 1, start + size
        while words[at : at + size] == gram:
            run += 1
            at += size
        longest = max(longest, run)
    return longest


def _is_looping(text: str) -> bool:
    words = _words(_normalize(text))
    return any(
        _longest_run(words, size) > MAX_NGRAM_REPEATS
        for size in range(1, LONGEST_NGRAM + 1)
    )


def keep_segment(text: str, no_speech_prob: float, avg_logprob: float) -> bool:
    """Si esto vuelve `False`, el segmento no llega al transcript."""
    if not text.strip():
        return False
    if _is_silence(no_speech_prob, avg_logprob):
        return False
    if _is_known_artifact(text):
        return False
    return not _is_looping(text)
