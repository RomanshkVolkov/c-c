"""Acuña el token del bot. **Sólo para el spike.**

En la fase 1 el token lo acuña el backend y lo manda en el trabajo: el worker
nunca ve el secreto de LiveKit. Esto existe porque el spike corre antes de que
ese backend exista, y se borra cuando exista.

Los permisos son los definitivos desde ya, porque son parte de lo que el spike
comprueba: un bot que **escucha y no habla**.
"""

import datetime

from livekit import api

# Identidad fija. LiveKit sustituye una conexión vieja que traiga la misma
# identidad, que es exactamente lo que queremos cuando el worker se reinicia a
# mitad de una grabación: entra el nuevo y el viejo se cae solo.
BOT_IDENTITY = "cac-transcriber"
BOT_NAME = "Transcriptor"


def mint(
    api_key: str,
    api_secret: str,
    room: str,
    call_id: str,
    started_by: str,
    ttl: datetime.timedelta,
) -> str:
    grants = api.VideoGrants(
        room_join=True,
        room=room,
        can_subscribe=True,
        # Las dos que hacen del bot un oyente. Si alguna se pone a `True`, el
        # bot puede meter audio en la sala de otro.
        can_publish=False,
        can_publish_data=False,
    )
    return (
        api.AccessToken(api_key, api_secret)
        .with_identity(BOT_IDENTITY)
        .with_name(BOT_NAME)
        # Lo que la app lee para pintar el chip REC: quién grabó y qué llamada.
        .with_attributes({"cac.callId": call_id, "cac.startedBy": started_by})
        .with_ttl(ttl)
        .with_grants(grants)
        .to_jwt()
    )
