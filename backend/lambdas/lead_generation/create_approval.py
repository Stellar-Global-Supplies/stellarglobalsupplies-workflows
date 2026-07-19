"""
Lambda: create_approval
Saves the Step Functions task token and pending item to approval_queue.
Invoked with waitForTaskToken — Step Function pauses until approve/reject.

approvalGate values:
  "save"    — Gate 1: reviewer decides whether to save the generated content
  "publish" — Gate 2: reviewer decides whether to publish/send saved content
"""
import sys, os, uuid
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.supabase_client import get_client
from shared.utils import now_iso


def handler(event, context):
    task_token    = event["taskToken"]
    workflow_type = event["workflowType"]
    approval_gate = event.get("approvalGate", "save")
    data          = event["data"]
    workflow_run_id = data.get("workflowRunId")

    db = get_client()

    # ── Lead approval ─────────────────────────────────────────────────────────
    if workflow_type == "lead_approval":
        raw_lead_id  = data.get("leadId")
        reference_id = raw_lead_id or data.get("workflowRunId") or str(uuid.uuid4())
        lead         = data.get("lead", {})
        payload      = {"lead": lead, "lead_id": data.get("leadId")}
        preview_html = f"""
<div style="font-family:Arial,sans-serif;max-width:600px">
  <h2>New Lead for Approval</h2>
  <p><strong>Company:</strong> {lead.get('company_name','N/A')}</p>
  <p><strong>Contact:</strong> {lead.get('contact_name','N/A')}</p>
  <p><strong>Email:</strong> {lead.get('email','N/A')}</p>
  <p><strong>Phone:</strong> {lead.get('phone','N/A')}</p>
  <p><strong>Industry:</strong> {lead.get('industry','N/A')}</p>
  <p><strong>Website:</strong> {lead.get('website','N/A')}</p>
  <p><strong>Address:</strong> {lead.get('address','N/A')}</p>
  <p><strong>Description:</strong> {lead.get('description','N/A')}</p>
  <p><strong>Source:</strong> {lead.get('source','N/A')}</p>
</div>"""

    # ── Email approval ────────────────────────────────────────────────────────
    elif workflow_type in ("lead_email", "lead_followup"):
        reference_id = data.get("emailDraftId") or data.get("leadId")
        payload      = {
            "lead":       data.get("lead"),
            "emailDraft": data.get("emailDraft"),
            "lead_id":    data.get("leadId"),
        }
        draft        = data.get("emailDraft", {})
        preview_html = f"""
<div style="font-family:Arial,sans-serif;max-width:600px">
  <p><strong>To:</strong> {data.get('lead',{}).get('email','')}</p>
  <p><strong>Subject:</strong> {draft.get('subject','')}</p>
  <hr/>
  <div style="white-space:pre-wrap">{draft.get('body','')}</div>
</div>"""

    # ── Social post approvals (Gate 1 save OR Gate 2 publish) ────────────────
    elif workflow_type in ("social_tech", "social_product"):
        post         = data.get("post", {})
        post_id      = data.get("postId") or post.get("id")
        reference_id = post_id or data.get("workflowRunId") or str(uuid.uuid4())
        payload      = {
            "post":          post,
            "postId":        post_id,
            "workflowRunId": workflow_run_id,
            "approvalGate":  approval_gate,
        }
        gate_label       = "Save Post" if approval_gate == "save" else "Publish Post"
        platforms        = post.get("platforms") or {}
        active_platforms = [p for p, v in platforms.items() if v]
        platform_str     = ", ".join(active_platforms) if active_platforms else post.get("platform", "")
        preview_html     = f"""
<div style="font-family:Arial,sans-serif;max-width:600px">
  <h2>{gate_label}</h2>
  <p><strong>Type:</strong> {post.get('type','')}</p>
  <p><strong>Title:</strong> {post.get('title','')}</p>
  <p><strong>Platforms:</strong> {platform_str}</p>
  {"<img src='" + post.get('image_url','') + "' style='max-width:100%;margin:8px 0'/>" if post.get('image_url') else ''}
  <p style="white-space:pre-wrap">{(post.get('caption') or post.get('content',''))[:500]}</p>
</div>"""
        # Set pending_approval status while waiting for Gate 1
        if approval_gate == "save" and post_id:
            try:
                db.update("social_posts", {"status": "pending_approval"}, params=f"id=eq.{post_id}")
            except Exception as e:
                print(f"[create_approval] could not set post status: {e}")

    # ── Blog approval ─────────────────────────────────────────────────────────
    elif workflow_type == "blog":
        blog         = data.get("blog", {})
        blog_id      = data.get("blogId") or blog.get("id")
        reference_id = blog_id or data.get("workflowRunId") or str(uuid.uuid4())
        payload      = {"blog": blog, "blogId": blog_id, "workflowRunId": workflow_run_id, "approvalGate": approval_gate}
        preview_html = f"""
<div style="font-family:Arial,sans-serif;max-width:600px">
  <h2>Blog Post for Approval</h2>
  <p><strong>Title:</strong> {blog.get('title','')}</p>
  <p>{blog.get('excerpt','')}</p>
</div>"""

    # ── Generic fallback ──────────────────────────────────────────────────────
    else:
        reference_id = data.get("postId") or data.get("blogId") or str(uuid.uuid4())
        payload      = data
        preview_html = f"<pre>{str(data)[:2000]}</pre>"

    if workflow_run_id and isinstance(payload, dict):
        payload = {**payload, "workflowRunId": workflow_run_id}

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

    try:
        saved = db.insert("approval_queue", row)
    except Exception as exc:
        if "workflow_run_id" not in str(exc):
            raise
        fallback = {k: v for k, v in row.items() if k != "workflow_run_id"}
        saved = db.insert("approval_queue", fallback)

    print(f"[create_approval] queued {workflow_type} gate={approval_gate} id={saved['id']}")
    return {"approvalId": saved["id"], "status": "waiting"}