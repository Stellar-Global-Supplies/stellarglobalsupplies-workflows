output "assets_bucket" {
  description = "S3 bucket for AI-generated assets"
  value       = aws_s3_bucket.assets.bucket
}

output "assets_cloudfront_domain" {
  description = "CloudFront distribution domain for assets"
  value       = aws_cloudfront_distribution.assets.domain_name
}

output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "state_machines" {
  description = "Step Functions state machine ARNs"
  value = {
    lead_generation = aws_sfn_state_machine.lead_generation.arn
    social_product  = aws_sfn_state_machine.social_product.arn
    social_tech     = aws_sfn_state_machine.social_tech.arn
    blog_post       = aws_sfn_state_machine.blog_post.arn
  }
}
