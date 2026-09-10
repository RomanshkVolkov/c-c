"""Configuración del worker: todo por entorno, nada por fichero.

Un secreto que se lee de una variable no acaba en un `ConfigMap` ni en un `git
diff` por descuido. Y `require` falla nombrando la variable que falta, nunca su
valor: un arranque roto tiene que decir qué le falta sin enseñar lo que ya tiene.
"""

import os


class MissingSetting(RuntimeError):
    pass


def require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise MissingSetting(f"falta la variable de entorno {name}")
    return value


def optional(name: str, default: str) -> str:
    return os.environ.get(name) or default


def as_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as err:
        raise MissingSetting(f"{name} no es un entero") from err


# URL interna del SFU. Desde un pod se llega por el DNS del clúster; el spike
# comprueba justo que el *media* también llegue, que es otra cosa.
def livekit_url() -> str:
    return optional("LIVEKIT_URL", "ws://livekit.default.svc.cluster.local:7880")
