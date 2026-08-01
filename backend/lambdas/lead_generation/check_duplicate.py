"""
Lambda: check_duplicate_lead
Checks Supabase for existing lead with same email or company_name.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import urllib.parse
from shared.supabase_client import get_client


def handler(event, context):
    lead = event["lead"]
    email        = lead["email"].lower().strip()
    company_name = lead.get("company_name", "").strip().lower()

    db = get_client()

    # URL-encode email — it may contain '+' or other special chars that break query strings
    enc_email = urllib.parse.quote(email, safe="")
    by_email = db.select("leads", params=f"email=eq.{enc_email}&select=id,email,status&limit=1")

    # Check by company name (fuzzy match via ilike)
    enc_name = urllib.parse.quote(f"%{company_name}%", safe="")
    by_name = db.select("leads", params=f"company_name=ilike.{enc_name}&select=id,company_name,status&limit=1")

    is_duplicate = bool(by_email or by_name)
    existing_id  = (by_email or by_name)[0]["id"] if is_duplicate else None

    return {
        **event,
        "isDuplicate": is_duplicate,
        "existingLeadId": existing_id,
    }