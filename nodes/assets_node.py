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


def parse_image_config(config_str):
    """Parse image config string into list of dicts.
    
    Format: name:type:default(min,max,step),name:type:default,...
    Types: Float, Int, Boolean, String
    Only Float/Int have (min,max,step); omitted defaults to (0.0,1.0,0.01) for Float, (0,1024,1) for Int.
    """
    import re
    defs = []
    if not config_str:
        return defs
    for part in config_str.split(','):
        part = part.strip()
        if not part:
            continue
        # Match: name:type:value(optional params)
        m = re.match(r'^(\w+):(Float|Int|Boolean|String):(.+?)(\(([^)]*)\))?$', part)
        if not m:
            continue
        name = m.group(1)
        val_type = m.group(2)
        value_str = m.group(3).strip()
        params_str = m.group(5)  # may be None
        
        entry = {'name': name, 'type': val_type}
        
        if val_type == 'Float':
            try:
                entry['default'] = float(value_str)
            except ValueError:
                entry['default'] = 0.0
            if params_str:
                p = [s.strip() for s in params_str.split(',')]
                entry['min'] = float(p[0]) if len(p) > 0 and p[0] else 0.0
                entry['max'] = float(p[1]) if len(p) > 1 and p[1] else 1.0
                entry['step'] = float(p[2]) if len(p) > 2 and p[2] else 0.01
            else:
                entry['min'] = 0.0
                entry['max'] = 1.0
                entry['step'] = 0.01
        elif val_type == 'Int':
            try:
                entry['default'] = int(value_str)
            except ValueError:
                entry['default'] = 0
            if params_str:
                p = [s.strip() for s in params_str.split(',')]
                entry['min'] = int(p[0]) if len(p) > 0 and p[0] else 0
                entry['max'] = int(p[1]) if len(p) > 1 and p[1] else 1024
                entry['step'] = int(p[2]) if len(p) > 2 and p[2] else 1
            else:
                entry['min'] = 0
                entry['max'] = 1024
                entry['step'] = 1
        elif val_type == 'Boolean':
            entry['default'] = value_str.lower() in ('true', '1', 'yes')
        elif val_type == 'String':
            entry['default'] = value_str
        
        defs.append(entry)
    return defs


class SnapshotAssetsServer:
    """HTTP server for SnapshotAssetsNode to let user drag/drop images and confirm selection."""

    def __init__(self, input_data="", canvas_snapshot=None, node_id=None, enable_image_config=False, enable_prompt=False, image_config="", enable_slot=False, slot_config="", enable_image=True, enable_video=True, enable_audio=True, global_mode=False):
        self.port = None
        self.server = None
        self.started = False
        self.confirm_event = threading.Event()
        self.window_closed = False
        self.browser_url = None
        self.selected_images = []
        self.selected_videos = []
        self.selected_slots = []
        self.prompt = ""
        self.input_data = input_data
        self.canvas_snapshot = canvas_snapshot
        self.node_id = node_id
        self.enable_image_config = enable_image_config
        self.enable_prompt = enable_prompt
        self.image_config = image_config
        self.enable_slot = enable_slot
        self.slot_config = slot_config
        self.enable_image = enable_image
        self.enable_video = enable_video
        self.enable_audio = enable_audio
        self.global_mode = global_mode
        self.should_stop = False
        self.asset_cache_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "assets")
        os.makedirs(self.asset_cache_dir, exist_ok=True)
        # Snapshot save directory for global_mode
        self.snapshot_cache_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "snapshots")
        os.makedirs(self.snapshot_cache_dir, exist_ok=True)

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

    def save_base64_audio(self, data_url):
        """Save base64 audio to cache directory and return URL path."""
        try:
            if ',' in data_url:
                header, base64_data = data_url.split(',', 1)
            else:
                base64_data = data_url
                header = "data:audio/mpeg;base64"

            ext = ".mp3"
            if "audio/flac" in header:
                ext = ".flac"
            elif "audio/mpeg" in header or "audio/mp3" in header:
                ext = ".mp3"
            elif "audio/wav" in header or "audio/wave" in header or "audio/x-wav" in header:
                ext = ".wav"
            elif "audio/ogg" in header:
                ext = ".ogg"
            elif "audio/mp4" in header or "audio/m4a" in header or "audio/x-m4a" in header:
                ext = ".m4a"
            elif "audio/aac" in header:
                ext = ".aac"
            elif "video/mp4" in header:
                ext = ".mp4"

            filename = hashlib.md5(base64_data.encode()).hexdigest() + ext
            filepath = os.path.join(self.asset_cache_dir, filename)

            if not os.path.exists(filepath):
                audio_bytes = base64.b64decode(base64_data)
                with open(filepath, 'wb') as f:
                    f.write(audio_bytes)
                print(f"[SnapshotAssets] Saved audio to: {filepath}")

            return f"/assets/{filename}"
        except Exception as e:
            print(f"[SnapshotAssets] Failed to save audio: {e}")
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
                # Parse image_config into list of config defs
                image_config_defs = []
                if self.server_instance and self.server_instance.image_config:
                    image_config_defs = parse_image_config(self.server_instance.image_config)
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
                            if slot_type in ('Image', 'Video', 'Audio') and slot_name:
                                slot_defs.append({'type': slot_type, 'name': slot_name})
                
                data = {
                    'input_data': self.server_instance.input_data if self.server_instance else '',
                    'canvas_snapshot': self.server_instance.canvas_snapshot if self.server_instance else None,
                    'enable_image_config': self.server_instance.enable_image_config if self.server_instance else False,
                    'enable_prompt': self.server_instance.enable_prompt if self.server_instance else False,
                    'image_config_defs': image_config_defs,
                    'enable_slot': self.server_instance.enable_slot if self.server_instance else False,
                    'enable_image': self.server_instance.enable_image if self.server_instance else True,
                    'enable_video': self.server_instance.enable_video if self.server_instance else True,
                    'enable_audio': self.server_instance.enable_audio if self.server_instance else True,
                    'global_mode': self.server_instance.global_mode if self.server_instance else False,
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
                        elif ext in ['.flac', '.mp3', '.wav', '.ogg', '.m4a', '.aac']:
                            if ext == '.flac': content_type = 'audio/flac'
                            elif ext == '.mp3': content_type = 'audio/mpeg'
                            elif ext == '.wav': content_type = 'audio/wav'
                            elif ext == '.ogg': content_type = 'audio/ogg'
                            elif ext == '.m4a': content_type = 'audio/mp4'
                            elif ext == '.aac': content_type = 'audio/aac'

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
                    selected_audios_data = data.get('audios', [])
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
                                            url = self.server_instance.save_base64_video(data_url)
                                            if url:
                                                panel_vid['dataUrl'] = url
                                        elif isinstance(data_url, str) and not data_url.startswith('/assets/'):
                                            if os.path.isabs(data_url):
                                                filename = os.path.basename(data_url)
                                                panel_vid['dataUrl'] = f"/assets/{filename}"
                            # Process panelAudios - convert base64 dataUrl to URL paths
                            if 'panelAudios' in snapshot and isinstance(snapshot['panelAudios'], list):
                                for panel_aud in snapshot['panelAudios']:
                                    if isinstance(panel_aud, dict) and 'dataUrl' in panel_aud:
                                        data_url = panel_aud['dataUrl']
                                        if isinstance(data_url, str) and data_url.startswith('data:'):
                                            url = self.server_instance.save_base64_audio(data_url)
                                            if url:
                                                panel_aud['dataUrl'] = url
                                        elif isinstance(data_url, str) and not data_url.startswith('/assets/'):
                                            if os.path.isabs(data_url):
                                                filename = os.path.basename(data_url)
                                                panel_aud['dataUrl'] = f"/assets/{filename}"
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
                            # Support image_infos dict (new) and legacy strengths dict
                            if 'image_infos' in img_data and img_data['image_infos'] is not None:
                                item['image_infos'] = img_data['image_infos']
                            elif 'strengths' in img_data and img_data['strengths'] is not None:
                                item['image_infos'] = img_data['strengths']
                            elif 'strength' in img_data and img_data['strength'] is not None:
                                item['image_infos'] = {'strength': img_data['strength']}
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
                    
                    # Convert selected audios
                    selected_audio_items = []
                    print(f"[SnapshotAssets] Received {len(selected_audios_data)} audio items from frontend")
                    for aud_data in selected_audios_data:
                        if isinstance(aud_data, dict) and 'audio' in aud_data:
                            audio_url = aud_data['audio']
                            if audio_url.startswith('data:'):
                                url = self.server_instance.save_base64_audio(audio_url)
                                if url:
                                    audio_url = url
                            elif not audio_url.startswith('/assets/') and os.path.isabs(audio_url):
                                filename = os.path.basename(audio_url)
                                audio_url = f"/assets/{filename}"
                            selected_audio_items.append({"audio": audio_url})
                        elif isinstance(aud_data, str):
                            if aud_data.startswith('data:'):
                                url = self.server_instance.save_base64_audio(aud_data)
                                if url:
                                    selected_audio_items.append({"audio": url})
                                else:
                                    selected_audio_items.append({"audio": aud_data})
                            elif aud_data.startswith('/assets/'):
                                selected_audio_items.append({"audio": aud_data})
                            elif os.path.isabs(aud_data):
                                filename = os.path.basename(aud_data)
                                selected_audio_items.append({"audio": f"/assets/{filename}"})
                            else:
                                selected_audio_items.append({"audio": aud_data})

                    print(f"[SnapshotAssets] Final selected_audio_items: {len(selected_audio_items)} items")
                    
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
                            elif slot_type == 'Audio':
                                # Process audio slot data
                                if isinstance(slot_data, dict) and 'audio' in slot_data:
                                    audio_url = slot_data['audio']
                                elif isinstance(slot_data, str):
                                    audio_url = slot_data
                                else:
                                    audio_url = str(slot_data)
                                
                                if audio_url.startswith('data:'):
                                    url = self.server_instance.save_base64_audio(audio_url)
                                    if url:
                                        audio_url = url
                                elif audio_url.startswith('/assets/'):
                                    pass  # Already a URL
                                elif os.path.isabs(audio_url):
                                    filename = os.path.basename(audio_url)
                                    audio_url = f"/assets/{filename}"
                                
                                selected_slot_items.append({'type': 'Audio', 'data': {'audio': audio_url}})
                                print(f"[SnapshotAssets]   Slot Audio: {audio_url[:80]}...")
                            else:
                                selected_slot_items.append({'type': slot_type, 'data': slot_data})
                    
                    self.server_instance.selected_images = selected_image_items
                    self.server_instance.selected_videos = selected_video_items
                    self.server_instance.selected_audios = selected_audio_items
                    self.server_instance.selected_slots = selected_slot_items
                    prompt_value = data.get('prompt', '')
                    print(f"[SnapshotAssets] Received prompt: '{prompt_value}'")
                    self.server_instance.prompt = prompt_value if prompt_value is not None else ''
                    self.server_instance.canvas_snapshot = canvas_snapshot
                    
                    # Save tldraw snapshot
                    if self.server_instance.global_mode and canvas_snapshot and self.server_instance.input_data.strip():
                        # global_mode: save snapshot to disk using data as name
                        snap_dir = self.server_instance.snapshot_cache_dir
                        snap_name = self.server_instance.input_data.strip()
                        snap_path = os.path.join(snap_dir, f"{snap_name}.json")
                        with open(snap_path, 'w', encoding='utf-8') as f:
                            f.write(canvas_snapshot)
                        print(f"[SnapshotAssets] Saved snapshot to disk: {snap_path}")
                    elif self.server_instance.node_id and canvas_snapshot:
                        # Normal mode: save snapshot to data widget
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
                
                # Normalize audio extensions
                ext_lower = ext.lower()
                if ext_lower in ('.flac', '.mp3', '.wav', '.ogg', '.m4a', '.aac'):
                    ext = ext_lower
                
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
                "global_mode": ("BOOLEAN", {"default": False}),
                "enable_prompt": ("BOOLEAN", {"default": False}),
                "enable_image": ("BOOLEAN", {"default": True}),
                "enable_image_config": ("BOOLEAN", {"default": False}),
                "image_config": ("STRING", {"default": "test0:Float:1.0(0.0,1.0,0.1),test1:Float:0.5(0.0,1.0,0.1)", "multiline": False}),
                "enable_video": ("BOOLEAN", {"default": True}),
                "enable_audio": ("BOOLEAN", {"default": True}),
                "enable_slot": ("BOOLEAN", {"default": False}),
                "slot_config": ("STRING", {"default": "Image:slot0,Video:slot1", "multiline": False}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE", "*", "VIDEO", "AUDIO", "*")
    RETURN_NAMES = ("prompt", "image", "image_infos", "video", "audio", "slot")
    OUTPUT_IS_LIST = (False, True, True, True, True, True)
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

    def snapshot_assets(self, data="", enable_image_config=False, enable_prompt=False, image_config="", enable_slot=False, slot_config="", enable_image=True, enable_video=True, enable_audio=True, global_mode=False, unique_id=None):
        # data contains the tldraw snapshot JSON string (normal mode) or a name (global_mode)
        canvas_snapshot = None
        if global_mode and data and data.strip():
            # global_mode: load snapshot from disk using data as name
            snap_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data", "snapshots")
            snap_path = os.path.join(snap_dir, f"{data.strip()}.json")
            if os.path.exists(snap_path):
                with open(snap_path, 'r', encoding='utf-8') as f:
                    canvas_snapshot = f.read()
                print(f"[SnapshotAssets] Loaded snapshot from disk: {snap_path}")
            else:
                print(f"[SnapshotAssets] Snapshot file not found: {snap_path}, starting fresh")
        elif data and data.strip():
            # Normal mode: parse data as snapshot JSON
            try:
                parsed = json.loads(data.strip())
                if isinstance(parsed, dict):
                    canvas_snapshot = data.strip()
                    print(f"[SnapshotAssets] Loaded tldraw snapshot")
            except Exception as e:
                print(f"[SnapshotAssets] Failed to parse data: {e}")
        
        server = SnapshotAssetsServer(input_data=data, canvas_snapshot=canvas_snapshot, node_id=unique_id, enable_image_config=enable_image_config, enable_prompt=enable_prompt, image_config=image_config, enable_slot=enable_slot, slot_config=slot_config, enable_image=enable_image, enable_video=enable_video, enable_audio=enable_audio, global_mode=global_mode)
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
        selected_audios = server.selected_audios if hasattr(server, 'selected_audios') else []
        selected_slots = server.selected_slots if hasattr(server, 'selected_slots') else []
        prompt = server.prompt if server.prompt is not None else ''
        
        print(f"[SnapshotAssets] After confirm: {len(selected_images)} images, {len(selected_videos)} videos, {len(selected_audios)} audios, {len(selected_slots)} slots")
        
        # Allow empty selection
        if not selected_images and not selected_videos and not selected_audios and not selected_slots:
            print("[SnapshotAssets] No images, videos, audios or slots selected, returning empty lists")
            return (prompt, [], [], [], [], [])

        # Process images
        images = []
        # Parse image config definitions
        # Parse image config
        config_defs = parse_image_config(image_config)
        if enable_image_config and not config_defs:
            config_defs = [{'name': 'config0', 'type': 'Float', 'default': 0.0, 'min': 0.0, 'max': 1.0, 'step': 0.01}]
        config_defaults_map = {d['name']: d['default'] for d in config_defs}

        # Collect image_infos as list of dicts
        image_infos_list = []

        for img_data in selected_images:
            try:
                if isinstance(img_data, dict):
                    image_url = img_data.get('image', '')
                    tensor = self._decode_image_data(image_url)
                    images.append(tensor)
                    if enable_image_config and config_defs:
                        infos_dict = img_data.get('image_infos', img_data.get('strengths', {}))
                        info_item = {}
                        for d in config_defs:
                            name = d['name']
                            if isinstance(infos_dict, dict) and name in infos_dict:
                                val = infos_dict[name]
                                # Cast to correct type
                                if d['type'] == 'Float':
                                    val = float(val)
                                elif d['type'] == 'Int':
                                    val = int(val)
                                elif d['type'] == 'Boolean':
                                    val = bool(val)
                                info_item[name] = val
                            else:
                                info_item[name] = config_defaults_map.get(name, d['default'])
                        image_infos_list.append(info_item)
                else:
                    tensor = self._decode_image_data(img_data)
                    images.append(tensor)
                    if enable_image_config and config_defs:
                        info_item = {}
                        for d in config_defs:
                            info_item[d['name']] = config_defaults_map.get(d['name'], d['default'])
                        image_infos_list.append(info_item)
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

        print(f"[SnapshotAssets] Output {len(images)} images, {len(image_infos_list)} image_infos, {len(videos)} videos, prompt: '{prompt[:50] if prompt else '(empty)'}'")
        
        # Debug: Verify video objects
        for i, vid in enumerate(videos):
            print(f"[SnapshotAssets] Video[{i}]: type={type(vid).__name__}, repr={repr(vid)[:200]}")
        
        # Process audios
        audios = []
        print(f"[SnapshotAssets] Processing {len(selected_audios)} audio items")
        for aud_data in selected_audios:
            try:
                audio_url = None
                if isinstance(aud_data, dict):
                    audio_url = aud_data.get('audio', '')
                elif isinstance(aud_data, str):
                    audio_url = aud_data
                
                if not audio_url:
                    continue
                
                if audio_url.startswith('/assets/'):
                    filename = os.path.basename(audio_url)
                    audio_path = os.path.join(asset_cache_dir, filename)
                else:
                    audio_path = audio_url
                
                if not os.path.exists(audio_path):
                    print(f"[SnapshotAssets] Warning: Audio file does not exist: {audio_path}")
                    continue
                
                from ..libs.audio_utils import load_audio_from_any_file
                audio_obj = load_audio_from_any_file(audio_path)
                audios.append(audio_obj)
                print(f"[SnapshotAssets] Successfully loaded audio: {audio_path}")
            except Exception as e:
                print(f"[SnapshotAssets] Failed to load audio: {e}")
                import traceback
                traceback.print_exc()
        
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
                    elif slot_type == 'Audio':
                        audio_url = slot_data.get('audio', '')
                        if audio_url.startswith('/assets/'):
                            filename = os.path.basename(audio_url)
                            audio_path = os.path.join(asset_cache_dir, filename)
                        else:
                            audio_path = audio_url
                        if not os.path.exists(audio_path):
                            print(f"[SnapshotAssets] Warning: Slot audio file not found: {audio_path}")
                            slot_outputs.append(None)
                            continue
                        from ..libs.audio_utils import load_audio_from_any_file
                        audio_obj = load_audio_from_any_file(audio_path)
                        slot_outputs.append(audio_obj)
                        print(f"[SnapshotAssets] Slot output: Audio")
                    else:
                        slot_outputs.append(None)
                except Exception as e:
                    print(f"[SnapshotAssets] Failed to process slot item: {e}")
                    slot_outputs.append(None)
        
        print(f"[SnapshotAssets] Final output: {len(images)} images, {len(videos)} videos, {len(audios)} audios, {len(slot_outputs)} slots")
        return (prompt, images, image_infos_list, videos, audios, slot_outputs)
