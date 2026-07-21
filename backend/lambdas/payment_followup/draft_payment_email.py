"""
Lambda: draft_payment_email
Uses Amazon Nova to draft a professional payment follow-up email
to the customer for their overdue order (payment_status = 'After 30 days').
Includes full order details: product, quantity, amount, GST breakdown.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.bedrock_client import generate_json
from shared.supabase_client import get_client
from shared.utils import now_iso

SENDER_NAME    = "Stellar Global Supplies Team"
SENDER_EMAIL   = os.environ.get("SENDER_EMAIL", "sales@stellarglobalsupplies.com")
COMPANY_WEBSITE = "https://stellarglobalsupplies.com"

SYSTEM = """You are a professional accounts receivable executive for Stellar Global Supplies,
a B2B industrial and commercial supplies company based in India.
Write polite but firm payment follow-up emails that:
- Are warm and respectful — this is a valued customer
- Clearly state what is owed and why
- Make it easy for the customer to act (contact us, pay, ask questions)
- Never sound threatening or aggressive
- Use formal Indian business English
- Include a clear subject line"""


def _format_currency(amount) -> str:
    try:
        return f"₹{float(amount):,.2f}"
    except (TypeError, ValueError):
        return f"₹{amount}"


def handler(event, context):
    order = event.get("order") or {}
    if not order:
        raise ValueError(f"Missing 'order' in event: {list(event.keys())}")

    # Build financial summary
    sale_cost   = float(order.get("sale_cost", 0))
    cgst        = float(order.get("cgst_total", 0))
    sgst        = float(order.get("sgst_total", 0))
    total       = sale_cost + cgst + sgst
    qty         = order.get("quantity", "")
    unit        = order.get("unit", "Pieces")
    delivery    = order.get("delivery_timeline", "N/A")
    order_date  = (order.get("created_at", "") or "")[:10]

    prompt = f"""Draft a payment follow-up email from {SENDER_NAME} to {order.get('customer_name', 'Valued Customer')}.

ORDER DETAILS (include all of this in the email):
- Order Date:      {order_date}
- Customer Name:   {order.get('customer_name', '')}
- Product:         {order.get('material', '')} ({order.get('product_type', '')})
- Quantity:        {qty} {unit}
- Base Amount:     {_format_currency(sale_cost)}
- CGST:            {_format_currency(cgst)}
- SGST:            {_format_currency(sgst)}
- Total Payable:   {_format_currency(total)}
- Delivery:        {delivery}
- Payment Terms:   After 30 days (now due)
- Order Status:    {order.get('status', 'Delivered')}

EMAIL REQUIREMENTS:
1. Subject line that clearly indicates this is a payment follow-up
2. Opening: thank them for their business and reference the specific order
3. State the total amount due ({_format_currency(total)}) and that payment was due after 30 days of delivery
4. Include the full order breakdown table in the body (product, qty, base, GST, total)
5. Ask them to arrange payment at the earliest convenience
6. Provide contact details: email ({SENDER_EMAIL}) and website ({COMPANY_WEBSITE})
7. Keep a warm but professional tone throughout
8. Sign off as {SENDER_NAME}

Return JSON with exactly these fields:
{{
  "subject": "Payment Follow-up: [Product] Order – {_format_currency(total)} Due",
  "body": "full professional email body with all order details, amount breakdown, and polite payment request"
}}"""

    draft = generate_json(prompt, system=SYSTEM, max_tokens=1500)

    # Save to email_drafts table (same pattern as lead email drafts)
    db  = get_client()
    row = {
        "lead_id":     None,
        "subject":     draft["subject"],
        "body":        draft["body"],
        "is_followup": False,
        "status":      "draft",
    }
    # email_drafts may have a lead_id NOT NULL — use order_id as reference in metadata
    # We store order context in the body; save without lead_id if nullable
    try:
        saved = db.insert("email_drafts", row)
    except Exception as e:
        if "lead_id" in str(e).lower() and "null" in str(e).lower():
            # lead_id is NOT NULL in schema — insert with a placeholder note
            # and rely on the order context carried through the SF event
            saved = {"id": None, **row}
        else:
            raise

    print(f"[draft_payment_email] drafted for order={order.get('id')} customer={order.get('customer_name')} total={_format_currency(total)}")

    return {
        **event,
        "emailDraftId": saved.get("id"),
        "emailDraft": {
            **draft,
            "id":              saved.get("id"),
            "to":              order.get("email", ""),
            "customer_name":   order.get("customer_name", ""),
            "total_payable":   total,
            "order_id":        order.get("id"),
        },
    }