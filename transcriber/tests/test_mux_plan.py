"""`plan` es lo único de la fase 2 que puede estropear un vídeo sin que nada
falle: ffmpeg termina con código 0 y el resultado tiene las voces pisadas, la
pantalla movida, o dura para siempre.

Los números que aparecen aquí no son inventados: salen de las medidas de la
fase 0 contra el SFU y el S3 de verdad, y están explicados en
`docs/grabacion.md`.
"""

import pytest

from transcriber.mux_plan import (
    NothingToMux,
    Track,
    plan,
)

Z = 1_000_000_000_000_000_000  # el cero de la línea de tiempo, en ns


def mic(offset_ms: int = 0, path: str = "mic.ogg", dur_s: int = 60) -> Track:
    return Track("MICROPHONE", path, Z + offset_ms * 1_000_000,
                 Z + (offset_ms + dur_s * 1000) * 1_000_000)


def screen(offset_ms: int = 0, path: str = "scr.webm", dur_s: int = 60,
           w: int = 1920, h: int = 1080) -> Track:
    return Track("SCREEN_SHARE", path, Z + offset_ms * 1_000_000,
                 Z + (offset_ms + dur_s * 1000) * 1_000_000, width=w, height=h)


def fc(p) -> str:
    """El grafo de filtros, que es donde vive casi todo lo que importa."""
    return p.argv[p.argv.index("-filter_complex") + 1]


# ─── Alineación ──────────────────────────────────────────────────────────────

def test_cada_pista_se_desplaza_por_su_propia_marca():
    """El desplazamiento sale de `started_at`, no del orden de llegada.

    El mutante que mata: usar el índice de la pista. Con dos personas daría un
    vídeo donde la segunda voz va un segundo tarde **siempre**, y nadie lo
    notaría hasta escucharlo entero.
    """
    p = plan([mic(0, "a.ogg"), mic(396, "b.ogg"), screen(452)], Z)
    assert p.offsets_ms == {"a.ogg": 0, "b.ogg": 396, "scr.webm": 452}
    assert "adelay=396:all=1" in fc(p)
    assert "+0.452/TB" in fc(p)


def test_la_primera_pista_no_lleva_adelay():
    """Un `adelay=0` es ruido, y `adelay` con cero puede comportarse raro."""
    p = plan([mic(0, "a.ogg")], Z)
    assert "adelay" not in fc(p)


def test_una_marca_anterior_al_cero_no_da_un_desplazamiento_negativo():
    """No existe un `adelay` negativo: si pasara, el cero estaría mal."""
    p = plan([Track("MICROPHONE", "a.ogg", Z - 5_000_000_000, Z + 1)], Z)
    assert p.offsets_ms["a.ogg"] == 0


def test_sin_cero_dado_se_deduce_de_la_pista_mas_temprana():
    p = plan([mic(1000, "a.ogg"), mic(1500, "b.ogg")])
    assert p.offsets_ms == {"a.ogg": 0, "b.ogg": 500}


# ─── Audio ───────────────────────────────────────────────────────────────────

def test_los_huecos_del_silencio_se_rellenan():
    """`aresample=async=1:first_pts=0` en **todas** las pistas de audio.

    El mutante que mata: quitarlo. Con DTX, Opus no manda paquetes mientras
    nadie habla; se midió que el `.ogg` conserva el hueco, pero esto es el
    cinturón para el que sí llegue a aparecer — y sin él, todo lo que venga
    detrás del hueco se adelanta.
    """
    p = plan([mic(0, "a.ogg"), mic(500, "b.ogg")], Z)
    assert fc(p).count("aresample=async=1:first_pts=0") == 2


def test_la_mezcla_no_reparte_el_volumen_entre_los_que_hablan():
    """`normalize=0`, o con cuatro personas todos suenan a la cuarta parte.

    Es el defecto de `amix` y el fallo más silencioso de todos: la grabación
    sale entera, correcta, y **inaudible**.
    """
    p = plan([mic(0, "a.ogg"), mic(0, "b.ogg"), mic(0, "c.ogg")], Z)
    assert "amix=inputs=3:duration=longest:normalize=0" in fc(p)


def test_una_sola_voz_no_se_mezcla_pero_sí_se_limita():
    p = plan([mic(0, "a.ogg")], Z)
    assert "amix" not in fc(p)
    assert "alimiter" in fc(p)


def test_sin_audio_no_hay_nada_que_montar():
    with pytest.raises(NothingToMux):
        plan([screen(0)], Z)


def test_el_audio_de_la_pantalla_cuenta_como_audio():
    p = plan([Track("SCREEN_SHARE_AUDIO", "sa.ogg", Z, Z + 1)], Z)
    assert p.output_name == "final.m4a"


# ─── Vídeo ───────────────────────────────────────────────────────────────────

def test_el_lienzo_tiene_duracion():
    """`color` es una fuente **infinita**.

    Sin `d=`, y con `eof_action=pass` para que el lienzo sobreviva al final de
    cada pantalla, ffmpeg no para nunca. Pasó de verdad: quince minutos de CPU
    y cincuenta megas para una grabación de tres minutos, y subiendo. El
    mutante que mata: quitar el `d=`.
    """
    p = plan([mic(0, dur_s=180), screen(452, dur_s=179)], Z)
    assert ":d=180.000[canvas]" in fc(p)


def test_sin_marcas_de_fin_manda_shortest():
    """Cuando no se puede calcular la duración, el cinturón es `-shortest`.

    Que está siempre, además: es lo que impide que un `d=` mal calculado deje
    el montaje codificando negro.
    """
    p = plan([Track("MICROPHONE", "a.ogg", Z), Track("SCREEN_SHARE", "s.webm", Z)], Z)
    assert ":d=" not in fc(p)
    assert "-shortest" in p.argv


def test_shortest_va_siempre():
    assert "-shortest" in plan([mic(0, dur_s=180), screen(0, dur_s=180)], Z).argv


def test_cada_trozo_de_pantalla_se_superpone_en_orden():
    """Dos personas comparten por turnos: los dos trozos entran, en su sitio.

    El mutante que mata: quedarse sólo con el primero. La segunda mitad de la
    reunión saldría en negro y el fichero seguiría siendo válido.
    """
    p = plan([mic(0), screen(1000, "uno.webm"), screen(30_000, "dos.webm")], Z)
    assert fc(p).count("overlay=") == 2
    assert "+1.000/TB" in fc(p) and "+30.000/TB" in fc(p)


def test_el_lienzo_es_el_mayor_de_los_que_haya_con_tope():
    p = plan([mic(0), screen(0, "a.webm", w=960, h=540), screen(0, "b.webm", w=1920, h=1080)], Z)
    assert "s=1920x1080" in fc(p)
    p = plan([mic(0), screen(0, w=3840, h=2160)], Z)
    assert "s=1920x1080" in fc(p)


def test_la_pantalla_se_encaja_sin_deformarse():
    """`force_original_aspect_ratio=decrease` más `pad`: una pantalla vertical
    entra con bandas, no estirada."""
    p = plan([mic(0), screen(0)], Z)
    assert "force_original_aspect_ratio=decrease" in fc(p)
    assert "pad=1920:1080" in fc(p)


# ─── Salida ──────────────────────────────────────────────────────────────────

def test_sin_pantalla_sale_un_m4a():
    """Un mp4 con una imagen fija cuesta codificar y no aporta nada.

    El mutante que mata: emitir siempre `.mp4`. La app pinta `<video>` para un
    `video/*` y `<audio>` para un `audio/*`; con la extensión equivocada, una
    llamada de sólo voz sale como un rectángulo negro.
    """
    p = plan([mic(0), mic(500, "b.ogg")], Z)
    assert (p.output_name, p.content_type, p.has_screen) == ("final.m4a", "audio/mp4", False)
    assert "-vn" in p.argv
    assert "libx264" not in p.argv


def test_con_pantalla_sale_un_mp4():
    p = plan([mic(0), screen(0)], Z)
    assert (p.output_name, p.content_type, p.has_screen) == ("final.mp4", "video/mp4", True)
    assert "libx264" in p.argv


def test_faststart_siempre():
    """Sin él, el índice del mp4 queda al final y el reproductor tiene que
    bajarse el fichero entero antes de empezar."""
    for p in (plan([mic(0)], Z), plan([mic(0), screen(0)], Z)):
        assert "+faststart" in p.argv


def test_la_salida_va_al_directorio_de_trabajo():
    p = plan([mic(0)], Z, workdir="/work/rec-1/")
    assert p.argv[-1] == "/work/rec-1/final.m4a"


# ─── Defensa en profundidad ──────────────────────────────────────────────────

def test_una_camara_se_ignora_aunque_llegue_listada():
    """El filtro de cámaras vive en el backend; éste es el segundo cerrojo.

    Si alguien añade `CAMERA` allí y se olvida de aquí, la cara de la gente no
    acaba en el vídeo por accidente. El mutante que mata: montar cualquier
    fuente de vídeo que llegue.
    """
    p = plan([mic(0), Track("CAMERA", "cam.webm", Z, Z + 1, width=640, height=480)], Z)
    assert p.has_screen is False
    assert "cam.webm" not in " ".join(p.argv)


def test_una_fuente_desconocida_tampoco_entra():
    p = plan([mic(0), Track("SOMETHING_NEW", "x.webm", Z, Z + 1)], Z)
    assert "x.webm" not in " ".join(p.argv)
