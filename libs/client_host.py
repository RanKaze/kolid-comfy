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
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

DISCOVERY_FILE = Path.home() / '.kolid_comfy' / 'client.json'

# 等待预算（秒）。桌面是 onefile 打包：先解压再起 WebView2，冷启动实测 2.5s 才
# 有 HTTP 服务、3.7s 窗口才可见；慢机器上翻倍也不稀奇，20s 是保守值。
LAUNCH_TIMEOUT = 20.0
# 客户端已在跑、但发现文件还新（壳页可能没加载完）时，给它多久就绪
READY_WAIT = 8.0
# 老客户端（不认 --url=、也没有 /status）只能靠 HTTP 补投，后台补多久
LEGACY_REDELIVER = 20.0
LEGACY_REDELIVER_EVERY = 1.5
# 发现文件比这还新 ⇒ 客户端刚起，不能把"受理"当成"注入成功"
CLIENT_YOUNG = 20.0

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


def _client_port():
    """发现文件 → (port, pid)。文件坏了/进程死了 → (None, 0)(不再浪费超时)。"""
    try:
        info = json.loads(DISCOVERY_FILE.read_text(encoding='utf-8'))
        port = int(info['port'])
        pid = int(info.get('pid') or 0)
    except Exception:
        return None, 0

    # 发现文件可能是陈旧的:进程死了就直接放弃
    if pid and os.name == 'nt':
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return None, 0
            kernel32.CloseHandle(handle)
        except Exception:
            pass
    return port, pid


def _client_age() -> float:
    """发现文件的年龄 ≈ 客户端进程的年龄。很新 = 刚被拉起,壳页多半还没加载。"""
    try:
        return max(0.0, time.time() - DISCOVERY_FILE.stat().st_mtime)
    except Exception:
        return 0.0


def _client_status(port) -> dict:
    """GET /status —— 客户端在不在 + 壳页就绪没有。老客户端没有这条路由 ⇒ None。"""
    try:
        req = urllib.request.Request(f'http://127.0.0.1:{port}/status')
        with urllib.request.urlopen(req, timeout=0.5) as r:
            data = json.loads(r.read().decode('utf-8') or '{}')
        return data if isinstance(data, dict) else {}
    except Exception:
        return None


def _open_once(port, url: str, title: str):
    """POST /open 一次。返回 (connected, delivered):
    connected = 客户端在且受理了;delivered = 它确认页签真的建出来了
    (True/False;None = 老客户端,回答不了这个问题)。"""
    body = json.dumps({'url': url, 'title': title}, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        f'http://127.0.0.1:{port}/open', data=body, method='POST',
        headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=1.5) as r:
            try:
                data = json.loads(r.read().decode('utf-8') or '{}')
            except Exception:
                data = {}
    except Exception:
        return False, None
    if 'delivered' in data:
        return True, bool(data.get('delivered'))
    return True, None


def _try_client(url: str, title: str) -> str:
    """一次注入尝试。返回:
      'delivered' — 客户端报告页签已经在壳里了(结束)
      'accepted'  — 老客户端受理了,但它不说建没建出来(见 _redeliver_later)
      'retry'     — 客户端还没起/壳页还没加载/连不上,调用方该继续重试
    不抛错。"""
    port, _pid = _client_port()
    if not port:
        return 'retry'

    status = _client_status(port)
    if status:
        tabs = status.get('tabs')
        if isinstance(tabs, list) and url in tabs:
            # 壳页自己报上来的页签里有它 —— 真的建出来了(多半是 exe 带 --url= 自己开的)
            return 'delivered'
        if not status.get('ready'):
            # 客户端在,但壳页还没加载 —— 此刻 /open 会被 _open_tab 静默丢掉,别投
            return 'retry'

    connected, delivered = _open_once(port, url, title)
    if not connected:
        return 'retry'
    if delivered is None:
        return 'accepted'
    return 'delivered' if delivered else 'retry'


def _redeliver_later(url: str, title: str,
                     seconds: float = LEGACY_REDELIVER,
                     every: float = LEGACY_REDELIVER_EVERY) -> None:
    """老客户端专用:后台补投。不阻塞节点线程。

    老 exe 不认 --url=,只能靠 HTTP 注入;而壳页起来时那次 NCR Reload 会让在途
    脚本被垂死的页面消费掉(实测最长能吃掉 15s 内投的所有脚本),所以一次投递
    不够。addTab 按 URL 去重,重复投递只是激活已有页签,慢慢补到页签出现为止。"""
    def run():
        deadline = time.time() + seconds
        while time.time() < deadline:
            time.sleep(every)
            try:
                if _try_client(url, title) == 'delivered':
                    return
            except Exception:
                return
    threading.Thread(target=run, daemon=True).start()


def _wait_inject(url: str, title: str, budget: float) -> str:
    """在 budget 秒内反复尝试。返回:
      'delivered' — 页签确认建出来了
      'accepted'  — 受理但拿不到确认(老客户端):早就在跑的视同成功,
                    刚起身的交给后台补投(_redeliver_later)
      'timeout'   — 一直没拿到,调用方退回浏览器"""
    deadline = time.time() + budget
    while True:
        state = _try_client(url, title)
        if state == 'delivered':
            return 'delivered'
        if state == 'accepted':
            # 客户端早就在跑 ⇒ 壳页必然已加载,受理即建成
            if _client_age() > CLIENT_YOUNG:
                return 'accepted'
            # 刚起身的:主线程不再干等,交给后台补投
            _redeliver_later(url, title)
            return 'accepted'
        if time.time() >= deadline:
            return 'timeout'
        time.sleep(0.35)


# 用户偏好（前端 Settings tab 的 user preference）。存仓库 data/sampler/ 下的一份共享文件 ——
# open_ui 被每个节点的服务器调用，这个偏好必须跨节点可见，不能挂在某个节点实例的配置上。
PREFS_FILE = Path(__file__).resolve().parents[1] / 'data' / 'sampler' / 'ui_prefs.json'
# 打包好的桌面客户端（client/build_exe.bat 的产物，仓库根）。"Open With Application" 打开时，
# KolidUI 没在跑就把这份 exe 拉起来再注入，而不是退回系统浏览器。
DESKTOP_EXE = Path(__file__).resolve().parents[1] / 'Kolid Desktop.exe'

def _load_prefs() -> dict:
    try:
        data = json.loads(PREFS_FILE.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def is_open_with_app() -> bool:
    """Open With Application 偏好的唯一真源（后端侧）。读不到/坏了都按关处理。"""
    return bool(_load_prefs().get('open_with_app'))


def set_open_with_app(on: bool) -> None:
    try:
        prefs = _load_prefs()
        if bool(prefs.get('open_with_app')) == bool(on):
            return
        prefs['open_with_app'] = bool(on)
        PREFS_FILE.parent.mkdir(parents=True, exist_ok=True)
        PREFS_FILE.write_text(json.dumps(prefs, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception as e:
        print(f'[kolid] saving ui_prefs failed: {e}', file=sys.stderr)


def _launch_desktop(url: str = None, title: str = None) -> bool:
    """直接打开 Kolid Desktop.exe（fire-and-forget）。带 url 时把页面作为命令行
    参数一起交给它（--url=…），由桌面自己登记成页签意图、壳页一加载就建出来 ——
    这比"先起进程、再 HTTP 注入"少一次和壳页加载的抢跑。

    老 exe 不认 --url=（当看不见的参数，只开一个空窗口），调用方随后退回 HTTP
    注入那条路。exe 在不在/起不起得来都不抛错。"""
    if not DESKTOP_EXE.exists():
        print(f'[kolid] Kolid Desktop.exe not found: {DESKTOP_EXE}', file=sys.stderr)
        return False
    args = [str(DESKTOP_EXE)]
    if url:
        args.append('--url=' + url)
        if title:
            args.append('--title=' + title)
    try:
        kw = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                  stderr=subprocess.DEVNULL, cwd=str(DESKTOP_EXE.parent))
        if os.name == 'nt':
            # 脱离本进程：不继承控制台/句柄，ComfyUI 退出也不牵连它
            kw['creationflags'] = (getattr(subprocess, 'DETACHED_PROCESS', 0)
                                   | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0))
            kw['close_fds'] = True
        subprocess.Popen(args, **kw)
        return True
    except Exception as e:
        print(f'[kolid] launching Kolid Desktop failed: {e}', file=sys.stderr)
        return False


def open_ui(url: str, title: str = None) -> None:
    """打开节点 UI。原逻辑：Kolid Client 在跑就注入其标签页，否则用系统浏览器。
    Open With Application 偏好打开时：客户端不在就把 Kolid Desktop.exe 拉起来（打包的
    解释器要几秒初始化，轮询最多 LAUNCH_TIMEOUT 秒），等它起不来再退回浏览器。永不抛错。

    关键：客户端的 HTTP 服务比它的壳页早 1~2 秒上线（实测 /ping 2.5s、窗口可见 3.7s），
    那段窗口里 /open 会被静默吞掉 —— 所以只有拿到客户端的"页签真在"确认才算成功，
    否则一直重试（详见 _try_client / _wait_inject）。"""
    title = title or _guess_title(url)
    started = time.time()
    port, _pid = _client_port()

    if port:
        # 客户端已在跑。它刚起（壳页还在加载）就给它一段就绪时间；早就在跑的
        # 第一次尝试就能拿到确认，零等待。
        budget = READY_WAIT if _client_age() < CLIENT_YOUNG else 0.0
        state = _wait_inject(url, title, budget)
        if state != 'timeout':
            print(f'[kolid] {title} {"injected into" if state == "delivered" else "queued for"}'
                  f' KolidUI ({time.time() - started:.2f}s)')
            return
    elif is_open_with_app() and _launch_desktop(url, title):
        state = _wait_inject(url, title, LAUNCH_TIMEOUT)
        if state != 'timeout':
            print(f'[kolid] {title} {"injected into" if state == "delivered" else "queued for"}'
                  f' KolidUI after launch ({time.time() - started:.2f}s)')
            return
        print('[kolid] Kolid Desktop did not come up in time, falling back to browser')

    print(f'[kolid] KolidUI not found, opening in browser: {url}')
    try:
        webbrowser.open(url)
    except Exception as e:
        print(f'[kolid] webbrowser.open failed: {e}', file=sys.stderr)
