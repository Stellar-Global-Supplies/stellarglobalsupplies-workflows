"""
Bedrock client — Nova Pro for text, Nova Canvas + Stability AI for images.

Image fallback order:
  1. FLUX.1-schnell via Gradio     — free, no auth, no AWS, fast (~10-20s)
  2. amazon.nova-canvas-v1:0       — AWS-native, no Marketplace needed (legacy, needs prior use)
  3. us.amazon.nova-canvas-v1:0    — cross-region inference profile variant
  4. stability.sd3-5-large-v1:0    — best quality, ~$0.065/image (needs Marketplace)
  5. stability.stable-image-core-v1:0 — cheaper,  ~$0.003/image (needs Marketplace)
  6. Branded SVG placeholder        — zero cost, always works

Nova Canvas uses the same us-east-1 client as Nova Pro text — no extra client needed.
Stability models use a separate us-west-2 client.
"""
import boto3
import json
import base64
import os
import random
import threading
import urllib.request
from typing import Optional
from botocore.config import Config

# ─── boto3 clients (lazy-initialised, module-level singletons) ────────────────
_bedrock_text  = None   # us-east-1 — Nova Pro text + Nova Canvas image
_bedrock_image = None   # us-west-2 — Stability AI only

_BOTO_CFG = Config(
    connect_timeout=10,
    read_timeout=120,
    retries={"max_attempts": 0},   # Step Functions handles retries
)


def _get_text_client():
    global _bedrock_text
    if _bedrock_text is None:
        _bedrock_text = boto3.client(
            "bedrock-runtime",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
            config=_BOTO_CFG,
        )
    return _bedrock_text


def _get_image_client():
    """us-west-2 client used only for Stability AI models."""
    global _bedrock_image
    if _bedrock_image is None:
        _bedrock_image = boto3.client(
            "bedrock-runtime",
            region_name="us-west-2",
            config=_BOTO_CFG,
        )
    return _bedrock_image


# ─── TEXT — Amazon Nova Pro ───────────────────────────────────────────────────
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


# ─── IMAGE 1 — Amazon Nova Canvas (us-east-1, no Marketplace needed) ─────────
def _invoke_nova_canvas(prompt: str, width: int = 1024, height: int = 1024, model_id: str = "amazon.nova-canvas-v1:0") -> bytes:
    """
    Nova Canvas request schema:
      taskType / textToImageParams / imageGenerationConfig
    Response: {"images": ["<base64>"], "error": null}
    """
    # Nova Canvas supports these exact sizes — clamp to nearest 64-multiple
    w = max(320, min(4096, (width  // 64) * 64))
    h = max(320, min(4096, (height // 64) * 64))

    body = {
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {
            "text": prompt[:1024],          # hard cap per AWS docs
        },
        "imageGenerationConfig": {
            "numberOfImages": 1,
            "quality":        "standard",   # "standard" | "premium"
            "width":          w,
            "height":         h,
            "seed":           random.randint(0, 858_993_459),
        },
    }
    print(f"[bedrock] invoking {model_id} ({w}×{h})")
    client = _get_text_client()                       # us-east-1, same as Nova Pro
    resp   = client.invoke_model(
        modelId      = model_id,
        body         = json.dumps(body),
        contentType  = "application/json",
        accept       = "application/json",
    )
    result = json.loads(resp["body"].read())

    if result.get("error"):
        raise RuntimeError(f"Nova Canvas error: {result['error']}")

    img_bytes = base64.b64decode(result["images"][0])
    if len(img_bytes) < 1000:
        raise ValueError(f"Nova Canvas returned suspiciously small image: {len(img_bytes)} bytes")
    return img_bytes


# ─── IMAGE 2 — Stability AI via Bedrock (us-west-2, needs Marketplace) ───────
_STABILITY_MODELS = [
    "stability.sd3-5-large-v1:0",           # best quality
    "stability.stable-image-core-v1:0",     # cheaper fallback
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
        modelId     = model_id,
        body        = body,
        contentType = "application/json",
        accept      = "application/json",
    )
    result    = json.loads(resp["body"].read())
    img_bytes = base64.b64decode(result["images"][0])
    if len(img_bytes) < 1000:
        raise ValueError(f"Image too small: {len(img_bytes)} bytes")
    return img_bytes


# ─── IMAGE fallback — Branded SVG placeholder (always works) ─────────────────
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


# ─── IMAGE 0 — FLUX.1-schnell via Hugging Face Gradio (free, no auth) ────────
_FLUX_SPACE = "black-forest-labs/FLUX.1-schnell"
_FLUX_TIMEOUT = 60  # seconds — Gradio spaces can be slow on cold start


def _flux_gradio(prompt: str, width: int = 1024, height: int = 1024) -> bytes:
    """
    Calls FLUX.1-schnell on HuggingFace Spaces via Gradio REST API.
    No API key required. Returns PNG bytes.
    """
    # Clamp to FLUX supported range (multiples of 8)
    w = max(256, min(1024, (width  // 8) * 8))
    h = max(256, min(1024, (height // 8) * 8))

    # Step 1: join the queue
    queue_url = f"https://black-forest-labs-flux-1-schnell.hf.space/queue/join"
    payload = json.dumps({
        "data": [
            prompt[:500],   # prompt
            0,              # seed
            True,           # randomize_seed
            w,              # width
            h,              # height
            4,              # num_inference_steps (4 is optimal for schnell)
        ],
        "event_data": None,
        "fn_index": 0,
        "trigger_id": 6,
        "session_hash": base64.urlsafe_b64encode(os.urandom(8)).decode().rstrip("="),
    }).encode()

    req = urllib.request.Request(
        queue_url,
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "StellarWorkflows/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        join_result = json.loads(resp.read())

    event_id = join_result.get("event_id")
    if not event_id:
        raise RuntimeError(f"FLUX Gradio: no event_id in join response: {join_result}")

    # Step 2: poll the SSE stream for the result
    stream_url = f"https://black-forest-labs-flux-1-schnell.hf.space/queue/data?session_hash={join_result.get('session_hash', '')}"
    result_holder: list = []
    error_holder:  list = []

    def _stream():
        try:
            req2 = urllib.request.Request(
                stream_url,
                headers={"Accept": "text/event-stream", "User-Agent": "StellarWorkflows/1.0"},
            )
            with urllib.request.urlopen(req2, timeout=_FLUX_TIMEOUT) as resp:
                for raw_line in resp:
                    line = raw_line.decode("utf-8").strip()
                    if not line.startswith("data:"):
                        continue
                    data = json.loads(line[5:].strip())
                    if data.get("msg") == "process_completed":
                        result_holder.append(data)
                        return
                    if data.get("msg") == "queue_full":
                        error_holder.append(RuntimeError("FLUX Gradio: queue full"))
                        return
        except Exception as exc:
            error_holder.append(exc)

    t = threading.Thread(target=_stream, daemon=True)
    t.start()
    t.join(timeout=_FLUX_TIMEOUT + 5)

    if t.is_alive():
        raise TimeoutError(f"FLUX Gradio did not respond within {_FLUX_TIMEOUT}s")
    if error_holder:
        raise error_holder[0]
    if not result_holder:
        raise RuntimeError("FLUX Gradio: stream ended without process_completed")

    # Step 3: extract image — output is a file URL or base64
    output = result_holder[0].get("output", {})
    data_list = output.get("data", [])
    if not data_list:
        raise ValueError(f"FLUX Gradio: empty output data: {output}")

    img_info = data_list[0]  # first output is the image

    # Could be {"url": "..."} or {"path": "..."} or a raw base64 string
    if isinstance(img_info, dict):
        img_url = img_info.get("url") or img_info.get("path")
        if not img_url:
            raise ValueError(f"FLUX Gradio: no url/path in image output: {img_info}")
        # Make absolute if relative
        if img_url.startswith("/"):
            img_url = f"https://black-forest-labs-flux-1-schnell.hf.space{img_url}"
        fetch_req = urllib.request.Request(img_url, headers={"User-Agent": "StellarWorkflows/1.0"})
        with urllib.request.urlopen(fetch_req, timeout=30) as img_resp:
            img_bytes = img_resp.read()
    elif isinstance(img_info, str) and img_info.startswith("data:image"):
        img_bytes = base64.b64decode(img_info.split(",", 1)[1])
    else:
        raise ValueError(f"FLUX Gradio: unexpected image format: {type(img_info)}")

    if len(img_bytes) < 1000:
        raise ValueError(f"FLUX Gradio returned too-small image: {len(img_bytes)} bytes")

    print(f"[bedrock] FLUX.1-schnell Gradio OK ({len(img_bytes):,} bytes)")
    return img_bytes


# ─── PUBLIC API ───────────────────────────────────────────────────────────────
def generate_image(prompt: str, width: int = 1024, height: int = 1024) -> Optional[bytes]:
    """
    Returns image bytes (PNG or SVG).

    Fallback order:
      1. FLUX.1-schnell — free, no auth, fast via Gradio
      2. Nova Canvas    — AWS-native, no Marketplace needed
      3. Stability SD3  — best quality, needs Marketplace subscription
      4. Stability Core — cheaper, needs Marketplace subscription
      5. SVG placeholder — always works, zero cost
    """
    # ── 1. FLUX.1-schnell via Gradio (free, no auth) ─────────────────────────
    try:
        data = _flux_gradio(prompt, width, height)
        return data
    except Exception as e:
        print(f"[bedrock] FLUX.1-schnell Gradio failed ({str(e)[:180]}) — trying Nova Canvas")

    # ── 2. Nova Canvas (direct, then cross-region profile) ────────────────────
    for canvas_id in ("amazon.nova-canvas-v1:0", "us.amazon.nova-canvas-v1:0"):
        try:
            data = _invoke_nova_canvas(prompt, width, height, model_id=canvas_id)
            print(f"[bedrock] {canvas_id} OK ({len(data):,} bytes)")
            return data
        except Exception as e:
            print(f"[bedrock] {canvas_id} failed ({str(e)[:180]}) — trying next")

    # ── 2 & 3. Stability AI ───────────────────────────────────
    for model_id in _STABILITY_MODELS:
        try:
            data = _invoke_stability(model_id, prompt)
            print(f"[bedrock] {model_id} OK ({len(data):,} bytes)")
            return data
        except Exception as e:
            print(f"[bedrock] {model_id} failed ({str(e)[:200]}) — trying next")

    # ── 4. SVG placeholder ────────────────────────────────────
    print("[bedrock] all image models failed — using branded SVG placeholder")
    return _branded_svg_placeholder(prompt, width, height)