#!/bin/bash
# =============================================================================
# setup-ssm-params.sh
# Run this once to store all secrets in AWS SSM Parameter Store.
# Uses SecureString type (KMS encrypted).
# =============================================================================
set -e

PROJECT="stellar-wf"
REGION="${AWS_REGION:-us-east-1}"

get_value() {
  local env_name="$1"
  local prompt="$2"
  local value="${!env_name:-}"

  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  if [ -t 0 ]; then
    read -rsp "$prompt" value
    echo
    printf '%s' "$value"
    return 0
  fi

  echo "Missing required value: $env_name" >&2
  exit 1
}

# Usage: put_param /path/to/param "value"
put_param() {
  local name="$1"
  local value="$2"
  aws ssm put-parameter \
    --name        "$name" \
    --value       "$value" \
    --type        "SecureString" \
    --overwrite \
    --region      "$REGION" \
    --no-cli-pager
  echo "✅ Stored: $name"
}

echo "=== Storing secrets for ${PROJECT} in SSM ==="

# ── Gmail OAuth ──────────────────────────────────
GMAIL_CLIENT_ID="$(get_value GMAIL_CLIENT_ID "Gmail OAuth Client ID: ")"
GMAIL_CLIENT_SECRET="$(get_value GMAIL_CLIENT_SECRET "Gmail OAuth Client Secret: ")"
GMAIL_REFRESH_TOKEN="$(get_value GMAIL_REFRESH_TOKEN "Gmail OAuth Refresh Token: ")"

put_param "/${PROJECT}/gmail/client_id"     "$GMAIL_CLIENT_ID"
put_param "/${PROJECT}/gmail/client_secret" "$GMAIL_CLIENT_SECRET"
put_param "/${PROJECT}/gmail/refresh_token" "$GMAIL_REFRESH_TOKEN"

# ── Facebook / Instagram ─────────────────────────
FB_PAGE_ID="$(get_value FB_PAGE_ID "Facebook Page ID: ")"
FB_TOKEN="$(get_value FB_ACCESS_TOKEN "Facebook Access Token: ")"
IG_ID="$(get_value IG_ACCOUNT_ID "Instagram Account ID: ")"
IG_TOKEN="$(get_value IG_ACCESS_TOKEN "Instagram Access Token: ")"

put_param "/${PROJECT}/facebook/page_id"       "$FB_PAGE_ID"
put_param "/${PROJECT}/facebook/access_token"  "$FB_TOKEN"
put_param "/${PROJECT}/instagram/account_id"   "$IG_ID"
put_param "/${PROJECT}/instagram/access_token" "$IG_TOKEN"

# ── GitHub ───────────────────────────────────────
GH_TOKEN="$(get_value TOKEN_PAT "GitHub PAT (repo write access): ")"
put_param "/${PROJECT}/github/token" "$GH_TOKEN"

# ── Hunter.io (optional) ─────────────────────────
if [ -n "${HUNTER_API_KEY:-}" ]; then
  put_param "/${PROJECT}/hunter/api_key" "$HUNTER_API_KEY"
else
  echo "⚠️  HUNTER_API_KEY not set, skipping Hunter.io SSM parameter"
fi

echo ""
echo "=== All secrets stored. Lambda env var HUNTER_API_KEY_PARAM=/${PROJECT}/hunter/api_key ==="
