// Package mediastore reads report screenshots straight from the private S3
// bucket. image-service has no serve endpoint (§5 of its integration doc): the
// authenticated backend proxy reads the object by its storage key — same
// pattern portento uses. Uploads still go through image-service; only reads
// touch S3 directly.
package mediastore

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

var ErrDisabled = errors.New("media store not configured")

type Store struct {
	client *s3.Client
	bucket string
}

// Object is a streamed S3 object; the caller must Close Body.
type Object struct {
	Body        io.ReadCloser
	ContentType string
	Size        int64
	// ContentRange viene puesto sólo cuando se pidió un rango, y se devuelve
	// tal cual: es lo que el navegador necesita para saber qué trozo recibió y
	// cuánto mide el total.
	ContentRange string
}

// New builds an S3 reader. When bucket/region are empty the store is disabled
// (Enabled() reports false). Static keys are used when provided; otherwise the
// default AWS credential chain applies.
func New(ctx context.Context, bucket, region, accessKeyID, secretKey string) (*Store, error) {
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
		return nil, fmt.Errorf("mediastore: load aws config: %w", err)
	}
	return &Store{client: s3.NewFromConfig(cfg), bucket: bucket}, nil
}

func (s *Store) Enabled() bool { return s != nil && s.client != nil }

// Get streams the object at key from the bucket.
func (s *Store) Get(ctx context.Context, key string) (*Object, error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, err
	}
	ct := ""
	if out.ContentType != nil {
		ct = *out.ContentType
	}
	size := int64(0)
	if out.ContentLength != nil {
		size = *out.ContentLength
	}
	return &Object{Body: out.Body, ContentType: ct, Size: size}, nil
}

// GetRange streams part of an object, for `Range` requests.
//
// Un vídeo de una reunión no se sirve como un adjunto: quien lo mira arrastra
// la barra, y sin `Range` el navegador tiene que bajarse el fichero entero para
// enseñar el minuto veinte. Se delega en S3 en vez de descartar bytes aquí —
// leer cien megas para tirar noventa y nueve es lo mismo que no tener rango.
//
// `rng` es la cabecera tal cual («bytes=0-99»); vacía se comporta como `Get`.
func (s *Store) GetRange(ctx context.Context, key, rng string) (*Object, error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	in := &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)}
	if rng != "" {
		in.Range = aws.String(rng)
	}
	out, err := s.client.GetObject(ctx, in)
	if err != nil {
		return nil, err
	}
	obj := &Object{Body: out.Body}
	if out.ContentType != nil {
		obj.ContentType = *out.ContentType
	}
	if out.ContentLength != nil {
		obj.Size = *out.ContentLength
	}
	if out.ContentRange != nil {
		obj.ContentRange = *out.ContentRange
	}
	return obj, nil
}

// Delete removes objects, one call each.
//
// Una grabación son unas pocas pistas más el montaje, así que el lote no
// compensa la complejidad de `DeleteObjects` —que además pide otro permiso de
// IAM—. Si algún día se borran grabaciones enteras a cientos, aquí es donde se
// cambia.
//
// Borrar algo que ya no está **no es un error** en S3, y eso importa: un
// reintento después de un fallo a medias tiene que poder terminar bien.
func (s *Store) Delete(ctx context.Context, keys ...string) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	for _, key := range keys {
		if key == "" {
			continue
		}
		_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(s.bucket), Key: aws.String(key),
		})
		if err != nil {
			return fmt.Errorf("mediastore: delete %s: %w", key, err)
		}
	}
	return nil
}

// Fake devuelve un almacén que dice estar encendido y no habla con nadie.
//
// Existe para las pruebas del reloj de grabación, que necesitan que
// `Enabled()` sea cierto —es una de las tres condiciones para grabar— pero no
// tocan S3 en ningún momento: las pistas las escribe Egress y el montaje lo
// sube el mux, cada uno con su propia credencial.
//
// Cualquier lectura o escritura sobre él revienta a propósito: si una prueba
// empieza a usarlo de verdad, que se entere.
func Fake() *Store { return &Store{client: &s3.Client{}, bucket: "fake"} }
