# El usuario con el que el backend de cac firma las URLs de subida y bajada, y
# con el que el conserje borra lo vencido. Sólo bajo el prefijo.
#
# Puede borrar, pero el Object Lock no le deja antes de la fecha de cada
# objeto, y **no** tiene `BypassGovernanceRetention`: con estas llaves robadas
# se pueden subir backups falsos, nunca hacer desaparecer los buenos.
resource "aws_iam_user" "backups" {
  name = "${var.bucket_name}-cac"
  tags = local.tags
}

resource "aws_iam_access_key" "backups" {
  user = aws_iam_user.backups.name
}

data "aws_iam_policy_document" "backups" {
  statement {
    sid = "BackupObjects"
    actions = [
      "s3:PutObject",
      # La fecha de retención va en la propia subida.
      "s3:PutObjectRetention",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectRetention",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.backups.arn}/${var.prefix}/*"]
  }

  statement {
    sid       = "ListOwnPrefix"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.backups.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.prefix}/*"]
    }
  }
}

resource "aws_iam_user_policy" "backups" {
  name   = "${var.bucket_name}-cac-policy"
  user   = aws_iam_user.backups.name
  policy = data.aws_iam_policy_document.backups.json
}
