"""
Lambda: draft_email
Uses Amazon Nova to draft a personalized outreach email for the lead.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.bedrock_client import generate_json
from shared.supabase_client import get_client

SENDER_NAME    = "Stellar Global Supplies Team"
SENDER_EMAIL   = os.environ.get("SENDER_EMAIL", "sales@stellarglobalsupplies.com")
COMPANY_WEBSITE = "https://stellarglobalsupplies.com"

SYSTEM = """You are a professional B2B sales copywriter for Stellar Global Supplies.
Write concise, personalized outreach emails that are warm but professional.
Never sound like a mass mailer. Reference the specific company and why we can help them."""


def handler(event, context):
    lead     = event["lead"]
    lead_id  = event["leadId"]

    prompt = f"""
Draft a B2B outreach email from {SENDER_NAME} to {lead.get('contact_name', 'the team')} at {lead['company_name']}.

Lead details:
- Company: {lead['company_name']}
- Industry: {lead.get('industry', 'unknown')}
- Website: {lead.get('website', 'N/A')}
- Description: {lead.get('description', '')}
- Location: {lead.get('address', '')}

Our company (Stellar Global Supplies) offers:
- Industrial, commercial, and office supplies in bulk
- Competitive pricing with volume discounts
- Global logistics and reliable delivery
- Dedicated account manager
- Website: {COMPANY_WEBSITE}

Return JSON with exactly these fields:
{{
  "subject": "email subject line",
  "body": "full email body with proper greeting, value proposition, CTA, and signature from {SENDER_NAME}"
}}
"""

    draft = generate_json(prompt, system=SYSTEM, max_tokens=1500)

    db  = get_client()
    row = {
        "lead_id":     lead_id,
        "subject":     draft["subject"],
        "body":        draft["body"],
        "is_followup": False,
        "status":      "draft",
    }
    saved = db.insert("email_drafts", row)

    return {
        **event,
        "emailDraftId": saved["id"],
        "emailDraft":   {**draft, "id": saved["id"], "lead_id": lead_id},
    }
