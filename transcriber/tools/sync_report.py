"""Lee las dos pistas de una toma de claqueta y dice cuánto se han movido.

    python3 tools/sync_report.py /tmp/clap3

En el directorio tiene que haber las dos pistas bajadas de S3 y un `info.json`:

    {"mic":    {"path": "…​.ogg",  "started_at": 1789699885295980825},
     "screen": {"path": "…​.webm", "started_at": 1789699891072580501},
     "schedule": [1789699887.802, …]}          ← lo que imprimió `clapper.py`

`schedule` es opcional pero es lo que convierte la medida en una acusación con
nombre: separa el error del ancla (lo que se quiere medir) del retardo del
propio emisor (la cola del `AudioSource`, que es del cliente y no del grabador).

Sin numpy a propósito: la envolvente de un minuto de audio a 5 ms cabe de sobra
en una lista, y así el guion corre donde caiga sin instalar nada.
"""

import array
import json
import math
import os
import re
import subprocess
import sys

# Un golpe en el audio: sube por encima de −12 dB de pico viniendo de por debajo
# de −30. En el vídeo: la luma media cruza 200 hacia arriba. Los dos son umbrales
# de una señal fabricada para ser inconfundible; no valen para voz de verdad.
AUDIO_ON_DB, AUDIO_OFF_DB = -12.0, -30.0
VIDEO_WHITE = 200.0
PAIR_WINDOW_S = 1.0


def audio_claps(path: str) -> list[float]:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000",
         "-f", "s16le", "-y", "/tmp/clap_mic.raw"], check=True)
    samples = array.array("h")
    samples.frombytes(open("/tmp/clap_mic.raw", "rb").read())
    window = 80  # 5 ms a 16 kHz
    count = len(samples) // window
    envelope = []
    for i in range(count):
        total = 0
        for v in samples[i * window : (i + 1) * window]:
            total += v * v
        envelope.append(math.sqrt(total / window))
    peak = max(envelope) or 1.0
    db = [20 * math.log10(e / peak) if e > 0 else -120 for e in envelope]
    out, i = [], 1
    while i < count:
        if db[i] > AUDIO_ON_DB and db[i - 1] < AUDIO_OFF_DB:
            out.append(i * 0.005)
            i += 40  # el golpe dura 60 ms; no se cuenta dos veces
        else:
            i += 1
    return out


def video_claps(path: str) -> list[float]:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf",
         "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=/tmp/clap_yavg.txt",
         "-f", "null", "-"], check=True, capture_output=True)
    text = open("/tmp/clap_yavg.txt").read()
    out, previous = [], 0.0
    for t, y in re.findall(r"pts_time:([0-9.]+)\n.*?YAVG=([0-9.]+)", text):
        y = float(y)
        if y > VIDEO_WHITE >= previous:
            out.append(float(t))
        previous = y
    return out


def main() -> int:
    d = sys.argv[1]
    info = json.load(open(os.path.join(d, "info.json")))
    mic_anchor = info["mic"]["started_at"] / 1e9
    screen_anchor = info["screen"]["started_at"] / 1e9
    schedule = info.get("schedule")

    audio = audio_claps(info["mic"]["path"])
    video = video_claps(info["screen"]["path"])
    print("golpes en el audio (t del .ogg):  ", ["%.3f" % x for x in audio])
    print("golpes en el vídeo (t del .webm): ", ["%.3f" % x for x in video])
    print()
    print("ancla micro − ancla pantalla = %+.1f ms"
          % ((mic_anchor - screen_anchor) * 1000))
    print()

    # Se casa por **tiempo de pared**, no por número de golpe: si un egress
    # arranca tarde se pierde los primeros, y el golpe 1 de uno es el 3 del otro.
    pairs = []
    for ta in audio:
        wa = mic_anchor + ta
        near = [tv for tv in video if abs((screen_anchor + tv) - wa) < PAIR_WINDOW_S]
        if near:
            pairs.append((wa, screen_anchor + near[0]))

    header = "  golpe |   audio→pared |   vídeo→pared | audio−vídeo"
    if schedule:
        header += " | audio−horario | vídeo−horario"
    print(header)
    for n, (wa, wv) in enumerate(pairs, 1):
        row = "  %5d | %13.3f | %13.3f | %+8.0f ms" % (n, wa, wv, (wa - wv) * 1000)
        if schedule:
            due = min(schedule, key=lambda x: abs(x - wa))
            row += " | %+10.0f ms | %+10.0f ms" % ((wa - due) * 1000, (wv - due) * 1000)
        print(row)

    if not pairs:
        print("  (ningún golpe coincide: ¿arrancó un egress fuera de tiempo?)")
        return 1

    gaps = [wa - wv for wa, wv in pairs]
    mean = sum(gaps) / len(gaps)
    print()
    print("aplicando el ancla:  media %+.0f ms   dispersión %.0f ms"
          % (mean * 1000, (max(gaps) - min(gaps)) * 1000))
    print("si se ignorara el ancla, el error sería el desfase entero: %+.0f ms"
          % ((screen_anchor - mic_anchor + mean) * 1000))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
