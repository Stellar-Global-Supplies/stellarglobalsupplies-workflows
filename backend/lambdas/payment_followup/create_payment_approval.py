"""
Lambda: create_payment_approval
Creates an approval_queue entry so the team can review and edit
the AI-drafted payment follow-up email before it is sent.
Gate: 'save' — approving sends the email.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import json
import boto3
from shared.supabase_client import get_client
from shared.utils import now_iso

def handler(event, context):
    order      = event.get("order", {})
    email_draft = event.get("emailDraft", {})

    if not email_draft:
        raise ValueError("Missing emailDraft in event")

    db = get_client()

    # Build payload the approval UI will render
    payload = {
        "approvalGate":  "save",
        "workflowType":  "payment_followup",
        "orderId":       order.get("id"),
        "order":         order,
        "email": {
            "to":      email_draft.get("to", ""),
            "subject": email_draft.get("subject", ""),
            "body":    email_draft.get("body", ""),
        },
        "emailDraftId":  email_draft.get("id"),
        "totalPayable":  email_draft.get("total_payable", 0),
        "customerName":  email_draft.get("customer_name", ""),
    }

    # Create approval queue entry with task token for Step Functions callback
    # We use a simpler pattern here: store the execution ARN so the send
    # lambda can look it up when approved. The approval_handler will call
    # send_payment_email directly via a dedicated route.
    row = {
        "workflow_type":   "payment_followup",
        "status":          "pending",
        "payload":         json.dumps(payload),
        "workflow_run_id": event.get("workflowRunId"),
        "created_at":      now_iso(),
        "updated_at":      now_iso(),
    }

    saved = db.insert("approval_queue", row)
    print(f"[create_payment_approval] approval_id={saved['id']} order={order.get('id')} customer={order.get('customer_name')}")

    return {
        **event,
        "approvalId": saved["id"],
        "status": "pending_approval",
    }