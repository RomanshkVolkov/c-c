// Package livekit habla con el SFU: descubrir quién está dentro, arrancar y
// parar los egress de cada pista, y poner el aviso de «se está grabando» en el
// metadata de la sala.
//
// # Por qué los clientes generados y no otro JSON a mano
//
// `service/voice.go` ya tiene un cliente Twirp escrito a mano, y funciona
// porque son dos llamadas con campos planos. Aquí no valdría: `TrackEgressRequest`
// lleva un **`oneof`** (`file` vs `stream`), y `encoding/json` no sabe
// serializar un `oneof` de protobuf — escribiría un objeto que el servidor lee
// como «sin salida» y el egress se quedaría sin sitio donde escribir.
//
// Y ya está en el árbol: `livekit/protocol` viene con el módulo, así que los
// clientes generados no traen ninguna dependencia nueva. La lección de la fase 0
// pesa lo suyo aquí — el JSON de Twirp del SFU es **`snake_case`**, y un cliente
// a mano con campos `camelCase` lee `nil` en silencio y hace creer que LiveKit
// no da marcas de tiempo.
package livekit

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
	lksdk "github.com/livekit/protocol/livekit"
)

// ErrUnconfigured: no hay SFU. Igual que en la voz, no es un fallo: una
// instalación sin llaves es legítima y la pantalla debe poder decirlo.
var ErrUnconfigured = errors.New("livekit is not configured")

// Client es la superficie que el servicio usa. Pequeña a propósito: es lo que
// permite doblarla entera en las pruebas del reloj sin levantar un SFU.
type Client interface {
	Participants(ctx context.Context, room string) ([]*lksdk.ParticipantInfo, error)
	StartTrackEgress(ctx context.Context, room, trackSID, key string) (*lksdk.EgressInfo, error)
	StopEgress(ctx context.Context, room, egressID string) (*lksdk.EgressInfo, error)
	ListEgress(ctx context.Context, room string) ([]*lksdk.EgressInfo, error)
	SetRoomMetadata(ctx context.Context, room, metadata string) error
}

type client struct {
	base   string
	key    string
	secret string
	http   *http.Client
}

// New construye el cliente. `url` es la de señalización (`wss://…`): la API de
// administración vive en el mismo host por https.
func New(url, key, secret string) Client {
	if url == "" || key == "" || secret == "" {
		return nil
	}
	base := strings.Replace(strings.Replace(url, "wss://", "https://", 1), "ws://", "http://", 1)
	return &client{
		base: base, key: key, secret: secret,
		// Timeout propio: una llamada al SFU que se cuelga bloquearía el tick
		// entero, y detrás del tick va el descubrimiento de pistas de todas las
		// grabaciones vivas.
		http: &http.Client{Timeout: 15 * time.Second},
	}
}

// tokenTTL corto: cada llamada acuña el suyo. Es una llave de una operación, no
// una sesión.
const tokenTTL = time.Minute

// bearer acuña el JWT de una llamada.
//
// **`RoomRecord` es obligatorio para cualquier `Egress.*`** — sin él LiveKit
// contesta 401, y costó verlo porque el 401 no dice qué concesión falta. Se
// concede sólo cuando hace falta: administrar una sala y grabarla son permisos
// distintos y no hay razón para llevar los dos siempre.
func (c *client) bearer(room string, record bool) (string, error) {
	grant := &auth.VideoGrant{RoomAdmin: true, Room: room}
	if record {
		grant.RoomRecord = true
	}
	return auth.NewAccessToken(c.key, c.secret).
		SetVideoGrant(grant).
		SetIdentity("cac-server").
		SetValidFor(tokenTTL).
		ToJWT()
}

// doer mete el `Authorization` en el transporte, que es donde el cliente
// generado deja sitio para él: su interfaz `HTTPClient` sólo recibe la petición
// ya construida.
type doer struct {
	inner *http.Client
	token string
}

func (d doer) Do(req *http.Request) (*http.Response, error) {
	req.Header.Set("Authorization", "Bearer "+d.token)
	return d.inner.Do(req)
}

func (c *client) egress(room string) (lksdk.Egress, error) {
	t, err := c.bearer(room, true)
	if err != nil {
		return nil, err
	}
	return lksdk.NewEgressProtobufClient(c.base, doer{c.http, t}), nil
}

func (c *client) rooms(room string) (lksdk.RoomService, error) {
	t, err := c.bearer(room, false)
	if err != nil {
		return nil, err
	}
	return lksdk.NewRoomServiceProtobufClient(c.base, doer{c.http, t}), nil
}

// Participants: quién está dentro y qué publica cada uno.
//
// Es el descubrimiento de pistas **sin webhooks**. La alternativa era escuchar
// los eventos de LiveKit, y es peor por la misma razón que en `voice.go`: ese
// estado se desincroniza con el primer evento perdido y con el primer reinicio,
// y entonces miente sin que nada falle. El SFU tiene la verdad por definición.
func (c *client) Participants(ctx context.Context, room string) ([]*lksdk.ParticipantInfo, error) {
	svc, err := c.rooms(room)
	if err != nil {
		return nil, err
	}
	res, err := svc.ListParticipants(ctx, &lksdk.ListParticipantsRequest{Room: room})
	if err != nil {
		return nil, err
	}
	return res.Participants, nil
}

// StartTrackEgress escribe una pista tal como llega, sin decodificarla.
//
// **Sin `S3` en la petición**: las credenciales del bucket están en la
// configuración del propio Egress (`EGRESS_CONFIG_BODY`), no aquí. Mandarlas en
// cada llamada las pasearía por la red y las metería en los registros del SFU
// para no ganar nada.
//
// `Filepath` va sin extensión a propósito: Egress le pone la que corresponda al
// códec real. Ver `domain.RecordingTrack.ObjectKey`.
func (c *client) StartTrackEgress(ctx context.Context, room, trackSID, key string) (*lksdk.EgressInfo, error) {
	svc, err := c.egress(room)
	if err != nil {
		return nil, err
	}
	return svc.StartTrackEgress(ctx, &lksdk.TrackEgressRequest{
		RoomName: room,
		TrackId:  trackSID,
		Output: &lksdk.TrackEgressRequest_File{
			File: &lksdk.DirectFileOutput{Filepath: key, DisableManifest: true},
		},
	})
}

func (c *client) StopEgress(ctx context.Context, room, egressID string) (*lksdk.EgressInfo, error) {
	svc, err := c.egress(room)
	if err != nil {
		return nil, err
	}
	return svc.StopEgress(ctx, &lksdk.StopEgressRequest{EgressId: egressID})
}

// ListEgress: todo lo que el SFU sabe de los egress de una sala.
//
// Una llamada por tick reconcilia la grabación entera. Preguntar por cada
// egress sería una llamada por pista, y con seis personas eso son siete.
func (c *client) ListEgress(ctx context.Context, room string) ([]*lksdk.EgressInfo, error) {
	svc, err := c.egress(room)
	if err != nil {
		return nil, err
	}
	res, err := svc.ListEgress(ctx, &lksdk.ListEgressRequest{RoomName: room})
	if err != nil {
		return nil, err
	}
	return res.Items, nil
}

// SetRoomMetadata es cómo se entera de la grabación quien **entra tarde**.
//
// Por SSE se avisa a quien ya estaba; el metadata de la sala se lo entrega
// LiveKit a cualquiera que se conecte después, sin que nadie tenga que repetir
// nada. Cadena vacía lo borra.
func (c *client) SetRoomMetadata(ctx context.Context, room, metadata string) error {
	svc, err := c.rooms(room)
	if err != nil {
		return err
	}
	_, err = svc.UpdateRoomMetadata(ctx, &lksdk.UpdateRoomMetadataRequest{
		Room: room, Metadata: metadata,
	})
	return err
}
