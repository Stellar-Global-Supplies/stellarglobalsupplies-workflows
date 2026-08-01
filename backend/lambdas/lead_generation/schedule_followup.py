"""
Lambda: schedule_followup
Drafts a follow-up email and schedules it via EventBridge after 5 days.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import boto3
import json
from datetime import datetime, timezone, timedelta
from shared.bedrock_client import generate_json
from shared.supabase_client import get_client

SYSTEM = "You are a B2B sales copywriter. Write a brief, friendly follow-up email."


def handler(event, context):
    lead      = event.get("lead") or event.get("payload", {}).get("lead") or {}
    lead_id   = event.get("leadId") or event.get("payload", {}).get("lead_id")
    if not lead or not lead_id:
        raise ValueError(f"Missing lead or leadId in event: {list(event.keys())}")
    sent_at   = event.get("emailSentAt", "recently")

    # Draft follow-up
    prompt = f"""
Draft a follow-up email for {lead['company_name']}.
The initial outreach was sent {sent_at}.
Keep it brief (3-4 sentences), reference the previous email, ask if they had a chance to review.
Sign off from Stellar Global Supplies Team.

Return JSON: {{"subject": "...", "body": "..."}}
"""
    followup = generate_json(prompt, system=SYSTEM, max_tokens=600)

    db  = get_client()
    row = {
        "lead_id":     lead_id,
        "subject":     followup["subject"],
        "body":        followup["body"],
        "is_followup": True,
        "status":      "draft",
    }
    saved = db.insert("email_drafts", row)

    # Schedule EventBridge rule to trigger follow-up approval workflow in 5 days
    followup_time = (datetime.now(timezone.utc) + timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%S")
    events = boto3.client("events")
    rule_name = f"followup-{lead_id[:8]}"

    state_machine_arn = os.environ.get("LEAD_GEN_STATE_MACHINE_ARN", "")
    role_arn          = os.environ.get("EVENTS_ROLE_ARN", "")

    if state_machine_arn and role_arn:
        events.put_rule(
            Name=rule_name,
            ScheduleExpression=f"at({followup_time})",
            State="ENABLED",
        )
        events.put_targets(
            Rule=rule_name,
            Targets=[{
                "Id":      "sfn-target",
                "Arn":     state_machine_arn,
                "RoleArn": role_arn,
                "Input":   json.dumps({
                    "mode":         "followup",
                    "leadId":       lead_id,
                    "lead":         lead,
                    "emailDraftId": saved["id"],
                    "emailDraft":   followup,
                }),
            }],
        )

    db.update("leads", {"status": "emailed"}, params=f"id=eq.{lead_id}")

    return {
        **event,
        "followupDraftId": saved["id"],
        "followupScheduledAt": followup_time,
    }