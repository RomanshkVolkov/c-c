// Package mailer manda los correos del backend por Amazon SES
// (infra/terraform/email).
//
// La llave sólo puede enviar desde `from`, por el configuration set de cac:
// los rebotes y las quejas van a la lista de supresión de la cuenta y SES no
// vuelve a intentar con esa dirección.
package mailer

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	"github.com/aws/aws-sdk-go-v2/service/sesv2/types"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// sender: lo que se usa del cliente de SES, para probar sin AWS.
type sender interface {
	SendEmail(ctx context.Context, in *sesv2.SendEmailInput, opts ...func(*sesv2.Options)) (*sesv2.SendEmailOutput, error)
}

type SES struct {
	client    sender
	from      string
	configSet string
}

// New: sin región o sin remitente, nil — el correo está apagado y el servicio
// lo sabe (`Mailer` nil). Es el caso de dev y de las pruebas.
func New(ctx context.Context, region, from, configSet, accessKeyID, secretKey string) (*SES, error) {
	if region == "" || from == "" {
		return nil, nil
	}
	opts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(region)}
	if accessKeyID != "" && secretKey != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(accessKeyID, secretKey, ""),
		))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("mailer: load aws config: %w", err)
	}
	return &SES{client: sesv2.NewFromConfig(cfg), from: from, configSet: configSet}, nil
}

func (m *SES) Send(ctx context.Context, e domain.Email) error {
	in := &sesv2.SendEmailInput{
		FromEmailAddress: aws.String("cac <" + m.from + ">"),
		Destination:      &types.Destination{ToAddresses: []string{e.To}},
		Content: &types.EmailContent{Simple: &types.Message{
			Subject: &types.Content{Data: aws.String(e.Subject), Charset: aws.String("UTF-8")},
			Body: &types.Body{
				Text: &types.Content{Data: aws.String(e.Text), Charset: aws.String("UTF-8")},
				Html: &types.Content{Data: aws.String(e.HTML), Charset: aws.String("UTF-8")},
			},
		}},
	}
	if m.configSet != "" {
		in.ConfigurationSetName = aws.String(m.configSet)
	}
	_, err := m.client.SendEmail(ctx, in)
	return err
}
