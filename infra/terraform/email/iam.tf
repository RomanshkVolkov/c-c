# El usuario con el que el backend envía. Sólo enviar, sólo desde el dominio,
# sólo por el configuration set de cac y sólo como `from_address`: con estas
# llaves robadas no se manda nada en nombre de otra dirección del dominio, ni
# se toca la configuración de SES.
resource "aws_iam_user" "email" {
  name = "cac-email"
  tags = local.tags
}

resource "aws_iam_access_key" "email" {
  user = aws_iam_user.email.name
}

data "aws_iam_policy_document" "email" {
  statement {
    sid     = "SendAsCac"
    actions = ["ses:SendEmail"]
    resources = [
      aws_sesv2_email_identity.domain.arn,
      aws_sesv2_configuration_set.cac.arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.from_address]
    }
  }
}

resource "aws_iam_user_policy" "email" {
  name   = "cac-email-send"
  user   = aws_iam_user.email.name
  policy = data.aws_iam_policy_document.email.json
}
