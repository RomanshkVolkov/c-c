# El usuario con el que barman (dentro del clúster) sube el WAL y los base
# backups, lista lo que hay y borra lo vencido. Sólo este bucket, y nada más
# de la cuenta. Sus llaves van a 1Password y de ahí, como referencias `op://`,
# a la config del servidor en cac; nunca al repo.
resource "aws_iam_user" "cnpg" {
  name = "${var.bucket_name}-barman"
  tags = local.tags
}

resource "aws_iam_access_key" "cnpg" {
  user = aws_iam_user.cnpg.name
}

data "aws_iam_policy_document" "cnpg" {
  statement {
    sid = "BarmanObjects"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.cnpg.arn}/*"]
  }

  statement {
    sid       = "ListBucket"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.cnpg.arn]
  }
}

resource "aws_iam_user_policy" "cnpg" {
  name   = "${var.bucket_name}-barman-policy"
  user   = aws_iam_user.cnpg.name
  policy = data.aws_iam_policy_document.cnpg.json
}
