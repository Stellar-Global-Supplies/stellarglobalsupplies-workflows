"""
Bedrock client — Nova Pro for text, FLUX.1-schnell via Gradio for images.

Text : Amazon Nova Pro (us-east-1)
Image: Nova Pro enhances the prompt, then FLUX.1-schnell generates via HF Gradio (free, no auth)
"""
import boto3
import json
import base64
import os
import threading
import urllib.request
from typing import Optional
from botocore.config import Config

# ─── Per-invocation cost accumulator ─────────────────────────────────────────
# Reset at start of each Lambda handler, read at the end to write to workflow_runs.
# Nova Pro pricing (us-east-1) per 1K tokens
_NOVA_INPUT_COST_PER_1K  = 0.0008
_NOVA_OUTPUT_COST_PER_1K = 0.0032

_run_tokens = {"input": 0, "output": 0, "images": 0}


def reset_cost_tracker():
    """Call at the start of each Lambda handler to zero counters."""
    _run_tokens.update({"input": 0, "output": 0, "images": 0})


def get_cost_summary() -> dict:
    """Return token counts + estimated USD cost for this Lambda invocation."""
    inp  = _run_tokens["input"]
    out  = _run_tokens["output"]
    imgs = _run_tokens["images"]
    # FLUX via Gradio is free; cost is purely Bedrock Nova Pro text calls
    cost = (inp / 1000 * _NOVA_INPUT_COST_PER_1K) + (out / 1000 * _NOVA_OUTPUT_COST_PER_1K)
    return {
        "input_tokens":  inp,
        "output_tokens": out,
        "image_count":   imgs,
        "cost_usd":      round(cost, 6),
    }

# ─── boto3 clients (lazy-initialised, module-level singletons) ────────────────
_bedrock_text  = None   # us-east-1 — Nova Pro text

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
    usage  = result.get("usage", {})
    _run_tokens["input"]  += usage.get("inputTokens",  0)
    _run_tokens["output"] += usage.get("outputTokens", 0)
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



# ─── IMAGE PROMPT ENHANCER — Nova Pro rewrites prompt for FLUX ───────────────
# ─── IMAGE PROMPT ENHANCER — Nova Pro polishes the prompt for FLUX ───────────
# Prompts now arrive already specific and well-structured from generate_post.py
# and generate_blog.py. The enhancer's job is a light polish pass only:
# tighten wording, ensure FLUX-friendly phrasing, stay under 100 words.
_ENHANCE_SYSTEM = """You are an expert FLUX image generation prompt writer.

You receive a well-specified image prompt and lightly polish it for FLUX.1:
- Keep all specific visual details, scene descriptions, and UI elements — do NOT generalise
- Tighten wording to stay under 100 words
- Ensure these technical qualifiers are present: "DSLR photo", "natural lighting", "photorealistic"
- Remove any AI-art language: no "cinematic", "render", "3D", "glowing", "dramatic"
- If the prompt describes a tech/screen scene: keep it as tech — do NOT change it to a product photo
- If the prompt describes a physical product: keep it as product — do NOT change it to a tech scene
- Output ONLY the polished prompt — no explanation, no preamble, no quotes
- No Text on Images or Logo unless explicitly requested in the original prompt"""

_ENHANCE_USER = """Prompt to polish: \"{prompt}\"

Polished FLUX prompt:"""


def _enhance_prompt(prompt: str) -> str:
    """Use Nova Pro to rewrite a short prompt into a rich FLUX-ready prompt."""
    try:
        enhanced = generate_text(
            _ENHANCE_USER.format(prompt=prompt),
            system=_ENHANCE_SYSTEM,
            max_tokens=300,
        ).strip()
        print(f"[bedrock] prompt enhanced: {enhanced[:120]}...")
        return enhanced
    except Exception as e:
        print(f"[bedrock] prompt enhancement failed ({e}) — using original prompt")
        return prompt


# ─── IMAGE 0 — FLUX.1-schnell via Hugging Face Gradio (free, no auth) ────────
_FLUX_BASE    = "https://black-forest-labs-flux-1-schnell.hf.space"
_FLUX_TIMEOUT = 120  # seconds — ZeroGPU spaces can queue


def _flux_gradio(prompt: str, width: int = 1024, height: int = 1024) -> bytes:
    """
    Calls FLUX.1-schnell on HuggingFace Spaces via the modern Gradio REST API
    (gradio_api/call/<fn> pattern — works on Gradio 4.x+ / ZeroGPU spaces).
    No API key required. Returns PNG bytes.

    Protocol:
      POST /gradio_api/call/infer  →  {"event_id": "..."}
      GET  /gradio_api/call/infer/<event_id>  →  SSE stream
           wait for  event: complete  then parse data line
    """
    # Clamp to FLUX supported range (multiples of 8)
    w = max(256, min(1024, (width  // 8) * 8))
    h = max(256, min(1024, (height // 8) * 8))

    # ── Step 1: submit job ────────────────────────────────────────────────────
    submit_url = f"{_FLUX_BASE}/gradio_api/call/infer"
    payload = json.dumps({
        "data": [
            prompt[:500],   # prompt
            0,              # seed
            True,           # randomize_seed
            w,              # width
            h,              # height
            4,              # num_inference_steps
        ]
    }).encode()

    req = urllib.request.Request(
        submit_url,
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "StellarWorkflows/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        submit_result = json.loads(resp.read())

    event_id = submit_result.get("event_id")
    if not event_id:
        raise RuntimeError(f"FLUX Gradio: no event_id in submit response: {submit_result}")

    print(f"[bedrock] FLUX.1-schnell queued — event_id={event_id}")

    # ── Step 2: stream SSE until 'complete' ───────────────────────────────────
    stream_url = f"{_FLUX_BASE}/gradio_api/call/infer/{event_id}"
    result_holder: list = []
    error_holder:  list = []

    def _stream():
        try:
            req2 = urllib.request.Request(
                stream_url,
                headers={"Accept": "text/event-stream", "User-Agent": "StellarWorkflows/1.0"},
            )
            with urllib.request.urlopen(req2, timeout=_FLUX_TIMEOUT) as resp:
                event_type = None
                for raw_line in resp:
                    line = raw_line.decode("utf-8").rstrip("\n").rstrip("\r")
                    if line.startswith("event:"):
                        event_type = line[6:].strip()
                    elif line.startswith("data:") and event_type == "complete":
                        result_holder.append(json.loads(line[5:].strip()))
                        return
                    elif line.startswith("data:") and event_type == "error":
                        error_holder.append(RuntimeError(f"FLUX Gradio stream error: {line[5:].strip()}"))
                        return
        except Exception as exc:
            error_holder.append(exc)

    t = threading.Thread(target=_stream, daemon=True)
    t.start()
    t.join(timeout=_FLUX_TIMEOUT + 10)

    if t.is_alive():
        raise TimeoutError(f"FLUX Gradio did not complete within {_FLUX_TIMEOUT}s")
    if error_holder:
        raise error_holder[0]
    if not result_holder:
        raise RuntimeError("FLUX Gradio: SSE stream ended without 'complete' event")

    # ── Step 3: extract image URL from result ─────────────────────────────────
    # result is a list matching output components: [image, seed]
    data_list = result_holder[0]
    if not data_list:
        raise ValueError(f"FLUX Gradio: empty result data")

    img_info = data_list[0]  # first output component is the image

    if isinstance(img_info, dict):
        img_url = img_info.get("url") or img_info.get("path")
        if not img_url:
            raise ValueError(f"FLUX Gradio: no url/path in image output: {img_info}")
        if img_url.startswith("/"):
            img_url = f"{_FLUX_BASE}{img_url}"
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


# ─── LOGO OVERLAY ────────────────────────────────────────────────────────────
# Path to the Stellar Global Supplies logo (PNG, placed at deployment root).
# Change this env var or constant to point to wherever the logo lives on disk.
_LOGO_PATH = os.environ.get(
    "STELLAR_LOGO_PATH",
    os.path.join(os.path.dirname(__file__), "logo.png"),
)

# Logo width as a fraction of the generated image width (15% feels clean)
_LOGO_WIDTH_RATIO = 0.15
# Padding from the top-right corner in pixels
_LOGO_PADDING = 18


def _overlay_logo(image_bytes: bytes) -> bytes:
    """
    Composite the Stellar Global Supplies logo onto the top-right corner
    of the generated image. Returns PNG bytes.
    Falls back to the original bytes if the logo file is missing or PIL fails.
    """
    try:
        from PIL import Image as PILImage
        import io

        if not os.path.exists(_LOGO_PATH):
            print(f"[bedrock] logo not found at {_LOGO_PATH} — skipping overlay")
            return image_bytes

        # Load generated image
        base = PILImage.open(io.BytesIO(image_bytes)).convert("RGBA")
        bw, bh = base.size

        # Load & resize logo proportionally
        logo = PILImage.open(_LOGO_PATH).convert("RGBA")
        target_w = max(80, int(bw * _LOGO_WIDTH_RATIO))
        ratio     = target_w / logo.width
        target_h  = int(logo.height * ratio)
        logo      = logo.resize((target_w, target_h), PILImage.LANCZOS)

        # Top-right position
        x = bw - target_w - _LOGO_PADDING
        y = _LOGO_PADDING

        # Paste using logo's alpha channel as mask
        base.paste(logo, (x, y), mask=logo)

        # Convert back to PNG bytes
        out = io.BytesIO()
        base.convert("RGB").save(out, format="PNG")
        print(f"[bedrock] logo overlaid at top-right ({target_w}×{target_h}px)")
        return out.getvalue()

    except Exception as e:
        print(f"[bedrock] logo overlay failed ({e}) — returning image without logo")
        return image_bytes



def generate_image(prompt: str, width: int = 1024, height: int = 1024) -> Optional[bytes]:
    """
    Returns image bytes (PNG).
    Enhances prompt with Nova Pro, then generates via FLUX.1-schnell on Gradio.
    """
    # ── 0. Enhance prompt with Nova Pro ───────────────────────────────────────
    enhanced_prompt = _enhance_prompt(prompt)

    # ── 1. FLUX.1-schnell via Gradio ─────────────────────────────────────────
    image_bytes = _flux_gradio(enhanced_prompt, width, height)

    # ── 2. Overlay company logo (top-right, full opacity) ─────────────────────
    result = _overlay_logo(image_bytes)
    _run_tokens["images"] += 1
    return result