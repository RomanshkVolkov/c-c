//! Terminales de verdad contra un servidor, desde la app.
//!
//! Dos cosas que parecen detalles y no lo son:
//!
//! **Por SSH y no por el agente de a bordo.** Lo natural sería añadirle un
//! `exec` a `swarm-manage/`, que ya sabe hablar con el docker.sock de la
//! máquina. Pero ese agente no tiene ninguna autenticación —sus rutas sólo
//! montan log, recovery y un CORS abierto— y escucha en un puerto público. Un
//! `exec` ahí sería una shell de root en el VPS para cualquiera que sepa la IP.
//! Por SSH la autorización ya existe y es la correcta: la llave la guarda el
//! agente SSH del usuario y la mitad privada nunca sale de su máquina.
//!
//! **Con un pty local y no con tuberías.** `ssh` saca el tamaño de la ventana
//! del tty que tiene delante. Sin tty local no hay tamaño, nunca manda
//! `SIGWINCH`, y todo lo que dibuje —`htop`, `vim`, `less`— se queda en 80×24
//! para siempre por mucho que estires el panel.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{LazyLock, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::{resolve_agent_socket, stage_public_key, EphemeralIdentity};

/// Lo que la sesión le manda a su pestaña.
///
/// Los bytes viajan en base64 a propósito. Un pty entrega bytes, y una lectura
/// puede cortar un carácter UTF-8 por la mitad: decodificar aquí convertiría
/// cada acento a caballo entre dos lecturas en basura. En base64 llegan
/// intactos y es xterm —que sí sabe juntar trozos— quien los interpreta.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    Data {
        b64: String,
    },
    /// La sesión terminó. Sin esto la pestaña se queda muda y parece colgada.
    Exit {
        code: u32,
    },
}

/// Dónde se abre la shell.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyTarget {
    /// La máquina: `ssh` a secas da la shell de login.
    Host,
    /// Dentro del contenedor de un servicio del swarm.
    Service { name: String },
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// La clave pública vive lo que viva la sesión, no lo que viva la llamada
    /// que la abrió. En las órdenes de un disparo (`deploy`, `update`) el guarda
    /// se destruye al volver de `ssh_run` y eso es correcto; aquí `ssh` sigue
    /// corriendo minutos después, y si el fichero desaparece antes, la próxima
    /// reconexión de la sesión se queda sin identidad.
    _identity: Option<EphemeralIdentity>,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, PtySession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// El guion que abre una shell dentro del contenedor de un servicio.
///
/// `bash` si la imagen lo trae y `sh` si no: media flota son imágenes alpine o
/// casi-distroless, y un `docker exec … bash` a secas falla con un error que no
/// dice por qué.
///
/// Y avisa cuando la tarea no corre aquí. `docker exec` sólo alcanza
/// contenedores de la máquina a la que entras, así que en un swarm de varios
/// nodos el servicio puede estar perfectamente vivo y aun así no haber nada que
/// abrir desde este lado. Decirlo con palabras cuesta dos líneas; no decirlo
/// deja al usuario mirando un error de docker que no explica nada.
pub fn service_shell_script(service: &str) -> Result<String, String> {
    if !nombre_de_servicio_valido(service) {
        return Err(format!(
            "Refusing to open a shell for {service:?}: not a valid Docker service name."
        ));
    }
    Ok(format!(
        r#"cid=$(docker ps -q -f label=com.docker.swarm.service.name={service} | head -n1)
if [ -z "$cid" ]; then
  echo "No task of {service} is running on this node — docker exec only reaches containers on the machine you log into."
  exit 1
fi
exec docker exec -it "$cid" sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'"#
    ))
}

/// El nombre acaba dentro de una orden que interpreta una shell remota, así que
/// una comilla ahí es ejecución arbitraria en el VPS. Docker ya restringe los
/// nombres a esto mismo, pero comprobarlo aquí es lo que hace que el argumento
/// «no puede llevar comillas» no dependa de la buena fe de quien conteste al
/// otro lado.
fn nombre_de_servicio_valido(s: &str) -> bool {
    if s.is_empty() || s.len() > 128 {
        return false;
    }
    let mut chars = s.chars();
    let primero = chars.next().unwrap();
    if !primero.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// Los argumentos de `ssh` para una sesión interactiva.
///
/// Comparte con `ssh_run` la razón de cada opción: `BatchMode` para que una
/// llave no autorizada falle en el acto en vez de esperar una contraseña que
/// este camino no va a pedir, `accept-new` para fijar el host la primera vez, y
/// `IdentitiesOnly` cuando hay llave elegida —un agente con muchas llaves las
/// ofrece una a una hasta que el servidor corta por `MaxAuthTries`, casi
/// siempre antes de llegar a la buena.
///
/// Lo propio de una sesión: `-tt` fuerza el tty aunque haya orden remota (sin
/// él, `docker exec -it` no tiene terminal que asignar), y los `ServerAlive`
/// hacen que una red que se cae cierre la sesión en un minuto y medio en vez de
/// dejar una pestaña viva contra nada.
fn ssh_args(host: &str, port: u16, user: &str, identity: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-tt".into(),
        "-p".into(),
        port.to_string(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ConnectTimeout=15".into(),
        "-o".into(),
        "ServerAliveInterval=30".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
    ];
    if let Some(id) = identity.filter(|s| !s.trim().is_empty()) {
        args.push("-i".into());
        args.push(id.trim().to_string());
        args.push("-o".into());
        args.push("IdentitiesOnly=yes".into());
    }
    args.push(format!("{user}@{host}"));
    args
}

#[tauri::command]
pub fn pty_open(
    server_id: String,
    host: String,
    ssh_port: u16,
    ssh_user: String,
    target: PtyTarget,
    rows: u16,
    cols: u16,
    on_output: Channel<PtyEvent>,
) -> Result<String, String> {
    // La llave se resuelve aquí y no en la pantalla: es la misma que usan
    // deploy y update, y hacerlo en Rust ahorra que cada sitio que quiera abrir
    // un terminal se acuerde de pedirla.
    let staged = match crate::stored_ssh_key(&server_id)
        .ok()
        .flatten()
        .filter(|k| !k.trim().is_empty())
    {
        Some(k) => Some(stage_public_key(&k)?),
        None => None,
    };
    let identity = staged
        .as_ref()
        .map(|s| s.path.to_string_lossy().into_owned());

    let mut cmd = CommandBuilder::new("ssh");
    for a in ssh_args(&host, ssh_port, &ssh_user, identity.as_deref()) {
        cmd.arg(a);
    }
    if let PtyTarget::Service { name } = &target {
        cmd.arg(service_shell_script(name)?);
    }
    // Sin `TERM` la shell remota se cree un terminal tonto y sale todo en
    // blanco y negro sin poder moverse por la línea.
    cmd.env("TERM", "xterm-256color");
    // Igual que en `ssh_run`: sin esto, una app lanzada desde el escritorio no
    // ve ningún agente y todo acaba en "Permission denied (publickey)".
    if let Some(sock) = resolve_agent_socket() {
        cmd.env("SSH_AUTH_SOCK", sock);
    }

    let Abierto {
        master,
        reader,
        writer,
        child,
    } = abrir_pty(cmd, rows, cols)?;

    let id = format!("pty-{}", crate::ephemeral_suffix());
    SESSIONS.lock().unwrap().insert(
        id.clone(),
        PtySession {
            master,
            writer,
            child,
            _identity: staged,
        },
    );

    bombear(id.clone(), reader, on_output);
    Ok(id)
}

struct Abierto {
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Abre el pty y arranca la orden dentro. Separado de `pty_open` para poder
/// probarlo con una orden local: lo de arriba necesita un servidor de verdad,
/// y esta es la parte donde un descuido con los descriptores no da error, sólo
/// una sesión que nunca dice que terminó.
fn abrir_pty(cmd: CommandBuilder, rows: u16, cols: u16) -> Result<Abierto, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Could not open a terminal: {e}"))?;

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        let s = e.to_string();
        if s.contains("No such file") {
            "`ssh` binary not found on PATH.".to_string()
        } else {
            format!("Could not start ssh: {s}")
        }
    })?;
    // El lado esclavo se suelta en cuanto el hijo lo tiene. Mientras quede uno
    // abierto de este lado, la lectura del maestro nunca ve EOF y la pestaña
    // espera para siempre un final que ya ocurrió. Hoy el `drop` es redundante
    // —el esclavo muere igual al acabar la función, porque sólo el maestro sale
    // de aquí— y está escrito igualmente: dice la condición en voz alta, para
    // que guardarse el par en algún sitio sea un cambio evidente y no un cuelgue
    // que nadie sabe explicar.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Could not read from the terminal: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Could not write to the terminal: {e}"))?;

    Ok(Abierto {
        master: pair.master,
        reader,
        writer,
        child,
    })
}

/// Vuelca lo que salga del pty en el canal de su pestaña, hasta que se acabe.
fn bombear(id: String, mut reader: Box<dyn Read + Send>, canal: Channel<PtyEvent>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    // Un envío fallido significa que la pestaña ya no está: no
                    // hay a quién seguir escribiéndole.
                    if canal.send(PtyEvent::Data { b64 }).is_err() {
                        break;
                    }
                }
            }
        }
        // Se saca del mapa antes de esperar al hijo: `wait` necesita el
        // préstamo mutable, y dejarlo dentro bloquearía el mapa para todos
        // mientras tanto.
        let salida = SESSIONS
            .lock()
            .unwrap()
            .remove(&id)
            .and_then(|mut s| s.child.wait().ok())
            .map(|st| st.exit_code())
            .unwrap_or(0);
        let _ = canal.send(PtyEvent::Exit { code: salida });
    });
}

#[tauri::command]
pub fn pty_write(id: String, data: String) -> Result<(), String> {
    let mut mapa = SESSIONS.lock().unwrap();
    let s = mapa.get_mut(&id).ok_or("That terminal session is gone")?;
    s.writer
        .write_all(data.as_bytes())
        .and_then(|_| s.writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(id: String, rows: u16, cols: u16) -> Result<(), String> {
    let mapa = SESSIONS.lock().unwrap();
    let s = mapa.get(&id).ok_or("That terminal session is gone")?;
    s.master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Cerrar es matar. Sin esto queda un `ssh` vivo por cada pestaña que se cerró.
#[tauri::command]
pub fn pty_close(id: String) {
    if let Some(mut s) = SESSIONS.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}

/// Al cerrar la ventana. En Unix el `ssh` moriría igual al cerrarse el maestro,
/// pero apoyarse en eso es apostar a cómo se destruyen los descriptores durante
/// una salida.
pub fn close_all() {
    for (_, mut s) in SESSIONS.lock().unwrap().drain() {
        let _ = s.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_guion_busca_el_contenedor_por_etiqueta_y_cae_a_sh() {
        let g = service_shell_script("portento_api").expect("nombre corriente");
        assert!(g.contains("label=com.docker.swarm.service.name=portento_api"));
        assert!(g.contains("exec bash"));
        assert!(g.contains("exec sh"));
        // El aviso de «no corre aquí» tiene que estar: es la diferencia entre
        // entender el fallo y ver un error de docker sin contexto.
        assert!(g.contains("No task of portento_api is running on this node"));
    }

    /// Lo que importa de verdad: el nombre acaba dentro de una orden que
    /// interpreta una shell remota.
    #[test]
    fn rechaza_todo_lo_que_pueda_escaparse_de_la_orden() {
        for malo in [
            "svc; rm -rf /",
            "svc$(id)",
            "svc`id`",
            "svc'x'",
            "svc\"x\"",
            "svc x",
            "svc|cat",
            "svc\nid",
            "-svc",
            "",
        ] {
            assert!(
                service_shell_script(malo).is_err(),
                "debería rechazar {malo:?}"
            );
        }
    }

    #[test]
    fn acepta_los_nombres_que_docker_permite() {
        for bueno in ["api", "cac_swarm-manage", "stack_svc.1", "a", "A9"] {
            assert!(
                service_shell_script(bueno).is_ok(),
                "debería aceptar {bueno:?}"
            );
        }
    }

    /// Sin `-tt` no hay terminal remoto y `docker exec -it` no arranca; sin
    /// `IdentitiesOnly` el agente ofrece todas sus llaves y el servidor corta.
    /// La plomería del pty, con una orden local en vez de ssh.
    ///
    /// Prueba lo que no se ve hasta que falla: que soltar el esclavo deja que
    /// la lectura vea EOF —sin eso la pestaña nunca diría «terminó»—, que el
    /// código de salida llega, y que dentro hay un terminal de verdad (`tty -s`
    /// falla si no lo hay, que es exactamente lo que rompe `docker exec -it`).
    #[cfg(unix)]
    #[test]
    fn el_pty_entrega_la_salida_el_final_y_un_tty() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("tty -s && echo hola; exit 3");

        let mut a = abrir_pty(cmd, 24, 80).expect("se abre");
        let mut salida = String::new();
        a.reader.read_to_string(&mut salida).expect("lee hasta EOF");

        assert!(salida.contains("hola"), "salida: {salida:?}");
        assert_eq!(a.child.wait().unwrap().exit_code(), 3);
    }

    /// Y que lo que se escribe llega al otro lado: es el camino de las teclas.
    #[cfg(unix)]
    #[test]
    fn lo_que_se_escribe_llega_al_proceso() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("read linea; echo \"eco:$linea\"");

        let mut a = abrir_pty(cmd, 24, 80).expect("se abre");
        a.writer.write_all(b"cuchi\n").unwrap();
        a.writer.flush().unwrap();

        let mut salida = String::new();
        a.reader.read_to_string(&mut salida).expect("lee hasta EOF");
        assert!(salida.contains("eco:cuchi"), "salida: {salida:?}");
        let _ = a.child.wait();
    }

    #[test]
    fn los_argumentos_de_ssh_fuerzan_tty_y_fijan_la_llave() {
        let con = ssh_args("1.2.3.4", 2222, "root", Some("/tmp/k.pub"));
        assert!(con.contains(&"-tt".to_string()));
        assert!(con.contains(&"IdentitiesOnly=yes".to_string()));
        assert!(con.contains(&"/tmp/k.pub".to_string()));
        assert_eq!(con.last().unwrap(), "root@1.2.3.4");
        assert!(con.contains(&"2222".to_string()));

        // Sin llave elegida no se fija ninguna: `IdentitiesOnly` sin `-i` deja
        // a ssh sin ninguna identidad que ofrecer.
        let sin = ssh_args("h", 22, "u", None);
        assert!(!sin.contains(&"IdentitiesOnly=yes".to_string()));
        assert!(!sin.contains(&"-i".to_string()));
    }
}
