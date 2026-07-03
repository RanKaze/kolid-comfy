# SPDX-License-Identifier: GPL-3.0-or-later
"""
Snapshot Region Node — browser-based visual bbox editor for region/caption building.

Follows the kolid-comfy snapshot node architecture (local HTTP server + threading.Event +
browser interaction). The region editing concept is inspired by KJNodes'
Ideogram4PromptBuilderKJ: draw regions on an image, set each region's type/desc/text/
color palette, and assemble a structured caption JSON.
"""

import os
import io
import re
import json
import time
import base64
import socket
import socketserver
import threading
import webbrowser
import http.server
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageEnhance
import torch
import comfy.model_management as mm
from server import PromptServer

# ─── win32gui for window focus management ───
try:
    import win32gui
    import win32con
    has_win32gui = True
except ImportError:
    has_win32gui = False


# ═══════════════════════════════════════════════════════════════════════════
#  Interrupt-safe wait helper (mirrors image_node.py pattern)
# ═══════════════════════════════════════════════════════════════════════════

def waitSnapShot(event, check_interval=0.05):
    while not event.is_set():
        if mm.processing_interrupted():
            return False
        event.wait(check_interval)
    return True


# ═══════════════════════════════════════════════════════════════════════════
#  Image → base64 (mirrors image_node.py pattern)
# ═══════════════════════════════════════════════════════════════════════════

def image_to_base64(image_tensor):
    """Convert IMAGE tensor [B,H,W,C] float32 0-1 → base64 JPEG data URL."""
    import cv2
    img_array = (image_tensor.squeeze(0).cpu().numpy() * 255).astype(np.uint8)
    img_bgr = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
    _, buffer = cv2.imencode('.jpg', img_bgr)
    b64_str = base64.b64encode(buffer).decode('utf-8')
    return f"data:image/jpeg;base64,{b64_str}"


# ═══════════════════════════════════════════════════════════════════════════
#  Caption helpers (adapted from KJNodes ideogram4_nodes.py)
# ═══════════════════════════════════════════════════════════════════════════

_FONT_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "fonts", "FreeMono.ttf")


def _hex_rgb(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)) if len(h) == 6 else (255, 255, 255)


def _readable(rgb):
    r, g, b = rgb
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    if lum < 130:
        t = (130 - lum) / (255 - lum)
        r, g, b = round(r + (255 - r) * t), round(g + (255 - g) * t), round(b + (255 - b) * t)
    return (r, g, b)


def _font(size):
    try:
        return ImageFont.truetype(_FONT_PATH, size)
    except Exception:
        try:
            return ImageFont.load_default(size)
        except Exception:
            return ImageFont.load_default()


def _wrap(draw, text, font, max_w):
    lines = []
    for para in text.split("\n"):
        line = ""
        for word in para.split():
            test = word if not line else line + " " + word
            if line and draw.textlength(test, font=font) > max_w:
                lines.append(line)
                line = word
            else:
                line = test
        lines.append(line)
    return lines


def _render_preview(boxes, width, height, bg=None, brightness=50):
    """Render regions + prompts over the reference image (or a blank canvas)."""
    if bg is not None:
        iw, ih = bg.size
        long_edge = max(iw, ih)
        scale = min(1.0, 1024 / long_edge) if long_edge > 0 else 1.0
        rw, rh = max(1, round(iw * scale)), max(1, round(ih * scale))
        base = bg.convert("RGB").resize((rw, rh), Image.LANCZOS)
        if brightness < 100:
            base = ImageEnhance.Brightness(base).enhance(max(0.0, brightness / 100.0))
        img = base.convert("RGBA")
    else:
        long_edge = max(width, height)
        scale = min(1.0, 1024 / long_edge) if long_edge > 0 else 1.0
        rw = max(1, round(width * scale))
        rh = max(1, round(height * scale))
        img = Image.new("RGBA", (rw, rh), (0, 0, 0, 255))

    overlay = Image.new("RGBA", (rw, rh), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fs = max(10, round(rh / 64))
    font = _font(fs)
    tag_font = _font(max(9, fs - 2))
    lh = fs + 2

    for i, box in enumerate(boxes):
        if not isinstance(box, dict) or box.get("nobbox"):
            continue
        palette = [c for c in (box.get("palette") or []) if c]
        r, g, b = _hex_rgb(palette[0]) if palette else (140, 140, 140)
        x1 = max(0, min(rw, round(box.get("x", 0) * rw)))
        y1 = max(0, min(rh, round(box.get("y", 0) * rh)))
        x2 = max(0, min(rw, round((box.get("x", 0) + box.get("w", 0)) * rw)))
        y2 = max(0, min(rh, round((box.get("y", 0) + box.get("h", 0)) * rh)))
        if x2 < x1:
            x1, x2 = x2, x1
        if y2 < y1:
            y1, y2 = y2, y1

        draw.rectangle([x1, y1, x2, y2], outline=(r, g, b, 255), width=2)

        pal5 = palette[:5]
        if pal5 and (x2 - x1) > 2:
            sh = max(5, fs // 2)
            seg = (x2 - x1) / len(pal5)
            for p, hexc in enumerate(pal5):
                sx = x1 + round(p * seg)
                draw.rectangle([sx, y1, x1 + round((p + 1) * seg), y1 + sh], fill=_hex_rgb(hexc))

        etype = "text" if box.get("type") == "text" else "obj"
        tag = str(i + 1).zfill(2)
        tw = draw.textlength(tag, font=tag_font)
        draw.rectangle([x1, y1, x1 + tw + 6, y1 + fs + 2], fill=(r, g, b, 255))
        tagfill = (0, 0, 0, 255) if (0.299 * r + 0.587 * g + 0.114 * b) > 140 else (255, 255, 255, 255)
        draw.text((x1 + 3, y1 + 1), tag, fill=tagfill, font=tag_font)

        body = box.get("desc", "") or ""
        if etype == "text" and box.get("text"):
            body = '"%s"%s' % (box["text"], " — " + body if body else "")
        if body and (x2 - x1) > 8:
            ty = y1 + fs + 5
            for line in _wrap(draw, body, font, x2 - x1 - 8):
                if ty > y2:
                    break
                draw.text((x1 + 4, ty), line, fill=_readable((r, g, b)) + (255,), font=font)
                ty += lh

    img = Image.alpha_composite(img, overlay).convert("RGB")
    arr = np.asarray(img, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _norm_bbox(box, sx=1000, sy=1000, order="yx"):
    """{x, y, w, h} fractions (0-1) → bbox; scaled by sx/sy."""
    def cx(v):
        return max(0, min(sx, round(v * sx)))
    def cy(v):
        return max(0, min(sy, round(v * sy)))
    x, y, w, h = box.get("x", 0.0), box.get("y", 0.0), box.get("w", 0.0), box.get("h", 0.0)
    ymin, xmin, ymax, xmax = cy(y), cx(x), cy(y + h), cx(x + w)
    if ymin > ymax:
        ymin, ymax = ymax, ymin
    if xmin > xmax:
        xmin, xmax = xmax, xmin
    return [xmin, ymin, xmax, ymax] if order == "xy" else [ymin, xmin, ymax, xmax]


def _palette(colors):
    if isinstance(colors, dict):
        colors = colors.values()
    return [c.upper() for c in colors if c]


def _dumps(v, lvl=0):
    """Custom JSON serializer: scalar arrays on one line, objects pretty-printed."""
    pad, end = "    " * (lvl + 1), "    " * lvl
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        if not v:
            return "[]"
        if all(not isinstance(x, (dict, list)) for x in v):
            return "[" + ", ".join(_dumps(x, lvl) for x in v) + "]"
        return "[\n" + ",\n".join(pad + _dumps(x, lvl + 1) for x in v) + "\n" + end + "]"
    if isinstance(v, dict):
        if not v:
            return "{}"
        items = [pad + json.dumps(k, ensure_ascii=False) + ": " + _dumps(val, lvl + 1) for k, val in v.items()]
        return "{\n" + ",\n".join(items) + "\n" + end + "}"
    return json.dumps(v, ensure_ascii=False)


def _parse_json_list(s):
    if s:
        try:
            v = json.loads(s)
            if isinstance(v, list):
                return v
        except json.JSONDecodeError:
            pass
    return []


def _repair_json(s):
    i, j = s.find("{"), s.rfind("}")
    t = s[i:j + 1] if (i != -1 and j > i) else s
    return re.sub(r'("(?:[^"\\]|\\.)*")|,(\s*[}\]])', lambda m: m.group(1) or m.group(2), t)


def _loads_caption(s):
    for cand in ((s, _repair_json(s)) if s and s.strip() else ()):
        try:
            v = json.loads(cand)
            if isinstance(v, dict):
                return v
        except (json.JSONDecodeError, TypeError):
            continue
    return None


def _caption_to_boxes(cap):
    cd = cap.get("compositional_deconstruction") or {}
    boxes = []
    for el in (cd.get("elements") or []):
        if not isinstance(el, dict):
            continue
        box = {
            "type": "text" if el.get("type") == "text" else "obj",
            "text": el.get("text", "") or "",
            "desc": el.get("desc", "") or "",
            "palette": list(el.get("color_palette") or []),
        }
        bb = el.get("bbox")
        if isinstance(bb, (list, tuple)) and len(bb) == 4:
            ymin, xmin, ymax, xmax = bb
            box.update(x=xmin / 1000.0, y=ymin / 1000.0,
                       w=(xmax - xmin) / 1000.0, h=(ymax - ymin) / 1000.0)
        else:
            box.update(x=0.03, y=0.03, w=0.22, h=0.14, nobbox=True)
        boxes.append(box)
    return boxes


# ═══════════════════════════════════════════════════════════════════════════
#  SnapshotRegionServer
# ═══════════════════════════════════════════════════════════════════════════

class SnapshotRegionServer:
    """Temporary HTTP server to serve the region editor page and handle results."""

    def __init__(self, image, width, height, config, prompt_server=None):
        self.image = image
        self.width = width
        self.height = height
        self.config = config
        self.prompt_server = prompt_server
        self.result = None
        self.server = None
        self.started = False
        self.result_event = threading.Event()
        self.window_closed = False
        self.browser_url = None

    def start(self):
        for port in range(8080, 9000):
            try:
                self.server = socketserver.TCPServer(('localhost', port), self.RegionNodeHandler)
                self.started = True
                print(f"[SnapshotRegion] Server started on port {port}")
                break
            except Exception:
                continue

        if not self.started:
            print("[SnapshotRegion] Failed to start server")
            return

        self.browser_url = f"http://localhost:{port}/region_node.html"
        self.RegionNodeHandler.server_instance = self

        try:
            self.server.serve_forever()
        except Exception:
            pass

    def stop(self):
        if self.server:
            print("[SnapshotRegion] Stopping server")
            self.server.shutdown()
            self.server.server_close()

    def wait_for_result(self):
        if not waitSnapShot(self.result_event):
            raise Exception("Canceled")

    class RegionNodeHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def do_GET(self):
            if self.path == '/region_node.html' or self.path == '/':
                file_path = os.path.join(os.path.dirname(__file__), 'web', 'region_node.html')
                if os.path.exists(file_path):
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
                    self.end_headers()
                    with open(file_path, 'rb') as f:
                        self.wfile.write(f.read())
                else:
                    self.send_error(404, "region_node.html not found. Run: npm run build -w region_node")
            elif self.path == '/config':
                if self.server_instance:
                    try:
                        if self.server_instance.image is not None:
                            img_b64 = image_to_base64(self.server_instance.image)
                        else:
                            img_b64 = None
                        cfg = self.server_instance.config
                        response = {
                            'image': img_b64,
                            'width': self.server_instance.width,
                            'height': self.server_instance.height,
                            'background': cfg.get('background', ''),
                            'high_level_description': cfg.get('high_level_description', ''),
                            'aesthetics': cfg.get('aesthetics', ''),
                            'lighting': cfg.get('lighting', ''),
                            'medium': cfg.get('medium', ''),
                            'style_palette': cfg.get('style_palette_data', ''),
                            'bbox_order': cfg.get('bbox_order', 'yx'),
                            'coord_mode': cfg.get('coord_mode', 'normalized'),
                            'output_format': cfg.get('output_format', 'compact'),
                            'bg_brightness': cfg.get('bg_brightness', 25),
                            'initial_boxes': cfg.get('initial_boxes', ''),
                            'prompt_url': cfg.get('prompt_url', None),
                        }
                        data = json.dumps(response).encode('utf-8')
                        self.send_response(200)
                        self.send_header('Content-type', 'application/json')
                        self.send_header('Content-Length', str(len(data)))
                        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
                        self.end_headers()
                        self.wfile.write(data)
                    except Exception as e:
                        self.send_error(500, f"Error: {e}")
                else:
                    self.send_error(500, "Server error")
            elif self.path == '/prompt_result':
                # Check if the prompt server has a confirmed result
                ps = self.server_instance.prompt_server if self.server_instance else None
                has_result = ps is not None and ps.prompt_event.is_set()
                result = None
                if has_result:
                    result = {
                        'prompts': ps.selected_prompts,
                        'custom_prompts': ps.custom_prompts,
                        'loras': ps.selected_loras,
                        'prefabs': ps.selected_prefabs,
                    }
                data = json.dumps({'has_result': has_result, 'result': result}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
                self.end_headers()
                self.wfile.write(data)
            else:
                super().do_GET()

        def do_POST(self):
            if self.path == '/confirm':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    self.server_instance.result = data
                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
                    self.server_instance.result_event.set()
                else:
                    self.send_error(500, "Server error")
            elif self.path == '/window_closed':
                self.server_instance.window_closed = True
                self.server_instance.result_event.set()
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
            elif self.path == '/switch_context':
                # Update prompt server's context for the newly selected region
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                ctx = json.loads(post_data) if post_data else {}
                ps = self.server_instance.prompt_server if self.server_instance else None
                if ps:
                    ps.last_selected = ctx.get('prompts', [])
                    ps.last_selected_loras = ctx.get('loras', [])
                    ps.last_selected_prefabs = ctx.get('prefabs', [])
                    # Clear any pending result so the frontend doesn't re-apply stale data
                    ps.prompt_event.clear()
                    ps.selected_prompts = []
                    ps.custom_prompts = ''
                    ps.selected_loras = []
                    ps.selected_prefabs = []
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
            elif self.path == '/reset_prompt':
                # Clear the prompt result so frontend can detect new confirmation
                ps = self.server_instance.prompt_server if self.server_instance else None
                if ps:
                    ps.prompt_event.clear()
                    ps.selected_prompts = []
                    ps.custom_prompts = ''
                    ps.selected_loras = []
                    ps.selected_prefabs = []
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
            else:
                super().do_POST()

        def log_message(self, format, *args):
            pass


# ═══════════════════════════════════════════════════════════════════════════
#  SnapshotRegionNode
# ═══════════════════════════════════════════════════════════════════════════

class SnapshotRegionNode:
    """Open an image in a browser, let user draw regions (bboxes) with descriptions,
    and return the assembled caption JSON, preview image, and pixel-space bboxes."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {
                    "default": 1024,
                    "min": 64,
                    "max": 16384,
                    "step": 16,
                    "tooltip": "Canvas aspect width (also the pixel grid the bbox is measured in)",
                }),
                "height": ("INT", {
                    "default": 1024,
                    "min": 64,
                    "max": 16384,
                    "step": 16,
                    "tooltip": "Canvas aspect height (also the pixel grid the bbox is measured in)",
                }),
                "background": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "Required scene background description",
                }),
            },
            "optional": {
                "image": ("IMAGE", {
                    "tooltip": "Optional input image to draw regions on",
                }),
                "high_level_description": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "Optional one-line overview of the whole image",
                }),
                "aesthetics": ("STRING", {
                    "default": "",
                    "tooltip": "Style descriptor (blank = omitted)",
                }),
                "lighting": ("STRING", {
                    "default": "",
                    "tooltip": "Style descriptor (blank = omitted)",
                }),
                "medium": ("STRING", {
                    "default": "",
                    "tooltip": "Style descriptor (blank = omitted)",
                }),
                "style_palette_data": ("STRING", {
                    "default": "",
                    "tooltip": "Serialized style color palette JSON from a previous run",
                }),
                "import_json": ("STRING", {
                    "default": "",
                    "tooltip": "Optional: a full caption JSON to pre-fill the editor",
                }),
                "bbox_order": (["yx", "xy"], {
                    "default": "yx",
                    "tooltip": "bbox axis order: 'yx' (Ideogram [ymin,xmin,ymax,xmax]) or 'xy' ([xmin,ymin,xmax,ymax])",
                }),
                "coord_mode": (["normalized", "absolute"], {
                    "default": "normalized",
                    "tooltip": "bbox coordinate space: 'normalized' (0-1000 grid) or 'absolute' (pixels)",
                }),
                "output_format": (["compact", "pretty"], {
                    "default": "compact",
                    "tooltip": "Output JSON formatting: 'compact' or 'pretty' (indented)",
                }),
                "bg_brightness": ("INT", {
                    "default": 25,
                    "min": 0,
                    "max": 100,
                    "tooltip": "Background image brightness % (lower = darker, for region visibility)",
                }),
                "data_cache": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Cache regions/style/text to widgets so they persist across runs",
                }),
                "cached_data": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Cached region data from previous run (auto-updated when data_cache is on)",
                }),
                "enable_snapshot_prompt": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Embed SnapshotPromptNode editor in the left panel for configuring region prompts",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE", "BBOX", "INT", "INT")
    RETURN_NAMES = ("prompt", "preview", "bboxes", "width", "height")
    FUNCTION = "build"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        return float("nan")

    def build(
        self,
        width: int = 1024,
        height: int = 1024,
        background: str = "",
        image=None,
        high_level_description: str = "",
        aesthetics: str = "",
        lighting: str = "",
        medium: str = "",
        style_palette_data: str = "",
        import_json: str = "",
        bbox_order: str = "yx",
        coord_mode: str = "normalized",
        output_format: str = "compact",
        bg_brightness: int = 25,
        data_cache: bool = True,
        cached_data: str = "",
        enable_snapshot_prompt: bool = False,
        unique_id: str = None,
    ):
        # Save foreground window for focus restoration
        focused_window = None
        if has_win32gui:
            try:
                focused_window = win32gui.GetForegroundWindow()
            except Exception:
                pass

        # Prepare initial boxes: cached_data takes priority, then import_json
        initial_boxes_str = ""
        if cached_data.strip():
            initial_boxes_str = cached_data
        elif import_json.strip():
            imported = _loads_caption(import_json)
            if imported:
                ib = _caption_to_boxes(imported)
                if ib:
                    initial_boxes_str = json.dumps(ib)

        # Build config dict for the frontend
        config = {
            'background': background,
            'high_level_description': high_level_description,
            'aesthetics': aesthetics,
            'lighting': lighting,
            'medium': medium,
            'style_palette_data': style_palette_data,
            'bbox_order': bbox_order,
            'coord_mode': coord_mode,
            'output_format': output_format,
            'bg_brightness': bg_brightness,
            'initial_boxes': initial_boxes_str,
        }

        # Start prompt server if enabled
        prompt_server = None
        if enable_snapshot_prompt:
            from .prompt_node import SnapshotPromptServer
            prompt_server = SnapshotPromptServer()
            prompt_server_thread = threading.Thread(target=prompt_server.start)
            prompt_server_thread.daemon = True
            prompt_server_thread.start()

            # Wait for prompt server to be ready
            ps_start = time.time()
            ps_timeout = 10
            while not prompt_server.started:
                if time.time() - ps_start > ps_timeout:
                    print("[SnapshotRegion] Prompt server startup timeout, continuing without it")
                    prompt_server = None
                    break
                time.sleep(0.1)

            if prompt_server and prompt_server.started:
                config['prompt_url'] = prompt_server.browser_url
                print(f"[SnapshotRegion] Prompt server started at: {prompt_server.browser_url}")

        # Start region server
        server = SnapshotRegionServer(image, width, height, config, prompt_server=prompt_server)
        server_thread = threading.Thread(target=server.start)
        server_thread.daemon = True
        server_thread.start()

        # Wait for server to be ready
        start_time = time.time()
        timeout = 10
        while not server.started:
            if time.time() - start_time > timeout:
                raise RuntimeError(f"[SnapshotRegion] Server startup timeout after {timeout} seconds")
            time.sleep(0.1)

        print(f"[SnapshotRegion] Opening browser at: {server.browser_url}")
        webbrowser.open(server.browser_url)

        # Wait for user to confirm or cancel
        print("[SnapshotRegion] Waiting for region selection...")
        server.wait_for_result()

        # Stop server
        server.stop()

        # Stop prompt server if running
        if prompt_server:
            prompt_server.stop()

        # Restore window focus
        if has_win32gui and focused_window:
            time.sleep(0.3)
            try:
                if win32gui.IsIconic(focused_window):
                    win32gui.ShowWindow(focused_window, win32con.SW_RESTORE)
                win32gui.SetForegroundWindow(focused_window)
            except Exception:
                pass

        if server.window_closed or server.result is None:
            raise ValueError("Window closed without confirming regions")

        # Extract result data
        result = server.result
        boxes = result.get('boxes', [])
        sp = result.get('style_palette', [])
        bg_text = result.get('background', background)
        hld = result.get('high_level_description', high_level_description)
        aest = result.get('aesthetics', aesthetics)
        light = result.get('lighting', lighting)
        med = result.get('medium', medium)

        # Build caption JSON
        dump = _dumps if output_format == "pretty" else (lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":")))
        bsx, bsy = (width, height) if coord_mode == "absolute" else (1000, 1000)
        border = "xy" if bbox_order == "xy" else "yx"

        caption = {}
        if hld.strip():
            caption["high_level_description"] = hld

        palette = _palette(sp)
        if palette or aest.strip() or light.strip() or med.strip():
            sd = {"aesthetics": aest, "lighting": light}
            sd["medium"] = med
            if palette:
                sd["color_palette"] = palette
            caption["style_description"] = sd

        elements = []
        for box in boxes:
            if not isinstance(box, dict):
                continue
            etype = "text" if box.get("type") == "text" else "obj"
            elem = {"type": etype}
            if not box.get("nobbox"):
                elem["bbox"] = _norm_bbox(box, bsx, bsy, border)
            if etype == "text":
                elem["text"] = box.get("text", "")
            elem["desc"] = box.get("desc", "")
            epal = _palette(box.get("palette", []))
            if epal:
                elem["color_palette"] = epal[:5]
            elements.append(elem)

        caption["compositional_deconstruction"] = {
            "background": bg_text,
            "elements": elements,
        }

        prompt_json = dump(caption)

        # Render preview image
        bg_pil = None
        if image is not None:
            try:
                bg_pil = Image.fromarray((image[0].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8))
            except Exception:
                bg_pil = None
        preview = _render_preview(boxes, width, height, bg_pil, bg_brightness if bg_pil else 50)

        # Build pixel-space bboxes for BBOX output
        bbox_dicts = []
        for box in boxes:
            if not isinstance(box, dict) or box.get("nobbox"):
                continue
            x, y = box.get("x", 0.0), box.get("y", 0.0)
            bw, bh = box.get("w", 0.0), box.get("h", 0.0)
            if bw < 0:
                x += bw
                bw = -bw
            if bh < 0:
                y += bh
                bh = -bh
            bbox_dicts.append({
                "x": round(x * width),
                "y": round(y * height),
                "width": round(bw * width),
                "height": round(bh * height),
            })
        bboxes_out = [bbox_dicts] if bbox_dicts else []

        # Cache result back to widgets so next run restores the data
        if data_cache and unique_id is not None:
            try:
                cache_payload = json.dumps(boxes, ensure_ascii=False)
                PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                    "node_id": unique_id,
                    "widget_name": "cached_data",
                    "type": "STRING",
                    "value": cache_payload,
                })
                PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                    "node_id": unique_id,
                    "widget_name": "style_palette_data",
                    "type": "STRING",
                    "value": json.dumps(sp, ensure_ascii=False),
                })
                PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                    "node_id": unique_id,
                    "widget_name": "background",
                    "type": "STRING",
                    "value": bg_text,
                })
                PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                    "node_id": unique_id,
                    "widget_name": "high_level_description",
                    "type": "STRING",
                    "value": hld,
                })
                PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                    "node_id": unique_id,
                    "widget_name": "aesthetics",
                    "type": "STRING",
                    "value": aest,
                })
                PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                    "node_id": unique_id,
                    "widget_name": "lighting",
                    "type": "STRING",
                    "value": light,
                })
                PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                    "node_id": unique_id,
                    "widget_name": "medium",
                    "type": "STRING",
                    "value": med,
                })
            except Exception as e:
                print(f"[SnapshotRegion] Warning: Failed to cache widgets: {e}")

        return (prompt_json, preview, bboxes_out, width, height)
