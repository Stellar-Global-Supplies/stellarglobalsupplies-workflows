#!/bin/bash
# =============================================================================
# retire-aws-resources.sh
# 
# This script helps retire all AWS resources used by the old Step Functions
# platform. Run this AFTER verifying Cloudflare Workers are fully functional.
#
# Prerequisites:
#   - AWS CLI configured with appropriate permissions
#   - Terraform installed
#   - All Cloudflare Workers deployed and working
#
# Usage:
#   chmod +x docs/retire-aws-resources.sh
#   ./docs/retire-aws-resources.sh
# =============================================================================
set -e

PROJECT="stellar-wf"
ENVIRONMENT="prod"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="${PROJECT}-${ENVIRONMENT}"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  AWS Resources Retirement Script                              ║"
echo "║  Project: ${PREFIX}                                          ║"
echo "║  Region:  ${REGION}                                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Safety check ──────────────────────────────────────────────────
echo "⚠️  WARNING: This will DESTROY all AWS resources for ${PREFIX}"
echo ""
echo "Before proceeding, verify:"
echo "  1. Cloudflare Workers are deployed and working"
echo "  2. Frontend is deployed (Cloudflare Pages/Netlify)"
echo "  3. D1 database has all required data"
echo "  4. Supabase is accessible from Workers"
echo "  5. You have backed up any needed S3 assets"
echo ""
read -p "Have you completed all checks above? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "❌ Aborting. Please complete the checks first."
  exit 1
fi

echo ""
echo "════════════════════════════════════════════════════════════════"

# ── Step 1: List EventBridge rules ────────────────────────────────
echo ""
echo "📋 Step 1: Listing EventBridge rules (will need manual deletion)..."
echo ""
RULES=$(aws events list-rules --name-prefix "${PREFIX}" --region "$REGION" --query 'Rules[].Name' --output text 2>/dev/null || echo "")
if [ -n "$RULES" ]; then
  echo "Found EventBridge rules:"
  echo "$RULES" | tr '\t' '\n' | while read -r rule; do
    if [ -n "$rule" ]; then
      echo "  - $rule"
    fi
  done
  echo ""
  read -p "Delete these EventBridge rules? (yes/no): " DEL_RULES
  if [ "$DEL_RULES" = "yes" ]; then
    echo "$RULES" | tr '\t' '\n' | while read -r rule; do
      if [ -n "$rule" ]; then
        echo "  Deleting rule: $rule"
        # Remove targets first
        TARGETS=$(aws events list-targets-by-rule --rule "$rule" --region "$REGION" --query 'Targets[].Id' --output text 2>/dev/null || echo "")
        if [ -n "$TARGETS" ]; then
          aws events remove-targets --rule "$rule" --ids $TARGETS --region "$REGION" --no-cli-pager 2>/dev/null || true
        fi
        aws events delete-rule --name "$rule" --region "$REGION" --no-cli-pager 2>/dev/null || true
      fi
    done
    echo "  ✅ EventBridge rules deleted"
  fi
else
  echo "  No EventBridge rules found"
fi

# ── Step 2: Terraform Destroy ─────────────────────────────────────
echo ""
echo "📋 Step 2: Terraform Destroy (destroys Lambdas, Step Functions, API Gateway, S3, CloudFront, IAM, logs, SSM)..."
echo ""
read -p "Run terraform destroy? (yes/no): " RUN_DESTROY
if [ "$RUN_DESTROY" = "yes" ]; then
  echo ""
  echo "  Enter required variables for terraform destroy:"
  read -p "  Supabase URL: " SUPABASE_URL
  read -sp "  Supabase Service Key: " SUPABASE_KEY
  echo ""
  read -p "  ACM Certificate ARN: " ACM_ARN
  echo ""
  
  cd terraform
  terraform init
  terraform destroy -auto-approve \
    -var="supabase_url=${SUPABASE_URL}" \
    -var="supabase_service_key=${SUPABASE_KEY}" \
    -var="acm_certificate_arn=${ACM_ARN}"
  cd ..
  echo "  ✅ Terraform destroy complete"
else
  echo "  ⏭️  Skipping terraform destroy"
  echo "  You can run it manually later:"
  echo "    cd terraform"
  echo "    terraform destroy"
fi

# ── Step 3: Delete Terraform backend ──────────────────────────────
echo ""
echo "📋 Step 3: Delete Terraform backend (S3 state bucket + DynamoDB lock table)..."
echo ""
read -p "Delete Terraform backend resources? (yes/no): " DEL_BACKEND
if [ "$DEL_BACKEND" = "yes" ]; then
  echo "  Emptying S3 state bucket..."
  aws s3 rm "s3://stellarglobalsupplies-backend-config" --recursive --region "$REGION" 2>/dev/null || true
  echo "  Deleting S3 state bucket..."
  aws s3api delete-bucket --bucket "stellarglobalsupplies-backend-config" --region "$REGION" 2>/dev/null || true
  echo "  Deleting DynamoDB lock table..."
  aws dynamodb delete-table --table-name "stellarglobalsupplies-backend-db-config" --region "$REGION" --no-cli-pager 2>/dev/null || true
  echo "  ✅ Terraform backend deleted"
else
  echo "  ⏭️  Skipping backend deletion"
fi

# ── Step 4: Delete SSM Parameters ─────────────────────────────────
echo ""
echo "📋 Step 4: Delete SSM Parameters..."
echo ""
read -p "Delete SSM parameters? (yes/no): " DEL_SSM
if [ "$DEL_SSM" = "yes" ]; then
  SSM_PARAMS=(
    "/${PROJECT}/gmail/client_id"
    "/${PROJECT}/gmail/client_secret"
    "/${PROJECT}/gmail/refresh_token"
    "/${PROJECT}/facebook/page_id"
    "/${PROJECT}/facebook/access_token"
    "/${PROJECT}/instagram/account_id"
    "/${PROJECT}/instagram/access_token"
    "/${PROJECT}/github/token"
    "/${PROJECT}/hunter/api_key"
    "/${PROJECT}/approval/reviewer_email"
  )
  for param in "${SSM_PARAMS[@]}"; do
    echo "  Deleting: $param"
    aws ssm delete-parameter --name "$param" --region "$REGION" --no-cli-pager 2>/dev/null || true
  done
  echo "  ✅ SSM parameters deleted"
else
  echo "  ⏭️  Skipping SSM deletion"
fi

# ── Step 5: Check for remaining resources ─────────────────────────
echo ""
echo "📋 Step 5: Checking for remaining resources..."
echo ""

# Check for remaining Lambdas
REMAINING_LAMBDAS=$(aws lambda list-functions --region "$REGION" --query "Functions[?starts_with(FunctionName, '${PREFIX}')].FunctionName" --output text 2>/dev/null || echo "")
if [ -n "$REMAINING_LAMBDAS" ]; then
  echo "  ⚠️  Remaining Lambda functions:"
  echo "$REMAINING_LAMBDAS" | tr '\t' '\n' | while read -r fn; do
    [ -n "$fn" ] && echo "    - $fn"
  done
else
  echo "  ✅ No remaining Lambda functions"
fi

# Check for remaining Step Functions
REMAINING_SFNS=$(aws stepfunctions list-state-machines --region "$REGION" --query "stateMachines[?starts_with(name, '${PREFIX}')].name" --output text 2>/dev/null || echo "")
if [ -n "$REMAINING_SFNS" ]; then
  echo "  ⚠️  Remaining Step Functions:"
  echo "$REMAINING_SFNS" | tr '\t' '\n' | while read -r sfn; do
    [ -n "$sfn" ] && echo "    - $sfn"
  done
else
  echo "  ✅ No remaining Step Functions"
fi

# Check for remaining S3 buckets
REMAINING_BUCKETS=$(aws s3api list-buckets --query "Buckets[?starts_with(Name, '${PREFIX}')].Name" --output text 2>/dev/null || echo "")
if [ -n "$REMAINING_BUCKETS" ]; then
  echo "  ⚠️  Remaining S3 buckets:"
  echo "$REMAINING_BUCKETS" | tr '\t' '\n' | while read -r bucket; do
    [ -n "$bucket" ] && echo "    - $bucket"
  done
else
  echo "  ✅ No remaining S3 buckets"
fi

# ── Step 6: Route53 & ACM (manual) ────────────────────────────────
echo ""
echo "📋 Step 6: Manual cleanup items..."
echo ""
echo "  The following may need manual cleanup:"
echo "  1. Route53 records:"
echo "     - workflow.stellarglobalsupplies.com (if pointing to AWS API Gateway)"
echo "     - assets.stellarglobalsupplies.com (if pointing to CloudFront)"
echo "  2. ACM certificate for assets.stellarglobalsupplies.com (if not used elsewhere)"
echo "  3. CloudWatch log groups (may take time to auto-delete)"
echo "  4. GitHub repository secrets:"
echo "     - AWS_ROLE_ARN"
echo "     - ACM_CERT_ARN"
echo "     - SUPABASE_URL (if only used by Terraform)"
echo "     - SUPABASE_SERVICE_KEY (if only used by Terraform)"
echo ""

echo "════════════════════════════════════════════════════════════════"
echo ""
echo "✅ AWS retirement script complete!"
echo ""
echo "Next steps:"
echo "  1. Update DNS records to point to Cloudflare"
echo "  2. Remove GitHub secrets (AWS_ROLE_ARN, ACM_CERT_ARN)"
echo "  3. The repository code cleanup (removing terraform/, backend/) will be done separately"
echo ""