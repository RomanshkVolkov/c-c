# Lo que sale mal, a una persona.
#
# La lista de supresión ya deja de mandarle a quien rebota o se queja (ver el
# configuration set en main.tf), pero en silencio: nadie se entera de que un
# alta no llegó. Aquí cada rebote, queja, rechazo, fallo de plantilla o retraso
# de entrega de los correos de cac va a un tema de SNS, y del tema a un correo.
#
# La suscripción por correo hay que confirmarla una vez: AWS manda un enlace a
# `alerts_email` y hasta que se pulsa no llega nada.

data "aws_caller_identity" "current" {}

resource "aws_sns_topic" "ses_events" {
  name = "cac-ses-events"
  tags = local.tags
}

# Sólo SES publica aquí, y sólo desde esta cuenta y este configuration set.
data "aws_iam_policy_document" "ses_events" {
  statement {
    sid     = "SESPublishes"
    actions = ["sns:Publish"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    resources = [aws_sns_topic.ses_events.arn]
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "AWS:SourceArn"
      values   = [aws_sesv2_configuration_set.cac.arn]
    }
  }
}

resource "aws_sns_topic_policy" "ses_events" {
  arn    = aws_sns_topic.ses_events.arn
  policy = data.aws_iam_policy_document.ses_events.json
}

resource "aws_sns_topic_subscription" "ses_events_email" {
  topic_arn = aws_sns_topic.ses_events.arn
  protocol  = "email"
  endpoint  = var.alerts_email
}

resource "aws_sesv2_configuration_set_event_destination" "problems" {
  configuration_set_name = aws_sesv2_configuration_set.cac.configuration_set_name
  event_destination_name = "problems-to-sns"

  event_destination {
    enabled = true
    # Lo que pide que alguien mire. Los envíos y las entregas buenas no: serían
    # un correo por cada correo.
    matching_event_types = ["BOUNCE", "COMPLAINT", "REJECT", "RENDERING_FAILURE", "DELIVERY_DELAY"]
    sns_destination {
      topic_arn = aws_sns_topic.ses_events.arn
    }
  }

  depends_on = [aws_sns_topic_policy.ses_events]
}
