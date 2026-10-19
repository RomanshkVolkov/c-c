# cac — el correo que manda el backend (bienvenida de una cuenta nueva,
# restablecer la contraseña).
#
# Amazon SES con el dominio `guz-studio.dev`. El dominio **recibe** en Zoho
# (su MX y su SPF son de Zoho) y eso no se toca:
#
# - La firma es DKIM: tres CNAME a SES, que prueban que el correo sale del
#   dominio sin pasar por su SPF.
# - El rebote (MAIL FROM) va a un subdominio propio con su MX y su SPF, así el
#   SPF del dominio raíz sigue siendo sólo el de Zoho y los dos conviven.
#
# Los registros van en Cloudflare, a mano: `terraform output dns_records`.
# Mientras no estén, SES no firma ni deja enviar desde el dominio.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = var.region
  profile = var.profile != "" ? var.profile : null
}

locals {
  tags = {
    Project   = "cac"
    Component = "email"
    ManagedBy = "terraform"
  }
  mail_from = "${var.mail_from_subdomain}.${var.domain}"
}

# Lo que se manda pasa por aquí: los rebotes y las quejas dejan la dirección
# en la lista de supresión de la cuenta, y SES no vuelve a intentar con ella.
# Insistir con una dirección que rebota es lo que hace que AWS te frene.
resource "aws_sesv2_configuration_set" "cac" {
  configuration_set_name = "cac"

  reputation_options {
    reputation_metrics_enabled = true
  }
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
  sending_options {
    sending_enabled = true
  }
  tags = local.tags
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity         = var.domain
  configuration_set_name = aws_sesv2_configuration_set.cac.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
  tags = local.tags
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity   = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain = local.mail_from
  # Si el MX del subdominio falla, SES rebota con su propio dominio en vez de
  # dejar de enviar.
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}
