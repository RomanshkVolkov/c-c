"""El token del bot: escucha y no habla.

En la fase 1 este token lo acuña el backend y este guardián se muda a Go con él.
Mientras el spike sea quien lo acuña, vive aquí: unos permisos de más convierten
al oyente en alguien que puede meter audio en la sala de otro, y eso no se ve
mirando — el bot funcionaría igual.
"""

import base64
import datetime
import json

from transcriber.token import BOT_IDENTITY, BOT_NAME, mint

KEY = "devkey"
SECRET = "devsecret-que-pasa-de-treinta-y-dos-caracteres"


def claims(**kwargs) -> dict:
    jwt = mint(
        api_key=KEY,
        api_secret=SECRET,
        room=kwargs.get("room", "voice:s1"),
        call_id=kwargs.get("call_id", "c1"),
        started_by=kwargs.get("started_by", "u1"),
        ttl=kwargs.get("ttl", datetime.timedelta(minutes=20)),
    )
    payload = jwt.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=="))


def test_escucha():
    assert claims()["video"]["canSubscribe"] is True


def test_y_no_habla():
    video = claims()["video"]
    assert video.get("canPublish") is not True
    assert video.get("canPublishData") is not True


def test_solo_entra_a_la_sala_que_le_toca():
    video = claims(room="voice:s7")["video"]
    assert video["roomJoin"] is True
    assert video["room"] == "voice:s7"


def test_se_llama_transcriptor_y_siempre_igual():
    """La identidad es fija a propósito.

    LiveKit sustituye una conexión vieja que traiga la misma identidad: es lo
    que hace que un worker reiniciado a mitad de grabación entre y eche al
    fantasma del anterior en vez de duplicarse.
    """
    c = claims()
    assert c["sub"] == BOT_IDENTITY == "cac-transcriber"
    assert c["name"] == BOT_NAME


def test_lleva_de_que_llamada_es_y_quien_la_pidio():
    assert claims(call_id="c9", started_by="u3")["attributes"] == {
        "cac.callId": "c9",
        "cac.startedBy": "u3",
    }


def test_caduca():
    c = claims(ttl=datetime.timedelta(minutes=20))
    assert c["exp"] - c["nbf"] == 20 * 60


# ── El precedente que abre el emisor del spike, y su cierre ──────────────────
#
# `spike_speaker.mint_speaker` sí acuña un token que publica: es el suplente del
# humano, porque el spike mide audio recibido y el audio no existe si nadie lo
# publica. Eso está justificado *para el suplente* y para nadie más.
#
# El riesgo no es el spike: es que, con esa función ya en el repo como
# precedente, alguien «unifique» las dos y `mint` acabe aceptando un permiso de
# publicar. El día que pase, el grabador podrá meter audio en la llamada de un
# cliente y ninguna prueba de comportamiento se enterará, porque el bot seguiría
# funcionando igual.
#
# Por eso esto no mira el resultado de una llamada: mira **la forma de la
# función**. Un caso suelto se arregla pasando el argumento correcto; una firma
# que no admite el argumento no se puede pasar por alto.


def test_el_grabador_no_puede_publicar_le_pases_lo_que_le_pases():
    import inspect

    from transcriber import token as modulo

    prohibidos = {"can_publish", "can_publish_data", "publish", "grants", "video_grants"}
    parametros = set(inspect.signature(modulo.mint).parameters)
    if parametros & prohibidos:
        raise AssertionError(
            f"mint() acepta {parametros & prohibidos}: el token del grabador ha dejado de "
            "ser de sólo escucha por construcción, y ahora depende de quién lo llame"
        )

    # Y con cualquier combinación de lo que sí acepta, sigue callado.
    for room in ("voice:s1", "voice:otra"):
        for call_id in ("c1", ""):
            video = claims(room=room, call_id=call_id)["video"]
            assert video.get("canPublish") is not True
            assert video.get("canPublishData") is not True


def test_el_suplente_es_otro_y_se_nota():
    """El emisor del spike no se puede confundir con el grabador.

    Si compartieran identidad, en la lista de participantes de una sala real
    aparecerían como el mismo, y el que publica pasaría por el que sólo escucha.
    """
    from transcriber.spike_speaker import SPEAKER_IDENTITY, mint_speaker

    assert SPEAKER_IDENTITY != BOT_IDENTITY

    jwt = mint_speaker(KEY, SECRET, "voice:s1", datetime.timedelta(minutes=5))
    c = json.loads(base64.urlsafe_b64decode(jwt.split(".")[1] + "=="))
    assert c["sub"] == SPEAKER_IDENTITY
    assert c["video"]["canPublish"] is True
    # Y el suplente tampoco escucha: sólo habla. Suscribirse le daría el audio
    # de los demás sin necesitarlo para nada.
    assert c["video"].get("canSubscribe") is not True
