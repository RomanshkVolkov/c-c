package service

import (
	"bytes"
	"html/template"
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/i18n"
)

// Las claves de cada correo en el catálogo del servidor (i18n/catalog.go).
// Aquí sólo está la forma: toda frase que se lee sale del catálogo, en el
// idioma de quien la recibe.
type mailKeys struct {
	subject, greeting, body, button, expires string
}

var (
	mailWelcome = mailKeys{"email.welcome.subject", "email.welcome.greeting", "email.welcome.body", "email.welcome.button", "email.welcome.expires"}
	mailInvited = mailKeys{"email.invited.subject", "email.welcome.greeting", "email.invited.body", "email.invited.button", ""}
	mailReset   = mailKeys{"email.reset.subject", "email.welcome.greeting", "email.reset.body", "email.reset.button", "email.reset.expires"}
)

// Una tabla y estilos en línea: es lo único que todos los clientes de correo
// pintan igual. Sin imágenes, que muchos bloquean, y con el enlace también en
// texto por si el botón no se ve.
var mailHTML = template.Must(template.New("mail").Parse(`<!doctype html>
<html lang="{{.Lang}}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{.Subject}}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<tr><td style="font-size:20px;font-weight:700;padding-bottom:24px">cac</td></tr>
<tr><td style="font-size:15px;line-height:1.6;padding-bottom:12px">{{.Greeting}}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;padding-bottom:24px">{{.Body}}</td></tr>
<tr><td style="padding-bottom:24px"><a href="{{.Link}}" style="display:inline-block;background:#0e7490;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px">{{.Button}}</a></td></tr>
{{if .Expires}}<tr><td style="font-size:13px;line-height:1.5;color:#52525b;padding-bottom:16px">{{.Expires}}</td></tr>{{end}}
<tr><td style="font-size:12px;line-height:1.5;color:#71717a;padding-bottom:4px">{{.Fallback}}</td></tr>
<tr><td style="font-size:12px;line-height:1.5;word-break:break-all;padding-bottom:24px"><a href="{{.Link}}" style="color:#0e7490">{{.Link}}</a></td></tr>
<tr><td style="font-size:12px;color:#a1a1aa;border-top:1px solid #e4e4e7;padding-top:16px">{{.Footer}}</td></tr>
</table></td></tr></table></body></html>`))

// renderEmail arma un correo con su versión HTML y la de texto.
func renderEmail(l i18n.Locale, to string, k mailKeys, args map[string]string, link string) domain.Email {
	t := func(key string) string {
		if key == "" {
			return ""
		}
		return i18n.T(l, key, args)
	}
	v := struct {
		Lang, Subject, Greeting, Body, Button, Expires, Fallback, Footer, Link string
	}{
		Lang: string(l), Subject: t(k.subject), Greeting: t(k.greeting), Body: t(k.body),
		Button: t(k.button), Expires: t(k.expires), Fallback: t("email.link.fallback"),
		Footer: t("email.footer"), Link: link,
	}
	var html bytes.Buffer
	// La plantilla es fija y sus datos son texto: no puede fallar al pintar.
	_ = mailHTML.Execute(&html, v)

	text := []string{v.Greeting, "", v.Body, "", v.Button + ":", link}
	if v.Expires != "" {
		text = append(text, "", v.Expires)
	}
	text = append(text, "", "--", v.Footer)
	return domain.Email{To: to, Subject: v.Subject, Text: strings.Join(text, "\n"), HTML: html.String()}
}
