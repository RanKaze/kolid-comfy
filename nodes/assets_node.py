import os
import json
import threading
import http.server
import webbrowser
import time
import base64
import hashlib
import urllib.parse
import io
import comfy.model_management as mm
from server import PromptServer
from comfy_api.latest import InputImpl


def check_interrupted():
    try:
        mm.throw_exception_if_processing_interrupted()
    except Exception:
        raise
    try:
        if mm.processing_interrupted():
            return True
        if hasattr(mm, 'interrupted') and mm.interrupted:
            return True
        if hasattr(mm, 'check_interrupt') and mm.check_interrupt():
            return True
    except Exception:
        pass
    return False


class SnapshotAssetsServer:
    """HTTP server for SnapshotAssetsNode to let user drag/drop images and confirm selection."""

    def __init__(self, input_data="", canvas_snapshot=None, node_id=None, enable_image_strength=False, enable_prompt=False, image_strength_config="", enable_slot=False, slot_config="", enable_image=True, enable_video=True):
        self.port = None
        self.server = None
        self.started = False
        self.confirm_event = threading.Event()
        self.window_closed = False
        self.browser_url = None
        self.selected_images = []
        self.selected_videos = []
        self.selected_slots = []  # List ordered by slot index: [{"type": "Image"/"Video", "data": {...}}]
        self.prompt = ""
        self.input_data = input_data
        self.canvas_snapshot = canvas_snapshot  # tldraw snapshot JSON string
        self.node_id = node_id  # Node ID for persistence
        self.enable_image_strength = enable_image_strength
        self.enable_prompt = enable_prompt
        self.image_strength_config = image_strength_config
        self.enable_slot = enable_slot
        self.slot_config = slot_config
        self.enable_image = enable_image
        self.enable_video = enable_video
        self.should_stop = False
        # Use data/assets directory for both image and video cache (persistent storage)
        self.asset_cache_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "assets")
        os.makedirs(self.asset_cache_dir, exist_ok=True)

    def save_base64_image(self, data_url):
        """Save base64 image to cache directory and return URL path."""
        try:
            # Extract base64 data
            if ',' in data_url:
                header, base64_data = data_url.split(',', 1)
            else:
                base64_data = data_url
                header = "data:image/png;base64"
            
            # GIF files are treated as video
            if "image/gif" in header:
                return self.save_base64_video(data_url)
            
            # Determine extension from mime type
            ext = ".png"
            if "image/jpeg" in header or "image/jpg" in header:
                ext = ".jpg"
            elif "image/webp" in header:
                ext = ".webp"
            
            # Generate unique filename
            import hashlib
            filename = hashlib.md5(base64_data.encode()).hexdigest() + ext
            filepath = os.path.join(self.asset_cache_dir, filename)
            
            # Save file if not exists
            if not os.path.exists(filepath):
                img_bytes = base64.b64decode(base64_data)
                with open(filepath, 'wb') as f:
                    f.write(img_bytes)
            
            # Return URL path (relative to server root)
            return f"/assets/{filename}"
        except Exception as e:
            print(f"[SnapshotAssets] Failed to save image: {e}")
            return None

    def save_base64_video(self, data_url):
        """Save base64 video to cache directory and return URL path."""
        try:
            # Extract base64 data
            if ',' in data_url:
                header, base64_data = data_url.split(',', 1)
            else:
                base64_data = data_url
                header = "data:video/mp4;base64"
            
            # Determine extension from mime type
            ext = ".mp4"
            if "video/webm" in header:
                ext = ".webm"
            elif "video/avi" in header:
                ext = ".avi"
            elif "video/mov" in header or "video/quicktime" in header:
                ext = ".mov"
            
            # Generate unique filename
            import hashlib
            filename = hashlib.md5(base64_data.encode()).hexdigest() + ext
            filepath = os.path.join(self.asset_cache_dir, filename)
            
            # Save file if not exists
            if not os.path.exists(filepath):
                video_bytes = base64.b64decode(base64_data)
                with open(filepath, 'wb') as f:
                    f.write(video_bytes)
                print(f"[SnapshotAssets] Saved video to: {filepath}")
            
            # Return URL path (relative to server root)
            return f"/assets/{filename}"
        except Exception as e:
            print(f"[SnapshotAssets] Failed to save video: {e}")
            return None

    def start(self):
        import socketserver
        class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
            pass
        for port in range(8800, 8900):
            try:
                self.server = ThreadingHTTPServer(('localhost', port), self.AssetsHandler)
                self.port = port
                self.started = True
                print(f"[SnapshotAssets] Server started on port {port}")
                break
            except Exception:
                continue

        self.browser_url = f"http://localhost:{self.port}/assets_node.html"

        if not self.started:
            print("[SnapshotAssets] Failed to start server")
            return

        self.AssetsHandler.server_instance = self
        try:
            self.server.serve_forever()
        except Exception:
            pass

    def stop(self):
        self.should_stop = True
        self.confirm_event.set()
        if self.server:
            print("[SnapshotAssets] Stopping server")
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:
                pass

    def wait_for_confirm(self, check_interval=0.001):
        print("[SnapshotAssets] Waiting for user confirmation...")
        while not self.confirm_event.is_set():
            try:
                mm.throw_exception_if_processing_interrupted()
            except Exception as e:
                if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                    print(f"[SnapshotAssets] Interrupt detected: {e}")
                    return False
                raise
            if check_interrupted():
                print("[SnapshotAssets] Interrupted!")
                return False
            if self.should_stop:
                return False
            self.confirm_event.wait(check_interval)
        return True

    class AssetsHandler(http.server.SimpleHTTPRequestHandler):
        server_instance = None

        def do_GET(self):
            if self.path in ('/', '/assets_node.html'):
                try:
                    web_dir = os.path.join(os.path.dirname(__file__), "web")
                    file_path = os.path.join(web_dir, "assets_node.html")
                    with open(file_path, 'rb') as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(content)
                    return
                except Exception as e:
                    self.send_error(404, f"HTML file not found: {e}")
                    return

            elif self.path == '/input_data':
                # Parse image_strength_config into list of {name, default} dicts
                # Format: "strength0:0.1,strength1:1" or "strength0,strength1" (defaults to 0)
                strength_defs = []
                if self.server_instance and self.server_instance.image_strength_config:
                    for part in self.server_instance.image_strength_config.split(','):
                        part = part.strip()
                        if not part:
                            continue
                        if ':' in part:
                            name, default_str = part.split(':', 1)
                            name = name.strip()
                            try:
                                default_val = float(default_str.strip())
                            except ValueError:
                                default_val = 0.0
                        else:
                            name = part
                            default_val = 0.0
                        if name:
                            strength_defs.append({'name': name, 'default': default_val})
                # Parse slot_config into list of {type, name} dicts
                # Format: "Image:Test,Video:Test1,Image:Test2"
                slot_defs = []
                if self.server_instance and self.server_instance.enable_slot and self.server_instance.slot_config:
                    for part in self.server_instance.slot_config.split(','):
                        part = part.strip()
                        if not part:
                            continue
                        if ':' in part:
                            slot_type, slot_name = part.split(':', 1)
                            slot_type = slot_type.strip().capitalize()
                            slot_name = slot_name.strip()
                            if slot_type in ('Image', 'Video') and slot_name:
                                slot_defs.append({'type': slot_type, 'name': slot_name})
                
                data = {
                    'input_data': self.server_instance.input_data if self.server_instance else '',
                    'canvas_snapshot': self.server_instance.canvas_snapshot if self.server_instance else None,
                    'enable_image_strength': self.server_instance.enable_image_strength if self.server_instance else False,
                    'enable_prompt': self.server_instance.enable_prompt if self.server_instance else False,
                    'strength_defs': strength_defs,
                    'enable_slot': self.server_instance.enable_slot if self.server_instance else False,
                    'enable_image': self.server_instance.enable_image if self.server_instance else True,
                    'enable_video': self.server_instance.enable_video if self.server_instance else True,
                    'slot_defs': slot_defs,
                }
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode('utf-8'))
                return

            elif self.path.startswith('/assets/'):
                # Serve cached images and videos from asset_cache_dir
                # Supports HTTP Range requests for video streaming
                if self.server_instance:
                    filename = os.path.basename(self.path)
                    filepath = os.path.join(self.server_instance.asset_cache_dir, filename)
                    if os.path.exists(filepath):
                        file_size = os.path.getsize(filepath)
                        # Determine content type from extension
                        ext = os.path.splitext(filename)[1].lower()
                        content_type = 'application/octet-stream'
                        if ext in ['.png', '.jpg', '.jpeg', '.webp', '.gif']:
                            if ext == '.png': content_type = 'image/png'
                            elif ext in ['.jpg', '.jpeg']: content_type = 'image/jpeg'
                            elif ext == '.webp': content_type = 'image/webp'
                            elif ext == '.gif': content_type = 'image/gif'
                        elif ext in ['.mp4', '.webm', '.avi', '.mov']:
                            if ext == '.mp4': content_type = 'video/mp4'
                            elif ext == '.webm': content_type = 'video/webm'
                            elif ext == '.avi': content_type = 'video/x-msvideo'
                            elif ext == '.mov': content_type = 'video/quicktime'

                        # Parse Range header for video streaming
                        range_header = self.headers.get('Range')
                        if range_header and range_header.startswith('bytes='):
                            # Parse "bytes=start-end"
                            range_str = range_header[6:]
                            parts = range_str.split('-')
                            start = int(parts[0]) if parts[0] else 0
                            end = int(parts[1]) if len(parts) > 1 and parts[1] else file_size - 1
                            if start >= file_size:
                                self.send_error(416, "Range Not Satisfiable")
                                return
                            end = min(end, file_size - 1)
                            content_len = end - start + 1
                            
                            self.send_response(206)
                            self.send_header('Content-type', content_type)
                            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
                            self.send_header('Content-Length', str(content_len))
                            self.send_header('Accept-Ranges', 'bytes')
                            self.send_header("Access-Control-Allow-Origin", "*")
                            self.end_headers()
                            with open(filepath, 'rb') as f:
                                f.seek(start)
                                remaining = content_len
                                while remaining > 0:
                                    chunk = f.read(min(64 * 1024, remaining))
                                    if not chunk: break
                                    self.wfile.write(chunk)
                                    remaining -= len(chunk)
                        else:
                            self.send_response(200)
                            self.send_header('Content-type', content_type)
                            self.send_header('Content-Length', str(file_size))
                            self.send_header('Accept-Ranges', 'bytes')
                            self.send_header("Access-Control-Allow-Origin", "*")
                            self.send_header('Cache-Control', 'public, max-age=31536000')
                            self.end_headers()
                            with open(filepath, 'rb') as f:
                                while True:
                                    chunk = f.read(64 * 1024)
                                    if not chunk: break
                                    self.wfile.write(chunk)
                        return
                self.send_error(404, "Asset not found")
                return

            self.send_error(404, "Not found")

        def do_POST(self):
            if self.path == '/confirm':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data)

                if self.server_instance:
                    # Get selected images, videos and tldraw snapshot from frontend
                    selected_images = data.get('images', [])
                    selected_videos_data = data.get('videos', [])
                    selected_slots_data = data.get('slots', [])  # Array of {type, data} per slot
                    canvas_snapshot = data.get('canvas_snapshot', '')
                    
                    # Process base64 images/videos in snapshot: convert to URLs/paths
                    if canvas_snapshot:
                        try:
                            snapshot = json.loads(canvas_snapshot)
                            # Process assets in snapshot store
                            if 'store' in snapshot:
                                for record_id, record in snapshot['store'].items():
                                    if isinstance(record, dict) and record.get('typeName') == 'asset' and 'props' in record:
                                        props = record['props']
                                        if 'src' in props and props['src'].startswith('data:'):
                                            if props.get('mimeType', '').startswith('video/'):
                                                url = self.server_instance.save_base64_video(props['src'])
                                            else:
                                                url = self.server_instance.save_base64_image(props['src'])
                                            if url:
                                                props['src'] = url
                            # Process panelImages - convert base64 dataUrl to URLs
                            if 'panelImages' in snapshot and isinstance(snapshot['panelImages'], list):
                                for panel_img in snapshot['panelImages']:
                                    if isinstance(panel_img, dict) and 'dataUrl' in panel_img:
                                        data_url = panel_img['dataUrl']
                                        if isinstance(data_url, str) and data_url.startswith('data:'):
                                            url = self.server_instance.save_base64_image(data_url)
                                            if url:
                                                panel_img['dataUrl'] = url
                            # Process panelVideos - convert base64 dataUrl to URL paths (same as images)
                            if 'panelVideos' in snapshot and isinstance(snapshot['panelVideos'], list):
                                for panel_vid in snapshot['panelVideos']:
                                    if isinstance(panel_vid, dict) and 'dataUrl' in panel_vid:
                                        data_url = panel_vid['dataUrl']
                                        if isinstance(data_url, str) and data_url.startswith('data:'):
                                            # Save video and get URL
                                            url = self.server_instance.save_base64_video(data_url)
                                            if url:
                                                panel_vid['dataUrl'] = url
                                        elif isinstance(data_url, str) and not data_url.startswith('/assets/'):
                                            # If it's already a file path (from previous save), convert to URL
                                            if os.path.isabs(data_url):
                                                filename = os.path.basename(data_url)
                                                panel_vid['dataUrl'] = f"/assets/{filename}"
                            # Process panelSlots - convert base64 dataUrl to URLs
                            if 'panelSlots' in snapshot and isinstance(snapshot['panelSlots'], list):
                                for panel_slot in snapshot['panelSlots']:
                                    if isinstance(panel_slot, dict) and panel_slot.get('data'):
                                        slot_data = panel_slot['data']
                                        if isinstance(slot_data, dict) and 'dataUrl' in slot_data:
                                            data_url = slot_data['dataUrl']
                                            if isinstance(data_url, str) and data_url.startswith('data:'):
                                                if panel_slot.get('type') == 'Video':
                                                    url = self.server_instance.save_base64_video(data_url)
                                                else:
                                                    url = self.server_instance.save_base64_image(data_url)
                                                if url:
                                                    slot_data['dataUrl'] = url
                                            elif isinstance(data_url, str) and not data_url.startswith('/assets/'):
                                                if os.path.isabs(data_url):
                                                    filename = os.path.basename(data_url)
                                                    slot_data['dataUrl'] = f"/assets/{filename}"
                            canvas_snapshot = json.dumps(snapshot)
                        except Exception as e:
                            print(f"[SnapshotAssets] Failed to process snapshot: {e}")
                    
                    # Also convert selected images if they are base64
                    selected_image_items = []
                    for img_data in selected_images:
                        if isinstance(img_data, dict) and 'image' in img_data:
                            image_url = img_data['image']
                            if image_url.startswith('data:'):
                                url = self.server_instance.save_base64_image(image_url)
                                if url:
                                    image_url = url
                            item = {"image": image_url}
                            # Support both single strength and multiple strengths dict
                            if 'strengths' in img_data and img_data['strengths'] is not None:
                                item['strengths'] = img_data['strengths']
                            elif 'strength' in img_data and img_data['strength'] is not None:
                                item['strength'] = img_data['strength']
                            selected_image_items.append(item)
                        elif isinstance(img_data, str):
                            if img_data.startswith('data:'):
                                url = self.server_instance.save_base64_image(img_data)
                                if url:
                                    selected_image_items.append({"image": url})
                                else:
                                    selected_image_items.append({"image": img_data})
                            else:
                                selected_image_items.append({"image": img_data})

                    # Convert selected videos if they are base64 or file paths (统一使用 /assets/ URL)
                    selected_video_items = []
                    print(f"[SnapshotAssets] Received {len(selected_videos_data)} video items from frontend")
                    for vid_data in selected_videos_data:
                        print(f"[SnapshotAssets] Processing video item: type={type(vid_data).__name__}, data={str(vid_data)[:100]}")
                        if isinstance(vid_data, dict) and 'video' in vid_data:
                            video_url = vid_data['video']
                            if video_url.startswith('data:'):
                                print(f"[SnapshotAssets] Converting base64 video to file...")
                                url = self.server_instance.save_base64_video(video_url)
                                if url:
                                    video_url = url
                                    print(f"[SnapshotAssets] Saved video, got URL: {video_url}")
                                else:
                                    video_url = vid_data['video']  # Keep original if save failed
                            elif not video_url.startswith('/assets/') and os.path.isabs(video_url):
                                # Convert absolute file path to URL
                                filename = os.path.basename(video_url)
                                video_url = f"/assets/{filename}"
                            item = {"video": video_url}
                            selected_video_items.append(item)
                        elif isinstance(vid_data, str):
                            if vid_data.startswith('data:'):
                                url = self.server_instance.save_base64_video(vid_data)
                                if url:
                                    selected_video_items.append({"video": url})
                                else:
                                    selected_video_items.append({"video": vid_data})
                            elif vid_data.startswith('/assets/'):
                                # Already a URL
                                selected_video_items.append({"video": vid_data})
                            elif os.path.isabs(vid_data):
                                # Absolute file path, convert to URL
                                filename = os.path.basename(vid_data)
                                selected_video_items.append({"video": f"/assets/{filename}"})
                            else:
                                selected_video_items.append({"video": vid_data})

                    print(f"[SnapshotAssets] Final selected_video_items: {len(selected_video_items)} items")
                    for item in selected_video_items:
                        print(f"[SnapshotAssets]   Video item: {item}")
                    
                    # Process selected slots if any
                    selected_slot_items = []
                    if selected_slots_data:
                        print(f"[SnapshotAssets] Received {len(selected_slots_data)} slot items from frontend")
                        for slot_item in selected_slots_data:
                            slot_type = slot_item.get('type', '')
                            slot_data = slot_item.get('data')
                            
                            if slot_data is None:
                                # Empty slot
                                selected_slot_items.append({'type': slot_type, 'data': None})
                                print(f"[SnapshotAssets]   Slot: type={slot_type}, empty")
                                continue
                            
                            if slot_type == 'Image':
                                # Process image slot data
                                if isinstance(slot_data, dict) and 'image' in slot_data:
                                    image_url = slot_data['image']
                                elif isinstance(slot_data, str):
                                    image_url = slot_data
                                else:
                                    image_url = str(slot_data)
                                
                                if image_url.startswith('data:'):
                                    url = self.server_instance.save_base64_image(image_url)
                                    if url:
                                        image_url = url
                                    else:
                                        image_url = slot_data.get('image', image_url) if isinstance(slot_data, dict) else image_url
                                elif image_url.startswith('/assets/'):
                                    pass  # Already a URL
                                
                                selected_slot_items.append({'type': 'Image', 'data': {'image': image_url}})
                                print(f"[SnapshotAssets]   Slot Image: {image_url[:80]}...")
                            
                            elif slot_type == 'Video':
                                # Process video slot data
                                if isinstance(slot_data, dict) and 'video' in slot_data:
                                    video_url = slot_data['video']
                                elif isinstance(slot_data, str):
                                    video_url = slot_data
                                else:
                                    video_url = str(slot_data)
                                
                                if video_url.startswith('data:'):
                                    url = self.server_instance.save_base64_video(video_url)
                                    if url:
                                        video_url = url
                                    else:
                                        video_url = slot_data.get('video', video_url) if isinstance(slot_data, dict) else video_url
                                elif video_url.startswith('/assets/'):
                                    pass  # Already a URL
                                elif not video_url.startswith('/assets/') and os.path.isabs(video_url):
                                    filename = os.path.basename(video_url)
                                    video_url = f"/assets/{filename}"
                                
                                selected_slot_items.append({'type': 'Video', 'data': {'video': video_url}})
                                print(f"[SnapshotAssets]   Slot Video: {video_url[:80]}...")
                            else:
                                selected_slot_items.append({'type': slot_type, 'data': slot_data})
                    
                    self.server_instance.selected_images = selected_image_items
                    self.server_instance.selected_videos = selected_video_items
                    self.server_instance.selected_slots = selected_slot_items
                    prompt_value = data.get('prompt', '')
                    print(f"[SnapshotAssets] Received prompt: '{prompt_value}'")
                    self.server_instance.prompt = prompt_value if prompt_value is not None else ''
                    self.server_instance.canvas_snapshot = canvas_snapshot
                    
                    # Save tldraw snapshot to data widget using send_sync
                    if self.server_instance.node_id and canvas_snapshot:
                        PromptServer.instance.send_sync("kolid-comfy-widget-set", {
                            "node_id": self.server_instance.node_id,
                            "widget_name": "data",
                            "type": "STRING",
                            "value": canvas_snapshot
                        })
                    self.server_instance.confirm_event.set()

                    self.send_response(200)
                    self.send_header('Content-type', 'application/json')
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf-8'))
                else:
                    self.send_error(500, "Server error")
                return

            elif self.path == '/upload_asset':
                # Handle raw binary file upload for large videos.
                # Sends the file directly as request body (no multipart).
                # Streams chunks to disk while computing MD5 hash in one pass.
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length == 0:
                    self.send_error(400, "Empty body")
                    return
                
                # Filename from custom header (URL-encoded)
                raw_name = self.headers.get('X-Filename', 'upload.mp4')
                original_name = urllib.parse.unquote(raw_name)
                # Sanitize: keep only the base filename
                original_name = os.path.basename(original_name) or 'upload.mp4'
                ext = os.path.splitext(original_name)[1] or '.mp4'
                
                if not self.server_instance:
                    self.send_error(500, "Server error")
                    return
                
                cache_dir = self.server_instance.asset_cache_dir
                # Write to temp file while computing hash in chunks
                temp_name = f'_tmp_{hashlib.md5(str(time.time()).encode()).hexdigest()}{ext}'
                temp_path = os.path.join(cache_dir, temp_name)
                
                md5_hash = hashlib.md5()
                total = 0
                with open(temp_path, 'wb') as f:
                    while total < content_length:
                        chunk_size = min(256 * 1024, content_length - total)
                        chunk = self.rfile.read(chunk_size)
                        if not chunk:
                            break
                        f.write(chunk)
                        md5_hash.update(chunk)
                        total += len(chunk)
                
                filename = md5_hash.hexdigest() + ext
                filepath = os.path.join(cache_dir, filename)
                # Remove existing file if any, then rename
                if os.path.exists(filepath):
                    os.remove(temp_path)
                else:
                    os.rename(temp_path, filepath)
                
                print(f"[SnapshotAssets] Uploaded file: {filepath} ({total} bytes, {total / 1024 / 1024:.1f} MB)")
                
                url = f"/assets/{filename}"
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'url': url, 'name': original_name}).encode('utf-8'))
                return

            elif self.path == '/window_closed':
                if self.server_instance:
                    self.server_instance.window_closed = True
                    self.server_instance.confirm_event.set()
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({'status': 'ok'}).encode('utf-8'))
                return

            self.send_error(404, "Not found")

        def log_message(self, format, *args):
            pass


class SnapshotAssetsNode:
    """Opens a tldraw-based web page where users can drag/drop images as cards,
    select them, and confirm. Outputs a list of dicts: [{"image": tensor}, ...]
    where each tensor is a ComfyUI-compatible image [B, H, W, C]."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "data": ("STRING", {"default": "", "multiline": True}),
                "enable_prompt": ("BOOLEAN", {"default": False}),
                "enable_image": ("BOOLEAN", {"default": True}),
                "enable_image_strength": ("BOOLEAN", {"default": False}),
                "image_strength_config": ("STRING", {"default": "test0:1.0,test1:0.5", "multiline": False}),
                "enable_video": ("BOOLEAN", {"default": True}),
                "enable_slot": ("BOOLEAN", {"default": False}),
                "slot_config": ("STRING", {"default": "Image:slot0,Video:slot1", "multiline": False}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE", "FLOAT", "VIDEO", "*")
    RETURN_NAMES = ("prompt", "image", "image_strength", "video", "slot")
    OUTPUT_IS_LIST = (False, True, True, True, True)
    FUNCTION = "snapshot_assets"
    CATEGORY = "Kolid-Toolkit"

    @classmethod
    def IS_CHANGED(s, Data):
        return float("nan")

    @staticmethod
    def _decode_image_data(image_data: str):
        """Decode image data (base64 or URL) to a ComfyUI-compatible torch tensor [B, H, W, C]."""
        import numpy as np
        from PIL import Image
        import torch

        # Handle URL paths (e.g., /assets/abc123.png)
        if image_data.startswith('/assets/'):
            # Get the absolute path from the URL
            base_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "assets")
            filename = os.path.basename(image_data)
            filepath = os.path.join(base_dir, filename)
            if os.path.exists(filepath):
                img = Image.open(filepath)
            else:
                raise ValueError(f"Image file not found: {filepath}")
        elif image_data.startswith('data:'):
            # Base64 data URL
            if ',' in image_data:
                image_data = image_data.split(',', 1)[1]
            img_bytes = base64.b64decode(image_data)
            img = Image.open(io.BytesIO(img_bytes))
        else:
            raise ValueError(f"Unsupported image data format: {image_data[:50]}...")

        if img.mode != 'RGB':
            img = img.convert('RGB')

        arr = np.array(img).astype(np.float32) / 255.0
        tensor = torch.from_numpy(arr).unsqueeze(0)  # [1, H, W, 3]
        return tensor

    def snapshot_assets(self, data="", enable_image_strength=False, enable_prompt=False, image_strength_config="", enable_slot=False, slot_config="", enable_image=True, enable_video=True, unique_id=None):
        # data contains the tldraw snapshot JSON string
        canvas_snapshot = None
        try:
            if data and data.strip():
                # Validate it's a proper JSON
                parsed = json.loads(data.strip())
                if isinstance(parsed, dict):
                    canvas_snapshot = data.strip()
                    print(f"[SnapshotAssets] Loaded tldraw snapshot")
        except Exception as e:
            print(f"[SnapshotAssets] Failed to parse data: {e}")
        
        server = SnapshotAssetsServer(input_data=data, canvas_snapshot=canvas_snapshot, node_id=unique_id, enable_image_strength=enable_image_strength, enable_prompt=enable_prompt, image_strength_config=image_strength_config, enable_slot=enable_slot, slot_config=slot_config, enable_image=enable_image, enable_video=enable_video)
        server_thread = threading.Thread(target=server.start)
        server_thread.daemon = True
        server_thread.start()

        start_time = time.time()
        while not server.started:
            try:
                mm.throw_exception_if_processing_interrupted()
            except Exception as e:
                if "interrupt" in str(e).lower() or "processing" in str(e).lower():
                    print(f"[SnapshotAssets] Interrupted during startup: {e}")
                    server.stop()
                    raise RuntimeError("[SnapshotAssets] Interrupted during startup")
                raise
            if check_interrupted():
                print("[SnapshotAssets] Interrupted during startup!")
                server.stop()
                raise RuntimeError("[SnapshotAssets] Interrupted during startup")
            if time.time() - start_time > 10:
                raise RuntimeError("[SnapshotAssets] Server startup timeout")
            time.sleep(0.01)

        print(f"[SnapshotAssets] Opening browser at: {server.browser_url}")
        webbrowser.open(server.browser_url)

        if not server.wait_for_confirm():
            print("[SnapshotAssets] Interrupted or timed out")
            server.stop()
            raise RuntimeError("[SnapshotAssets] Interrupted or timed out")
        server.stop()

        selected_images = server.selected_images
        selected_videos = server.selected_videos if hasattr(server, 'selected_videos') else []
        selected_slots = server.selected_slots if hasattr(server, 'selected_slots') else []
        prompt = server.prompt if server.prompt is not None else ''
        
        print(f"[SnapshotAssets] After confirm: {len(selected_images)} images, {len(selected_videos)} videos, {len(selected_slots)} slots")
        for vid in selected_videos:
            print(f"[SnapshotAssets]   Selected video: {vid}")
        
        # Allow empty selection - return empty list if no images/videos selected
        if not selected_images and not selected_videos and not selected_slots:
            print("[SnapshotAssets] No images, videos or slots selected, returning empty lists")
            return (prompt, [], [], [], [])

        # Process images
        images = []
        # Parse strength definitions from image_strength_config: "name:default,name:default"
        strength_defs = []
        if image_strength_config:
            for part in image_strength_config.split(','):
                part = part.strip()
                if not part:
                    continue
                if ':' in part:
                    name, default_str = part.split(':', 1)
                    name = name.strip()
                    try:
                        default_val = float(default_str.strip())
                    except ValueError:
                        default_val = 0.0
                else:
                    name = part
                    default_val = 0.0
                if name:
                    strength_defs.append({'name': name, 'default': default_val})
        if enable_image_strength and not strength_defs:
            strength_defs = [{'name': 'strength0', 'default': 0.0}]

        strength_names = [d['name'] for d in strength_defs]
        strength_defaults_map = {d['name']: d['default'] for d in strength_defs}

        # Initialize strengths as 2D list: each inner list is one named strength across all images
        strengths_2d = [[] for _ in strength_names] if enable_image_strength and strength_names else []

        for img_data in selected_images:
            try:
                if isinstance(img_data, dict):
                    image_url = img_data.get('image', '')
                    tensor = self._decode_image_data(image_url)
                    images.append(tensor)
                    if enable_image_strength and strength_names:
                        # Get strengths dict from frontend
                        strengths_dict = img_data.get('strengths', {})
                        for idx, name in enumerate(strength_names):
                            if isinstance(strengths_dict, dict) and name in strengths_dict:
                                val = float(strengths_dict[name])
                            else:
                                val = strength_defaults_map.get(name, 0.0)
                            strengths_2d[idx].append(val)
                else:
                    tensor = self._decode_image_data(img_data)
                    images.append(tensor)
                    if enable_image_strength and strength_names:
                        for idx, name in enumerate(strength_names):
                            strengths_2d[idx].append(strength_defaults_map.get(name, 0.0))
            except Exception as e:
                print(f"[SnapshotAssets] Failed to decode image: {e}")
                raise RuntimeError(f"[SnapshotAssets] Failed to decode image: {e}")

        # Process videos (video URLs from frontend, convert to file paths for VideoFromFile)
        videos = []
        # Get asset_cache_dir from server instance
        asset_cache_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "assets")
        
        print(f"[SnapshotAssets] Processing {len(selected_videos)} video items")
        for vid_data in selected_videos:
            try:
                video_url = None
                if isinstance(vid_data, dict):
                    video_url = vid_data.get('video', '')
                elif isinstance(vid_data, str):
                    video_url = vid_data
                
                if not video_url:
                    print(f"[SnapshotAssets] Skipping empty video URL")
                    continue
                    
                print(f"[SnapshotAssets] Processing video URL: {video_url[:100]}...")
                
                # Convert URL to file path
                if video_url.startswith('/assets/'):
                    filename = os.path.basename(video_url)
                    video_path = os.path.join(asset_cache_dir, filename)
                    print(f"[SnapshotAssets] Converted URL to path: {video_path}")
                else:
                    video_path = video_url
                
                # Check if file exists
                if not os.path.exists(video_path):
                    print(f"[SnapshotAssets] Warning: Video file does not exist: {video_path}")
                    continue
                
                # Create VideoFromFile object
                print(f"[SnapshotAssets] Creating VideoFromFile for: {video_path}")
                video_obj = InputImpl.VideoFromFile(video_path)
                videos.append(video_obj)
                print(f"[SnapshotAssets] Successfully loaded video: {video_path}")
            except Exception as e:
                print(f"[SnapshotAssets] Failed to load video: {e}")
                import traceback
                traceback.print_exc()
                # Skip failed videos

        print(f"[SnapshotAssets] Output {len(images)} images, {len(videos)} videos, {len(strengths_2d)} strength arrays, prompt: '{prompt[:50] if prompt else '(empty)'}'")
        
        # Debug: Verify video objects
        for i, vid in enumerate(videos):
            print(f"[SnapshotAssets] Video[{i}]: type={type(vid).__name__}, repr={repr(vid)[:200]}")
        
        # Process slots if enabled
        slot_outputs = []
        if enable_slot and selected_slots:
            print(f"[SnapshotAssets] Processing {len(selected_slots)} slot items")
            for slot_item in selected_slots:
                slot_type = slot_item.get('type', '')
                slot_data = slot_item.get('data')
                
                if slot_data is None:
                    # Empty slot - output None
                    slot_outputs.append(None)
                    print(f"[SnapshotAssets] Slot output: None (empty)")
                    continue
                
                try:
                    if slot_type == 'Image':
                        image_url = slot_data.get('image', '')
                        tensor = self._decode_image_data(image_url)
                        slot_outputs.append(tensor)
                        print(f"[SnapshotAssets] Slot output: Image tensor")
                    elif slot_type == 'Video':
                        video_url = slot_data.get('video', '')
                        if video_url.startswith('/assets/'):
                            filename = os.path.basename(video_url)
                            video_path = os.path.join(asset_cache_dir, filename)
                        else:
                            video_path = video_url
                        video_obj = InputImpl.VideoFromFile(video_path)
                        slot_outputs.append(video_obj)
                        print(f"[SnapshotAssets] Slot output: VideoFromFile")
                    else:
                        slot_outputs.append(None)
                except Exception as e:
                    print(f"[SnapshotAssets] Failed to process slot item: {e}")
                    slot_outputs.append(None)
        
        print(f"[SnapshotAssets] Final output: {len(images)} images, {len(videos)} videos, {len(slot_outputs)} slots")
        return (prompt, images, strengths_2d, videos, slot_outputs)
