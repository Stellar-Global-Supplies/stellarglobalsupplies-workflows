"""
Lambda: save_lead
Saves a new lead to Supabase leads table.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.supabase_client import get_client


def handler(event, context):
    lead = event["lead"]
    db   = get_client()

    row = {
        "company_name":    lead.get("company_name"),
        "website":         lead.get("website"),
        "email":           lead["email"].lower().strip(),
        "phone":           lead.get("phone"),
        "industry":        lead.get("industry"),
        "address":         lead.get("address"),
        "contact_name":    lead.get("contact_name"),
        "description":     lead.get("description"),
        "status":          "approved",
        "source":          lead.get("source", "ai_generated"),
        "workflow_run_id": event.get("workflowRunId") or None,
    }

    saved = db.insert("leads", row)

    return {
        **event,
        "leadId": saved["id"],
        "lead":   {**lead, "id": saved["id"]},
    }