"""
Lambda: get_orders
Fetches recent order data from the orders table in Supabase for social post creation.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.supabase_client import get_client

ID_FIELDS = ("id", "tracking_token")
PRODUCT_FIELDS = ("material", "product_type")
CATEGORY_FIELDS = ("product_type",)


def _looks_like_uuid(value: str) -> bool:
    parts = value.split("-")
    return len(value) == 36 and len(parts) == 5


def _field(row: dict, fields: tuple[str, ...], default: str = "") -> str:
    return str(next((row.get(field) for field in fields if row.get(field)), default))


def _matches_lookup(row: dict, lookup: str) -> bool:
    needle = lookup.lower()
    for field in ID_FIELDS:
        value = str(row.get(field, "")).lower()
        if value == needle or value.startswith(needle):
            return True
    return False


def handler(event, context):
    """
    Input: { "order_id": "<lookup>" } OR { "limit": 5, "product_type": "industrial" }
    """
    db       = get_client()
    order_id = event.get("order_id") or event.get("orderLookup")

    if order_id:
        order_id_str = str(order_id).strip()
        rows = []

        # Full UUIDs can be queried directly against the production orders id.
        if _looks_like_uuid(order_id_str):
            rows = db.select("orders", params=f"id=eq.{order_id_str}&limit=1")

        if not rows:
            # Support short display IDs / UUID prefixes from the UI by scanning recent rows locally,
            # so we do not need schema changes in the production order-management table.
            recent = db.select("orders", params="select=*&order=created_at.desc&limit=100")
            rows = [r for r in recent if _matches_lookup(r, order_id_str)]
    else:
        limit        = event.get("limit", 1)
        product_type = event.get("product_type", "")
        params = f"select=*&order=created_at.desc&limit={limit}"
        if product_type:
            import urllib.parse
            params += f"&product_type=ilike.{urllib.parse.quote(f'%{product_type}%')}"
        try:
            rows = db.select("orders", params=params)
        except Exception as exc:
            if "product_category" not in str(exc):
                raise
            rows = db.select("orders", params=f"select=*&order=created_at.desc&limit={max(limit, 25)}")
            if product_type:
                needle = product_type.lower()
                rows = [r for r in rows if any(needle in str(r.get(field, "")).lower() for field in CATEGORY_FIELDS)]
            rows = rows[:limit]

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
    order_uuid = str(order.get("id") or "") if _looks_like_uuid(str(order.get("id") or "")) else ""
    order_display_id = _field(order, ID_FIELDS)
    order_key = order_uuid or order_display_id
    normalized_order = {
        **order,
        "product_name": _field(order, PRODUCT_FIELDS, event.get("product_name", "")),
        "product_category": _field(order, CATEGORY_FIELDS, event.get("product_type", "")),
        "customer_segment": str(order.get("customer_name") or ""),
        "description": (
            f"{order.get('quantity')} {order.get('unit')} of {order.get('material')} "
            f"({order.get('product_type')}) for {order.get('customer_name')}. "
            f"Order status: {order.get('status')}; payment: {order.get('payment_status')}; "
            f"sale cost: {order.get('sale_cost')}."
        ),
    }
    return {
        **event,
        "order": normalized_order,
        "orderId": order_key,
        "orderKey": order_key,
        "orderUuid": order_uuid,
        "orderDisplayId": order_display_id[:8],
    }
