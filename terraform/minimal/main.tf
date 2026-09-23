terraform {
  required_version = ">= 1.3"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_iam_role" "ec2_ssm_role" {
  name = "ai-tutor-ec2-ssm-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "ec2_ssm_core" {
  role       = aws_iam_role.ec2_ssm_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2_ssm_profile" {
  name = "ai-tutor-ec2-ssm-profile"
  role = aws_iam_role.ec2_ssm_role.name
}

# Use default VPC to keep costs and complexity low
resource "aws_default_vpc" "default" {}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [aws_default_vpc.default.id]
  }
}

# Latest Ubuntu 22.04 ARM64
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-arm64-server-*"]
  }
}

resource "aws_security_group" "app_sg" {
  name        = "ai-tutor-app-sg"
  description = "Allow HTTP/HTTPS and SSH"
  vpc_id      = aws_default_vpc.default.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_ip_cidr]
  }

  ingress {
    description = "Neo4j Bolt (restricted)"
    from_port   = 7687
    to_port     = 7687
    protocol    = "tcp"
    cidr_blocks = [var.admin_ip_cidr]
  }

  ingress {
    description = "Neo4j Browser HTTP (restricted)"
    from_port   = 7474
    to_port     = 7474
    protocol    = "tcp"
    cidr_blocks = [var.admin_ip_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
}

resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  key_name                    = var.key_pair_name
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.app_sg.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.ec2_ssm_profile.name

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size_gb
  }

  user_data = <<-EOF
    #!/bin/bash
    set -e
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg lsb-release git

    # Install Docker
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    usermod -aG docker ubuntu
  EOF

  tags = merge(var.tags, {
    Name = "ai-tutor-app"
  })
}

resource "aws_s3_bucket" "frontend" {
  bucket = var.bucket_name
  tags   = var.tags
}

resource "aws_s3_bucket_website_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["s3:GetObject"]
        Resource  = ["${aws_s3_bucket.frontend.arn}/*"]
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

# ─────────────────────────────────────────────────────────────
# SQS — durable job queue for question generation and evaluation
# ─────────────────────────────────────────────────────────────

resource "aws_sqs_queue" "jobs_dlq" {
  name                      = "ai-tutor-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days
  tags                      = var.tags
}

resource "aws_sqs_queue" "jobs" {
  name                       = "ai-tutor-jobs"
  visibility_timeout_seconds = 900 # 15 min — covers longest evaluation jobs
  message_retention_seconds  = 345600 # 4 days

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 3
  })

  tags = var.tags
}

# Grant the EC2 instance role access to send/receive/delete job messages
resource "aws_iam_role_policy" "ec2_sqs" {
  name = "ai-tutor-ec2-sqs"
  role = aws_iam_role.ec2_ssm_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          # Heartbeat and retry backoff in SQSJobDispatcher. Without it both are
          # AccessDenied, logged only, and retries wait the full visibility timeout.
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
        ]
        Resource = [
          aws_sqs_queue.jobs.arn,
          aws_sqs_queue.jobs_dlq.arn,
        ]
      }
    ]
  })
}

# ─────────────────────────────────────────────────────────────
# CloudWatch — API log group + error rate alarm
# ─────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ai-tutor/api"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_cloudwatch_log_metric_filter" "api_errors" {
  name           = "ai-tutor-api-errors"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "ERROR"

  metric_transformation {
    name      = "ErrorCount"
    namespace = "AiTutor"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "high_error_rate" {
  alarm_name          = "ai-tutor-high-error-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ErrorCount"
  namespace           = "AiTutor"
  period              = 300 # 5-minute window
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "More than 10 API errors in a 5-minute window"
  treat_missing_data  = "notBreaching"
  tags                = var.tags
}
