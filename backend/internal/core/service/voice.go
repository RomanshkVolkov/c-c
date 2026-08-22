package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
)

// ErrVoiceUnconfigured: no hay SFU al que mandar a nadie.
//
// Se distingue de un fallo porque no lo es: una instalación sin voz configurada
// es legítima, y la pantalla debe poder decir «esto no está montado» en vez de
// enseñar un error rojo.
var ErrVoiceUnconfigured = errors.New("voice is not configured")

// VoiceService acuña los permisos de entrada a una sala de LiveKit.
//
// El token se firma **aquí y sólo aquí**. Es lo que hace que la autorización de
// la voz sea la misma que la del resto de cac: la app no conoce el secreto, así
// que no puede fabricarse la entrada a una sala que no le toca. Su única vía es
// pedirla, y quien la concede ya sabe a qué organización pertenece.
type VoiceService struct {
	url    string
	key    string
	secret string
}

func NewVoiceService(url, key, secret string) *VoiceService {
	return &VoiceService{url: url, key: key, secret: secret}
}

// Configured dice si hay SFU. Sin llaves no se acuña nada.
func (s *VoiceService) Configured() bool {
	return s != nil && s.url != "" && s.key != "" && s.secret != ""
}

// RoomFor es el nombre de la sala de un espacio.
//
// Derivado del id **en el servidor**, nunca recibido del cliente: si la sala
// viajara en la petición, cualquiera podría pedir entrada a la de otro equipo y
// el guard de pertenencia estaría comprobando una cosa mientras el token
// concede otra. El prefijo mantiene el espacio de nombres separado de cualquier
// otro uso futuro de LiveKit.
func RoomFor(spaceID string) string { return "voice:" + spaceID }

// TTL corto a propósito: el token es una llave de entrada, no una sesión. Una
// reconexión pide otro, y eso mantiene corta la ventana en la que un token
// filtrado sirve de algo.
const voiceTokenTTL = time.Hour

// Token acuña la entrada de una persona a la sala de un espacio.
//
// `identity` es el id de usuario de cac: es lo que permite que la app sepa quién
// es cada participante sin un segundo directorio, y lo que hace que echar a
// alguien sea posible más adelante.
func (s *VoiceService) Token(spaceID, userID, username string) (string, error) {
	if !s.Configured() {
		return "", ErrVoiceUnconfigured
	}
	sala := RoomFor(spaceID)
	concesion := &auth.VideoGrant{
		RoomJoin: true,
		Room:     sala,
		// Publicar y suscribirse, sí; administrar la sala, no. Un cliente no
		// tiene por qué poder echar a nadie ni cambiar metadatos, y concederlo
		// «por si acaso» es dar permisos que nadie pidió.
		CanPublish:     boolPtr(true),
		CanSubscribe:   boolPtr(true),
		CanPublishData: boolPtr(true),
	}
	t := auth.NewAccessToken(s.key, s.secret).
		SetVideoGrant(concesion).
		SetIdentity(userID).
		SetName(username).
		SetValidFor(voiceTokenTTL)
	return t.ToJWT()
}

// URL del SFU, para que la app sepa a dónde conectarse.
func (s *VoiceService) URL() string { return s.url }

// ─── Quién está dentro ────────────────────────────────────────────────────────

// Ocupacion es quién está en la sala de cada espacio, para poder pintarlo en la
// lista de canales **sin entrar**.
//
// Es la diferencia entre un canal de voz que se usa y uno decorativo: si no ves
// que hay alguien dentro, no entras; y si nadie entra, nunca hay nadie a quien
// ver. Romper ese círculo es el único motivo de esta consulta.
type Ocupacion map[string][]OcupanteResponse

type OcupanteResponse struct {
	// Identity es el id de usuario de cac — el mismo que acuñó el token, así que
	// la pantalla lo cruza con la gente que ya conoce sin un segundo directorio.
	Identity string `json:"identity"`
	Name     string `json:"name"`
}

/*
Se pregunta al SFU en cada consulta, en vez de llevar la cuenta por nuestro lado.

La alternativa era escuchar los webhooks de LiveKit y mantener el estado aquí.
Suena más eficiente y es peor: ese estado se desincroniza con el primer evento
perdido y con el primer reinicio, y entonces la lista miente sin que nada falle
—gente dentro que ya no está, o al revés—. El SFU tiene la verdad por
definición; preguntársela cuesta una llamada en la misma máquina.

Cuando el volumen lo pida, la optimización es cachear unos segundos, no llevar
un registro paralelo.
*/
func (s *VoiceService) Ocupacion(ctx context.Context, spaceIDs []string) (Ocupacion, error) {
	out := Ocupacion{}
	if !s.Configured() || len(spaceIDs) == 0 {
		return out, nil
	}

	// Se piden por nombre y no todas: un superadmin pertenece a muchas
	// organizaciones, y traerse las salas de todas para descartar la mayoría
	// sería contar en el servidor lo que ya sabíamos al preguntar.
	nombres := make([]string, len(spaceIDs))
	for i, id := range spaceIDs {
		nombres[i] = RoomFor(id)
	}
	var salas struct {
		Rooms []struct {
			Name            string `json:"name"`
			NumParticipants int    `json:"numParticipants"`
		} `json:"rooms"`
	}
	if err := s.twirp(ctx, "ListRooms", map[string]any{"names": nombres}, &salas); err != nil {
		return nil, err
	}

	for _, sala := range salas.Rooms {
		if sala.NumParticipants == 0 {
			continue
		}
		var dentro struct {
			Participants []OcupanteResponse `json:"participants"`
		}
		if err := s.twirp(ctx, "ListParticipants", map[string]any{"room": sala.Name}, &dentro); err != nil {
			// Una sala que no se deja leer no tumba las demás: media lista es
			// más útil que un error, y la que falte volverá en la siguiente.
			continue
		}
		out[strings.TrimPrefix(sala.Name, salaPrefijo)] = dentro.Participants
	}
	return out, nil
}

const salaPrefijo = "voice:"

// twirp habla con la API de LiveKit sin arrastrar su SDK de servidor.
//
// Son dos endpoints y un JWT que ya sabemos firmar; el SDK traería consigo grpc
// y la mitad de su árbol de dependencias para eso. Si algún día hacen falta
// diez llamadas más, el SDK deja de ser desproporcionado y entonces se mete.
func (s *VoiceService) twirp(ctx context.Context, metodo string, cuerpo any, salida any) error {
	// El mismo par de llaves, con una concesión distinta: esto administra —lista
	// salas—, así que no vale el token de entrar. Y nunca sale de aquí.
	jwt, err := auth.NewAccessToken(s.key, s.secret).
		SetVideoGrant(&auth.VideoGrant{RoomList: true, RoomAdmin: true}).
		SetIdentity("cac-server").
		SetValidFor(time.Minute).
		ToJWT()
	if err != nil {
		return err
	}

	datos, err := json.Marshal(cuerpo)
	if err != nil {
		return err
	}
	// La URL de señalización es `wss://`; la API es el mismo host por https.
	base := strings.Replace(strings.Replace(s.url, "wss://", "https://", 1), "ws://", "http://", 1)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		base+"/twirp/livekit.RoomService/"+metodo, bytes.NewReader(datos))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", "application/json")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return fmt.Errorf("livekit %s: %s", metodo, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(salida)
}

func boolPtr(b bool) *bool { return &b }
