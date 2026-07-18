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
    workflow_run_id = data.get("workflowRunId")

    # Determine reference_id
    if workflow_type == "lead_approval":
        reference_id = data.get("leadId")
        lead = data.get("lead", {})
        payload = {
            "lead":      lead,
            "lead_id":   data.get("leadId"),
        }
        # Build HTML preview for lead approval
        preview_html = f"""
<div style="font-family:Arial,sans-serif;max-width:600px">
  <h2>New Lead for Approval</h2>
  <p><strong>Company:</strong> {lead.get('company_name', 'N/A')}</p>
  <p><strong>Contact:</strong> {lead.get('contact_name', 'N/A')}</p>
  <p><strong>Email:</strong> {lead.get('email', 'N/A')}</p>
  <p><strong>Phone:</strong> {lead.get('phone', 'N/A')}</p>
  <p><strong>Industry:</strong> {lead.get('industry', 'N/A')}</p>
  <p><strong>Website:</strong> {lead.get('website', 'N/A')}</p>
  <p><strong>Address:</strong> {lead.get('address', 'N/A')}</p>
  <p><strong>Description:</strong> {lead.get('description', 'N/A')}</p>
  <p><strong>Source:</strong> {lead.get('source', 'N/A')}</p>
</div>"""
    elif workflow_type in ("lead_email", "lead_followup"):
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

    # Keep the workflow run id inside the payload too so approval_handler can
    # still resolve and update workflow_runs even if the approval_queue schema
    # is missing the optional workflow_run_id column in an older deployment.
    if workflow_run_id and isinstance(payload, dict):
        payload = {**payload, "workflowRunId": workflow_run_id}

    db  = get_client()
    row = {
        "workflow_type": workflow_type,
        "reference_id":  str(reference_id),
        "task_token":    task_token,
        "payload":       payload,
        "preview_html":  preview_html,
        "status":        "pending",
    }

    if workflow_run_id:
        row["workflow_run_id"] = workflow_run_id

    # Older Supabase deployments may not have the workflow_run_id column yet.
    # Insert the approval anyway, then fall back to a schema-compatible row.
    try:
        saved = db.insert("approval_queue", row)
    except Exception as exc:
        if "workflow_run_id" not in str(exc):
            raise
        fallback_row = {k: v for k, v in row.items() if k != "workflow_run_id"}
        saved = db.insert("approval_queue", fallback_row)

    # Do NOT return - lambda exits here, Step Function waits for SendTaskSuccess/Failure
    return {"approvalId": saved["id"], "status": "waiting"}
