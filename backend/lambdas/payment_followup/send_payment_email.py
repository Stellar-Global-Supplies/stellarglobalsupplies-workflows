"""
Lambda: send_payment_email
Sends the approved payment follow-up email to the customer via Gmail OAuth.
Called by approval_handler after team approves the draft.
Also marks the order with a payment_followup_sent_at note in metadata (if column exists).
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import json
import base64
import urllib.request
import urllib.parse
from shared.supabase_client import get_client
from shared.utils import get_ssm, now_iso


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
        "https://oauth2.googleapis.com/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["access_token"]


def _build_html_email(subject: str, body: str, order: dict) -> str:
    """Wrap plain text body in a clean HTML email template."""
    body_html = body.replace("\n\n", "</p><p style='margin:14px 0;color:#1e293b;line-height:1.7;'>")
    body_html = body_html.replace("\n", "<br>")
    body_html = f"<p style='margin:14px 0;color:#1e293b;line-height:1.7;'>{body_html}</p>"

    sale_cost = float(order.get("sale_cost", 0))
    cgst      = float(order.get("cgst_total", 0))
    sgst      = float(order.get("sgst_total", 0))
    total     = sale_cost + cgst + sgst

    def fmt(n): return f"₹{float(n):,.2f}"

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;">

  <div style="background:#0A2547;padding:24px 32px;display:flex;align-items:center;gap:12px;">
    <div style="width:36px;height:36px;background:#F59E0B;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#0A2547;font-size:18px;flex-shrink:0;">S</div>
    <div>
      <div style="color:#fff;font-weight:700;font-size:16px;">Stellar Global Supplies</div>
      <div style="color:#94a3b8;font-size:12px;">Payment Follow-up</div>
    </div>
  </div>

  <div style="padding:32px;">
    {body_html}

    <table style="width:100%;border-collapse:collapse;margin:24px 0;font-size:13px;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="text-align:left;padding:10px 12px;border:1px solid #e2e8f0;color:#64748b;font-weight:600;">Description</th>
          <th style="text-align:right;padding:10px 12px;border:1px solid #e2e8f0;color:#64748b;font-weight:600;">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e2e8f0;color:#1e293b;">
            {order.get('material','')} ({order.get('product_type','')}) &times; {order.get('quantity','')} {order.get('unit','Pieces')}
          </td>
          <td style="text-align:right;padding:10px 12px;border:1px solid #e2e8f0;color:#1e293b;">{fmt(sale_cost)}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e2e8f0;color:#64748b;">CGST</td>
          <td style="text-align:right;padding:10px 12px;border:1px solid #e2e8f0;color:#64748b;">{fmt(cgst)}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e2e8f0;color:#64748b;">SGST</td>
          <td style="text-align:right;padding:10px 12px;border:1px solid #e2e8f0;color:#64748b;">{fmt(sgst)}</td>
        </tr>
        <tr style="background:#f0fdf4;">
          <td style="padding:12px;border:1px solid #e2e8f0;font-weight:700;color:#0A2547;">Total Payable</td>
          <td style="text-align:right;padding:12px;border:1px solid #e2e8f0;font-weight:700;color:#0A2547;">{fmt(total)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center;">
    <p style="margin:0;font-size:12px;color:#94a3b8;">
      Stellar Global Supplies · stellarglobalsupplies.com<br>
      This is an automated payment reminder. Please ignore if payment has already been made.
    </p>
  </div>
</div>
</body></html>"""


def _send_via_gmail(access_token: str, to: str, subject: str, html: str, sender: str):
    mime = (
        f"From: Stellar Global Supplies <{sender}>\r\n"
        f"To: {to}\r\n"
        f"Subject: {subject}\r\n"
        f"MIME-Version: 1.0\r\n"
        f"Content-Type: text/html; charset=utf-8\r\n\r\n"
        f"{html}"
    )
    raw = base64.urlsafe_b64encode(mime.encode()).decode()
    payload = json.dumps({"raw": raw}).encode()
    req = urllib.request.Request(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        data=payload,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type":  "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def handler(event, context):
    order      = event.get("order", {})
    email_data = event.get("email", {})   # from approval payload: {to, subject, body}
    approval_id = event.get("approvalId")

    to      = email_data.get("to", "")
    subject = email_data.get("subject", "Payment Follow-up")
    body    = email_data.get("body", "")
    sender  = os.environ.get("SENDER_EMAIL", "sales@stellarglobalsupplies.com")

    if not to:
        raise ValueError("No recipient email address on order")

    html         = _build_html_email(subject, body, order)
    access_token = _get_gmail_token()
    result       = _send_via_gmail(access_token, to, subject, html, sender)

    print(f"[send_payment_email] sent to={to} messageId={result.get('id')} order={order.get('id')}")

    # Update approval as sent
    db = get_client()
    if approval_id:
        try:
            db.update("approval_queue",
                      {"status": "approved", "updated_at": now_iso()},
                      params=f"id=eq.{approval_id}")
        except Exception as e:
            print(f"[send_payment_email] approval update failed: {e}")

    return {
        **event,
        "emailSent":   True,
        "messageId":   result.get("id"),
        "sentTo":      to,
        "sentAt":      now_iso(),
    }