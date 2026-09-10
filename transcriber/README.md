# `transcriber/`

El bot que entra a una sala de LiveKit, escucha y devuelve el transcript. Es el
**único Python del repo**, y lo es por dos librerías que no tienen equivalente
en Go ni en Rust: `livekit` (rtc), que entrega PCM ya decodificado por pista, y
`faster-whisper`, que es la referencia para transcribir en CPU.

Hoy esto es **la fase 0**: un spike, no un worker. Contesta una sola pregunta
—si el media llega desde un pod— y para eso no hace falta ni servidor ni
modelo. Lo que hay ya está en su forma definitiva; lo que falta, falta entero.

Lo medido va a `docs/transcripcion.md`. El porqué del diseño, al plan.

## Correr el spike

En local, contra un LiveKit de desarrollo o contra el de verdad:

```sh
uv sync --group dev
LIVEKIT_URL=ws://localhost:7880 \
LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… \
  uv run python -m transcriber --room voice:<spaceId> --seconds 120
```

En el clúster, que es donde la pregunta tiene sentido, `k8s/spike.yaml`.

Sale con **0** si llegó audio y con **1** si no. Es la puerta (a) del plan.

## El `rtf` del modelo

```sh
uv run --extra stt python tools/bench_stt.py grabacion/*.wav
```

Una pista por persona, no una mezcla: es como transcribe la producción, y el
VAD sobre pistas casi-silenciosas es lo que hace barato el diseño entero.

## Las pruebas

```sh
uv run pytest -q
```

Sólo cubren la **puerta** del spike, y es donde tienen que estar: si el bot no
conecta se ve a simple vista, pero una puerta que dice «pasó» cuando no pasó
manda el plan tres fases adelante sobre un resultado falso.

Mutadas con `/mutar` (plan en `/tmp`, `"cwd": "transcriber"`).

## Lo que falta para ser un worker

De la fase 1, y en el plan con detalle: `jobs.py` (la máquina de estados),
`stt.py` (+ filtro de alucinaciones), `merge.py` (puro, el más mutado),
`delivery.py` (reintentos y outbox de 24 h), `storage.py` (PVC 0700 y borrado
seguro), `api.py` (`/v1/jobs*`, `/healthz`, `/metrics`), el `Dockerfile.model`
con el CT2 horneado, y el `docker-compose` de desarrollo.
