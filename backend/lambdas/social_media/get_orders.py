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
    Input: { "order_id": "ORD-123" } OR { "limit": 5, "product_type": "industrial" }
    """
    db       = get_client()
    order_id = event.get("order_id")

    if order_id:
        rows = db.select("orders", params=f"id=eq.{order_id}&limit=1")
        if not rows:
            # Try by order number field
            rows = db.select("orders", params=f"order_number=eq.{order_id}&limit=1")
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
            "order_number":     event.get("order_id", "DEMO-001"),
            "product_name":     event.get("product_name", "Industrial Cleaning Supplies Bundle"),
            "product_category": event.get("product_type", "Industrial"),
            "quantity":         500,
            "description":      "Premium bulk industrial cleaning products",
            "customer_segment": "Manufacturing",
        }]

    order = rows[0]
    return {
        **event,
        "order": order,
        "orderId": str(order.get("id") or order.get("order_number", "")),
    }
