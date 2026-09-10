"""`merge_segments` es lo más mutado del worker, y con motivo: es lo único que
puede estropear un transcript sin que nada falle. Un hueco mal medido parte una
frase en dos; un solape recortado inventa un turno de palabra.
"""

from transcriber.merge import MAX_GAP_MS, Segment, merge_segments


def seg(start: int, end: int, text: str = "hola", confidence: float = 0.9) -> Segment:
    return Segment(
        start_ms=start,
        end_ms=end,
        speaker_user_id="",  # lo pone la pista
        text=text,
        confidence=confidence,
    )


def test_sin_pistas_no_hay_nada():
    assert merge_segments({}) == []


def test_el_hablante_lo_pone_la_pista():
    [out] = merge_segments({"ana": [seg(0, 500)]})
    assert out.speaker_user_id == "ana"


def test_sale_ordenado_por_tiempo_aunque_entre_al_reves():
    out = merge_segments({"ana": [seg(5000, 5500)], "bob": [seg(0, 500)]})
    assert [s.speaker_user_id for s in out] == ["bob", "ana"]


def test_un_hueco_corto_es_una_frase_partida():
    out = merge_segments({"ana": [seg(0, 1000, "buenos"), seg(1500, 2000, "días")]})
    assert len(out) == 1
    assert out[0].text == "buenos días"
    assert (out[0].start_ms, out[0].end_ms) == (0, 2000)


def test_un_hueco_largo_son_dos_intervenciones():
    """Segundo y medio de silencio es un turno de palabra, no una respiración.

    El hueco va en milisegundos de verdad y no en múltiplos de `MAX_GAP_MS`, a
    propósito: escrito contra la constante, esta prueba se movería con ella y
    subirla a tres segundos —pegando dos intervenciones en una— no rompería
    nada. Se midió: el mutante sobrevivía.
    """
    out = merge_segments({"ana": [seg(0, 1000, "buenos"), seg(2500, 3000, "días")]})
    assert len(out) == 2


def test_el_limite_del_hueco_es_estricto():
    """Justo `MAX_GAP_MS` NO une; un milisegundo menos, sí.

    Es la frontera que el plan fija en «hueco < 1 s», y donde un `<=` colado
    cambiaría el resultado de cada transcript sin que nadie se entere.
    """
    justo = merge_segments({"ana": [seg(0, 1000), seg(1000 + MAX_GAP_MS, 4000)]})
    casi = merge_segments({"ana": [seg(0, 1000), seg(1000 + MAX_GAP_MS - 1, 4000)]})
    assert len(justo) == 2
    assert len(casi) == 1


def test_dos_personas_a_la_vez_siguen_siendo_dos():
    """El solape se conserva: recortarlo inventaría un turno que no ocurrió."""
    out = merge_segments({"ana": [seg(0, 3000, "yo creo")], "bob": [seg(1000, 2000, "sí")]})
    assert len(out) == 2
    ana = next(s for s in out if s.speaker_user_id == "ana")
    bob = next(s for s in out if s.speaker_user_id == "bob")
    assert ana.start_ms < bob.start_ms and bob.end_ms < ana.end_ms


def test_lo_de_bob_no_decide_si_lo_de_ana_se_une():
    """Coser va dentro de la pista, no sobre la lista ya mezclada.

    Bob habla justo en medio de las dos frases de Ana. Si el cosido mirase la
    lista global, Ana quedaría partida por algo que dijo otro.
    """
    out = merge_segments(
        {
            "ana": [seg(0, 1000, "buenos"), seg(1500, 2000, "días")],
            "bob": [seg(1100, 1400, "hola")],
        }
    )
    ana = [s for s in out if s.speaker_user_id == "ana"]
    assert len(ana) == 1
    assert ana[0].text == "buenos días"


def test_un_segmento_contenido_en_otro_no_acorta_el_final():
    """El final del cosido es el que llegaba más lejos, no el del último."""
    out = merge_segments({"ana": [seg(0, 5000), seg(1000, 2000)]})
    assert len(out) == 1
    assert out[0].end_ms == 5000


def test_la_confianza_del_cosido_pesa_por_duracion():
    """Un «sí» de 200 ms no arrastra a una frase de 20 s."""
    largo = seg(0, 20000, "una frase larga", confidence=0.9)
    corto = seg(20200, 20400, "sí", confidence=0.1)
    [out] = merge_segments({"ana": [largo, corto]})
    assert out.confidence > 0.85


def test_dos_veces_lo_mismo_da_lo_mismo():
    """Un transcript que baila entre reintentos es uno en el que no se confía."""
    tracks = {
        "ana": [seg(1000, 2000, "a")],
        "bob": [seg(1000, 2000, "b")],
        "cec": [seg(1000, 2000, "c")],
    }
    once = merge_segments(tracks)
    twice = merge_segments({k: list(v) for k, v in reversed(list(tracks.items()))})
    assert [(s.start_ms, s.speaker_user_id) for s in once] == [
        (s.start_ms, s.speaker_user_id) for s in twice
    ]
