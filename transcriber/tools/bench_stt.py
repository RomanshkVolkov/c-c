"""Mide el `rtf` del modelo sobre audio real. Puerta (b) de la fase 0.

    uv run --extra stt python tools/bench_stt.py grabacion/*.wav

Se le pasan **las pistas por separado**, una por persona, que es como transcribe
la producción. Medir sobre una mezcla de 30 minutos daría un número más malo y
además falso: cada pista es mayormente silencio y el VAD es justo lo que hace
barato este diseño. Sumar las pistas es la medida honesta.

Los ajustes son los de producción a propósito. Cambiar `beam_size` o el VAD aquí
convertiría el número en una promesa que el worker no va a cumplir.
"""

import argparse
import json
import sys
import time
import wave
from pathlib import Path

from faster_whisper import WhisperModel

# El objetivo del plan: si `large-v3-turbo` no va al menos a 3× tiempo real
# sobre este hardware, se baja a `medium`.
TARGET_SPEEDUP = 3.0

# Cada cuánto decir por dónde va. No es cosmético: sin esto la única forma de
# saber si sigue trabajando es adivinar.
PROGRESS_EVERY_SECONDS = 20.0


def audio_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as wav:
        return wav.getnframes() / wav.getframerate()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("wavs", nargs="+", type=Path)
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--language", default="es")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    print(
        f"  cargando {args.model} int8 con {args.threads} hilos"
        " (la primera vez se lo descarga, ~1,5 GB)",
        flush=True,
    )
    loading = time.monotonic()
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        # Seis y no ocho: quedan dos para LiveKit, el backend y Postgres, que
        # comparten el host.
        cpu_threads=args.threads,
    )
    load_seconds = time.monotonic() - loading

    tracks = []
    for path in args.wavs:
        seconds = audio_seconds(path)
        started = time.monotonic()
        segments, _ = model.transcribe(
            str(path),
            language=args.language,
            beam_size=5,
            vad_filter=True,
            # El anti-bucle de alucinación más efectivo, y cambia el coste: sin
            # esto el modelo arrastra contexto y tarda distinto.
            condition_on_previous_text=False,
            word_timestamps=False,
        )
        # `transcribe` es perezoso: hasta que no se recorre, no ha trabajado.
        #
        # Y se recorre contando, no con `sum(1 for _ in …)`, porque cada segmento
        # trae su posición en el audio (`end`) y con eso se sabe por dónde va.
        # Una medida que tarda minutos y no dice nada hasta el final es
        # indistinguible de una colgada — y eso ya costó una hora de nodo al
        # triple de carga, por relanzar encima de algo que seguía vivo.
        count = 0
        ultimo_aviso = started
        for segment in segments:
            count += 1
            ahora = time.monotonic()
            if ahora - ultimo_aviso >= PROGRESS_EVERY_SECONDS:
                corrido = ahora - started
                print(
                    f"  … {segment.end / 60:5.1f} / {seconds / 60:.1f} min de audio"
                    f"   en {corrido / 60:5.1f} min"
                    f"   ({segment.end / corrido:.2f}× por ahora)",
                    flush=True,
                )
                ultimo_aviso = ahora
        elapsed = time.monotonic() - started
        tracks.append(
            {
                "file": path.name,
                "audioSeconds": round(seconds, 1),
                "wallSeconds": round(elapsed, 1),
                "speedup": round(seconds / elapsed, 2) if elapsed else None,
                "segments": count,
            }
        )

    audio = sum(t["audioSeconds"] for t in tracks)
    wall = sum(t["wallSeconds"] for t in tracks)
    result = {
        "model": args.model,
        "threads": args.threads,
        "computeType": "int8",
        "loadSeconds": round(load_seconds, 1),
        "audioSeconds": round(audio, 1),
        "wallSeconds": round(wall, 1),
        "rtf": round(wall / audio, 3) if audio else None,
        "speedup": round(audio / wall, 2) if wall else None,
        "tracks": tracks,
    }
    result["passed"] = bool(result["speedup"] and result["speedup"] >= TARGET_SPEEDUP)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print()
        print(f"  modelo        {result['model']} int8, {result['threads']} hilos")
        print(f"  cargar        {result['loadSeconds']} s")
        for track in tracks:
            print(
                f"    · {track['file']:<28} {track['audioSeconds']:>7} s audio"
                f" → {track['wallSeconds']:>7} s   {track['speedup']}×"
            )
        print(f"  total         {result['audioSeconds']} s audio en {result['wallSeconds']} s")
        print(f"  rtf           {result['rtf']}   ({result['speedup']}× tiempo real)")
        print()
        print(
            f"  vale: {result['model']}"
            if result["passed"]
            else f"  por debajo de {TARGET_SPEEDUP}× — bajar a `medium`"
        )
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
