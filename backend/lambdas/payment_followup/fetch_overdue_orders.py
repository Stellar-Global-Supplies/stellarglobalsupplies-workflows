"""
Lambda: fetch_overdue_orders
Reads all orders from Supabase where payment_status = 'After 30 days'.
Can be invoked with a specific order_id to target one order,
or without to batch-process all overdue orders (used by EventBridge schedule).

Returns a list of orders so Step Functions can Map over them,
or a single order when order_id is provided.
"""
import sys, os
sys.path.insert(0, "/opt/python")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from shared.supabase_client import get_client
from shared.utils import ok, err, now_iso


def handler(event, context):
    db       = get_client()
    order_id = event.get("orderId") or event.get("order_id")

    if order_id:
        # Single order — triggered from the UI
        rows = db.select(
            "orders",
            params=f"id=eq.{order_id}&limit=1"
        )
        if not rows:
            raise ValueError(f"Order {order_id} not found")
        order = rows[0]
        if order.get("payment_status") != "After 30 days":
            raise ValueError(
                f"Order {order_id} has payment_status='{order.get('payment_status')}', "
                f"expected 'After 30 days'"
            )
        print(f"[fetch_overdue_orders] single order: {order_id} customer={order.get('customer_name')}")
        return {
            **event,
            "order":     order,
            "orderId":   order["id"],
            "isBatch":   False,
        }

    # Batch — all overdue orders (for EventBridge / manual batch trigger)
    rows = db.select(
        "orders",
        params="payment_status=eq.After 30 days&order=created_at.asc&limit=50"
    )
    print(f"[fetch_overdue_orders] batch: found {len(rows)} overdue orders")
    return {
        **event,
        "orders":  rows,
        "count":   len(rows),
        "isBatch": True,
    }