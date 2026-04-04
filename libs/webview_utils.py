import threading
import os
import tempfile
import base64
import time
import json
import webview

class SnapshotWebView:
    """PyWebView wrapper for snapshot nodes with built-in HTTP server-like functionality"""

    def __init__(self, title="Snapshot", width=800, height=600):
        self.title = title
        self.width = width
        self.height = height
        self.html_content = None
        self.image_data = None
        self.result = None
        self.window_closed = False
        self.ready_event = threading.Event()
        self.selection_done = threading.Event()
        self._window = None
        self._bridge_functions = {}

    def set_html(self, html_content):
        """Set the HTML content directly"""
        self.html_content = html_content
        return self

    def set_image_data(self, image_data):
        """Set image data (numpy array or PIL Image) to be embedded in HTML"""
        from PIL import Image
        import numpy as np

        if isinstance(image_data, np.ndarray):
            # Convert numpy array to PIL Image
            if image_data.dtype != np.uint8:
                image_data = (image_data * 255).astype(np.uint8)
            if image_data.shape[2] == 4:  # RGBA
                image_data = image_data[:, :, :3]  # Remove alpha
            image = Image.fromarray(image_data)
        elif isinstance(image_data, Image.Image):
            image = image_data
        else:
            raise ValueError(f"Unsupported image data type: {type(image_data)}")

        # Convert to base64
        buffer = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        image.save(buffer.name, 'PNG')
        buffer.close()

        with open(buffer.name, 'rb') as f:
            img_base64 = base64.b64encode(f.read()).decode('utf-8')

        os.unlink(buffer.name)
        self.image_data = f"data:image/png;base64,{img_base64}"
        return self

    def expose_function(self, name, callback):
        """Expose a Python function to JavaScript"""
        self._bridge_functions[name] = callback
        return self

    def start(self):
        """Start the webview window in a separate thread"""
        thread = threading.Thread(target=self._run_window)
        thread.daemon = True
        thread.start()
        return self

    def _run_window(self):
        """Run the webview window (called in separate thread)"""
        try:
            if self.html_content:
                # Create temp HTML file
                with tempfile.NamedTemporaryFile(mode='w', suffix='.html', delete=False, encoding='utf-8') as f:
                    f.write(self.html_content)
                    html_file = f.name
                    self.url = f"file:///{html_file.replace(os.sep, '/')}"

                self._window = webview.create_window(
                    self.title,
                    html_file,
                    width=self.width,
                    height=self.height,
                    resizable=True,
                    debug=False
                )
            else:
                self.url = None
                html_file = None

            # Create a dict to hold results that can be modified by the callback
            window_data = {"result": None, "closed": False}

            def on_closed():
                self.window_closed = True
                window_data["closed"] = True
                self.selection_done.set()

            def on_load():
                self.ready_event.set()

            webview.start(on_load, self._window)
            on_closed()

        except Exception as e:
            print(f"[SnapshotWebView] Error: {e}")
            self.window_closed = True
            self.selection_done.set()

    def wait_for_ready(self, timeout=10):
        """Wait for window to be ready"""
        return self.ready_event.wait(timeout)

    def wait_for_selection(self, timeout=None):
        """Wait for user to complete selection"""
        return self.selection_done.wait(timeout)

    def close(self):
        """Close the window"""
        if self._window:
            try:
                self._window.destroy()
            except:
                pass

    def set_result(self, result):
        """Set the result and signal completion"""
        self.result = result
        self.selection_done.set()


class ImageSnapshotWebView(SnapshotWebView):
    """Specialized webview for image snapshot selection"""

    def __init__(self, image, width=512, height=512, title="Image Selection"):
        super().__init__(title=title, width=width or 800, height=height or 600)

        self.image = image
        self.selected_image = None
        self.image_path = None

        # Set up the image data
        self.set_image_data(image)

    def create_html(self, template_name='image_snapshot'):
        """Create HTML for image snapshot selection"""
        return f'''<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{self.title}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            background: #1a1a1a;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }}
        #imageContainer {{
            position: relative;
            flex: 1;
            min-height: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 20px;
        }}
        #image {{
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            display: block;
        }}
        #status {{
            position: absolute;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.7);
            padding: 8px 16px;
            border-radius: 4px;
            color: #fff;
            font-size: 12px;
            z-index: 50;
        }}
        .instructions {{
            position: absolute;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.7);
            padding: 8px 16px;
            border-radius: 4px;
            color: #fff;
            font-size: 12px;
            z-index: 50;
        }}
        .screenshot-area-indicator {{
            position: absolute;
            top: 0;
            left: 0;
            z-index: 40;
        }}
        .screenshot-area-indicator .indicator-border {{
            border: 2px solid rgba(255, 255, 255, 0.5);
            box-shadow: 0 0 0 2px rgba(0, 122, 255, 0.3);
            position: relative;
        }}
        .screenshot-area-indicator .indicator-label {{
            position: absolute;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 122, 255, 0.8);
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            white-space: nowrap;
            margin-bottom: 8px;
        }}
    </style>
</head>
<body>
    <div id="imageContainer">
        <img id="image" src="{self.image_data}" alt="Image">
        <div id="status">Loading...</div>
        <div class="instructions">Press <strong>Ctrl</strong> to drag/resize selection, then press <strong>Enter</strong> to confirm</div>
        <div id="screenshotAreaIndicator" class="screenshot-area-indicator">
            <div class="indicator-border"></div>
            <div class="indicator-label"><span class="label-text"></span></div>
        </div>
    </div>
    <script>
        let image = document.getElementById('image');
        let imageContainer = document.getElementById('imageContainer');
        let status = document.getElementById('status');
        let screenshotWidth = {self.width};
        let screenshotHeight = {self.height};
        let isDragging = false;
        let isResizing = false;
        let ctrlKeyPressed = false;

        function updateIndicator() {{
            const indicator = document.getElementById('screenshotAreaIndicator');
            const border = indicator.querySelector('.indicator-border');
            const imageRect = image.getBoundingClientRect();
            const containerRect = imageContainer.getBoundingClientRect();
            const left = (imageRect.left + (imageRect.width - screenshotWidth) / 2) - containerRect.left;
            const top = (imageRect.top + (imageRect.height - screenshotHeight) / 2) - containerRect.top;
            indicator.style.left = left + 'px';
            indicator.style.top = top + 'px';
            border.style.width = screenshotWidth + 'px';
            border.style.height = screenshotHeight + 'px';
            indicator.querySelector('.label-text').textContent = screenshotWidth + ' x ' + screenshotHeight;
        }}

        function captureSelection() {{
            const canvas = document.createElement('canvas');
            canvas.width = screenshotWidth;
            canvas.height = screenshotHeight;
            const ctx = canvas.getContext('2d');
            const scaleX = image.naturalWidth / image.getBoundingClientRect().width;
            const scaleY = image.naturalHeight / image.getBoundingClientRect().height;
            const imageRect = image.getBoundingClientRect();
            const containerRect = imageContainer.getBoundingClientRect();
            const indicator = document.getElementById('screenshotAreaIndicator');
            const border = indicator.getBoundingClientRect();
            const srcX = Math.round((border.left - imageRect.left) * scaleX);
            const srcY = Math.round((border.top - imageRect.top) * scaleY);
            ctx.drawImage(image, srcX, srcY, screenshotWidth * scaleX, screenshotHeight * scaleY, 0, 0, screenshotWidth, screenshotHeight);
            window.pywebview.api.set_result({{
                'image': canvas.toDataURL('image/png'),
                'width': screenshotWidth,
                'height': screenshotHeight
            }});
        }}

        document.addEventListener('keydown', (e) => {{
            if (e.key === 'Control') ctrlKeyPressed = true;
            if (e.key === 'Enter') captureSelection();
        }});
        document.addEventListener('keyup', (e) => {{
            if (e.key === 'Control') ctrlKeyPressed = false;
        }});
        window.addEventListener('load', () => {{
            updateIndicator();
            status.textContent = 'Ready: Press Ctrl to drag/resize, Enter to confirm';
        }});
        window.addEventListener('resize', updateIndicator);
    </script>
</body>
</html>'''

    def start_and_wait(self):
        """Start the webview and wait for selection"""
        self.html_content = self.create_html()
        self.expose_function('set_result', self._on_result)
        self.start()
        self.wait_for_selection()
        return self.selected_image, self.image_path

    def _on_result(self, result):
        """Callback when user makes a selection"""
        self.selected_image = result
        self.selection_done.set()


def create_image_snapshot_window(image, width=512, height=512):
    """Create an image snapshot window and wait for user selection"""
    from PIL import Image
    import numpy as np
    import torch

    # Convert tensor to numpy if needed
    if isinstance(image, torch.Tensor):
        image = image.cpu().numpy()
        if image.ndim == 4:
            image = image[0]  # Remove batch dimension
        image = (image * 255).astype(np.uint8)

    webview_window = ImageSnapshotWebView(image, width, height)
    webview_window.start()
    webview_window.wait_for_selection()

    if webview_window.selected_image:
        # Decode base64 image
        img_data = webview_window.selected_image['image'].split(',')[1]
        img_bytes = base64.b64decode(img_data)
        img = Image.open(io.BytesIO(img_bytes))
        img_array = np.array(img).astype(np.float32) / 255.0
        if img_array.ndim == 3:
            img_array = np.expand_dims(img_array, axis=0)
        return torch.from_numpy(img_array), webview_window.image_path

    return None, None


# Import for image decoding
import io
