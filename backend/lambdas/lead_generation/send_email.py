"""
Lambda: send_email
Sends approved email via Gmail OAuth (using refresh token stored in SSM).
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import json
import base64
import urllib.request
import urllib.parse
from shared.supabase_client import get_client
from shared.utils import now_iso, get_ssm


def get_gmail_access_token() -> str:
    """Exchange refresh token for access token."""
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


def build_mime_message(to: str, subject: str, body: str, sender: str) -> str:
    """Build RFC2822 MIME message."""
    mime = (
        f"From: {sender}\r\n"
        f"To: {to}\r\n"
        f"Subject: {subject}\r\n"
        f"MIME-Version: 1.0\r\n"
        f"Content-Type: text/plain; charset=utf-8\r\n\r\n"
        f"{body}"
    )
    return base64.urlsafe_b64encode(mime.encode()).decode()


def send_gmail(access_token: str, raw: str) -> dict:
    payload = json.dumps({"raw": raw}).encode()
    req = urllib.request.Request(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        data=payload,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def handler(event, context):
    lead       = event["lead"]
    draft      = event["emailDraft"]
    draft_id   = event["emailDraftId"]
    lead_id    = event["leadId"]
    sender     = os.environ.get("SENDER_EMAIL", "sales@stellarglobalsupplies.com")

    access_token = get_gmail_access_token()
    raw          = build_mime_message(lead["email"], draft["subject"], draft["body"], sender)
    result       = send_gmail(access_token, raw)

    db  = get_client()
    now = now_iso()
    # Update draft status
    db.update("email_drafts", {"status": "sent", "sent_at": now},
              params=f"id=eq.{draft_id}")
    # Update lead status
    db.update("leads", {"status": "emailed", "updated_at": now},
              params=f"id=eq.{lead_id}")

    return {
        **event,
        "gmailMessageId": result.get("id"),
        "emailSentAt":    now,
    }
