"""节点 Web UI 的打开方式接管:优先注入 Kolid Client,客户端不在时回退系统浏览器。

用法(替换各节点里的 `webbrowser.open(server.browser_url)`):

    from ...libs.client_host import open_ui
    open_ui(server.browser_url)                # 标题从页面名自动推断
    open_ui(url, title='Snapshot Switch')      # 显式标题

KolidUI(client/kolid_client.py 打包的 Kolid Desktop.exe)启动后会在
~/.kolid_comfy/client.json 写入发现信息;本模块探测其存活后把页面 POST 给它注入为
标签页。任何一步失败(文件不存在/进程死了/超时)都静默回退 webbrowser.open,
行为与没有这个客户端时完全一致。
"""
import json
import os
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

DISCOVERY_FILE = Path.home() / '.kolid_comfy' / 'client.json'

# 常见页面名 → 标签页标题
TITLE_BY_PAGE = {
    'sampler_node.html': 'Detailer Sampler',
    'blend_node.html': 'Blend Workbench',
    'prompt_node.html': 'Prompt Selector',
    'assets_node.html': 'Assets Canvas',
    'switch_node.html': 'Snapshot Switch',
    'region_node.html': 'Region Editor',
    'mask_node.html': 'Mask Painter',
    'outpaint_mask_node.html': 'Outpaint Mask',
    'image_node.html': 'Image Picker',
    'image_points.html': 'SAM Points',
    'video_node.html': 'Video Timestamp',
    'gaussian_node.html': '3D Gaussian',
    'draw_node.html': 'Draw',
    'image_preview.html': 'Image Preview',
}


def _guess_title(url: str) -> str:
    page = url.rsplit('/', 1)[-1].split('?')[0]
    return TITLE_BY_PAGE.get(page) or page


def _try_client(url: str, title: str) -> bool:
    """把页面交给 KolidUI 客户端。成功返回 True;任何失败返回 False(不抛错)。"""
    try:
        info = json.loads(DISCOVERY_FILE.read_text(encoding='utf-8'))
        port = int(info['port'])
        pid = int(info.get('pid') or 0)
    except Exception:
        return False

    # 发现文件可能是陈旧的:进程死了就直接放弃(不再等超时)
    if pid and os.name == 'nt':
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return False
            kernel32.CloseHandle(handle)
        except Exception:
            pass

    try:
        # 先快探存活(客户端可能刚被杀,文件还没删)
        req = urllib.request.Request(f'http://127.0.0.1:{port}/ping')
        urllib.request.urlopen(req, timeout=0.25)
        body = json.dumps({'url': url, 'title': title}, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(
            f'http://127.0.0.1:{port}/open', data=body, method='POST',
            headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=1.0)
        return True
    except Exception:
        return False


def open_ui(url: str, title: str = None) -> None:
    """打开节点 UI:Kolid Client 在跑就注入其标签页,否则用系统浏览器。永不抛错。"""
    title = title or _guess_title(url)
    started = time.time()
    if _try_client(url, title):
        print(f'[kolid] {title} injected into KolidUI ({time.time() - started:.2f}s)')
        return
    print(f'[kolid] KolidUI not found, opening in browser: {url}')
    try:
        webbrowser.open(url)
    except Exception as e:
        print(f'[kolid] webbrowser.open failed: {e}', file=sys.stderr)
