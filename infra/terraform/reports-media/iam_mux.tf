# Usuario dedicado del montador: **lee las pistas y escribe el montaje**.
#
# El tercero, y cada uno con su frontera. Egress sólo escribe bajo
# `recordings/`; éste lee lo que aquél escribió y sube el `final.*` al lado; y
# cac —con las llaves de image-service— es el único que borra. Tres credenciales
# en tres pods distintos, y ninguna puede hacer el trabajo de otra.
#
# **Sin `DeleteObject` a propósito.** Un montador con permiso de borrar podría,
# ante un fallo a mitad, llevarse por delante las pistas originales — que son
# justamente el material para reintentarlo, y la transcripción de mañana.
resource "aws_iam_user" "mux" {
  name = "${var.bucket_name}-mux"
  tags = local.tags
}

resource "aws_iam_access_key" "mux" {
  user = aws_iam_user.mux.name
}

data "aws_iam_policy_document" "mux" {
  statement {
    sid = "MuxReadAndWriteRecordings"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      # El montaje de una reunión larga sube por multipart; sin estas dos, una
      # subida que falle deja trozos que nadie puede limpiar.
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.media.arn}/${var.recordings_prefix}/*"]
  }

  statement {
    sid       = "MuxListOwnPrefix"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.recordings_prefix}/*"]
    }
  }
}

resource "aws_iam_user_policy" "mux" {
  name   = "${var.bucket_name}-mux-policy"
  user   = aws_iam_user.mux.name
  policy = data.aws_iam_policy_document.mux.json
}
