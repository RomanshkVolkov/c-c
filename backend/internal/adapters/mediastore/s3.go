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
