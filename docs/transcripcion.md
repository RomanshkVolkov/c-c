# Transcripción de llamadas: el acta del terreno

Como `voz.md`, y por lo mismo: la decisión cara de este trabajo —**dónde escucha
el bot**— depende de un hecho que no se sabe, y se mide antes de escribir el
resto. Este documento es el sitio donde ese hecho aterriza con fecha y números.

Última revisión: **2026-09-09**. Estado: **fase 0 escrita, sin medir**.

## 1 · Las dos preguntas de la fase 0

Ninguna de las dos se contesta leyendo. Hasta que tengan número, el plan
(`transcripción y resumen de llamadas`) no pasa de aquí.

### (a) ¿Llega el media de WebRTC desde un pod hasta el SFU?

El diseño elegido es un **bot participante**: un pod entra a la sala como uno
más y se suscribe al audio. Eso obliga a que el media llegue, y el media no va
por donde va la señalización.

LiveKit corre con `hostNetwork: true` y `use_external_ip: true`
(`backend/k8s/5-livekit.yaml`, con su porqué escrito allí): anuncia en sus
candidatos ICE la **IP pública** que descubre por STUN, porque el VPS está
detrás del NAT de AWS. Un cliente de fuera la alcanza — es el caso para el que
se hizo.

Un pod de la red de Cilium es otro caso. Para mandarle UDP a esa IP tiene que
salir del VPC y volver a entrar, y ese rebote **puede no existir**. La
señalización no lo detecta: el `Service` de `livekit` sólo publica el 7880, así
que el WebSocket conecta igual y la sala se une igual. Lo que faltaría es el
audio, en silencio.

Se mide con un Job que **no** lleva `hostNetwork`, entra a una sala real y
cuenta segundos de audio por persona:

```sh
kubectl apply -f transcriber/k8s/spike.yaml     # tras poner la sala en args
kubectl logs -f job/transcriber-spike
```

Sale con 0 si alguna pista trajo ≥ 5 s de audio, con 1 si no.

**Si sale 1**, en este orden, y lo que funcione se anota en `5-livekit.yaml`
como medida y no como idea:

1. `rtc.tcp_port` (7881) desde el pod. Peor latencia, pero conecta, y a un bot
   que sólo escucha la latencia le da igual.
2. Añadir la IP privada del nodo a los candidatos (`rtc.node_ip`), para que el
   pod tenga una ruta que no salga del VPC.
3. Si ninguna vale: **el plan cambia a Egress y se re-planifica**. Egress cuesta
   `redis:` en LiveKit (la voz pasaría a depender de Valkey), webhooks para las
   pistas tardías, una imagen de 2 GB con Chrome dentro, y un participante que
   nadie ve — por eso es el plan B y no el A.

#### Medido el 12-sep-2026 — **pasa**

| Medida | Resultado |
|---|---|
| Conecta (WebSocket + sala) | **0,73 s** |
| Primera muestra de audio | **1,18 s** |
| Segundos de audio en 120 s de escucha | **119,52 s** (99%, sin cortes) |
| Salida del Job | **0** |

El media llega. **No hace falta `rtc.tcp_port` ni `rtc.node_ip`**, y el plan no
cambia a Egress: el bot participante se sostiene tal como está diseñado.

Cómo se midió, porque cambia lo que la medida significa: el Job levanta **dos**
bots en el mismo pod — el grabador, con su token de sólo escucha, y un suplente
(`spike-speaker`) que publica un tono de 440 Hz. Sin él no habría audio que
contar: en un pod no hay nadie hablando.

Eso deja la prueba en pod → SFU → pod, y **es la pregunta entera**: el grabador
nunca habla con un navegador, sólo con el SFU, así que su camino es el mismo
venga el audio de donde venga. Lo que el suplente sustituye es a la persona, no
al SFU.

Y el grabador llevaba `can_publish: False` durante toda la medida, que es lo que
la hace honesta: demuestra que un token de **sólo escucha** recibe media por ese
camino. Darle permiso de publicar para simplificar habría medido algo que no es
lo que se despliega.

Lo que esto no cubre: un cliente real publicando desde fuera del clúster. Su
audio llega al SFU por otro camino que este Job no ejercita — pero ése es el
camino que ya funciona todos los días, y no es el que estaba en duda.

### (b) ¿Cuánto tarda el modelo en este hardware?

Sin GPU. El host es 8 vCPU EPYC con AVX2 y 23 GB, y **de esos 8 hay ~1,5–2
cores permanentemente ocupados por el plano de control de k8s** (`kube-apiserver`,
`cilium-agent`, `kubelet`, `etcd`), que viajan con cac al host que sea. De ahí
`cpu_threads=6`: quedan dos para LiveKit, el backend y Postgres.

Se mide con las pistas **por separado**, que es como transcribe la producción.
Medir sobre una mezcla daría un número peor y además falso: cada pista es casi
toda silencio, y el VAD es justo lo que hace barato este diseño.

```sh
cd transcriber && uv run --extra stt python tools/bench_stt.py grabacion/*.wav
```

El objetivo es **≥ 3× tiempo real** con `large-v3-turbo` int8. Por debajo, se
baja a `medium`: media hora de llamada tardando más de diez minutos convierte
«el resumen llega al rato» en «el resumen llega cuando ya no importa».

| Medida | Resultado |
|---|---|
| Audio de la prueba | *sin medir* |
| `large-v3-turbo` int8, 6 hilos | *sin medir* |
| `medium` int8, 6 hilos (si hace falta) | *sin medir* |

## 2 · Lo que el spike **no** contesta

Para que nadie lea de más en un verde:

- **No prueba la calidad de la transcripción.** Sólo el coste. La calidad se
  mide en la fase 1 con fixtures y aserciones por palabras clave.
- **No prueba que el bot sea visible** en la sala para los demás. Eso es del
  lado de la app y se ve en la fase 3.
- **No prueba nada sobre el resumen.** El resumidor es lo último de todo (ver
  el orden en `STATUS.md`).
- **Un verde en (a) con una sola persona hablando no es un verde con seis.** El
  spike dice que la ruta existe, no que aguante.
