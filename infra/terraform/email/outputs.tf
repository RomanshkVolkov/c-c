# Los registros que van en Cloudflare, todos **sin proxy** (nube gris): un
# CNAME con proxy no lo resuelve SES.
output "dns_records" {
  description = "Para Cloudflare. Nombre, tipo y valor de cada registro."
  value = concat(
    [for t in aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens : {
      name  = "${t}._domainkey.${var.domain}"
      type  = "CNAME"
      value = "${t}.dkim.amazonses.com"
    }],
    [
      {
        name  = local.mail_from
        type  = "MX"
        value = "10 feedback-smtp.${var.region}.amazonses.com"
      },
      {
        name  = local.mail_from
        type  = "TXT"
        value = "v=spf1 include:amazonses.com ~all"
      },
      # Empieza observando: con `p=none` nada se rechaza todavía. Se endurece
      # (quarantine, reject) cuando se vea que todo lo legítimo pasa.
      {
        name  = "_dmarc.${var.domain}"
        type  = "TXT"
        value = "v=DMARC1; p=none"
      },
    ],
  )
}

output "region" {
  value       = var.region
  description = "EMAIL_REGION del backend."
}

output "from_address" {
  value       = var.from_address
  description = "EMAIL_FROM del backend."
}

output "configuration_set" {
  value       = aws_sesv2_configuration_set.cac.configuration_set_name
  description = "EMAIL_CONFIGURATION_SET del backend."
}

output "access_key_id" {
  value       = aws_iam_access_key.email.id
  description = "EMAIL_ACCESS_KEY_ID del backend."
}

output "secret_access_key" {
  value       = aws_iam_access_key.email.secret
  sensitive   = true
  description = "EMAIL_SECRET_ACCESS_KEY. Sólo por stdin: terraform output -raw secret_access_key | gh secret set …"
}
