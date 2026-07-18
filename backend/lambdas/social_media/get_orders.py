"""
Lambda: get_orders
Fetches recent order data from the orders table in Supabase for social post creation.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.supabase_client import get_client


def handler(event, context):
    """
    Input: { "order_id": "<uuid>" } OR { "limit": 5, "product_type": "industrial" }
    """
    db       = get_client()
    order_id = event.get("order_id")

    if order_id:
        order_id_str = str(order_id).strip()
        rows = []

        # Full UUIDs can be queried directly.
        if len(order_id_str) >= 32:
            rows = db.select("orders", params=f"id=eq.{order_id_str}&limit=1")

        if not rows:
            # Support short display IDs / UUID prefixes from the UI by scanning recent rows locally.
            recent = db.select("orders", params="select=*&order=created_at.desc&limit=100")
            rows = [r for r in recent if str(r.get("id", "")).startswith(order_id_str)]
    else:
        limit        = event.get("limit", 1)
        product_type = event.get("product_type", "")
        params = f"select=*&order=created_at.desc&limit={limit}"
        if product_type:
            import urllib.parse
            params += f"&product_category=ilike.{urllib.parse.quote(f'%{product_type}%')}"
        rows = db.select("orders", params=params)

    if not rows:
        # Return mock data for demo if no orders table or no orders yet
        rows = [{
            "id":               event.get("order_id", "DEMO-001"),
            "order_display_id": str(event.get("order_id", "DEMO-001"))[:8],
            "product_name":     event.get("product_name", "Industrial Cleaning Supplies Bundle"),
            "product_category": event.get("product_type", "Industrial"),
            "quantity":         500,
            "description":      "Premium bulk industrial cleaning products",
            "customer_segment": "Manufacturing",
        }]

    order = rows[0]
    order_id_value = str(order.get("id") or order.get("order_display_id") or "")
    return {
        **event,
        "order": order,
        "orderId": order_id_value,
        "orderUuid": order_id_value,
        "orderDisplayId": order_id_value[:8],
    }
