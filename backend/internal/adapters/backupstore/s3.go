// Package backupstore firma las subidas y bajadas de los backups de bases al
// bucket de backups (#166, infra/terraform/backups) y borra lo vencido.
//
// El backend nunca toca los bytes: el agente del servidor sube y baja directo
// con URLs firmadas. Firmar no llama a nadie —es una cuenta con la llave del
// usuario IAM—, así que no hay un servicio en medio que pueda caerse.
package backupstore

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

var ErrDisabled = errors.New("backup store not configured")

// UploadTTL / DownloadTTL: lo que vive una URL firmada. La de subida, lo que
// tarda un backup grande en subir por un enlace normal; la de bajada para una
// persona, poco, porque se puede reenviar.
const (
	UploadTTL         = 30 * time.Minute
	AgentDownloadTTL  = 30 * time.Minute
	PersonDownloadTTL = 5 * time.Minute
)

type Store struct {
	client  *s3.Client
	presign *s3.PresignClient
	// presignGet firma las bajadas con todo en la URL (el firmante por
	// defecto): una bajada la puede pedir un navegador, que no manda
	// cabeceras, y la subida sin «hoisting» de arriba firmaba cabeceras que
	// luego nadie mandaba (`SignatureDoesNotMatch` en la primera prueba de
	// restauración, 18-oct-2026).
	presignGet *s3.PresignClient
	bucket     string
	prefix     string
}

// New: sin bucket o región, apagado (Enabled() es false) y la app lo dice.
func New(ctx context.Context, bucket, region, prefix, accessKeyID, secretKey string) (*Store, error) {
	if bucket == "" || region == "" {
		return &Store{}, nil
	}
	opts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(region)}
	if accessKeyID != "" && secretKey != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(accessKeyID, secretKey, ""),
		))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("backupstore: load aws config: %w", err)
	}
	if prefix == "" {
		prefix = "backups"
	}
	c := s3.NewFromConfig(cfg)
	// Sin «hoisting»: por defecto el firmante sube las cabeceras `x-amz-*` a
	// la query de la URL, y S3 exige el checksum **en cabecera** en una subida
	// con Object Lock («Content-MD5 OR x-amz-checksum- HTTP header is
	// required»); y una cabecera añadida a mano no va firmada y la rechaza
	// («headers present in the request which were not signed»). Medido contra
	// el bucket el 18-oct-2026. Así se quedan como cabeceras firmadas.
	presign := s3.NewPresignClient(c, func(o *s3.PresignOptions) {
		o.Presigner = v4.NewSigner(func(so *v4.SignerOptions) { so.DisableHeaderHoisting = true })
	})
	return &Store{client: c, presign: presign, presignGet: s3.NewPresignClient(c), bucket: bucket, prefix: prefix}, nil
}

func (s *Store) Enabled() bool { return s != nil && s.client != nil }

func (s *Store) Prefix() string { return s.prefix }

// PresignPut firma la subida de **ese** fichero: el tamaño, el sha256 y el
// Object Lock entran en la firma. S3 rechaza un cuerpo distinto (otro sha256)
// y una subida sin la retención; y como la retención va firmada, quien tenga
// la URL no puede acortarla.
func (s *Store) PresignPut(ctx context.Context, key string, size int64, sha256hex string, retainUntil time.Time) (*domain.PresignedRequest, error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	raw, err := hex.DecodeString(sha256hex)
	if err != nil || len(raw) != 32 {
		return nil, fmt.Errorf("invalid sha256")
	}
	sum := base64.StdEncoding.EncodeToString(raw)
	until := retainUntil.UTC().Truncate(time.Second)
	req, err := s.presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:                    aws.String(s.bucket),
		Key:                       aws.String(key),
		ContentLength:             aws.Int64(size),
		ChecksumSHA256:            aws.String(sum),
		ObjectLockMode:            types.ObjectLockModeGovernance,
		ObjectLockRetainUntilDate: aws.Time(until),
		ContentType:               aws.String("application/octet-stream"),
	}, s3.WithPresignExpires(UploadTTL))
	if err != nil {
		return nil, err
	}
	headers := map[string]string{}
	for k, v := range req.SignedHeader {
		// `Host` lo pone el cliente HTTP solo; mandarlo a mano lo duplica.
		if k == "Host" || len(v) == 0 {
			continue
		}
		headers[k] = v[0]
	}
	return &domain.PresignedRequest{Method: req.Method, URL: req.URL, Headers: headers}, nil
}

// PresignGet firma la bajada de un objeto.
func (s *Store) PresignGet(ctx context.Context, key string, ttl time.Duration) (*domain.PresignedRequest, error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	req, err := s.presignGet.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return nil, err
	}
	return &domain.PresignedRequest{Method: req.Method, URL: req.URL, Headers: map[string]string{}}, nil
}

// DeleteAllVersions borra **todas** las versiones de un objeto. Con
// versionado, un DELETE a secas sólo pone una marca encima y el fichero sigue
// ahí, cobrando. Antes de su fecha de retención S3 se niega, y eso es lo
// que se quiere: el error vuelve y el conserje lo reintenta otro día.
func (s *Store) DeleteAllVersions(ctx context.Context, key string) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	out, err := s.client.ListObjectVersions(ctx, &s3.ListObjectVersionsInput{
		Bucket: aws.String(s.bucket), Prefix: aws.String(key),
	})
	if err != nil {
		return err
	}
	del := func(version *string) error {
		_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(s.bucket), Key: aws.String(key), VersionId: version,
		})
		return err
	}
	for _, v := range out.Versions {
		if aws.ToString(v.Key) != key {
			continue
		}
		if err := del(v.VersionId); err != nil {
			return err
		}
	}
	for _, m := range out.DeleteMarkers {
		if aws.ToString(m.Key) != key {
			continue
		}
		if err := del(m.VersionId); err != nil {
			return err
		}
	}
	return nil
}
