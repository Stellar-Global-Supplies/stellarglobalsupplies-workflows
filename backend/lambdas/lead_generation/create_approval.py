"""
Lambda: create_approval
Saves the Step Functions task token and pending item to approval_queue.
Invoked with waitForTaskToken — Step Function pauses until approve/reject.

After saving, sends an HTML email to the reviewer with:
  - Content preview
  - One-click Approve button (magic link, expires in 1 hour)
  - One-click Reject button (magic link, expires in 1 hour)

approvalGate: "save" | "publish"
"""
import sys, os, uuid, json, base64
from datetime import datetime, timezone, timedelta
import urllib.request, urllib.parse

sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.supabase_client import get_client
from shared.utils import now_iso, get_ssm


def _get_gmail_token() -> str:
    client_id     = get_ssm(os.environ["GMAIL_CLIENT_ID_PARAM"])
    client_secret = get_ssm(os.environ["GMAIL_CLIENT_SECRET_PARAM"])
    refresh_token = get_ssm(os.environ["GMAIL_REFRESH_TOKEN_PARAM"])
    data = urllib.parse.urlencode({
        "client_id":     client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type":    "refresh_token",
    }).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token", data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["access_token"]


def _send_email(to: str, subject: str, html_body: str):
    sender  = os.environ.get("SENDER_EMAIL", "sales@stellarglobalsupplies.com")
    mime    = (
        f"From: Stellar Workflows <{sender}>\r\n"
        f"To: {to}\r\n"
        f"Subject: {subject}\r\n"
        f"MIME-Version: 1.0\r\n"
        f"Content-Type: text/html; charset=utf-8\r\n\r\n"
        f"{html_body}"
    )
    raw     = base64.urlsafe_b64encode(mime.encode()).decode()
    token   = _get_gmail_token()
    payload = json.dumps({"raw": raw}).encode()
    req     = urllib.request.Request(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        data=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
    print(f"[create_approval] email sent to {to}, gmail id={result.get('id')}")


def _build_email_html(workflow_type, gate_label, preview_html, approve_url, reject_url):
    wf_labels = {
        "social_tech":      "Tech Showcase Post",
        "social_product":   "Product Social Post",
        "blog":             "Blog Post",
        "lead_approval":    "New Lead",
        "lead_email":       "Outreach Email",
        "lead_followup":    "Follow-up Email",
        "payment_followup": "Payment Follow-up Email",
    }
    label = wf_labels.get(workflow_type, workflow_type.replace("_", " ").title())

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
        style="background:#ffffff;border-radius:12px;overflow:hidden;
               box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:#0A2547;padding:24px 32px">
            <table width="100%"><tr>
              <td>
                <div style="color:#F59E0B;font-size:20px;font-weight:bold">Stellar Global Supplies</div>
                <div style="color:#94A3B8;font-size:13px;margin-top:4px">Workflow Automation</div>
              </td>
              <td align="right">
                <div style="background:#F59E0B;color:#0A2547;font-size:12px;font-weight:bold;
                            padding:6px 14px;border-radius:20px">{gate_label.upper()} REQUIRED</div>
              </td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 16px">
            <div style="font-size:22px;font-weight:bold;color:#0A2547">{label}</div>
            <div style="color:#64748B;font-size:14px;margin-top:6px">
              Review the content below. Approve or Reject links expire in <strong>1 hour</strong>.
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px">
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;
                        padding:20px;font-size:14px;color:#334155;line-height:1.6">
              {preview_html}
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px">
            <table width="100%"><tr>
              <td width="48%" align="center">
                <a href="{approve_url}"
                   style="display:block;background:#10B981;color:#ffffff;text-decoration:none;
                          font-size:16px;font-weight:bold;padding:14px 20px;
                          border-radius:8px;text-align:center">
                  ✓ &nbsp; Approve
                </a>
              </td>
              <td width="4%"></td>
              <td width="48%" align="center">
                <a href="{reject_url}"
                   style="display:block;background:#EF4444;color:#ffffff;text-decoration:none;
                          font-size:16px;font-weight:bold;padding:14px 20px;
                          border-radius:8px;text-align:center">
                  ✕ &nbsp; Reject
                </a>
              </td>
            </tr></table>
            <div style="text-align:center;margin-top:16px;color:#94A3B8;font-size:12px">
              Links expire in 1 hour. Also manage approvals at
              <a href="https://app.stellarglobalsupplies.com/approvals"
                 style="color:#1565C0">the dashboard</a>.
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#F8FAFC;border-top:1px solid #E2E8F0;
                     padding:16px 32px;text-align:center">
            <div style="color:#94A3B8;font-size:12px">
              Stellar Global Supplies &middot; Pune, India &middot; stellarglobalsupplies.com
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


def handler(event, context):
    task_token      = event["taskToken"]
    workflow_type   = event["workflowType"]
    approval_gate   = event.get("approvalGate", "save")
    data            = event["data"]
    workflow_run_id = data.get("workflowRunId")

    db = get_client()

    # ── Lead approval ─────────────────────────────────────────────────────────
    if workflow_type == "lead_approval":
        reference_id = data.get("leadId") or data.get("workflowRunId") or str(uuid.uuid4())
        lead         = data.get("lead", {})
        payload      = {"lead": lead, "lead_id": data.get("leadId")}
        preview_html = f"""
<p><strong>Company:</strong> {lead.get('company_name','N/A')}</p>
<p><strong>Contact:</strong> {lead.get('contact_name','N/A')}</p>
<p><strong>Email:</strong> {lead.get('email','N/A')}</p>
<p><strong>Phone:</strong> {lead.get('phone','N/A')}</p>
<p><strong>Industry:</strong> {lead.get('industry','N/A')}</p>
<p><strong>Website:</strong> {lead.get('website','N/A')}</p>
<p><strong>Address:</strong> {lead.get('address','N/A')}</p>
<p><strong>Description:</strong> {lead.get('description','N/A')}</p>
<p><strong>Source:</strong> {lead.get('source','N/A')}</p>"""
        email_subject = f"[Approval] New Lead — {lead.get('company_name','')}"

    # ── Email approval ────────────────────────────────────────────────────────
    elif workflow_type in ("lead_email", "lead_followup"):
        reference_id = data.get("emailDraftId") or data.get("leadId")
        payload      = {
            "lead":       data.get("lead"),
            "emailDraft": data.get("emailDraft"),
            "lead_id":    data.get("leadId"),
        }
        draft        = data.get("emailDraft", {})
        lead         = data.get("lead", {})
        preview_html = f"""
<p><strong>To:</strong> {lead.get('email','')}</p>
<p><strong>Subject:</strong> {draft.get('subject','')}</p>
<hr style="border:none;border-top:1px solid #E2E8F0;margin:12px 0"/>
<div style="white-space:pre-wrap;font-size:13px">{draft.get('body','')[:800]}</div>"""
        email_subject = f"[Approval] Email Draft — {lead.get('company_name','')}"

    # ── Social post (Gate 1 save OR Gate 2 publish) ───────────────────────────
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
        gate_label_str   = "Save Post" if approval_gate == "save" else "Publish Post"
        platforms        = post.get("platforms") or {}
        active_platforms = [p for p, v in platforms.items() if v]
        platform_str     = ", ".join(active_platforms) if active_platforms else post.get("platform", "")
        img_tag          = f'<img src="{post["image_url"]}" style="max-width:100%;border-radius:6px;margin:10px 0"/>' if post.get("image_url") else ""
        caption          = (post.get("caption") or post.get("content", ""))[:400]
        preview_html     = f"""
<p><strong>Type:</strong> {post.get('type','').title()}</p>
<p><strong>Title:</strong> {post.get('title','')}</p>
<p><strong>Platforms:</strong> {platform_str}</p>
{img_tag}
<p style="white-space:pre-wrap;margin-top:10px">{caption}{"..." if len(caption)==400 else ""}</p>"""
        email_subject = f"[{gate_label_str}] {post.get('type','').title()} Post — {post.get('title','')}"

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
<p><strong>Title:</strong> {blog.get('title','')}</p>
<p style="color:#64748B">{blog.get('excerpt','')}</p>"""
        email_subject = f"[Approval] Blog Post — {blog.get('title','')}"

    # ── Generic fallback ──────────────────────────────────────────────────────
    else:
        reference_id  = data.get("postId") or data.get("blogId") or str(uuid.uuid4())
        payload       = data
        preview_html  = f"<pre style='font-size:12px'>{str(data)[:1000]}</pre>"
        email_subject = f"[Approval] {workflow_type.replace('_',' ').title()}"

    if workflow_run_id and isinstance(payload, dict):
        payload = {**payload, "workflowRunId": workflow_run_id}

    # ── Generate magic token (1 hour expiry) ──────────────────────────────────
    email_token   = str(uuid.uuid4()).replace("-", "")
    token_expires = datetime.now(timezone.utc) + timedelta(hours=1)
    gate_label_str = "Save" if approval_gate == "save" else "Publish"

    # ── Save to approval_queue ────────────────────────────────────────────────
    row = {
        "workflow_type":    workflow_type,
        "reference_id":     str(reference_id),
        "task_token":       task_token,
        "payload":          payload,
        "preview_html":     f"<div style='font-family:Arial,sans-serif'>{preview_html}</div>",
        "status":           "pending",
        "email_token":      email_token,
        "token_expires_at": token_expires.isoformat(),
    }
    if workflow_run_id:
        row["workflow_run_id"] = workflow_run_id

    try:
        saved = db.insert("approval_queue", row)
    except Exception as exc:
        exc_str = str(exc)
        if "workflow_run_id" in exc_str:
            fallback = {k: v for k, v in row.items() if k != "workflow_run_id"}
            saved = db.insert("approval_queue", fallback)
        elif "email_token" in exc_str or "token_expires_at" in exc_str:
            # Migration 008 not yet run — insert without token fields
            fallback   = {k: v for k, v in row.items() if k not in ("email_token", "token_expires_at")}
            saved      = db.insert("approval_queue", fallback)
            email_token = None
        else:
            raise

    approval_id = saved["id"]
    print(f"[create_approval] queued {workflow_type} gate={approval_gate} id={approval_id}")

    # ── Send notification email ───────────────────────────────────────────────
    if email_token:
        try:
            reviewer_email = get_ssm(
                os.environ.get("REVIEWER_EMAIL_PARAM", "/stellar-wf/approval/reviewer_email")
            )
            api_base    = os.environ.get("API_BASE_URL", "").rstrip("/")
            approve_url = f"{api_base}/approvals/{approval_id}/email-action?token={email_token}&action=approve"
            reject_url  = f"{api_base}/approvals/{approval_id}/email-action?token={email_token}&action=reject"

            html = _build_email_html(
                workflow_type=workflow_type,
                gate_label=gate_label_str,
                preview_html=preview_html,
                approve_url=approve_url,
                reject_url=reject_url,
            )
            _send_email(to=reviewer_email, subject=email_subject, html_body=html)
        except Exception as e:
            # Never block the workflow for email failures
            print(f"[create_approval] WARNING: email notification failed: {e}")

    return {"approvalId": approval_id, "status": "waiting"}