"""
Bedrock client — Nova Pro for text, Stability AI via Bedrock for images.

Model Access page was retired — all Bedrock models are now auto-enabled.

Image fallback order:
  1. stability.sd3-5-large-v1:0    — best quality, ~$0.065/image  (us-west-2)
  2. stability.stable-image-core-v1:0 — good quality, ~$0.003/image (us-west-2)
  3. Branded SVG placeholder       — zero cost, always works

All Stability models live in us-west-2. Text (Nova Pro) stays in us-east-1.
"""
import boto3
import json
import base64
import os
from typing import Optional

_bedrock_text   = None   # us-east-1 — Nova Pro
_bedrock_image  = None   # us-west-2 — Stability AI


def _get_text_client():
    global _bedrock_text
    if _bedrock_text is None:
        _bedrock_text = boto3.client(
            "bedrock-runtime",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )
    return _bedrock_text


def _get_image_client():
    global _bedrock_image
    if _bedrock_image is None:
        # Stability models are hosted in us-west-2 regardless of primary region
        _bedrock_image = boto3.client(
            "bedrock-runtime",
            region_name="us-west-2",
        )
    return _bedrock_image


# ─── TEXT — Amazon Nova Pro (us-east-1) ──────────────────────────────────────
def generate_text(prompt: str, system: str = "", max_tokens: int = 2000) -> str:
    client   = _get_text_client()
    model_id = os.environ.get("BEDROCK_TEXT_MODEL", "amazon.nova-pro-v1:0")
    body = {
        "messages": [{"role": "user", "content": [{"text": prompt}]}],
        "inferenceConfig": {"maxTokens": max_tokens, "temperature": 0.7, "topP": 0.9},
    }
    if system:
        body["system"] = [{"text": system}]
    resp   = client.invoke_model(modelId=model_id, body=json.dumps(body),
                                 contentType="application/json", accept="application/json")
    result = json.loads(resp["body"].read())
    return result["output"]["message"]["content"][0]["text"]


def generate_json(prompt: str, system: str = "", max_tokens: int = 2000) -> dict:
    sys_p = (system or "") + "\n\nRespond ONLY with valid JSON. No markdown fences, no commentary."
    last_exc = None
    for attempt in range(2):
        text = generate_text(prompt, system=sys_p, max_tokens=max_tokens).strip()
        if text.startswith("```"):
            parts = text.split("```")
            text  = parts[1][4:] if parts[1].startswith("json") else parts[1]
        text = text.strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            last_exc = exc
            print(f"[bedrock] generate_json attempt {attempt+1} returned invalid JSON: {text[:200]}")
    raise ValueError(f"Nova returned invalid JSON after 2 attempts: {last_exc}") from last_exc


# ─── IMAGE — Stability AI via Bedrock (us-west-2) ────────────────────────────
# Model Access page retired — models auto-enabled, no manual approval needed.
# All three models share the same request/response format.
#
# Pricing (on-demand):
#   sd3-5-large      $0.065/image  — best quality, 8B params, photorealistic
#   stable-image-core $0.003/image  — fast, great for social posts

_STABILITY_MODELS = [
    "stability.sd3-5-large-v1:0",        # best quality
    "stability.stable-image-core-v1:0",  # cheapest fallback
]


def _invoke_stability(model_id: str, prompt: str) -> bytes:
    client = _get_image_client()
    body   = json.dumps({
        "prompt":        prompt[:10000],
        "mode":          "text-to-image",
        "aspect_ratio":  "1:1",
        "output_format": "png",
    })
    print(f"[bedrock] invoking {model_id}")
    resp = client.invoke_model(
        modelId=model_id,
        body=body,
        contentType="application/json",
        accept="application/json",
    )
    result = json.loads(resp["body"].read())
    # Both models return {"images": ["<base64>"], ...}
    img_bytes = base64.b64decode(result["images"][0])
    if len(img_bytes) < 1000:
        raise ValueError(f"Image too small: {len(img_bytes)} bytes")
    return img_bytes


# ─── IMAGE fallback: Branded SVG placeholder ─────────────────────────────────
def _branded_svg_placeholder(prompt: str, width: int = 1024, height: int = 1024) -> bytes:
    label = (prompt[:58] + "…") if len(prompt) > 60 else prompt
    for ch, esc in [("&","&amp;"),("<","&lt;"),(">","&gt;"),("\"","&quot;")]:
        label = label.replace(ch, esc)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#0A2547"/>
      <stop offset="100%" stop-color="#1565C0"/>
    </linearGradient>
  </defs>
  <rect width="{width}" height="{height}" fill="url(#bg)"/>
  <rect x="40" y="40" width="{width-80}" height="{height-80}" rx="16"
        fill="none" stroke="#F59E0B" stroke-width="2" opacity="0.4"/>
  <circle cx="{width//2}" cy="{height//2 - 80}" r="54" fill="#F59E0B" opacity="0.15"/>
  <text x="{width//2}" y="{height//2 - 58}"
        font-family="Arial,sans-serif" font-size="64" font-weight="bold"
        fill="#F59E0B" text-anchor="middle">S</text>
  <text x="{width//2}" y="{height//2 + 10}"
        font-family="Arial,sans-serif" font-size="22" font-weight="600"
        fill="#FFFFFF" text-anchor="middle">Stellar Global Supplies</text>
  <text x="{width//2}" y="{height//2 + 46}"
        font-family="Arial,sans-serif" font-size="13"
        fill="#94A3B8" text-anchor="middle">{label}</text>
  <rect x="{width//2 - 52}" y="{height//2 + 72}" width="104" height="26" rx="13"
        fill="#F59E0B" opacity="0.18"/>
  <text x="{width//2}" y="{height//2 + 90}"
        font-family="Arial,sans-serif" font-size="11" font-weight="500"
        fill="#F59E0B" text-anchor="middle">AI · Placeholder</text>
</svg>"""
    return svg.encode("utf-8")


def generate_image(prompt: str, width: int = 1024, height: int = 1024) -> Optional[bytes]:
    """
    Returns image bytes (PNG or SVG).
    Tries Stability AI models via Bedrock (us-west-2) best → cheapest,
    falls back to branded SVG if all fail.
    No API keys needed — billed through AWS.
    """
    for model_id in _STABILITY_MODELS:
        try:
            data = _invoke_stability(model_id, prompt)
            print(f"[bedrock] {model_id} OK ({len(data):,} bytes)")
            return data
        except Exception as e:
            print(f"[bedrock] {model_id} failed ({str(e)[:200]}) — trying next")

    print("[bedrock] all Stability models failed — using branded SVG placeholder")
    return _branded_svg_placeholder(prompt, width, height)