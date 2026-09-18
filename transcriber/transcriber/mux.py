"""El montador: baja las pistas, las pega y sube el vídeo.

Todo lo que decide **cómo** se monta vive en `mux_plan.py`, que es puro y está
mutado. Aquí sólo hay entrada y salida: pedir trabajo, bajar, ejecutar, subir,
contestar. La separación es a propósito — un fallo de receta se caza con una
prueba de mesa; uno de red, no.

# Por qué pregunta en vez de que le avisen

La verdad de «qué hay que montar» ya vive en Postgres: el estado de cada pista y
sus marcas de tiempo. Una cola aparte obligaría a escribir el mismo reparto
condicional en dos sitios, y un marcador en S3 obligaría al backend a escribir
en el bucket —se ha querido que sólo lea— y aun así no sabría si el multipart de
Egress terminó: eso sólo lo sabe `EGRESS_COMPLETE`.

Con el endpoint interno, el reparto es una columna y este proceso **no necesita
ninguna credencial de cac**: una llave y un puerto. Del bucket sólo alcanza
`recordings/`, con un usuario de IAM propio.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from .mux_plan import NothingToMux, Plan, Track, plan

log = logging.getLogger("mux")

# El latido para el `livenessProbe`. Si el bucle se atasca —una descarga que no
# termina, un ffmpeg colgado—, el fichero deja de tocarse y kubernetes reinicia.
HEARTBEAT = Path("/tmp/alive")

# Cada cuánto se pregunta si hay trabajo. No corre prisa: entre que alguien
# cuelga y el reloj cierra la grabación pasan segundos, y el objetivo es
# «montado en minutos», no en segundos.
POLL_S = 15

# El resultado tiene que durar al menos esto respecto de lo que duró la
# grabación. Menos significa que ffmpeg cortó por donde no debía —y un vídeo
# cortado no da error, se ve corto.
MIN_DURATION_RATIO = 0.9


class Backend:
    """El endpoint interno de cac. Una llave y un puerto."""

    def __init__(self, base: str, key: str, timeout: int = 30) -> None:
        self.base = base.rstrip("/")
        self.key = key
        self.timeout = timeout

    def _call(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json", "X-API-Key": self.key},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, {}

    def pending(self) -> list[dict]:
        status, body = self._call("GET", "/internal/v1/recordings/pending-mux")
        if status != 200:
            log.warning("pending-mux answered %s", status)
            return []
        return body.get("data") or []

    def claim(self, rec_id: str) -> bool:
        status, _ = self._call("POST", f"/internal/v1/recordings/{rec_id}/claim")
        return status == 200

    def ready(self, rec_id: str, **fields) -> None:
        self._call("POST", f"/internal/v1/recordings/{rec_id}/ready", fields)

    def failed(self, rec_id: str, reason: str) -> None:
        self._call("POST", f"/internal/v1/recordings/{rec_id}/failed", {"error": reason[:380]})


def probe_duration_ms(path: str) -> int:
    """Cuánto dura de verdad el fichero que salió."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=True).stdout.strip()
    return int(float(out) * 1000)


def has_audio_stream(path: str) -> bool:
    """Un montaje sin audio es un fallo aunque ffmpeg diga que no lo hubo."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=codec_type", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True).stdout
    return "audio" in out


def expected_duration_ms(job: dict) -> int:
    zero = job.get("firstMediaAtNs") or 0
    ends = [t.get("endedAtNs") or 0 for t in job.get("tracks", [])]
    if not zero or not any(ends):
        return 0
    return max(0, (max(ends) - zero) // 1_000_000)


class Mux:
    def __init__(self, backend: Backend, bucket: str, s3) -> None:
        self.backend = backend
        self.bucket = bucket
        self.s3 = s3

    def run_forever(self) -> None:
        while True:
            HEARTBEAT.touch()
            try:
                for job in self.backend.pending():
                    HEARTBEAT.touch()
                    if not self.backend.claim(job["id"]):
                        continue  # otro mux llegó antes
                    self.process(job)
            except Exception:  # noqa: BLE001 — el bucle no se muere por una pasada
                log.exception("the polling round failed; will try again")
            time.sleep(POLL_S)

    def process(self, job: dict) -> None:
        rec_id = job["id"]
        # **El directorio se borra siempre.** Un montaje que falla a mitad deja
        # gigas de vídeo a medias, y el disco del pod no es grande.
        workdir = tempfile.mkdtemp(prefix=f"mux-{rec_id}-", dir=os.environ.get("MUX_WORKDIR", "/work"))
        try:
            self._process(job, workdir)
        except NothingToMux as e:
            log.warning("%s: %s", rec_id, e)
            self.backend.failed(rec_id, str(e))
        except Exception as e:  # noqa: BLE001
            log.exception("%s failed", rec_id)
            self.backend.failed(rec_id, f"{type(e).__name__}: {e}")
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def _process(self, job: dict, workdir: str) -> None:
        rec_id = job["id"]
        tracks = []
        for n, t in enumerate(job.get("tracks", [])):
            key = t["objectKey"]
            local = os.path.join(workdir, f"{n}-{os.path.basename(key)}")
            self.s3.download_file(self.bucket, key, local)
            HEARTBEAT.touch()
            tracks.append(Track(
                source=t["source"], path=local,
                started_at_ns=t.get("startedAtNs") or 0,
                ended_at_ns=t.get("endedAtNs") or 0,
            ))

        p: Plan = plan(tracks, job.get("firstMediaAtNs") or 0, workdir=workdir)
        log.info("%s: %d tracks, offsets %s", rec_id, len(tracks), p.offsets_ms)
        started = time.time()
        r = subprocess.run(p.argv, capture_output=True, text=True)
        HEARTBEAT.touch()
        if r.returncode != 0:
            raise RuntimeError("ffmpeg: " + r.stderr[-400:])

        out = os.path.join(workdir, p.output_name)
        duration_ms = probe_duration_ms(out)
        if not has_audio_stream(out):
            raise RuntimeError("the muxed file has no audio stream")
        expected = expected_duration_ms(job)
        if expected and duration_ms < expected * MIN_DURATION_RATIO:
            # Un vídeo cortado no da error: se ve corto. Por eso se mide.
            raise RuntimeError(f"muxed {duration_ms} ms for an expected {expected} ms")

        # La clave es determinista: reintentar sobrescribe en vez de dejar dos
        # ficheros y ninguna forma de saber cuál vale.
        prefix = job.get("prefix") or "recordings"
        key = f"{prefix}/{job['orgId']}/{job['spaceId']}/{rec_id}/{p.output_name}"
        self.s3.upload_file(out, self.bucket, key, ExtraArgs={"ContentType": p.content_type})
        log.info("%s: %s in %.1f s (%d ms)", rec_id, key, time.time() - started, duration_ms)

        self.backend.ready(
            rec_id, objectKey=key, contentType=p.content_type,
            bytes=os.path.getsize(out), durationMs=duration_ms, hasScreen=p.has_screen,
        )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    import boto3  # se importa aquí para que las pruebas de `mux_plan` no lo pidan

    backend = Backend(os.environ["CAC_INTERNAL_URL"], os.environ["RECORDINGS_MUX_KEY"])
    mux = Mux(backend, os.environ["RECORDINGS_BUCKET"], boto3.client("s3"))
    log.info("mux up, polling %s every %ss", backend.base, POLL_S)
    mux.run_forever()


if __name__ == "__main__":
    main()
