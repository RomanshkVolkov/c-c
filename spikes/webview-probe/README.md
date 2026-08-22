# Qué sabe hacer de verdad el WebKitGTK de esta máquina

Dos programas de C que abren un webview y le preguntan corriendo JavaScript.

Existen porque `strings` sobre `libwebkit2gtk-4.1.so` **miente en las dos
direcciones**: buscar `JSVideoDecoder` da un falso negativo porque las clases se
llaman `JSWebCodecsVideoDecoder`, y encontrar `JSGPUCommandEncoder` da un falso
positivo porque WebGPU está compilado pero apagado. Preguntar en ejecución no
admite ninguno de los dos errores.

## `probe` — qué APIs responden

```
gcc probe.c -o probe $(pkg-config --cflags --libs webkit2gtk-4.1) && ./probe
```

Imprime un JSON con `RTCPeerConnection`, `MediaSource`, las clases de WebCodecs,
`navigator.gpu`, WebGL2 y algunas más. El acta de esta máquina está en
`docs/voz-video.md` §2.

## `bench` — cuánto aguanta pintando vídeo

```
gcc bench.c -o bench $(pkg-config --cflags --libs webkit2gtk-4.1) && ./bench
```

Compara los tres caminos posibles con los mismos píxeles: `VideoFrame` de
WebCodecs desde I420 crudo, `putImageData` con RGBA convertido en JavaScript, y
`createImageBitmap` de un JPEG. A 640×360, 720p y 1080p.

**Abre una ventana en el escritorio.** Se intentó con `gtk_offscreen_window_new`
y GDK aborta: sin superficie real no hay contexto OpenGL, y entonces no se puede
medir ni WebGL ni nada que dependa de la GPU. La ventana es de 1×1 y se cierra
sola al terminar, pero el gestor de ventanas la enmarca y la pone en medio — así
que **avisa antes de lanzarlo en la máquina de otro**.

Tarda un par de minutos: el `putImageData` a 1080p recorre dos millones de
píxeles en JavaScript, veinte veces.

## Una trampa de la API

El resultado vuelve por `document.title` y no por
`webkit_user_content_manager_register_script_message_handler`. En WebKitGTK
2.52.4 el manejador entrega algo que `jsc_value_to_string` rechaza
(`assertion 'JSC_IS_VALUE(value)' failed`), y el programa se queda esperando un
mensaje que no llega. El título cambia una vez, se observa con `notify::title`,
y no depende de ninguna API que se haya movido de sitio.
