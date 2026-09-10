"""Entrada del spike de la fase 0.

    python -m transcriber --room voice:<spaceId> --seconds 120

Sale con 0 si llegó audio de verdad y con 1 si no. Ese código es la puerta (a)
del plan: si falla desde un pod, hay que probar `rtc.tcp_port` o añadir la IP
privada del nodo a los candidatos, y si nada de eso vale, el plan cambia a
Egress.
"""

import argparse
import asyncio
import datetime
import json
import logging
import sys

from . import config
from .recorder import Recorder, Report
from .token import BOT_IDENTITY, mint


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="transcriber")
    parser.add_argument("--room", required=True, help="voice:<spaceId>")
    parser.add_argument("--seconds", type=float, default=120.0)
    parser.add_argument(
        "--min-seconds",
        type=float,
        default=5.0,
        help="cuánto audio de una sola persona cuenta como «llegó»",
    )
    parser.add_argument("--call-id", default="spike")
    parser.add_argument("--started-by", default="spike")
    parser.add_argument("--json", action="store_true", help="el informe en JSON")
    return parser.parse_args()


def _print(report: Report, min_seconds: float, as_json: bool) -> None:
    data = {
        "connectedAfter": report.connected_after,
        "wallSeconds": round(report.wall_seconds, 2),
        "audioSeconds": round(report.audio_seconds, 2),
        "states": [{"at": round(at, 2), "state": s} for at, s in report.states],
        "tracks": [
            {
                "identity": t.identity,
                "seconds": round(t.seconds, 2),
                "frames": t.frames,
                "firstFrameAfter": (
                    None if t.first_frame_after is None else round(t.first_frame_after, 2)
                ),
            }
            for t in report.tallies.values()
        ],
        "passed": report.got_audio(min_seconds),
    }
    if as_json:
        print(json.dumps(data, indent=2))
        return
    print()
    print(f"  conectado a los       {data['connectedAfter']} s")
    print(f"  escuchando            {data['wallSeconds']} s")
    print(f"  audio recibido        {data['audioSeconds']} s")
    for track in data["tracks"]:
        print(
            f"    · {track['identity']:<24} {track['seconds']:>8} s"
            f"   primera muestra a los {track['firstFrameAfter']} s"
        )
    if not data["tracks"]:
        print("    · (ninguna pista)")
    print()
    print("  ICE negoció y el media llega" if data["passed"] else "  NO llegó audio")


async def _run() -> int:
    args = _args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(message)s",
    )

    url = config.livekit_url()
    token = mint(
        api_key=config.require("LIVEKIT_API_KEY"),
        api_secret=config.require("LIVEKIT_API_SECRET"),
        room=args.room,
        call_id=args.call_id,
        started_by=args.started_by,
        ttl=datetime.timedelta(seconds=args.seconds + 900),
    )
    logging.info("entro a %s como %s por %s", args.room, BOT_IDENTITY, url)

    report = await Recorder(url, token).run(args.seconds)
    _print(report, args.min_seconds, args.json)
    return 0 if report.got_audio(args.min_seconds) else 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(_run()))
    except config.MissingSetting as err:
        print(f"configuración: {err}", file=sys.stderr)
        sys.exit(2)
