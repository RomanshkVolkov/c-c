"""El filtro descarta alucinaciones **y respeta habla real**.

Las dos mitades, y la segunda es la que importa: un filtro que tira todo pasa la
primera con nota. Lo que se pierde aquí no se recupera — el audio se borra en
cuanto existe el JSON del transcript.
"""

from transcriber.stt import keep_segment

# Un segmento normal: el modelo está seguro de que hay voz y de lo que oyó.
CLARO = {"no_speech_prob": 0.05, "avg_logprob": -0.3}
# Sobre silencio: las dos señales malas a la vez.
SILENCIO = {"no_speech_prob": 0.9, "avg_logprob": -1.5}


def test_lo_que_se_oyo_bien_se_queda():
    assert keep_segment("vamos a mover la entrega al jueves", **CLARO)


def test_el_vacio_no_es_un_segmento():
    assert not keep_segment("   ", **CLARO)


def test_sobre_silencio_el_modelo_se_lo_invento():
    assert not keep_segment("Subtítulos realizados por la comunidad", **SILENCIO)


def test_una_sola_senal_mala_no_basta():
    """Es un `y`, no un `o`, y ahí se juega el filtro entero.

    Una frase corta y clara puede tener `no_speech_prob` alto; una frase larga
    entre ruido, `avg_logprob` malo. Con un `o` se tiran las dos.
    """
    assert keep_segment("sí", no_speech_prob=0.9, avg_logprob=-0.3)
    assert keep_segment("no te oigo bien, repite", no_speech_prob=0.05, avg_logprob=-1.5)


def test_los_umbrales_son_los_del_plan():
    """Justo en el umbral todavía se queda; pasado, no."""
    assert keep_segment("hola", no_speech_prob=0.6, avg_logprob=-1.0)
    assert not keep_segment("hola", no_speech_prob=0.61, avg_logprob=-1.01)


def test_los_creditos_de_subtitulos_se_van():
    """La alucinación más famosa de Whisper, y una regresión medida.

    Con la primera regla —«que sobren tres palabras alrededor del artefacto»—
    esta frase **pasaba el filtro**: está cosida de dos trozos de la denylist
    con relleno en medio, y alrededor de cada trozo sobran palabras de sobra.
    Lo que la delata es que casi todo el segmento es denylist.
    """
    assert not keep_segment("Subtítulos realizados por la comunidad de Amara.org", **CLARO)


def test_las_tildes_no_deciden_si_algo_es_basura():
    """El modelo escribe «Subtítulos» y «Subtitulos» según le da."""
    assert not keep_segment("subtitulos realizados por la comunidad", **CLARO)


def test_un_artefacto_dentro_de_una_frase_de_verdad_es_habla():
    """Alguien puede *mencionarlo*.

    Lo que se tira es el segmento que no es más que el artefacto, no la frase
    que lo cita.
    """
    assert keep_segment(
        "gracias por ver el prototipo, lo revisamos el lunes con el equipo", **CLARO
    )


def test_el_modelo_enganchado_se_va():
    assert not keep_segment("sí sí sí sí sí sí sí sí", **CLARO)
    assert not keep_segment(
        "ya lo vemos ya lo vemos ya lo vemos ya lo vemos ya lo vemos", **CLARO
    )


def test_cuatro_veces_es_enfasis_humano():
    """La frontera: cuatro repeticiones son una persona insistiendo."""
    assert keep_segment("no no no no", **CLARO)
    assert not keep_segment("no no no no no", **CLARO)


def test_una_palabra_repetida_lejos_no_es_un_bucle():
    """El bucle es *seguido*. Repetir una palabra a lo largo de una frase, no."""
    assert keep_segment(
        "el jueves lo vemos, y si el jueves no puedes lo dejamos para el jueves siguiente",
        **CLARO,
    )


def test_donde_esta_la_raya_entre_citar_y_ser_el_artefacto():
    """Tres palabras de artefacto sobre cinco es el artefacto; sobre seis, no.

    La raya está en la proporción, así que se escribe en palabras contadas y no
    en `ARTIFACT_COVERAGE_MIN`: escrita contra la constante, esta prueba se
    movería con ella.
    """
    assert not keep_segment("gracias por ver el vídeo", **CLARO)
    assert keep_segment("gracias por ver el vídeo de ayer", **CLARO)
