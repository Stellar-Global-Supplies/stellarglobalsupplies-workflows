"""
Lambda: create_approval
Saves the Step Functions task token and pending item to the approval_queue table.
This lambda is invoked with waitForTaskToken - the Step Function will pause until
a human approves/rejects via the API.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.supabase_client import get_client
from shared.utils import now_iso


def handler(event, context):
    """
    Called by Step Functions with .waitForTaskToken pattern.
    event = {
      "taskToken": "...",
      "workflowType": "lead_email" | "lead_followup",
      "data": { ...full workflow state... }
    }
    """
    task_token    = event["taskToken"]
    workflow_type = event["workflowType"]
    data          = event["data"]

    # Determine reference_id
    if workflow_type in ("lead_email", "lead_followup"):
        reference_id = data.get("emailDraftId") or data.get("leadId")
        payload = {
            "lead":        data.get("lead"),
            "emailDraft":  data.get("emailDraft"),
            "lead_id":     data.get("leadId"),
        }
        # Build HTML preview
        draft = data.get("emailDraft", {})
        preview_html = f"""
<div style="font-family:Arial,sans-serif;max-width:600px">
  <p><strong>To:</strong> {data.get('lead', {}).get('email','')}</p>
  <p><strong>Subject:</strong> {draft.get('subject','')}</p>
  <hr/>
  <div style="white-space:pre-wrap">{draft.get('body','')}</div>
</div>"""
    else:
        reference_id = data.get("postId") or data.get("blogId")
        payload      = data
        preview_html = f"<pre>{str(data)[:2000]}</pre>"

    db  = get_client()
    row = {
        "workflow_type": workflow_type,
        "reference_id":  str(reference_id),
        "task_token":    task_token,
        "payload":       payload,
        "preview_html":  preview_html,
        "status":        "pending",
    }
    saved = db.insert("approval_queue", row)

    # Do NOT return - lambda exits here, Step Function waits for SendTaskSuccess/Failure
    return {"approvalId": saved["id"], "status": "waiting"}
