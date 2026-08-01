"""
Lambda: generate_leads
Step: First step in Lead Generation workflow.

Flow:
  1. Use Nova AI to identify a target company (name, website, industry, etc.)
  2. Check Hunter.io credits — if available, search for REAL verified email
  3. If Hunter.io has no credits OR finds nothing → fall back to AI-generated free email
  4. Deduplication happens in the NEXT step (check_duplicate)
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.bedrock_client import generate_json
from shared.supabase_client import get_client
from shared.hunter_client   import find_email_for_lead, credits_remaining
from shared.utils            import now_iso

COMPANY_NAME = "Stellar Global Supplies"
COMPANY_DESC = (
    "Stellar Global Supplies is a global B2B supplier of industrial, commercial, "
    "and office supplies. Bulk procurement, competitive pricing, reliable logistics, "
    "and dedicated account management for businesses worldwide."
)


def _ai_generate_company(industry: str, country: str, context: str) -> dict:
    """Ask Nova to describe a realistic target company (no email yet)."""
    prompt = f"""
You are a B2B sales intelligence AI for {COMPANY_NAME}.
{COMPANY_DESC}

Identify ONE realistic potential business (not a made-up company) in:
- Industry: {industry}
- Country/Region: {country}
{f"- Context: {context}" if context else ""}

Return a JSON object with these fields only:
{{
  "company_name": "real-sounding company name",
  "website":      "https://plausible-domain.com",
  "industry":     "{industry}",
  "address":      "realistic address in {country}",
  "description":  "1-2 sentences why they need bulk industrial/office/commercial supplies"
}}

Do NOT include any email address — that will be sourced separately.
"""
    return generate_json(prompt, max_tokens=600)


def _ai_generate_free_email(company: dict) -> dict:
    """Fallback: ask Nova to generate a contact with a free email."""
    prompt = f"""
Generate a realistic contact person at {company['company_name']} ({company.get('industry', '')}, {company.get('address', '')}).
The contact should be a procurement/operations/purchasing manager.

Return JSON:
{{
  "contact_name": "First Last",
  "email":        "firstname.lastname@gmail.com  (use Gmail, Outlook, or Yahoo — free email only)",
  "phone":        "+country-code-local-number"
}}
"""
    contact = generate_json(prompt, max_tokens=300)
    return {
        **company,
        "contact_name": contact.get("contact_name", ""),
        "email":        contact.get("email", "").lower().strip(),
        "phone":        contact.get("phone", ""),
        "source":       "ai_generated",
    }


def handler(event, context):
    """
    Input:
      target_industry:    str  (e.g. "manufacturing")
      target_country:     str  (e.g. "India")
      additional_context: str  (optional)

    Output: adds `lead` dict and `hunterCreditsRemaining` to event
    """
    industry   = event.get("target_industry", "manufacturing")
    country    = event.get("target_country", "India")
    extra      = event.get("additional_context", "")

    # Step 1 — Generate company details via AI
    company = _ai_generate_company(industry, country, extra)
    for f in ("company_name", "industry"):
        if not company.get(f):
            raise ValueError(f"AI did not return required field: {f}")

    db = get_client()

    # Step 2 — Try Hunter.io for a verified real email
    hunter_result = find_email_for_lead(
        company_website=company.get("website", ""),
        company_name=company["company_name"],
        db_client=db,
    )

    if hunter_result.get("hunter_used") and hunter_result.get("email"):
        # Hunter found a real email
        lead = {
            **company,
            "email":        hunter_result["email"].lower().strip(),
            "contact_name": hunter_result.get("contact_name") or company.get("contact_name", ""),
            "phone":        hunter_result.get("phone") or company.get("phone", ""),
            "description":  hunter_result.get("description") or company.get("description", ""),
            "source":       "hunter.io",
            "created_at":   now_iso(),
        }
    else:
        # Fallback: AI free email
        skip_reason = hunter_result.get("hunter_skipped_reason", "unknown")
        print(f"[generate_leads] Hunter.io skipped ({skip_reason}). Using AI fallback.")
        lead = _ai_generate_free_email(company)
        lead["created_at"] = now_iso()

    # Fetch updated credits count for monitoring
    try:
        credits_left = credits_remaining()
    except Exception:
        credits_left = None

    return {
        **event,
        "lead":                   lead,
        "hunterUsed":             hunter_result.get("hunter_used", False),
        "hunterSkipReason":       hunter_result.get("hunter_skipped_reason"),
        "hunterCreditsRemaining": credits_left,
    }
