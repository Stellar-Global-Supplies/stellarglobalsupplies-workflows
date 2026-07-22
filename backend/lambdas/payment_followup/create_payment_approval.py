"""
Lambda: create_payment_approval
Creates an approval_queue entry so the team can review and edit
the AI-drafted payment follow-up email before it is sent.
Gate: 'save' — approving sends the email.

Also sends an email notification with one-click Approve/Reject links.
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


def _send_notification(to: str, approval_id: str, email_token: str,
                       order: dict, email_draft: dict):
    sender   = os.environ.get("SENDER_EMAIL", "sales@stellarglobalsupplies.com")
    api_base = os.environ.get("API_BASE_URL", "").rstrip("/")

    approve_url = f"{api_base}/approvals/{approval_id}/email-action?token={email_token}&action=approve"
    reject_url  = f"{api_base}/approvals/{approval_id}/email-action?token={email_token}&action=reject"

    customer = order.get("customer_name", "")
    subject_line = email_draft.get("subject", "")
    body_preview = email_draft.get("body", "")[:600]

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
        style="background:#fff;border-radius:12px;overflow:hidden;
               box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:#0A2547;padding:24px 32px">
            <div style="color:#F59E0B;font-size:20px;font-weight:bold">Stellar Global Supplies</div>
            <div style="color:#94A3B8;font-size:13px;margin-top:4px">Payment Follow-up Approval</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 16px">
            <div style="font-size:20px;font-weight:bold;color:#0A2547">
              Payment Follow-up Email — {customer}
            </div>
            <div style="color:#64748B;font-size:14px;margin-top:6px">
              Review the AI-drafted email below. Links expire in <strong>1 hour</strong>.
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px">
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;
                        padding:20px;font-size:14px;color:#334155">
              <p><strong>To:</strong> {email_draft.get('to','')}</p>
              <p><strong>Subject:</strong> {subject_line}</p>
              <hr style="border:none;border-top:1px solid #E2E8F0;margin:12px 0"/>
              <div style="white-space:pre-wrap;font-size:13px">{body_preview}{"..." if len(body_preview)==600 else ""}</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px">
            <table width="100%"><tr>
              <td width="48%" align="center">
                <a href="{approve_url}"
                   style="display:block;background:#10B981;color:#fff;text-decoration:none;
                          font-size:16px;font-weight:bold;padding:14px 20px;
                          border-radius:8px;text-align:center">
                  ✓ &nbsp; Approve & Send
                </a>
              </td>
              <td width="4%"></td>
              <td width="48%" align="center">
                <a href="{reject_url}"
                   style="display:block;background:#EF4444;color:#fff;text-decoration:none;
                          font-size:16px;font-weight:bold;padding:14px 20px;
                          border-radius:8px;text-align:center">
                  ✕ &nbsp; Reject
                </a>
              </td>
            </tr></table>
            <div style="text-align:center;margin-top:16px;color:#94A3B8;font-size:12px">
              Links expire in 1 hour. Also manage at
              <a href="https://app.stellarglobalsupplies.com/approvals"
                 style="color:#1565C0">the dashboard</a>.
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#F8FAFC;border-top:1px solid #E2E8F0;
                     padding:16px 32px;text-align:center">
            <div style="color:#94A3B8;font-size:12px">
              Stellar Global Supplies &middot; Pune, India
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>"""

    mime = (
        f"From: Stellar Workflows <{sender}>\r\n"
        f"To: {to}\r\n"
        f"Subject: [Approval] Payment Follow-up — {customer}\r\n"
        f"MIME-Version: 1.0\r\n"
        f"Content-Type: text/html; charset=utf-8\r\n\r\n"
        f"{html}"
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
    print(f"[create_payment_approval] email sent id={result.get('id')}")


def handler(event, context):
    order       = event.get("order", {})
    email_draft = event.get("emailDraft", {})

    if not email_draft:
        raise ValueError("Missing emailDraft in event")

    db = get_client()

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

    # Generate magic token (1 hour expiry)
    email_token   = str(uuid.uuid4()).replace("-", "")
    token_expires = datetime.now(timezone.utc) + timedelta(hours=1)

    row = {
        "workflow_type":    "payment_followup",
        "status":           "pending",
        "payload":          json.dumps(payload),
        "workflow_run_id":  event.get("workflowRunId"),
        "task_token":       f"payment-direct-{uuid.uuid4()}",  # no SF resume needed
        "email_token":      email_token,
        "token_expires_at": token_expires.isoformat(),
        "created_at":       now_iso(),
        "updated_at":       now_iso(),
    }

    try:
        saved = db.insert("approval_queue", row)
    except Exception as exc:
        # Graceful fallback if migration 008 not yet run
        if "email_token" in str(exc) or "token_expires_at" in str(exc):
            fallback = {k: v for k, v in row.items()
                        if k not in ("email_token", "token_expires_at")}
            saved = db.insert("approval_queue", fallback)
            email_token = None
        else:
            raise

    approval_id = saved["id"]
    print(f"[create_payment_approval] approval_id={approval_id} "
          f"order={order.get('id')} customer={order.get('customer_name')}")

    # Send notification email
    if email_token:
        try:
            reviewer_email = get_ssm(
                os.environ.get("REVIEWER_EMAIL_PARAM", "/stellar-wf/approval/reviewer_email")
            )
            _send_notification(reviewer_email, approval_id, email_token, order, email_draft)
        except Exception as e:
            print(f"[create_payment_approval] WARNING: email notification failed: {e}")

    return {
        **event,
        "approvalId": approval_id,
        "status":     "pending_approval",
    }