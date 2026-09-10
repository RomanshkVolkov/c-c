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
