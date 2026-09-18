"""Fase 0 de la grabación: grabar una llamada **por pistas** y a mano.

    uv run python tools/egress_tracks.py voice:<sala> --seconds 180

Contesta la única pregunta que puede tumbar el diseño: **¿queda el vídeo
montado bien alineado?** Lo demás ya está medido (el media llega desde un pod,
las versiones casan, la llave sólo escribe en su rincón).

Lo que hace: descubre las pistas preguntándole al SFU —sin webhooks, como hará
el reloj del backend—, lanza un Track Egress por cada una, espera, las para y
enseña dónde quedó cada fichero con su marca de tiempo.

**Las cámaras se descartan.** No es una opción del guion: es la decisión de
producto. Sólo se graba micrófono y pantalla compartida (con su audio, si lo
hay), porque es lo que alguien vuelve a mirar.

Esto se borra cuando el backend haga lo mismo de verdad; vive aquí para que un
error de receta salga hoy y no después de quinientas líneas de Go.
"""

import argparse
import base64
import hashlib
import hmac
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

# Lo que se graba, y lo que no. `CAMERA` está fuera a propósito.
SOURCES = {"SOURCE_MICROPHONE": "microphone",
           "SOURCE_SCREEN_SHARE": "screen_share",
           "SOURCE_SCREEN_SHARE_AUDIO": "screen_share_audio",
           # Los nombres que devuelve el JSON de Twirp según versión.
           "MICROPHONE": "microphone",
           "SCREEN_SHARE": "screen_share",
           "SCREEN_SHARE_AUDIO": "screen_share_audio"}

# **La extensión no se adivina.** `ListParticipants` puede no traer `mimeType`
# (medido: llegó vacío para una pista de audio), y Egress le añade la que toca
# según el códec real — `…​.ogg` en ese caso. Así que la clave que se guarda es
# la que devuelve `file_results[].filename`, **no** la que se pidió.


def keys() -> tuple[str, str]:
    """Las llaves del SFU, leídas del clúster. No se escriben en ningún sitio."""
    crudo = subprocess.run(
        ["kubectl", "get", "secret", "livekit-secret", "-o",
         "jsonpath={.data.LIVEKIT_KEYS}"],
        capture_output=True, text=True, check=True).stdout
    par = base64.b64decode(crudo).decode()
    clave, secreto = par.split(":", 1)
    return clave.strip(), secreto.strip()


def token(api_key: str, api_secret: str, grant: dict, minutos: int = 15) -> str:
    b64 = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=")
    ahora = int(time.time())
    cab = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    cuerpo = b64(json.dumps({"iss": api_key, "sub": "fase0", "nbf": ahora,
                             "exp": ahora + minutos * 60, "video": grant}).encode())
    firma = b64(hmac.new(api_secret.encode(), cab + b"." + cuerpo, hashlib.sha256).digest())
    return (cab + b"." + cuerpo + b"." + firma).decode()


def twirp(base: str, api_key: str, api_secret: str,
          servicio: str, metodo: str, cuerpo: dict, grant: dict) -> dict:
    pet = urllib.request.Request(
        f"{base}/twirp/livekit.{servicio}/{metodo}",
        data=json.dumps(cuerpo).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + token(api_key, api_secret, grant)})
    try:
        with urllib.request.urlopen(pet, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return {"__error": e.code, "__body": e.read().decode()[:300]}


def main() -> int:
    ap = argparse.ArgumentParser(prog="egress_tracks")
    ap.add_argument("room", help="voice:<spaceId>")
    ap.add_argument("--seconds", type=float, default=180.0)
    ap.add_argument("--stagger", type=float, default=0.0,
                    help="espera entre el arranque de un egress y el siguiente")
    # El SFU va con hostNetwork: desde el nodo se le habla por localhost.
    ap.add_argument("--base", default="http://127.0.0.1:7880")
    ap.add_argument("--prefix", default="recordings/fase0")
    args = ap.parse_args()

    api_key, api_secret = keys()
    llamar = lambda s, m, c, g: twirp(args.base, api_key, api_secret, s, m, c, g)
    admin = {"roomList": True, "roomAdmin": True, "room": args.room}
    # `RoomRecord` es lo que LiveKit exige para Egress.*; sin él, 401.
    grabar = {"roomRecord": True, "room": args.room}

    print(f"=== pistas en {args.room} ===")
    p = llamar("RoomService", "ListParticipants", {"room": args.room}, admin)
    if "__error" in p:
        print("  no pude preguntar:", p); return 1

    pistas = []
    for part in p.get("participants", []):
        if part.get("kind") not in (None, "STANDARD", "PARTICIPANT_KIND_STANDARD"):
            continue  # el propio grabador, agentes, SIP
        for t in part.get("tracks", []):
            fuente = SOURCES.get(str(t.get("source", "")))
            marca = "graba " if fuente else "IGNORA"
            print(f"  {marca} {part.get('identity'):<20} {t.get('source'):<24} "
                  f"{t.get('mimeType','?'):<12} muted={t.get('muted', False)}")
            if fuente:
                pistas.append((part.get("identity"), fuente, t.get("sid"),
                               (t.get("mimeType") or "").lower()))

    if not pistas:
        print("\n  no hay nada que grabar: ¿está alguien dentro con micro?")
        return 1

    print(f"\n=== arranco {len(pistas)} egress ===")
    lanzados = []
    for n, (identidad, fuente, sid, _mime) in enumerate(pistas):
        # `--stagger` separa los arranques a propósito. Es lo que convierte la
        # claqueta en una prueba: si el desfase medido entre voz e imagen no se
        # mueve cuando los dos egress arrancan con segundos de diferencia,
        # entonces `started_at` es un ancla de verdad y no una casualidad.
        if n and args.stagger:
            print(f"  (espero {args.stagger:.1f} s antes del siguiente)")
            time.sleep(args.stagger)
        clave = f"{args.prefix}/{fuente}-{identidad}-{sid}"
        r = llamar("Egress", "StartTrackEgress", {
            "room_name": args.room, "track_id": sid,
            "file": {"filepath": clave, "disable_manifest": True},
        }, grabar)
        eg = r.get("egress_id")
        if not eg:
            print(f"  FALLÓ {fuente} de {identidad}: {r}"); continue
        print(f"  {eg}  {clave}")
        lanzados.append(eg)

    if not lanzados:
        return 1

    print(f"\ngrabando {args.seconds:.0f} s — comparte pantalla, cuenta en voz "
          "alta y cállate 20 s a mitad…")
    time.sleep(args.seconds)

    print("\n=== parando ===")
    for eg in lanzados:
        llamar("Egress", "StopEgress", {"egress_id": eg}, grabar)

    for _ in range(30):
        time.sleep(6)
        l = llamar("Egress", "ListEgress", {"room_name": args.room}, grabar)
        items = [i for i in l.get("items", []) if i.get("egress_id") in lanzados]
        if items and all(i.get("status") in ("EGRESS_COMPLETE", "EGRESS_FAILED",
                                             "EGRESS_ABORTED", "EGRESS_LIMIT_REACHED")
                         for i in items):
            break

    print("\n=== resultado ===")
    for i in items:
        print(f"  {i.get('status')}")
        if i.get("error"):
            print("    error:", i["error"][:200])
        for f in i.get("file_results", []):
            # `startedAt`/`endedAt` vienen en nanosegundos Unix — es lo que el
            # mux usará para alinear, así que se enseña crudo para anotarlo.
            # Ésta es la clave buena, la que Egress escribió de verdad.
            print(f"    {f.get('filename')}")
            print(f"      bytes={f.get('size')}  started_at={f.get('started_at')}  "
                  f"ended_at={f.get('ended_at')}  duration={f.get('duration')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
