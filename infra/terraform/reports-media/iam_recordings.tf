# Usuario dedicado que LiveKit Egress usa para subir las grabaciones.
#
# Aparte del de image-service a propósito. Ese tiene Put/Get/Delete/List sobre
# **todo** el bucket, incluidas las imágenes de los reportes; el Egress corre en
# otro pod, con su configuración en un Secret distinto, y no tiene por qué poder
# tocar nada que no sea lo suyo. Comprometido, lo peor que puede hacer es
# escribir mp4 bajo `recordings/`.
#
# Tampoco puede leer ni borrar: las grabaciones se sirven y se borran desde cac,
# con las llaves que ya tenía.
resource "aws_iam_user" "recordings" {
  name = "${var.bucket_name}-recordings"
  tags = local.tags
}

resource "aws_iam_access_key" "recordings" {
  user = aws_iam_user.recordings.name
}

data "aws_iam_policy_document" "recordings" {
  statement {
    sid = "RecordingsWriteOnly"
    actions = [
      "s3:PutObject",
      # Un mp4 de una reunión va por multipart; sin estas dos, una subida que
      # falle deja trozos que nadie puede limpiar.
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.media.arn}/${var.recordings_prefix}/*"]
  }

  # `ListBucket` es del bucket, no del objeto, así que la única forma de
  # acotarla es por condición de prefijo.
  statement {
    sid       = "RecordingsListOwnPrefix"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.recordings_prefix}/*"]
    }
  }
}

resource "aws_iam_user_policy" "recordings" {
  name   = "${var.bucket_name}-recordings-policy"
  user   = aws_iam_user.recordings.name
  policy = data.aws_iam_policy_document.recordings.json
}
