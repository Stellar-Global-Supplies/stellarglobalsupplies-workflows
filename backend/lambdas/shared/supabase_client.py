import os
import json
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional

# Hard timeout for every Supabase HTTP call.
# Without this, urlopen blocks indefinitely when Supabase is slow/unreachable,
# causing Lambda to hang until the function-level timeout kills the execution.
_HTTP_TIMEOUT = 30  # seconds


class SupabaseClient:
    """Lightweight Supabase REST client for Lambda (no external deps beyond stdlib)."""

    def __init__(self, url: str, key: str):
        self.url = url.rstrip("/")
        self.key = key
        self.headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }

    def _request(self, method: str, path: str, body: Any = None, params: str = "") -> Any:
        full_url = f"{self.url}/rest/v1/{path}"
        if params:
            full_url += f"?{params}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(full_url, data=data, headers=self.headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            err = e.read().decode()
            raise RuntimeError(f"Supabase {method} {path} failed {e.code}: {err}")

    def select(self, table: str, params: str = "") -> List[Dict]:
        headers_backup = self.headers.copy()
        self.headers["Accept"] = "application/json"
        result = self._request("GET", table, params=params)
        self.headers = headers_backup
        return result

    def insert(self, table: str, row: Dict) -> Dict:
        result = self._request("POST", table, body=row)
        return result[0] if isinstance(result, list) and result else result

    def upsert(self, table: str, row: Dict, on_conflict: str = "") -> Dict:
        path = table
        params = f"on_conflict={on_conflict}" if on_conflict else ""
        original = self.headers.get("Prefer", "")
        self.headers["Prefer"] = "return=representation,resolution=merge-duplicates"
        result = self._request("POST", path, body=row, params=params)
        self.headers["Prefer"] = original
        return result[0] if isinstance(result, list) and result else result

    def update(self, table: str, row: Dict, params: str = "") -> List[Dict]:
        return self._request("PATCH", table, body=row, params=params)

    def delete(self, table: str, params: str = "") -> List[Dict]:
        return self._request("DELETE", table, params=params)


_client: Optional[SupabaseClient] = None


def get_client() -> SupabaseClient:
    global _client
    if _client is None:
        _client = SupabaseClient(
            url=os.environ["SUPABASE_URL"],
            key=os.environ["SUPABASE_SERVICE_KEY"],
        )
    return _client