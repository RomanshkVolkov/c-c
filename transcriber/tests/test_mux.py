"""Lo poco de `mux.py` que se puede probar sin red, que resulta ser lo que más
duele si falla: las comprobaciones que separan «salió un vídeo» de «salió un
vídeo correcto».
"""

from transcriber.mux import MIN_DURATION_RATIO, expected_duration_ms

Z = 1_000_000_000_000_000_000


def job(zero: int = Z, ends: list[int] | None = None) -> dict:
    return {
        "firstMediaAtNs": zero,
        "tracks": [{"endedAtNs": e} for e in (ends or [])],
    }


def test_la_duracion_esperada_sale_de_la_pista_que_acabo_mas_tarde():
    """Y en milisegundos, que es como la mide `ffprobe`."""
    assert expected_duration_ms(job(Z, [Z + 60_000_000_000, Z + 90_000_000_000])) == 90_000


def test_sin_marcas_no_se_exige_duracion():
    """Mejor no comprobar que comprobar contra un cero.

    Un `expected` de 0 haría pasar cualquier cosa; devolverlo a propósito es
    decir «esto no se puede verificar», y el llamante se lo salta. Lo contrario
    —inventar una duración— rechazaría montajes buenos.
    """
    assert expected_duration_ms(job(Z, [])) == 0
    assert expected_duration_ms(job(0, [Z])) == 0


def test_una_marca_anterior_al_cero_no_da_una_duracion_negativa():
    assert expected_duration_ms(job(Z, [Z - 1000])) == 0


def test_el_margen_deja_pasar_lo_normal_y_caza_lo_cortado():
    """El 0,9 no es un número redondo por gusto: un montaje pierde unos pocos
    milisegundos al cerrar el contenedor, y uno cortado pierde minutos."""
    esperado = 600_000  # diez minutos
    assert 599_800 >= esperado * MIN_DURATION_RATIO   # el caso normal pasa
    assert not 300_000 >= esperado * MIN_DURATION_RATIO  # la mitad, no
