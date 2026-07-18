variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "prod"
}

variable "project_name" {
  description = "Project name prefix for all resources"
  type        = string
  default     = "stellar-wf"
}

variable "root_domain" {
  description = "Root domain name (Route53 hosted zone)"
  type        = string
  default     = "stellarglobalsupplies.com"
}

variable "workflow_domain" {
  description = "Full subdomain for the workflow platform"
  type        = string
  default     = "workflow.stellarglobalsupplies.com"
}

variable "assets_domain" {
  description = "Full subdomain for assets CDN"
  type        = string
  default     = "assets.stellarglobalsupplies.com"
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (must be in us-east-1 for CloudFront)"
  type        = string
  # Set this in terraform.tfvars - e.g. arn:aws:acm:us-east-1:123456789:certificate/abc...
}

variable "supabase_url" {
  description = "Supabase project URL"
  type        = string
  sensitive   = true
}

variable "supabase_service_key" {
  description = "Supabase service role key"
  type        = string
  sensitive   = true
}

variable "sender_email" {
  description = "Gmail sender email address"
  type        = string
  default     = "sales@stellarglobalsupplies.com"
}

variable "website_repo_owner" {
  description = "GitHub org/user owning the website repo"
  type        = string
  default     = "Stellar-Global-Supplies"
}

variable "website_repo_name" {
  description = "GitHub repo name for the company website"
  type        = string
  default     = "stellarglobalsupplies-website"
}

variable "context_bucket" {
  description = "S3 bucket for AI context storage"
  type        = string
  default     = "stellar-global-ai-context"
}
