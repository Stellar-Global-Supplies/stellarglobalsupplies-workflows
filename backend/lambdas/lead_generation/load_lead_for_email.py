"""
Lambda: load_lead_for_email
Fetches an existing lead and prepares it for email drafting.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.supabase_client import get_client


def handler(event, context):
    lead_id = event.get("leadId")
    if not lead_id:
        raise ValueError("Missing leadId")

    db = get_client()
    rows = db.select("leads", params=f"id=eq.{lead_id}&limit=1")
    if not rows:
        raise ValueError(f"Lead not found: {lead_id}")

    lead = rows[0]
    return {
        **event,
        "lead": lead,
    }
