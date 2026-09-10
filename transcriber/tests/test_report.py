"""La puerta del spike: qué cuenta como «el media llega».

Es lo único del spike que puede mentir en silencio. Si el bot no conecta, se ve;
si conecta y esta función dice que sí cuando no, el plan sigue adelante sobre un
resultado falso y el error aparece tres fases después.
"""

from transcriber.recorder import SAMPLE_RATE, Report, TrackTally


def tally(identity: str, seconds: float) -> TrackTally:
    return TrackTally(identity=identity, samples=int(seconds * SAMPLE_RATE))


def report(*tallies: TrackTally) -> Report:
    return Report(tallies={t.identity: t for t in tallies})


def test_sin_pistas_no_hay_media():
    assert not report().got_audio(5.0)


def test_una_pista_con_audio_suficiente_pasa():
    assert report(tally("ana", 12.0)).got_audio(5.0)


def test_muchos_saludos_cortos_no_son_una_conversacion():
    """Diez pistas de medio segundo suman cinco, y no valen.

    Es la trampa concreta: ICE puede llegar a mandar unos frames y morirse. El
    total pasaría el umbral y la puerta diría que sí. Se mira por pista.
    """
    saludos = [tally(f"p{i}", 0.5) for i in range(10)]
    assert not report(*saludos).got_audio(5.0)


def test_el_umbral_es_inclusivo():
    """Justo el umbral pasa; justo por debajo, no."""
    assert report(tally("ana", 5.0)).got_audio(5.0)
    assert not report(tally("ana", 4.99)).got_audio(5.0)


def test_los_segundos_salen_de_las_muestras_a_16k():
    assert TrackTally("ana", samples=SAMPLE_RATE * 3).seconds == 3.0


def test_el_total_suma_todas_las_pistas():
    assert report(tally("ana", 4.0), tally("bob", 6.0)).audio_seconds == 10.0
