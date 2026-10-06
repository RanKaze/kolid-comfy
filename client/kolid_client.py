"""KolidUI — kolid-comfy 节点 Web UI 的常驻桌面壳。

窗口实现(pywebview/WinForms 之上直连 ctypes;pythonnet 不分发受保护虚方法,
WndProc 只能在窗口过程链上挂钩):
- 无边框 Form 上挂 wndproc 链:WM_NCCALCSIZE 全幅客户区(内容贴边,抵消
  WS_THICKFRAME 的 7px 原生边框),WM_GETMINMAXINFO 最大化=工作区+边缘带宽过扫
  (最大化内容贴边、不盖任务栏、缩放条自动离屏),WM_SIZE 重新摆放缩放条
- 边缘/角落 8 向缩放:8 个进程内透明子窗口(WS_EX_TRANSPARENT,覆盖外圈 8px)
  WM_NCHITTEST 应答 HT 边缘码、把 WM_NCLBUTTONDOWN 转交给主窗体 —— 按下落在
  自己进程的窗口上,系统原生缩放循环(含 Snap、最小尺寸钳制)才会正确运行;
  光标用系统标准缩放光标,最大化时缩放条应答 HTCLIENT 直接穿透
- 标题栏拖动/双击最大化/右键系统菜单:标题栏 CSS 声明 app-region: drag,
  由 WebView2 转交主窗体走原生行为(需开启 IsNonClientRegionSupportEnabled
  后重新导航一次才生效);页面内可点控件全部 no-drag
- 图标同步与窗口位置持久化:全在 wndproc 链里同步做(WM_SIZE 跨 zoomed 边界、
  WM_EXITSIZEMOVE 收手势、WM_CLOSE 落盘),零事件订阅、零轮询
- 跨线程(服务器线程/js_api 线程/loaded 事件线程)绝不 marshal Python 回调进
  控件窗过程 —— pythonnet 3.0.5 在 Control.InvokeMarshaledCallbackDo 上会
  AccessViolation(事件日志 .NET Runtime 1026 的崩溃栈就钉在这),"开一会儿就
  卡死/崩溃"的根因。异步动作只走两条通道:
    ① PostMessage 主窗体(WM_APP_SETUP 收尾;由消息泵所在 UI 线程经窗口过程链
       处理;挂链引导是一次跨线程 SetWindowLongPtr)
    ② 页面 JS:投进待执行队列,壳页面自己长轮询同源 HTTP(/pull)取出后本地
       eval —— 本端从不执行 JS
- 窗口过程里(ctypes 回调上下文)同样禁止发起 .NET 调用:实测 pythonnet 在
  wndproc 里调 CoreWebView2.ExecuteScriptAsync(Task 型异步方法)会把 CPython 3.14
  的线程状态记账弄劈叉,最大化/还原循环约 3 次调用内必崩(faulthandler 两种交替:
  _PyThreadState_Attach "non-NULL old thread state",或数秒后无关线程 select() 里
  的 AV)。这就是 ② 走页面自拉而不是注入的原因;通道 ① 的处理器里只准剩下
  ctypes/纯 Python 动作(WM_CLOSE 分支的一次性 IO 与 TerminateProcess 同理)。

握手服务(127.0.0.1):
    GET  /ping              → 存活探测
    POST /open {url, title} → 注入一个新标签页(仅 localhost URL)并前置窗口
    POST /focus             → 二次启动时只聚焦已有窗口

打包:client/build_exe.bat → 仓库根目录 Kolid Desktop.exe
"""
import atexit
import base64
import ctypes
import ctypes.wintypes as wt
import json
import os
import shutil
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import webview
import webview.platforms.winforms as winforms_impl  # 确保引用 System.Windows.Forms

from System.Drawing import Size

# 不要重新引入"启动期 gc.disable() + 稍后 gc.freeze()/gc.enable()"的 GC hack:
# exe 栈(CPython 3.14 + pythonnet 3.2.0)上 gc.freeze() 必 AV(python314.dll,
# 事件日志 1026;窗口开好约 20s 后即崩)。那是 pythonnet 3.0.5(旧 venv 栈)的
# 老毛病,3.2.0 已修——直接吃默认 GC:冷启动 10/10、全量 E2E 电池 37/37。

WINDOW_TITLE = 'KolidUI'
DISCOVERY_DIR = Path.home() / '.kolid_comfy'
DISCOVERY_FILE = DISCOVERY_DIR / 'client.json'
UI_STATE_FILE = DISCOVERY_DIR / 'ui_state.json'
PROFILES_TODO = DISCOVERY_DIR / 'profiles.todo'
# Tinkle(铃声):配置落 tinkle.json(sounds = 音频池,每条 {id,name,start,end}),
# 音频原件存同目录 tinkle_audio_<id>.<ext>。触发时随机播池中一条;池空播内置合成铃声。
# 持久化位置随程序走(相对定位,不落绝对路径):打包后 = exe 旁的 data/desktop/tinkle,
# 源码直跑 = 仓库根的 data/desktop/tinkle;旧档在 ~/.kolid_comfy 的自动迁过来。
def _program_root():
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


TINKLE_DIR = _program_root() / 'data' / 'desktop' / 'tinkle'
TINKLE_CONFIG_FILE = TINKLE_DIR / 'tinkle.json'
TINKLE_AUDIO_STEM = 'tinkle_audio_'
TINKLE_DEFAULT = {'enabled': False, 'volume': 0.9, 'sounds': []}
# 旧版(2026-10-06 早些时候)把铃声档放这里;只在迁移时读一次
TINKLE_LEGACY_DIR = DISCOVERY_DIR
TINKLE_CTYPE = {'.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
                '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
                '.flac': 'audio/flac', '.opus': 'audio/ogg', '.webm': 'audio/webm',
                '.weba': 'audio/webm'}
PORT_RANGE = range(8790, 8800)
MIN_W, MIN_H = 560, 420

WM_NCCALCSIZE, WM_GETMINMAXINFO, WM_SIZE = 0x0083, 0x0024, 0x0005
WM_NCHITTEST, WM_SETCURSOR = 0x0084, 0x0020
WM_NCLBUTTONDOWN, WM_NCLBUTTONDBLCLK = 0x00A1, 0x00A3
WM_ERASEBKGND, WM_PAINT = 0x0014, 0x000F
WM_EXITSIZEMOVE, WM_CLOSE = 0x0231, 0x0010
WM_SETICON = 0x0080
WM_SYSCOMMAND = 0x0112
WM_APP_SETUP = 0x8001
SC_MINIMIZE, SC_MAXIMIZE, SC_RESTORE = 0xF020, 0xF030, 0xF120
GWL_STYLE, GWLP_WNDPROC = -16, -4
WS_THICKFRAME = 0x00040000
WS_MINIMIZEBOX, WS_MAXIMIZEBOX, WS_SYSMENU = 0x00020000, 0x00010000, 0x00080000
WS_CHILD, WS_VISIBLE = 0x40000000, 0x10000000
WS_EX_TRANSPARENT = 0x00000020
SWP_NOSIZE, SWP_NOMOVE, SWP_NOZORDER, SWP_FRAMECHANGED = 0x0001, 0x0002, 0x0004, 0x0020
SWP_NOACTIVATE = 0x0010
SW_HIDE = 0
SW_SHOW, SW_RESTORE = 5, 9
IMAGE_ICON, LR_LOADFROMFILE = 1, 0x0010
SM_CXSIZEFRAME, SM_CXPADDEDBORDER = 32, 92
HTCAPTION, HTCLIENT = 2, 1
# HT 码 / 系统标准缩放光标(与普通可缩放窗口一致)
ROLE_CODES = {'n': 12, 's': 15, 'w': 10, 'e': 11, 'nw': 13, 'ne': 14, 'sw': 16, 'se': 17}
ROLE_CURSORS = {'n': 32645, 's': 32645, 'w': 32644, 'e': 32644,
                'nw': 32642, 'se': 32642, 'ne': 32643, 'sw': 32643}

_state = {'window': None, 'loaded': False, 'server': None, 'pending_ui_state': None,
          'last_saved_state': None, 'ncr_set': False}

# 待执行 JS 队列(见 _post_js):页面长轮询 /pull 自取,本端零执行。
# token 随 /shell 页面下发,挡住其他本地页面替我们"接管"队列(拉走即消费)。
_pending_js = []
_js_cv = threading.Condition()
_PULL_TOKEN = os.urandom(16).hex()

# 壳页当前页签 URL 镜像(Api.tabs_changed 逐次同步):应用退出时给每个
# 还开着页签的节点补发 /window_closed 用,见 _notify_tabs_window_closed。
_tabs = {'urls': []}


def _free_port(start):
    for port in start, *range(start + 1, start + 10):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    return None


def _write_discovery(port):
    DISCOVERY_DIR.mkdir(exist_ok=True)
    DISCOVERY_FILE.write_text(json.dumps({'port': port, 'pid': os.getpid()}), encoding='utf-8')


def _clear_discovery():
    try:
        DISCOVERY_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def _is_localhost(url):
    host = urllib.parse.urlparse(url).hostname or ''
    return host in ('localhost', '127.0.0.1', '::1', '[::1]')


def _native():
    win = _state['window']
    return win.native if win else None


def _save_ui_state():
    try:
        hwnd = _shell.get('hwnd') or 0
        if not hwnd:
            return
        wp = _WINDOWPLACEMENT()
        wp.length = ctypes.sizeof(_WINDOWPLACEMENT)
        if not _user32.GetWindowPlacement(wt.HWND(hwnd), ctypes.byref(wp)):
            return
        nr = wp.rcNormalPosition
        # rcNormalPosition 在任何状态下都是"还原后几何",最小化/最大化时不会把
        # 屏幕外工作区矩形存进档。全程 ctypes:WM_CLOSE 里读 Form.Bounds 会偶发
        # pythonnet AV(实测 8 次关窗死 3 次,栈固定钉在那一行),关窗路径不碰 .NET
        bounds = [nr.left, nr.top, nr.right - nr.left, nr.bottom - nr.top]
        maximized = wp.showCmd == 3  # SW_SHOWMAXIMIZED
        # 去重键必须含 maximized:纯最大化/还原切换不改 rcNormalPosition,
        # 只按 bounds 去重会把 maximized 的变化吞掉(实测还原后档里仍是 True,
        # 关窗重开就变最大化)
        key = (tuple(bounds), maximized)
        if _state.get('last_saved_state') == key:
            return
        _state['last_saved_state'] = key
        DISCOVERY_DIR.mkdir(exist_ok=True)
        UI_STATE_FILE.write_text(json.dumps({'bounds': bounds, 'maximized': maximized}), encoding='utf-8')
    except Exception:
        pass


def _load_ui_state():
    try:
        d = json.loads(UI_STATE_FILE.read_text(encoding='utf-8'))
        b = d.get('bounds') or []
        if len(b) == 4 and b[2] >= MIN_W and b[3] >= MIN_H and b[0] > -200 and b[1] > -200:
            _state['pending_ui_state'] = {'bounds': [int(v) for v in b],
                                          'maximized': bool(d.get('maximized'))}
    except Exception:
        pass


def _load_tinkle_config():
    """读铃声配置,缺的字段用默认值补齐。任何异常都回落默认(壳页面不因坏档哑火)。
    兼容旧单文件档(audio/start/end):迁成池里一条,文件改名带上 id;
    档在旧位置(~/.kolid_comfy)的整批挪到 TINKLE_DIR。"""
    if any(TINKLE_LEGACY_DIR.glob('tinkle*')):
        # 触发条件是旧目录还有残留,而不是新档不存在:否则半途而废的首次迁移
        # (配置已复制、音频没搬)之后,余下的音频永远不会再迁
        _migrate_tinkle_legacy()
    raw = {}
    try:
        raw = json.loads(TINKLE_CONFIG_FILE.read_text(encoding='utf-8'))
        if not isinstance(raw, dict):
            raw = {}
    except Exception:
        pass
    cfg = dict(TINKLE_DEFAULT)
    for k in TINKLE_DEFAULT:
        if k in raw:
            cfg[k] = raw[k]
    sounds = [s for s in (cfg['sounds'] or [])
              if isinstance(s, dict) and isinstance(s.get('id'), str) and s['id'].isalnum()]
    if not sounds and isinstance(raw.get('audio'), str) and raw['audio']:
        old = TINKLE_DIR / raw['audio']
        if old.is_file():
            try:
                new = TINKLE_DIR / (TINKLE_AUDIO_STEM + '0' + old.suffix)
                old.rename(new)
                sounds = [{'id': '0', 'name': raw['audio'],
                           'start': float(raw.get('start') or 0.0),
                           'end': float(raw.get('end') if raw.get('end') is not None else 1.0)}]
                cfg['sounds'] = sounds
                _write_tinkle_config(cfg)   # 老 schema 一次性转成 sounds 池,否则下次读回又丢了
            except Exception:
                sounds = []
    cfg['sounds'] = sounds
    return cfg


def _migrate_tinkle_legacy():
    """旧档(今天早些时候的单文件版)落在 ~/.kolid_comfy:整批搬到 data/desktop/tinkle。"""
    try:
        old_cfg = TINKLE_LEGACY_DIR / 'tinkle.json'
        leftovers = list(TINKLE_LEGACY_DIR.glob('tinkle_audio*'))
        if not old_cfg.is_file() and not leftovers:
            return
        TINKLE_DIR.mkdir(parents=True, exist_ok=True)
        if old_cfg.is_file() and not TINKLE_CONFIG_FILE.exists():
            TINKLE_CONFIG_FILE.write_text(old_cfg.read_text(encoding='utf-8'), encoding='utf-8')
        for f in TINKLE_LEGACY_DIR.glob('tinkle_audio*'):
            dst = TINKLE_DIR / f.name
            if dst.exists():
                f.unlink()
            else:
                # C: ~/.kolid_comfy → F: 仓库根是跨盘符,Path.rename 会 WinError 17,必须 move
                shutil.move(str(f), str(dst))
        old_cfg.unlink(missing_ok=True)
    except Exception:
        pass


def _write_tinkle_config(cfg):
    try:
        TINKLE_DIR.mkdir(parents=True, exist_ok=True)
        TINKLE_CONFIG_FILE.write_text(json.dumps(cfg), encoding='utf-8')
    except Exception:
        pass
    return cfg


# ---------------- 原生窗口外壳(ctypes) ----------------

# 注意:ctypes.windll.user32 是进程级单例,argtypes 一挂全局生效,
# pywebview 自己的调用也会被拦 —— 所以凡 pywebview 可能传 None 的参数
# 一律声明成 c_void_p(None→NULL 合法),别用具体句柄类型。
_user32 = ctypes.windll.user32
_kernel32 = ctypes.windll.kernel32
_shell32 = ctypes.windll.shell32


class _NCCALCSIZE_PARAMS(ctypes.Structure):
    _fields_ = [('rgrc', wt.RECT * 3), ('lppos', ctypes.c_void_p)]


class _WINDOWPOS(ctypes.Structure):
    _fields_ = [('hwnd', wt.HWND), ('hwndInsertAfter', wt.HWND),
                ('x', ctypes.c_int), ('y', ctypes.c_int),
                ('cx', ctypes.c_int), ('cy', ctypes.c_int), ('flags', wt.UINT)]


class _MINMAXINFO(ctypes.Structure):
    _fields_ = [('ptReserved', wt.POINT), ('ptMaxSize', wt.POINT), ('ptMaxPosition', wt.POINT),
                ('ptMinTrackSize', wt.POINT), ('ptMaxTrackSize', wt.POINT)]


class _MONITORINFO(ctypes.Structure):
    _fields_ = [('cbSize', wt.DWORD), ('rcMonitor', wt.RECT), ('rcWork', wt.RECT),
                ('dwFlags', wt.DWORD)]


class _WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [('length', wt.UINT), ('flags', wt.UINT), ('showCmd', wt.UINT),
                ('ptMinPosition', wt.POINT), ('ptMaxPosition', wt.POINT),
                ('rcNormalPosition', wt.RECT)]


class _WNDCLASSEXW(ctypes.Structure):
    _fields_ = [('cbSize', wt.UINT), ('style', wt.UINT), ('lpfnWndProc', ctypes.c_void_p),
                ('cbClsExtra', ctypes.c_int), ('cbWndExtra', ctypes.c_int),
                ('hInstance', wt.HINSTANCE), ('hIcon', wt.HICON), ('hCursor', wt.HANDLE),
                ('hbrBackground', wt.HBRUSH), ('lpszMenuName', wt.LPCWSTR),
                ('lpszClassName', wt.LPCWSTR), ('hIconSm', wt.HICON)]


_WNDPROC_T = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM)
_ENUMPROC_T = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

# ctypes 默认把所有参数当 C int:64 位指针/lparam 会 OverflowError,必须声明原型
_user32.SetWindowLongPtrW.restype = ctypes.c_void_p
_user32.SetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_void_p]
_user32.CallWindowProcW.restype = ctypes.c_ssize_t
_user32.CallWindowProcW.argtypes = [ctypes.c_void_p, wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
_user32.DefWindowProcW.restype = ctypes.c_ssize_t
_user32.DefWindowProcW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
_user32.SendMessageW.restype = ctypes.c_ssize_t
_user32.SendMessageW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
_user32.PostMessageW.restype = wt.BOOL
_user32.PostMessageW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
_user32.SetWindowPos.restype = wt.BOOL
# pywebview 的 window.move/resize 也调这个共享函数:move 里 hWndInsertAfter 和
# cx/cy(配 SWP_NOSIZE)都传 None。这几个位置一律 c_void_p(None→NULL 合法),
# 否则 ctypes 在入口抛 ArgumentError —— 而 winforms.py 没接异常。
_user32.SetWindowPos.argtypes = [wt.HWND, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                 ctypes.c_void_p, ctypes.c_void_p, wt.UINT]
_user32.SetWindowLongW.restype = ctypes.c_long
_user32.SetWindowLongW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_long]
_user32.GetWindowLongW.restype = ctypes.c_long
_user32.GetWindowLongW.argtypes = [wt.HWND, ctypes.c_int]
_user32.GetWindowRect.restype = wt.BOOL
_user32.GetWindowRect.argtypes = [wt.HWND, ctypes.c_void_p]
_user32.GetWindowPlacement.restype = wt.BOOL
_user32.GetWindowPlacement.argtypes = [wt.HWND, ctypes.c_void_p]
_user32.IsZoomed.restype = wt.BOOL
_user32.IsZoomed.argtypes = [wt.HWND]
_user32.IsIconic.restype = wt.BOOL
_user32.IsIconic.argtypes = [wt.HWND]
_user32.SetForegroundWindow.restype = wt.BOOL
_user32.SetForegroundWindow.argtypes = [wt.HWND]
_user32.EnumWindows.restype = wt.BOOL
_user32.EnumWindows.argtypes = [_ENUMPROC_T, wt.LPARAM]
_user32.GetWindowThreadProcessId.restype = wt.DWORD
_user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.c_void_p]
_user32.GetClassNameW.restype = ctypes.c_int
_user32.GetClassNameW.argtypes = [wt.HWND, ctypes.c_void_p, ctypes.c_int]
_user32.GetWindowTextW.restype = ctypes.c_int
_user32.GetWindowTextW.argtypes = [wt.HWND, ctypes.c_void_p, ctypes.c_int]
_user32.GetWindowLongPtrW.restype = ctypes.c_void_p
_user32.GetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int]
_user32.SetCursor.restype = ctypes.c_void_p
_user32.SetCursor.argtypes = [ctypes.c_void_p]
_user32.LoadCursorW.restype = ctypes.c_void_p
_user32.LoadCursorW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
_user32.BeginPaint.restype = ctypes.c_void_p
_user32.BeginPaint.argtypes = [wt.HWND, ctypes.c_void_p]
_user32.EndPaint.restype = wt.BOOL
_user32.EndPaint.argtypes = [wt.HWND, ctypes.c_void_p]
_user32.GetSystemMetrics.restype = ctypes.c_int
_user32.GetSystemMetrics.argtypes = [ctypes.c_int]
_user32.GetDpiForWindow.restype = wt.UINT
_user32.GetDpiForWindow.argtypes = [wt.HWND]
_user32.MonitorFromWindow.restype = wt.HMONITOR
_user32.MonitorFromWindow.argtypes = [wt.HWND, wt.DWORD]
_user32.GetMonitorInfoW.restype = wt.BOOL
_user32.GetMonitorInfoW.argtypes = [wt.HMONITOR, ctypes.c_void_p]
_user32.ShowWindow.restype = wt.BOOL
_user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
_user32.LoadImageW.restype = ctypes.c_void_p
_user32.LoadImageW.argtypes = [ctypes.c_void_p, wt.LPCWSTR, wt.UINT, ctypes.c_int, ctypes.c_int, wt.UINT]
_user32.SendMessageW.restype = ctypes.c_void_p
_user32.SendMessageW.argtypes = [ctypes.c_void_p, wt.UINT, ctypes.c_void_p, ctypes.c_void_p]
_shell32.ExtractIconW.restype = ctypes.c_void_p
_shell32.ExtractIconW.argtypes = [ctypes.c_void_p, wt.LPCWSTR, ctypes.c_int]
_user32.CreateWindowExW.restype = wt.HWND
_user32.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD,
                                    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                    wt.HWND, wt.HMENU, wt.HINSTANCE, ctypes.c_void_p]
_user32.RegisterClassExW.restype = wt.ATOM
_user32.RegisterClassExW.argtypes = [ctypes.c_void_p]
_kernel32.GetModuleHandleW.restype = ctypes.c_void_p
_kernel32.GetModuleHandleW.argtypes = [wt.LPCWSTR]
_kernel32.GetCurrentProcess.restype = ctypes.c_void_p
_kernel32.TerminateProcess.restype = wt.BOOL
_kernel32.TerminateProcess.argtypes = [ctypes.c_void_p, wt.UINT]

# chain_cb/strip_cb 必须在模块级持有:回调对象被 GC 后窗口过程立刻崩溃
_shell = {'hwnd': 0, 'prev_proc': ctypes.c_void_p(0), 'chain_cb': None, 'strip_cb': None,
          'strips': {}, 'band': 8, 'ready': False, 'zoomed': False}
# 关窗收尾只准跑一次(WM_CLOSE 可能来第二次:系统菜单/任务栏/双击 X)
_closing = threading.Event()


def _rect_of(hwnd):
    r = wt.RECT()
    _user32.GetWindowRect(wt.HWND(hwnd), ctypes.byref(r))
    return (r.left, r.top, r.right - r.left, r.bottom - r.top)


def _place_strips():
    hwnd = _shell['hwnd']
    if not hwnd or not _shell['strips']:
        return
    _, _, w, h = _rect_of(hwnd)
    b = _shell['band']
    geo = {'n': (0, 0, w, b), 's': (0, h - b, w, b), 'w': (0, 0, b, h), 'e': (w - b, 0, b, h),
           'nw': (0, 0, b, b), 'ne': (w - b, 0, b, b),
           'sw': (0, h - b, b, b), 'se': (w - b, h - b, b, b)}
    for strip, role in _shell['strips'].items():
        gx, gy, gw, gh = geo[role]
        # 子窗口置顶只能用 HWND_TOP(0);-1(TOPMOST) 对 child 无效,整个调用会失败
        _user32.SetWindowPos(wt.HWND(strip), wt.HWND(0), gx, gy, gw, gh, SWP_NOACTIVATE)


def _closing_log(msg):
    """关窗路径进度打点(诊断用):关窗期任何未捕获的崩溃都会把最后一条
    打点留在 stderr/日志里,定位崩溃点不靠猜。"""
    try:
        print('[KolidUI:close] %s' % msg, file=sys.stderr, flush=True)
    except Exception:
        pass


def _hard_exit(code=0):
    """最硬退出:TerminateProcess 自己,内核即刻终止,不返回。
    os._exit 走 CRT _exit → ExitProcess,会为每个已加载 DLL 跑
    DllMain(PROCESS_DETACH) —— WebView2Loader 的 detach 实测稳定拖 ~2.1s
    (farm 12/12:exiting→dead=2.067~2.112s);TerminateProcess 整段跳过。
    调用点均已隐藏窗口、落盘状态、清发现文件;profile 删除本就交给下次
    启动的 _sweep_old_profiles。os._exit 仅为理论兜底(TerminateProcess 不返回)。"""
    try:
        _kernel32.TerminateProcess(_kernel32.GetCurrentProcess(), code)
    except Exception:
        pass
    os._exit(code)


def _sweep_old_profiles():
    """删掉上一次运行留下的 WebView2 临时 profile。

    关窗路径做的是硬退出(见 WM_CLOSE 分支),进程内不再做任何重活:每个
    运行在 _on_loaded 里把自己的 profile 路径记进 profiles.todo,由下一次
    启动在后台清掉 —— 此时上个进程连同它的 msedgewebview2 子进程早已死透,
    文件没有锁,rmtree 一次干净。异常退出(崩溃/强杀)同样靠这个自愈。"""
    try:
        paths = PROFILES_TODO.read_text(encoding='utf-8').splitlines()
    except OSError:
        return
    try:
        PROFILES_TODO.write_text('', encoding='utf-8')
    except OSError:
        pass
    for p in paths:
        p = p.strip()
        if p and os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)


def _form_wndproc(hwnd, msg, wparam, lparam):
    if msg == WM_APP_SETUP:
        # loaded 事件线程 → UI 线程的收尾入口(此刻我们就在消息泵线程上)
        try:
            _late_setup()
        except Exception:
            pass
        return 0
    if msg == WM_NCCALCSIZE and wparam:
        try:
            p = ctypes.cast(lparam, ctypes.POINTER(_NCCALCSIZE_PARAMS)).contents
            cur = wt.RECT()
            _user32.GetWindowRect(hwnd, ctypes.byref(cur))
            r = wt.RECT(cur.left, cur.top, cur.right, cur.bottom)
            if p.lppos:  # 目标窗口矩形取本次 SetWindowPos 的意图值,避免读到旧矩形
                wp = ctypes.cast(p.lppos, ctypes.POINTER(_WINDOWPOS)).contents
                if not (wp.flags & SWP_NOMOVE):
                    r.left, r.top = wp.x, wp.y
                if not (wp.flags & SWP_NOSIZE):
                    r.right, r.bottom = wp.x + wp.cx, wp.y + wp.cy
            p.rgrc[0] = r
        except Exception:
            pass
        return 0
    if msg == WM_GETMINMAXINFO:
        try:
            mmi = ctypes.cast(lparam, ctypes.POINTER(_MINMAXINFO)).contents
            mon = _user32.MonitorFromWindow(hwnd, 2)  # MONITOR_DEFAULTTONEAREST
            mi = _MONITORINFO()
            mi.cbSize = ctypes.sizeof(_MONITORINFO)
            _user32.GetMonitorInfoW(mon, ctypes.byref(mi))
            wa = mi.rcWork
            b = _shell['band']
            mmi.ptMaxPosition.x = wa.left - b
            mmi.ptMaxPosition.y = wa.top - b
            mmi.ptMaxSize.x = (wa.right - wa.left) + 2 * b
            mmi.ptMaxSize.y = (wa.bottom - wa.top) + 2 * b
            dpi = _user32.GetDpiForWindow(hwnd) or 96
            mmi.ptMinTrackSize.x = MIN_W * dpi // 96
            mmi.ptMinTrackSize.y = MIN_H * dpi // 96
        except Exception:
            pass
        return 0
    if msg == WM_SIZE:
        try:
            _place_strips()
        except Exception:
            pass
        try:
            # WM_SIZE 在拖动缩放时是消息风暴;只有跨越 zoomed 边界的
            # 那一次(最大化/还原)才落盘 + 同步标题栏图标
            zoomed = bool(_user32.IsZoomed(hwnd))
            if zoomed != _shell['zoomed']:
                _shell['zoomed'] = zoomed
                _save_ui_state()
                _post_js('setMaximized(%s)' % ('true' if zoomed else 'false'))
        except Exception:
            pass
    if msg == WM_EXITSIZEMOVE:
        # 拖拽/缩放手势收尾(含贴边吸附),此处才是最终几何
        try:
            _save_ui_state()
        except Exception:
            pass
    if msg == WM_CLOSE:
        # 不落回 CallWindowProcW —— 那会驶入 pywebview/WinForms 的 .NET 拆解
        # 走廊(实测 2/6 卡死、堆损坏),pythonnet 收尾还有偶发 AV。这里就地
        # 收个尾:落盘、隐藏窗口(用户视角立即关闭)、清发现文件,然后硬退出。
        # 关窗不做重活(profile 删除挪到下次启动,见 _sweep_old_profiles):
        # 实测关窗起 Python 工作线程边删边退,~1/3 的运行会撞 pythonnet
        # 竞态 AV(0xC0000005),越少分配越稳。第二次 WM_CLOSE 直接吞掉。
        _closing_log('wm_close')
        try:
            _save_ui_state()
        except Exception:
            pass
        if not _closing.is_set():
            _closing.set()
            try:
                _user32.ShowWindow(wt.HWND(hwnd), SW_HIDE)
            except Exception:
                pass
            try:
                _clear_discovery()
            except Exception:
                pass
            # 还开着的页签 = 还在等界面的节点:退出前逐个补发 /window_closed,
            # 否则它们永远挂住(浏览器里关整个窗口也会触发每个页签的 beforeunload)。
            # 纯 socket 后台线程 + 有界等待;没有页签时直接返回,零开销。
            try:
                _notify_tabs_window_closed()
            except Exception:
                pass
            _closing_log('exiting')
            try:
                sys.stdout.flush()
                sys.stderr.flush()
            except Exception:
                pass
            _closing_log('flushed')
            _hard_exit(0)
        return 0
    return _user32.CallWindowProcW(_shell['prev_proc'], hwnd, msg, wparam, lparam)


def _strip_wndproc(hwnd, msg, wparam, lparam):
    try:
        role = _shell['strips'].get(int(hwnd))
        if role is not None:
            if msg == WM_NCHITTEST:
                # 最大化时不做缩放:穿透,点击交给内容
                if _user32.IsZoomed(wt.HWND(_shell['hwnd'])):
                    return HTCLIENT
                return ROLE_CODES[role]
            if msg == WM_SETCURSOR:
                _user32.SetCursor(_user32.LoadCursorW(None, ROLE_CURSORS[role]))
                return 1
            if msg == WM_NCLBUTTONDOWN or msg == WM_NCLBUTTONDBLCLK:
                # 把 NC 按下转交主窗体:wparam 是 HT 码,lparam 是屏幕坐标,
                # 由主窗体的 DefWindowProc 运行原生移动/缩放循环
                _user32.ReleaseCapture()
                _user32.SendMessageW(wt.HWND(_shell['hwnd']), msg, wparam, lparam)
                return 0
            # 右键不转交:原生窗口对缩放边(HTTOP/HTLEFT/…)的右键本就不弹系统菜单
            # (基准:普通 Win32 窗体边框 y+2/y+5 右键 menus=0,标题栏 menus=1),
            # 条上收到 WM_NCRBUTTONUP 后走 DefWindowProc 即可 —— 与原生一致
            if msg == WM_ERASEBKGND:
                return 1
            if msg == WM_PAINT:
                ps = ctypes.create_string_buffer(64)
                _user32.BeginPaint(wt.HWND(hwnd), ps)
                _user32.EndPaint(wt.HWND(hwnd), ps)
                return 0
    except Exception:
        pass
    return _user32.DefWindowProcW(hwnd, msg, wparam, lparam)


# ---------------- UI 线程引导与跨线程消息 ----------------

# 任意线程 → UI 线程的原生通道:PostMessage 主窗体,由挂在窗口过程链上的
# _form_wndproc 在 UI 线程处理(WM_APP_SETUP 收尾)。JS 不下发到 UI 线程,
# 走 _post_js 的队列 + 页面自拉。
# 不用 Control.BeginInvoke/Invoke:它们把 Python 函数 marshal 成 CLR 回调、经
# Control.InvokeMarshaledCallbackDo 在控件窗过程里执行,是 AV/互锁的高发路径
# (WM_SIZE 里起线程调 evaluate_js、js_api 里 win.minimize()/destroy() 全属此列)。


def _find_main_hwnd():
    """纯 ctypes 从任意线程找主窗体 hwnd(loaded 事件线程不能读 .NET property,
    有 AV 先例)。谓词:本进程 + 类名 WindowsForms10.* + 标题为 WINDOW_TITLE
    (或其 .title() 变体)。找不到如实打日志,不猜。"""
    pid = os.getpid()
    found = []

    def _cb(hwnd, _lparam):
        try:
            wpid = wt.DWORD()
            _user32.GetWindowThreadProcessId(wt.HWND(hwnd), ctypes.byref(wpid))
            if wpid.value != pid:
                return True
            cls = ctypes.create_unicode_buffer(128)
            _user32.GetClassNameW(wt.HWND(hwnd), cls, 128)
            if not cls.value.startswith('WindowsForms10.'):
                return True
            text = ctypes.create_unicode_buffer(256)
            _user32.GetWindowTextW(wt.HWND(hwnd), text, 256)
            found.append((int(hwnd), cls.value, text.value))
        except Exception:
            pass
        return True

    _user32.EnumWindows(_ENUMPROC_T(_cb), 0)
    for hwnd, _cls, text in found:
        if text in (WINDOW_TITLE, WINDOW_TITLE.title()):
            return hwnd
    print(f'[KolidUI] main window not found: {found}', file=sys.stderr)
    return 0


def _install_chain(hwnd):
    """挂窗口过程链 + 初始化外壳状态。调用点在 loaded 事件线程,纯 ctypes:
    SetWindowLongPtrW 换过程是原子替换(同进程跨线程合法,无撕裂态,前面没有任何
    一条消息依赖旧过程的新逻辑)。这是全程唯一一次跨线程引导;之后一切跨线程
    动作都只走 PostMessage。装完即现场回读验证,失败打日志留证。"""
    if _shell['ready']:
        return
    band = (_user32.GetSystemMetrics(SM_CXSIZEFRAME)
            + _user32.GetSystemMetrics(SM_CXPADDEDBORDER))
    _shell['band'] = band if band > 0 else 8
    _shell['hwnd'] = int(hwnd)
    _shell['zoomed'] = bool(_user32.IsZoomed(wt.HWND(hwnd)))
    _shell['chain_cb'] = _WNDPROC_T(_form_wndproc)
    _shell['strip_cb'] = _WNDPROC_T(_strip_wndproc)
    prev = _user32.SetWindowLongPtrW(wt.HWND(hwnd), GWLP_WNDPROC,
                                     ctypes.cast(_shell['chain_cb'], ctypes.c_void_p))
    _shell['prev_proc'] = ctypes.c_void_p(prev)
    cur = _user32.GetWindowLongPtrW(wt.HWND(hwnd), GWLP_WNDPROC)
    if int(cur or 0) != ctypes.cast(_shell['chain_cb'], ctypes.c_void_p).value:
        print(f'[KolidUI] chain install verify failed: cur={cur} prev={prev}', file=sys.stderr)
    _shell['ready'] = True


def _post_js(script):
    """任意线程:把一段 JS 放进待执行队列,由壳页面长轮询 /pull 自取后本地执行。
    本端不执行 JS —— wndproc(ctypes 回调)里调 CoreWebView2.ExecuteScriptAsync
    会崩(见文件头),页面自拉是唯一不碰 .NET 的下发通道。"""
    if _closing.is_set():
        return
    with _js_cv:
        _pending_js.append(script)
        _js_cv.notify_all()


def _post_win(msg, wparam=0):
    """任意线程:给主窗体 Post 一条原生消息(js_api/服务器线程专用)。"""
    hwnd = _shell.get('hwnd') or 0
    if hwnd:
        _user32.PostMessageW(wt.HWND(hwnd), msg, wparam, 0)


def _create_strips(hwnd):
    hinst = _kernel32.GetModuleHandleW(None)
    wc = _WNDCLASSEXW()
    wc.cbSize = ctypes.sizeof(_WNDCLASSEXW)
    wc.style = 0x0008  # CS_DBLCLKS:否则收不到 WM_NCLBUTTONDBLCLK
    wc.lpfnWndProc = ctypes.cast(_shell['strip_cb'], ctypes.c_void_p)
    wc.hInstance = hinst
    wc.hbrBackground = 0
    wc.lpszClassName = 'KolidEdgeStrip'
    _user32.RegisterClassExW(ctypes.byref(wc))
    for role in ROLE_CODES:
        strip = _user32.CreateWindowExW(WS_EX_TRANSPARENT, 'KolidEdgeStrip', '',
                                        WS_CHILD | WS_VISIBLE, 0, 0, 10, 10,
                                        wt.HWND(hwnd), 0, hinst, None)
        if strip:
            _shell['strips'][int(strip)] = role
    _place_strips()


def _setup_native_shell():
    """UI 线程(WM_APP_SETUP):样式位(THICKFRAME/SYS 位)+ 缩放条。纯 ctypes,
    幂等可重放(缩放条只建一次)。"""
    hwnd = _shell['hwnd']
    if not hwnd:
        return
    # WinForms 在状态切换时会按 CreateParams 重置样式位,所以每次重放都要重打。
    # WS_THICKFRAME 是原生缩放循环的前提;其 7px 边框由 NCCALCSIZE 全幅客户区抵消。
    style = _user32.GetWindowLongW(wt.HWND(hwnd), GWL_STYLE)
    _user32.SetWindowLongW(wt.HWND(hwnd), GWL_STYLE,
                           style | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_THICKFRAME)
    _user32.SetWindowPos(wt.HWND(hwnd), 0, 0, 0, 0, 0,
                         SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED)
    if not _shell['strips']:
        _create_strips(hwnd)  # 含 _place_strips;必须建在 UI 线程(输入消息投给创建线程)
    else:
        _place_strips()


def _late_setup():
    """UI 线程(WM_APP_SETUP):loaded 之后的收尾全搬到这跑。这里能直接碰 .NET,
    因为执行点就是 UI 线程本身(消息泵在我们的 wndproc 里同步调 Python),
    不存在跨线程 marshal —— 与 pywebview 自己在 UI 线程上跑代码等价。"""
    try:
        _setup_native_shell()
    except Exception as e:
        print(f'[KolidUI] native shell failed: {e}', file=sys.stderr)
    win = _state['window']
    native = _native()
    if win is None or native is None:
        return
    try:
        native.MinimumSize = Size(MIN_W, MIN_H)
    except Exception:
        pass
    if not _state.get('ncr_set'):
        _state['ncr_set'] = True
        try:
            # app-region(拖动/双击最大化/右键菜单)需开启设置后重新导航一次才生效
            core = native.webview.CoreWebView2
            core.Settings.IsNonClientRegionSupportEnabled = True
            core.Reload()
        except Exception as e:
            print(f'[KolidUI] app-region setup failed: {e}', file=sys.stderr)
    _set_window_icon()
    pending = _state.get('pending_ui_state')
    if pending:
        _state['pending_ui_state'] = None
        try:
            # 存取的 bounds 是物理像素(GetWindowPlacement 坐标系),直接
            # SetWindowPos,不走 pywebview 的逻辑像素换算(DPI≠100% 会被二次缩放)
            x, y, w, h = pending['bounds']
            _user32.SetWindowPos(wt.HWND(_shell['hwnd']), None, x, y, w, h,
                                 SWP_NOZORDER | SWP_NOACTIVATE)
            if pending.get('maximized'):
                # 勿用 win.maximize()(pywebview 走 Invoke marshal);原生 SC 命令等价
                _post_win(WM_SYSCOMMAND, SC_MAXIMIZE)
        except Exception as e:
            print(f'[KolidUI] restore geometry failed: {e}', file=sys.stderr)
    # 记下 WebView2 私有模式的临时 profile(%TEMP%\tmpXXXX):硬退出的关窗
    # 路径不做删除(见 WM_CLOSE 分支),路径写进 profiles.todo,由下一次
    # 启动的 _sweep_old_profiles 在后台清掉,否则每次运行泄漏 ~7.5MB
    try:
        prof = getattr(getattr(native, 'browser', None), 'user_data_folder', None)
        if isinstance(prof, str) and prof and webview._state.get('private_mode'):
            DISCOVERY_DIR.mkdir(exist_ok=True)
            with open(PROFILES_TODO, 'a', encoding='utf-8') as f:
                f.write(prof + '\n')
    except Exception:
        pass
    try:
        win.show()
    except Exception as e:
        print(f'[KolidUI] show failed: {e}', file=sys.stderr)


class Api:
    """暴露给 shell 页面的 window.pywebview.api.*
    (拖动/缩放/系统菜单不在此处:标题栏走 app-region,边缘走缩放条,均为原生路径)
    注意:这些方法跑在 js_api 线程上,win.minimize()/destroy()/evaluate_js 这类
    跨线程 .NET 调用会把 Python 回调 marshal 进控件窗过程(AV/卡死高发),
    一律只 PostMessage 回 UI 线程走原生路径。"""

    def window_min(self):
        _post_win(WM_SYSCOMMAND, SC_MINIMIZE)

    def window_max_toggle(self):
        """最大化/还原:Post 原生 SC 命令(WinForms DefWndProc 处理;几何由
        wndproc 链的 WM_GETMINMAXINFO 决定,状态切换经 WM_SIZE 回同步标题栏）。"""
        hwnd = _shell.get('hwnd') or 0
        if not hwnd:
            return
        if _user32.IsZoomed(wt.HWND(hwnd)):
            _post_win(WM_SYSCOMMAND, SC_RESTORE)
        else:
            _post_win(WM_SYSCOMMAND, SC_MAXIMIZE)

    def window_close(self):
        # win.destroy() 走 pywebview 的 .NET 拆解走廊(实测卡死/堆损坏),
        # 直接投 WM_CLOSE,由 _form_wndproc 的硬退出收尾
        _post_win(WM_CLOSE)

    def tab_reload(self):
        if _state['loaded']:
            _post_js('reloadActive()')

    def tabs_changed(self, urls):
        """壳页每次增删页签后同步当前 URL 列表(只存数据,不碰控件)。"""
        try:
            _tabs['urls'] = [str(u) for u in (urls or []) if isinstance(u, str)]
        except Exception:
            _tabs['urls'] = []

    def tab_closed(self, url):
        """用户点页签 ×:等价浏览器里关掉页签 —— iframe 摘除不会触发
        页面自己的 beforeunload,这里替它补发 /window_closed(取消语义,
        节点才能从等待里醒来)。后台线程发出,绝不阻塞 js_api 线程。"""
        url = str(url or '')
        if not (url.startswith('http://') or url.startswith('https://')) or not _is_localhost(url):
            return
        u = urllib.parse.urlparse(url)
        threading.Thread(target=_post_window_closed,
                         args=('%s://%s' % (u.scheme, u.netloc),), daemon=True).start()

    # ---- Tinkle(铃声;User Setting Modal 配置)----
    # 全是纯 Python 文件 IO,js_api 线程安全(规则:不碰 .NET)。

    def get_tinkle_config(self):
        return _load_tinkle_config()

    def save_tinkle_config(self, cfg):
        """壳页面整体回写配置(enabled/segment/volume)。未知字段忽略,不整档替换。"""
        if not isinstance(cfg, dict):
            return _load_tinkle_config()
        cur = _load_tinkle_config()
        for k in TINKLE_DEFAULT:
            if k in cfg:
                cur[k] = cfg[k]
        return _write_tinkle_config(cur)

    def save_tinkle_audio(self, name, data_b64):
        """收下 Modal 里选的音频文件(base64),存为 tinkle_audio_<id>.<ext> 并追加进音频池。"""
        name = str(name or '')
        ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
        if ext not in TINKLE_CTYPE:
            ext = 'mp3'
        try:
            raw = base64.b64decode(str(data_b64 or ''))
        except Exception:
            return {'ok': False, 'error': 'bad audio data'}
        if not raw:
            return {'ok': False, 'error': 'empty audio file'}
        try:
            TINKLE_DIR.mkdir(parents=True, exist_ok=True)
            sid = os.urandom(4).hex()
            fname = TINKLE_AUDIO_STEM + sid + '.' + ext
            (TINKLE_DIR / fname).write_bytes(raw)
        except Exception as e:
            return {'ok': False, 'error': str(e)}
        cfg = _load_tinkle_config()
        entry = {'id': sid, 'name': name or fname, 'start': 0.0, 'end': 1.0}
        cfg['sounds'].append(entry)
        return {'ok': True, 'sound': entry, 'config': _write_tinkle_config(cfg)}

    def remove_tinkle_audio(self, sid):
        """从音频池移除一条:删文件 + 删条目。"""
        sid = str(sid or '')
        if not sid.isalnum():
            return {'ok': False, 'error': 'bad id'}
        try:
            for old in TINKLE_DIR.glob(TINKLE_AUDIO_STEM + sid + '.*'):
                try:
                    old.unlink()
                except OSError:
                    pass
        except Exception:
            pass
        cfg = _load_tinkle_config()
        cfg['sounds'] = [s for s in cfg['sounds'] if s.get('id') != sid]
        return {'ok': True, 'config': _write_tinkle_config(cfg)}

    def clear_tinkle_audio(self):
        """清空音频池,回到内置合成铃声。"""
        try:
            for old in TINKLE_DIR.glob(TINKLE_AUDIO_STEM + '*'):
                try:
                    old.unlink()
                except OSError:
                    pass
        except Exception:
            pass
        cfg = _load_tinkle_config()
        cfg['sounds'] = []
        return {'ok': True, 'config': _write_tinkle_config(cfg)}


SHELL_HTML = r"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>KolidUI</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; background: #111; color: #fff;
                 font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
    /* ---- 顶栏(自绘标题栏;app-region: drag 由 WebView2 转交系统原生标题栏行为) ---- */
    #titlebar { display: flex; align-items: center; height: 36px; background: #101012;
                border-bottom: 1px solid #232326; user-select: none;
                app-region: drag; -webkit-app-region: drag; }
    #titlebar .side { display: flex; align-items: center; gap: 2px; height: 100%; }
    #titlebar .spacer { flex: 1; height: 100%; }
    .tb-btn { width: 34px; height: 100%; display: flex; align-items: center; justify-content: center;
              color: #b8b8bc; cursor: pointer; font-size: 13px;
              app-region: no-drag; -webkit-app-region: no-drag; }
    .tb-btn:hover { background: #232326; color: #fff; }
    .tb-btn svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 1.8;
                  stroke-linecap: round; stroke-linejoin: round; }
    .win-btn { width: 44px; }
    .win-btn:hover { background: #2c2c2e; }
    .win-btn.close:hover { background: #e81123; color: #fff; }
    /* 中间 pill:页面切换 */
    #pagepill { display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 12px;
                margin-top: 2px; border-radius: 12px; background: #1c1c1e; font-size: 12px;
                color: #ccc; cursor: pointer;
                app-region: no-drag; -webkit-app-region: no-drag; }
    #pagepill:hover { background: #26262a; }
    #pagepill .chev { font-size: 9px; color: #888; }
    #pagepill .label { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #pillmenu { position: absolute; top: 30px; left: 50%; transform: translateX(-50%);
                min-width: 200px; max-height: 300px; overflow-y: auto; background: #1c1c1e;
                border: 1px solid #2c2c2e; border-radius: 8px; padding: 4px; z-index: 99;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5); display: none; }
    #pillmenu.open { display: block; }
    #pillmenu .item { padding: 7px 10px; border-radius: 6px; font-size: 12.5px; color: #ccc;
                      cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #pillmenu .item:hover { background: #2c2c2e; color: #fff; }
    #pillmenu .item.active { color: #0a84ff; }
    #pillmenu .empty { padding: 10px; font-size: 12px; color: #666; text-align: center; }
    /* ---- 左上角主菜单(menuBtn)---- */
    #mainmenu { position: absolute; top: 34px; left: 4px; min-width: 190px; background: #1c1c1e;
                border: 1px solid #2c2c2e; border-radius: 8px; padding: 4px; z-index: 99;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5); display: none; }
    #mainmenu.open { display: block; }
    #mainmenu .item { padding: 7px 10px; border-radius: 6px; font-size: 12.5px; color: #ccc;
                      cursor: pointer; white-space: nowrap; }
    #mainmenu .item:hover { background: #2c2c2e; color: #fff; }
    .tb-btn.on { color: #0a84ff; }
    .tb-btn.on:hover { color: #3da0ff; }
    /* ---- User Setting Modal ---- */
    #modalOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1000;
                    display: none; align-items: center; justify-content: center;
                    app-region: no-drag; -webkit-app-region: no-drag; }
    #modalOverlay.open { display: flex; }
    .modal { width: 540px; max-width: calc(100vw - 48px); background: #1c1c1e;
             border: 1px solid #2c2c2e; border-radius: 12px;
             box-shadow: 0 16px 48px rgba(0,0,0,0.6); overflow: hidden; }
    .modal-head { display: flex; align-items: center; justify-content: space-between;
                  padding: 12px 16px; border-bottom: 1px solid #2c2c2e;
                  font-size: 13.5px; font-weight: 600; color: #fff; }
    .modal-x { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
               border-radius: 6px; color: #888; cursor: pointer; font-size: 15px; }
    .modal-x:hover { background: #2c2c2e; color: #fff; }
    .modal-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; }
    .set-title { font-size: 13px; font-weight: 600; color: #eee; }
    .set-hint { font-size: 11.5px; color: #777; line-height: 1.5; margin-top: -6px; }
    .set-file-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    #tinkleStatus { font-size: 11.5px; color: #e05555; overflow: hidden; text-overflow: ellipsis;
                    white-space: nowrap; }
    /* 音频池条目:点击选中(波形条调它的段落),× 单独移除 */
    #tinkleSounds { display: flex; flex-wrap: wrap; gap: 6px; min-height: 20px; }
    #tinkleSounds .t-empty { font-size: 12px; color: #777; padding: 2px 0; }
    .t-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 210px; padding: 4px 9px;
              border: 1px solid #2c2c2e; border-radius: 12px; background: #232327; font-size: 11.5px;
              color: #bbb; cursor: pointer; user-select: none; }
    .t-chip:hover { background: #2c2c2e; }
    .t-chip.sel { border-color: #0a84ff; background: rgba(10,132,255,0.16); color: #fff; }
    .t-chip .t-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .t-chip .t-x { flex: 0 0 auto; width: 15px; height: 15px; display: inline-flex; align-items: center;
                   justify-content: center; border-radius: 50%; color: #888; font-size: 11px; }
    .t-chip .t-x:hover { background: #3a3a3c; color: #fff; }
    .set-btn { padding: 6px 12px; border: 1px solid #2c2c2e; border-radius: 7px; background: #26262a;
               color: #ddd; font-size: 12px; cursor: pointer; white-space: nowrap; }
    .set-btn:hover { background: #303034; color: #fff; }
    .set-btn.primary { background: #0a84ff; border-color: #0a84ff; color: #fff; }
    .set-btn.primary:hover { background: #2f97ff; }
    .set-btn.primary:disabled { opacity: 0.5; cursor: default; }
    .set-btn.ghost { padding: 6px 9px; background: transparent; color: #888; }
    .set-btn.ghost:hover { background: #2c2c2e; color: #fff; }
    /* 音乐条:波形 + 选段 */
    #waveWrap { position: relative; height: 84px; border: 1px solid #2c2c2e; border-radius: 8px;
                background: #141416; overflow: hidden; }
    #waveCanvas { width: 100%; height: 100%; display: block; touch-action: none;
                  user-select: none; -webkit-user-drag: none; }
    #waveCanvas.editable { cursor: ew-resize; }
    .wave-times { display: flex; justify-content: space-between; font-size: 11px;
                  color: #777; font-variant-numeric: tabular-nums; margin-top: -4px; }
    .set-row { display: flex; align-items: center; gap: 12px; }
    .set-vol { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #aaa; }
    .set-vol input[type=range] { width: 130px; accent-color: #0a84ff; }
    /* ---- 标签栏 ---- */
    #tabbar { display: flex; align-items: stretch; height: 34px; background: #161618;
              border-bottom: 1px solid #232326; overflow-x: auto; scrollbar-width: none; }
    #tabbar::-webkit-scrollbar { display: none; }
    .tab { display: flex; align-items: center; gap: 6px; padding: 0 8px 0 12px; max-width: 220px;
           font-size: 12.5px; color: #999; cursor: pointer; border-right: 1px solid #232326;
           white-space: nowrap; user-select: none; }
    .tab.active { background: #111; color: #fff; box-shadow: inset 0 -2px 0 #0a84ff; }
    .tab .close { width: 16px; height: 16px; border-radius: 50%; display: flex; align-items: center;
                  justify-content: center; font-size: 11px; color: #888; flex-shrink: 0; }
    .tab .close:hover { background: #3a3a3c; color: #fff; }
    .tab .label { overflow: hidden; text-overflow: ellipsis; }
    .tab .dot { width: 6px; height: 6px; border-radius: 50%; background: #30d158; flex-shrink: 0; }
    /* ---- 装载区 ---- */
    #stage { position: relative; height: calc(100% - 70px); }
    .page { position: absolute; inset: 0; display: none; }
    .page.active { display: block; }
    .page iframe { width: 100%; height: 100%; border: none; background: #111; }
    #empty { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 10px;
             align-items: center; justify-content: center; color: #555; }
    #empty .logo { font-size: 40px; font-weight: 200; letter-spacing: 2px; color: #3a3a3c; }
    #empty.hidden { display: none; }
</style>
</head>
<body>
<div id="titlebar">
    <div class="side" id="dragzone">
        <div class="tb-btn" id="menuBtn" title="KolidUI">
            <svg viewBox="0 0 24 24"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
        </div>
        <div class="tb-btn" id="reloadBtn" title="Reload current page">
            <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><polyline points="20 5 20 11 14 11"/></svg>
        </div>
    </div>
    <div class="spacer" id="dragzone2"></div>
    <div id="pagepill" title="Switch page">
        <img width="18" height="18" src="data:image/png;base64,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"/>
        <span class="label" id="pillLabel">KolidUI</span>
        <span class="chev">&#9662;</span>
    </div>
    <div class="spacer" id="dragzone3"></div>
    <div class="side">
        <div class="tb-btn win-btn" id="bellBtn" title="Tinkle off — 在 User Setting 里配置铃声">
            <svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
        </div>
        <div class="tb-btn win-btn" id="minBtn" title="Minimize"><svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
        <div class="tb-btn win-btn" id="maxBtn" title="Maximize">
            <svg id="icoMax" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>
            <svg id="icoRestore" viewBox="0 0 24 24" style="display:none"><rect x="4" y="8" width="11" height="11" rx="1"/><polyline points="8 4 19 4 19 15"/></svg>
        </div>
        <div class="tb-btn win-btn close" id="closeBtn" title="Close"><svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></div>
    </div>
</div>
<div id="pillmenu"></div>
<div id="mainmenu">
    <div class="item" id="userSettingItem">User Setting</div>
</div>
<div id="modalOverlay">
    <div class="modal">
        <div class="modal-head"><span>User Setting</span><span class="modal-x" id="settingsClose">&#215;</span></div>
        <div class="modal-body">
            <div class="set-title">Tinkle</div>
            <div class="set-hint">Blend 工作台的 pipeline blocks 跑完时,随机播放音频池里的一条。标题栏最小化按钮左侧的铃铛是
                总开关,只有亮起时才会响。池为空时播内置铃声。点选一个音频可以单独调它的播放段落。</div>
            <div class="set-file-row">
                <button class="set-btn" id="tinklePickBtn">Choose audio…</button>
                <button class="set-btn ghost" id="tinkleClearBtn" title="Remove all sounds, back to built-in chime">&#10005;</button>
                <span id="tinkleStatus"></span>
            </div>
            <div id="tinkleSounds"></div>
            <div id="waveWrap"><canvas id="waveCanvas"></canvas></div>
            <div class="wave-times"><span id="tinkleTStart">0:00.0</span><span>拖动两个手柄选择播放的段落</span><span id="tinkleTEnd">0:00.0</span></div>
            <div class="set-row">
                <button class="set-btn primary" id="tinklePreviewBtn">&#9654; Preview</button>
                <label class="set-vol">Volume <input type="range" id="tinkleVol" min="0" max="100" value="90"></label>
            </div>
        </div>
    </div>
</div>
<input type="file" id="tinkleFile" multiple accept="audio/*,.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.opus,.webm,.weba" hidden>
<div id="tabbar"></div>
<div id="stage">
    <div id="empty">
        <div class="logo">KOLID UI</div>
        <div>No pages yet — run a node in ComfyUI and its UI will be injected here.</div>
        <div style="font-size:12px">在 ComfyUI 里执行带界面的节点,页面会自动注入为本窗口的标签页</div>
    </div>
</div>
<script>
    const api = () => window.pywebview && window.pywebview.api;
    const tabbar = document.getElementById('tabbar');
    const stage = document.getElementById('stage');
    const empty = document.getElementById('empty');
    const pillLabel = document.getElementById('pillLabel');
    const pillmenu = document.getElementById('pillmenu');
    let tabs = [];   // {id, url, title, root, frame}
    let activeId = null;

    // 页签 URL 列表镜像给 Python(应用退出时靠它给每个节点补发 /window_closed)
    function syncTabs() {
        try { api() && api().tabs_changed(tabs.map(t => t.url)); } catch (err) {}
    }

    function render() {
        tabbar.innerHTML = '';
        for (const t of tabs) {
            const el = document.createElement('div');
            el.className = 'tab' + (t.id === activeId ? ' active' : '');
            const dot = document.createElement('span'); dot.className = 'dot';
            const label = document.createElement('span'); label.className = 'label'; label.textContent = t.title;
            const close = document.createElement('span'); close.className = 'close'; close.textContent = '\u00d7';
            close.onclick = (e) => { e.stopPropagation(); closeTabFromShell(t); };
            el.onclick = () => activate(t.id);
            el.append(dot, label, close);
            tabbar.appendChild(el);
        }
        for (const t of tabs) t.root.classList.toggle('active', t.id === activeId);
        empty.classList.toggle('hidden', tabs.length > 0);
        const act = tabs.find(t => t.id === activeId);
        pillLabel.textContent = act ? act.title : 'KolidUI';
        pillmenu.innerHTML = '';
        if (!tabs.length) {
            const d = document.createElement('div'); d.className = 'empty';
            d.textContent = 'No pages yet';
            pillmenu.appendChild(d);
        }
        for (const t of tabs) {
            const d = document.createElement('div');
            d.className = 'item' + (t.id === activeId ? ' active' : '');
            d.textContent = t.title;
            d.onclick = () => { activate(t.id); pillmenu.classList.remove('open'); };
            pillmenu.appendChild(d);
        }
    }

    function addTab(url, title) {
        const existing = tabs.find(t => t.url === url);
        if (existing) { activate(existing.id); return; }
        const id = 'tab-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
        const root = document.createElement('div');
        root.className = 'page';
        const frame = document.createElement('iframe');
        frame.src = url;
        frame.allow = 'clipboard-read; clipboard-write';
        root.appendChild(frame);
        stage.appendChild(root);
        tabs.push({ id, url, title: title || url, root, frame });
        activeId = id;
        render();
        syncTabs();
    }

    function activate(id) { activeId = id; render(); }

    function removeTab(id) {
        const idx = tabs.findIndex(t => t.id === id);
        if (idx === -1) return;
        const t = tabs[idx];
        t.root.remove();
        tabs.splice(idx, 1);
        if (activeId === id) activeId = tabs.length ? tabs[Math.max(0, idx - 1)].id : null;
        render();
        syncTabs();
    }

    // 页签 ×:先让页面把 beforeunload 的通知发出去(跨源 iframe 摘除不会自己
    // 触发它),350ms 后再真正摘除;期间先把容器藏掉,视觉上立即消失。
    // tab_closed 是双保险:页面没有 beforeunload 处理器时由 Python 直接补 POST。
    function closeTabFromShell(t) {
        if (!tabs.includes(t)) return;
        try { t.frame.contentWindow.postMessage({ __kolid: 'pageClose' }, '*'); } catch (err) {}
        try { api() && api().tab_closed(t.url); } catch (err) {}
        t.root.style.display = 'none';
        setTimeout(() => removeTab(t.id), 350);
    }

    // 页面自发的 window.close()(跨源 iframe 里是 no-op)由页面里的 shim 转发
    // 到这里:按 e.source 认领页签关掉。刻意不补发 /window_closed —— 这类关闭
    // 都发生在页面已经发出真实信号(confirm/finish/select…)之后,补发会把
    // 「已确认」翻成「已取消」;浏览器里这次竞态也几乎总是节点先走。
    window.addEventListener('message', (e) => {
        if (!e.data || e.data.__kolid !== 'closeTab') return;
        const t = tabs.find(x => x.frame && x.frame.contentWindow === e.source);
        if (t) removeTab(t.id);
    });

    function reloadActive() {
        const act = tabs.find(t => t.id === activeId);
        if (act) act.frame.src = act.frame.src;  // 跨端口 iframe,重设 src 重新导航
    }

    // Python 侧在最大化/还原后回调,交换标题栏图标
    function setMaximized(state) {
        document.getElementById('icoMax').style.display = state ? 'none' : 'block';
        document.getElementById('icoRestore').style.display = state ? 'block' : 'none';
    }

    // 拖动/双击最大化/右键系统菜单:标题栏 app-region 由 WebView2 转交系统原生行为
    document.getElementById('minBtn').onclick = () => api() && api().window_min();
    document.getElementById('maxBtn').onclick = () => api() && api().window_max_toggle();
    document.getElementById('closeBtn').onclick = () => api() && api().window_close();
    document.getElementById('reloadBtn').onclick = () => reloadActive();
    document.getElementById('pagepill').onclick = (e) => { e.stopPropagation(); pillmenu.classList.toggle('open'); };
    document.addEventListener('click', (e) => {
        if (!pillmenu.contains(e.target) && e.target.closest && !e.target.closest('#pagepill')) pillmenu.classList.remove('open');
        if (!mainmenu.contains(e.target) && e.target.closest && !e.target.closest('#menuBtn')) mainmenu.classList.remove('open');
    });

    // ---- Tinkle(铃声)----
    // 配置与音频池都在 Python 侧(~/.kolid_comfy/):tinkle.json 存 enabled/volume/sounds,
    // 音频原件 tinkle_audio_<id>.<ext> 由 /tinkle_audio?id= 同源取。Blend 工作台(sampler 页)
    // 跑完 pipeline blocks 时向父窗口 postMessage {__kolid:'tinkle'},触发时随机播池中一条;
    // 响不响由铃铛总开关(tinkleCfg.enabled)决定。
    const bellBtn = document.getElementById('bellBtn');
    const mainmenu = document.getElementById('mainmenu');
    const modalOverlay = document.getElementById('modalOverlay');
    const waveCanvas = document.getElementById('waveCanvas');
    const tinkleFileInput = document.getElementById('tinkleFile');
    let tinkleCfg = { enabled: false, volume: 0.9, sounds: [] };   // sounds: [{id,name,start,end}]
    let tinkleAC = null;                 // 共享 AudioContext
    let tinkleSelId = null;              // 波形条正在编辑的音频(选段按条独立保存)
    const tinkleBuffers = new Map();     // id → AudioBuffer(解码缓存)
    let tinkleNodes = [];        // 正在响的节点(Preview 可停)
    let lastTinkleAt = 0;        // 1.5s 节流:连续完成不叠罗汉
    let waveDrag = null;         // 'start' | 'end'

    const fmtTime = (s) => {
        if (!isFinite(s)) s = 0;
        const m = Math.floor(s / 60), sec = s - m * 60;
        return m + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1);
    };

    const selSound = () => tinkleCfg.sounds.find(s => s.id === tinkleSelId) || null;

    function saveTinkleCfg() {
        try { const a = api(); a && a.save_tinkle_config(JSON.parse(JSON.stringify(tinkleCfg))); } catch (err) {}
    }

    function updateBellBtn() {
        bellBtn.classList.toggle('on', !!tinkleCfg.enabled);
        bellBtn.title = tinkleCfg.enabled
            ? 'Tinkle on — run finished will chime (click to turn off)'
            : 'Tinkle off — 在 User Setting 里配置铃声';
    }

    function stopTinkle() {
        for (const n of tinkleNodes) {
            try {
                // stop() 同样会触发 onended:先摘掉,别让旧源的收尾把新一次播放的
                // 状态(Preview 按钮/节点表)清掉
                n.onended = null;
                n.stop ? n.stop() : n.disconnect();
            } catch (err) {}
        }
        tinkleNodes = [];
        setPreviewPlaying(false);
    }

    function setPreviewPlaying(on) {
        const b = document.getElementById('tinklePreviewBtn');
        b.innerHTML = on ? '&#9632; Stop' : '&#9654; Preview';
    }

    function tinkleAudioCtx() {
        if (!tinkleAC) tinkleAC = new (window.AudioContext || window.webkitAudioContext)();
        if (tinkleAC.state === 'suspended') tinkleAC.resume();
        return tinkleAC;
    }

    // 内置铃声:三连上行铃音(E6-G6-C7),双正弦分音模拟铃的金属感
    function playBuiltInChime(vol) {
        const ac = tinkleAudioCtx();
        const t0 = ac.currentTime + 0.02;
        [[1318.51, 0], [1567.98, 0.16], [2093.00, 0.32]].forEach(([f, dt]) => {
            [[1, 0.32], [2.756, 0.07]].forEach(([mul, amp]) => {
                const o = ac.createOscillator(), g = ac.createGain();
                o.type = 'sine'; o.frequency.value = f * mul;
                g.gain.setValueAtTime(0.0001, t0 + dt);
                g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * vol), t0 + dt + 0.008);
                g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 1.1);
                o.connect(g); g.connect(ac.destination);
                o.start(t0 + dt); o.stop(t0 + dt + 1.2);
                tinkleNodes.push(o);
            });
        });
    }

    async function loadTinkleBuffer(id, force) {
        if (!force && tinkleBuffers.has(id)) return tinkleBuffers.get(id);
        const r = await fetch('/tinkle_audio?id=' + encodeURIComponent(id), { cache: 'no-store' });
        if (!r.ok) throw new Error('no audio');
        const buf = await r.arrayBuffer();
        const ab = await tinkleAudioCtx().decodeAudioData(buf);
        tinkleBuffers.set(id, ab);
        return ab;
    }

    function playSegment(buffer, start, end) {
        const ac = tinkleAudioCtx();
        const src = ac.createBufferSource(), g = ac.createGain();
        src.buffer = buffer;
        g.gain.value = Math.min(1, Math.max(0, Number(tinkleCfg.volume) || 0));
        src.connect(g); g.connect(ac.destination);
        const dur = Math.max(0.05, (end - start) * buffer.duration);
        src.start(0, start * buffer.duration, dur);
        src.onended = () => { tinkleNodes = tinkleNodes.filter(n => n !== src); setPreviewPlaying(false); };
        tinkleNodes.push(src);
        setPreviewPlaying(true);
    }

    // 触发入口:随机挑池中一条播;池空或拉取失败回退内置铃声
    async function playTinkle(force) {
        if (!force && !tinkleCfg.enabled) return;
        stopTinkle();
        const pool = tinkleCfg.sounds;
        if (!pool.length) {
            playBuiltInChime(Math.min(1, Math.max(0, Number(tinkleCfg.volume) || 0)));
            setPreviewPlaying(true);
            return;
        }
        const pick = pool[Math.floor(Math.random() * pool.length)];
        try {
            const buf = await loadTinkleBuffer(pick.id);
            stopTinkle();
            playSegment(buf, pick.start, pick.end);
        } catch (err) {
            tinkleBuffers.delete(pick.id);
            playBuiltInChime(Math.min(1, Math.max(0, Number(tinkleCfg.volume) || 0)));
            setPreviewPlaying(true);
        }
    }

    // pipeline blocks 跑完(仅 'done';取消/报错不响)
    window.addEventListener('message', (e) => {
        if (!e.data || e.data.__kolid !== 'tinkle' || e.data.event !== 'pipeline-done') return;
        const now = Date.now();
        if (now - lastTinkleAt < 1500) return;
        lastTinkleAt = now;
        playTinkle(false);
    });

    // ---- 波形选段(音乐条;编辑的是当前选中的那条音频)----
    function drawWave() {
        const wrap = document.getElementById('waveWrap');
        const snd = selSound();
        const buf = snd ? tinkleBuffers.get(snd.id) : null;
        const dpr = window.devicePixelRatio || 1;
        const w = wrap.clientWidth, h = wrap.clientHeight;
        if (waveCanvas.width !== w * dpr || waveCanvas.height !== h * dpr) {
            waveCanvas.width = w * dpr; waveCanvas.height = h * dpr;
        }
        const ctx = waveCanvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const mid = h / 2;
        if (!buf) {
            waveCanvas.classList.remove('editable');
            ctx.strokeStyle = '#3a3a3c'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
            ctx.fillStyle = '#666'; ctx.font = '12px -apple-system, Segoe UI, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(snd ? 'Loading audio…' : 'No audio — built-in chime', w / 2, mid - 10);
            document.getElementById('tinkleTStart').textContent = '0:00.0';
            document.getElementById('tinkleTEnd').textContent = '0:00.0';
            return;
        }
        waveCanvas.classList.add('editable');
        const ch = buf.getChannelData(0);
        const bars = Math.max(60, Math.floor(w / 3));
        const per = Math.floor(ch.length / bars) || 1;
        const peaks = new Float32Array(bars);
        for (let i = 0; i < bars; i++) {
            let mx = 0;
            for (let j = i * per; j < (i + 1) * per && j < ch.length; j += 4) {
                const v = Math.abs(ch[j]);
                if (v > mx) mx = v;
            }
            peaks[i] = mx;
        }
        const mx = Math.max(0.02, ...peaks);
        const s = Math.round(snd.start * bars), e = Math.max(s + 1, Math.round(snd.end * bars));
        const bw = w / bars;
        for (let i = 0; i < bars; i++) {
            const bh = Math.max(2, (peaks[i] / mx) * (h - 14));
            const inSel = i >= s && i < e;
            ctx.fillStyle = inSel ? '#0a84ff' : 'rgba(255,255,255,0.22)';
            ctx.fillRect(i * bw, mid - bh / 2, Math.max(1, bw - 1), bh);
        }
        // 两个选段手柄
        for (const f of [snd.start, snd.end]) {
            const x = f * w;
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, h - 4); ctx.stroke();
            ctx.fillStyle = '#0a84ff';
            ctx.beginPath(); ctx.arc(x, 8, 4.5, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
        }
        const total = buf.duration;
        document.getElementById('tinkleTStart').textContent = fmtTime(snd.start * total);
        document.getElementById('tinkleTEnd').textContent = fmtTime(snd.end * total);
    }

    // 拖拽监听挂在 document 上,不依赖 setPointerCapture:WebView2 开着非客户区
    // 支持(NC region),画布级 capture 在真实鼠标下会丢 move;document 级
    // down/move/up 只要按下点落在画布内就接管,拖出边界也不断。
    const fracFromEvent = (e) => {
        const r = waveCanvas.getBoundingClientRect();
        return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };

    document.addEventListener('pointerdown', (e) => {
        if (!modalOverlay.classList.contains('open') || !selSound() || !tinkleBuffers.get(tinkleSelId)) return;
        const r = waveCanvas.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
        const f = fracFromEvent(e);
        waveDrag = Math.abs(f - selSound().start) <= Math.abs(f - selSound().end) ? 'start' : 'end';
        e.preventDefault();   // 别让浏览器起原生拖拽/选区
        applyWaveDrag(f);
    });
    document.addEventListener('pointermove', (e) => {
        if (!waveDrag) return;
        applyWaveDrag(fracFromEvent(e));
    });
    const endWaveDrag = () => {
        if (!waveDrag) return;
        waveDrag = null;
        saveTinkleCfg();
    };
    document.addEventListener('pointerup', endWaveDrag);
    document.addEventListener('pointercancel', endWaveDrag);

    function applyWaveDrag(f) {
        const snd = selSound();
        if (!snd) return;
        const minGap = Math.min(0.02, 0.05 / Math.max(0.1, tinkleBuffers.get(snd.id).duration));  // ≈50ms
        if (waveDrag === 'start') snd.start = Math.min(f, snd.end - minGap);
        else snd.end = Math.max(f, snd.start + minGap);
        snd.start = Math.min(1, Math.max(0, snd.start));
        snd.end = Math.min(1, Math.max(0, snd.end));
        drawWave();
    }

    // ---- 音频池条目(chips)----
    function renderChips() {
        const box = document.getElementById('tinkleSounds');
        box.innerHTML = '';
        if (!tinkleCfg.sounds.length) {
            tinkleSelId = null;
            const d = document.createElement('span');
            d.className = 't-empty';
            d.textContent = 'Built-in chime';
            box.appendChild(d);
            return;
        }
        if (!selSound()) tinkleSelId = tinkleCfg.sounds[0].id;
        for (const s of tinkleCfg.sounds) {
            const chip = document.createElement('span');
            chip.className = 't-chip' + (s.id === tinkleSelId ? ' sel' : '');
            const nm = document.createElement('span');
            nm.className = 't-name'; nm.textContent = s.name; nm.title = s.name;
            const x = document.createElement('span');
            x.className = 't-x'; x.textContent = '\u00d7'; x.title = 'Remove';
            x.onclick = (e) => { e.stopPropagation(); removeSound(s.id); };
            chip.onclick = () => {
                if (tinkleSelId === s.id) return;
                tinkleSelId = s.id;
                renderChips();
                drawWave();
                if (!tinkleBuffers.has(s.id)) {
                    loadTinkleBuffer(s.id).then(() => { if (tinkleSelId === s.id) drawWave(); })
                        .catch(e => { document.getElementById('tinkleStatus').textContent = 'Load failed: ' + e; });
                }
            };
            chip.append(nm, x);
            box.appendChild(chip);
        }
    }

    async function removeSound(id) {
        try {
            const a = api();
            const r = a && await a.remove_tinkle_audio(id);
            if (r && r.config) tinkleCfg = { ...tinkleCfg, ...r.config };
        } catch (err) {}
        tinkleBuffers.delete(id);
        if (tinkleSelId === id) tinkleSelId = (tinkleCfg.sounds[0] || {}).id || null;
        renderChips();
        drawWave();
    }

    // ---- User Setting Modal ----
    function openSettings() {
        mainmenu.classList.remove('open');
        modalOverlay.classList.add('open');
        stopTinkle();
        document.getElementById('tinkleVol').value = Math.round((tinkleCfg.volume || 0.9) * 100);
        renderChips();
        drawWave();
        const snd = selSound();
        if (snd && !tinkleBuffers.has(snd.id)) loadTinkleBuffer(snd.id).then(drawWave).catch(() => {});
    }
    function closeSettings() {
        modalOverlay.classList.remove('open');
        stopTinkle();
    }
    document.getElementById('menuBtn').onclick = (e) => {
        e.stopPropagation();
        pillmenu.classList.remove('open');
        mainmenu.classList.toggle('open');
    };
    document.getElementById('userSettingItem').onclick = openSettings;
    document.getElementById('settingsClose').onclick = closeSettings;
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeSettings(); });
    document.getElementById('tinkleVol').addEventListener('input', (e) => {
        tinkleCfg.volume = Number(e.target.value) / 100;
        saveTinkleCfg();
    });
    document.getElementById('tinklePickBtn').onclick = () => tinkleFileInput.click();
    document.getElementById('tinkleClearBtn').onclick = async () => {
        try {
            const a = api();
            const r = a && await a.clear_tinkle_audio();
            if (r && r.config) tinkleCfg = { ...tinkleCfg, ...r.config };
        } catch (err) {}
        tinkleBuffers.clear();
        document.getElementById('tinkleStatus').textContent = '';
        renderChips();
        drawWave();
    };
    tinkleFileInput.addEventListener('change', async () => {
        const files = Array.from(tinkleFileInput.files || []);
        tinkleFileInput.value = '';
        const status = document.getElementById('tinkleStatus');
        status.textContent = '';
        for (const file of files) {
            // 整文件 base64 上传给 Python 落盘(铃声文件一般都很小)
            const buf = await file.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }
            try {
                const a = api();
                const r = a && await a.save_tinkle_audio(file.name, btoa(bin));
                if (r && r.ok && r.config) {
                    tinkleCfg = { ...tinkleCfg, ...r.config };
                    tinkleSelId = r.sound ? r.sound.id : tinkleSelId;
                } else {
                    status.textContent = 'Failed: ' + ((r && r.error) || file.name);
                }
            } catch (err) {
                status.textContent = 'Failed: ' + file.name;
            }
        }
        renderChips();
        drawWave();
        const snd = selSound();
        if (snd) loadTinkleBuffer(snd.id).then(drawWave).catch(() => {});
    });
    document.getElementById('tinklePreviewBtn').onclick = () => {
        if (tinkleNodes.length) { stopTinkle(); return; }
        const snd = selSound();
        if (!snd) {
            // 池空:直接听内置铃声
            playBuiltInChime(Math.min(1, Math.max(0, Number(tinkleCfg.volume) || 0)));
            setPreviewPlaying(true);
            return;
        }
        setPreviewPlaying(true);
        loadTinkleBuffer(snd.id, true).then((buf) => {
            stopTinkle();
            playSegment(buf, snd.start, snd.end);   // Preview 是显式动作,不受铃铛开关限制
        }).catch(() => {
            tinkleBuffers.delete(snd.id);
            playBuiltInChime(Math.min(1, Math.max(0, Number(tinkleCfg.volume) || 0)));
            setPreviewPlaying(true);
        });
    };
    bellBtn.onclick = () => {
        tinkleCfg.enabled = !tinkleCfg.enabled;
        updateBellBtn();
        saveTinkleCfg();
        if (tinkleCfg.enabled) playTinkle(true);   // 开启即时反馈:当场随机响一条
    };

    // 启动:等 pywebview 桥就绪后读回配置,预解码整个音频池(第一次响铃不迟到)
    function initTinkle() {
        const a = api();
        if (!a || !a.get_tinkle_config) {
            initTinkle.tries = (initTinkle.tries || 0) + 1;
            if (initTinkle.tries < 50) setTimeout(initTinkle, 200);
            return;
        }
        a.get_tinkle_config().then((c) => {
            if (c && typeof c === 'object') tinkleCfg = { ...tinkleCfg, ...c };
            updateBellBtn();
            for (const s of tinkleCfg.sounds) loadTinkleBuffer(s.id).catch(() => {});
        }).catch(() => {});
    }
    window.addEventListener('pywebviewready', initTinkle);
    initTinkle();


    // ---- JS 队列自拉(替代注入;原生侧不执行 JS,见 kolid_client.py 文件头)----
    // 长轮询握手服务,拿到的脚本在全局作用域 eval。页面 Reload 后自动重启,
    // 队列存服务端,不丢。
    (function pullLoop() {
        fetch('/pull?token=__PULL_TOKEN__')
            .then(r => r.ok ? r.json() : { scripts: [] })
            .then(d => {
                (d.scripts || []).forEach(s => { try { (0, eval)(s); } catch (e) {} });
                setTimeout(pullLoop, 60);
            })
            .catch(() => setTimeout(pullLoop, 1000));
    })();
</script>
</body>
</html>
"""


class HandshakeHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, data, ctype, code=200, extra_headers=None):
        # 写失败(页面刷新/关窗掐断长轮询)静默 —— 否则 socketserver 会往
        # stderr 打整条 traceback
        try:
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            for k, v in (extra_headers or ()):
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            pass

    def _json(self, obj, code=200):
        self._send(json.dumps(obj).encode('utf-8'), 'application/json', code)

    def _html(self, text):
        self._send(text.encode('utf-8'), 'text/html; charset=utf-8')

    def do_GET(self):
        path, _, query = self.path.partition('?')
        if path in ('/', '/shell'):
            # 壳页面由本服务供页(不再是 NavigateToString):页面与 /pull 同源,
            # 拉取通道不需要任何跨域许可;token 只挡"别的本地页面来接管队列"
            return self._html(SHELL_HTML.replace('__PULL_TOKEN__', _PULL_TOKEN))
        if path == '/ping':
            return self._json({'ok': True, 'client': 'kolidui'})
        if path == '/tinkle_audio':
            # 壳页面同源拉铃声原件(?id= 音频池条目;no-store:增删后立即跟上)
            q = urllib.parse.parse_qs(query)
            sid = q.get('id', [''])[0]
            if sid and not sid.isalnum():
                return self._json({'error': 'bad id'}, 400)
            pattern = TINKLE_AUDIO_STEM + (sid + '.*' if sid else '*')
            TINKLE_DIR.mkdir(parents=True, exist_ok=True)
            matches = sorted(TINKLE_DIR.glob(pattern)) if sid else []
            f = matches[0] if matches else None
            if not f or not f.is_file():
                return self._json({'error': 'no audio'}, 404)
            return self._send(f.read_bytes(),
                              TINKLE_CTYPE.get(f.suffix.lower(), 'application/octet-stream'),
                              extra_headers=[('Cache-Control', 'no-store')])
        if path == '/pull':
            q = urllib.parse.parse_qs(query)
            if q.get('token', [''])[0] != _PULL_TOKEN:
                return self._json({'error': 'forbidden'}, 403)
            deadline = time.time() + 15  # 长轮询:有活即回,没活最多挂 15s
            with _js_cv:
                while not _pending_js:
                    left = deadline - time.time()
                    if left <= 0:
                        break
                    _js_cv.wait(left)
                scripts = _pending_js[:]
                del _pending_js[:]
            if scripts and not _state.get('pull_logged'):
                _state['pull_logged'] = True
                print(f'[KolidUI] pull channel active ({len(scripts)} script(s))')
            return self._json({'scripts': scripts})
        self._json({'error': 'not found'}, 404)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            return self._json({'error': 'bad json'}, 400)
        path = self.path.split('?')[0]
        if path == '/focus':
            _bring_to_front()
            return self._json({'ok': True})
        if path == '/open':
            url = str(body.get('url') or '')
            title = str(body.get('title') or '')
            if not url.startswith('http://') and not url.startswith('https://'):
                return self._json({'error': 'bad url'}, 400)
            if not _is_localhost(url):
                return self._json({'error': 'only localhost urls are accepted'}, 400)
            _open_tab(url, title)
            return self._json({'ok': True})
        return self._json({'error': 'not found'}, 404)


def _open_tab(url, title):
    if not _state['loaded']:
        return
    _post_js('addTab(%s, %s)' % (json.dumps(url, ensure_ascii=False),
                                 json.dumps(title, ensure_ascii=False)))
    _bring_to_front()


def _post_window_closed(origin, timeout=1.5):
    """向节点页补发 POST {origin}/window_closed —— 等价浏览器关页签时
    页面 beforeunload 自己做的那次通知。尽力而为:连不上/超时/任何非 2xx
    都忽略(补发只是通知,不是协议)。"""
    try:
        req = urllib.request.Request(origin + '/window_closed', data=b'{}',
                                     headers={'Content-Type': 'application/json'},
                                     method='POST')
        urllib.request.urlopen(req, timeout=timeout).close()
    except Exception:
        pass


def _notify_tabs_window_closed(budget=0.5):
    """应用退出(WM_CLOSE)= 浏览器关掉整个窗口:给每个还开着页签的节点
    补发 /window_closed,否则正在等界面的节点会一直挂住。并行发,总等待
    预算 budget 秒;没有页签时零开销(关窗路径保持极简)。"""
    urls = list(_tabs.get('urls') or [])
    if not urls:
        return
    threads = []
    for url in urls:
        try:
            if not (url.startswith('http://') or url.startswith('https://')) or not _is_localhost(url):
                continue
            u = urllib.parse.urlparse(url)
            t = threading.Thread(target=_post_window_closed,
                                 args=('%s://%s' % (u.scheme, u.netloc), 0.8), daemon=True)
            t.start()
            threads.append(t)
        except Exception:
            continue
    deadline = time.time() + budget
    for t in threads:
        left = deadline - time.time()
        if left <= 0:
            break
        t.join(left)


def _bring_to_front():
    """服务器线程调用:全程 ctypes(不碰 .NET),JS focus 走 _post_js。"""
    hwnd = _shell.get('hwnd') or 0
    if not hwnd:
        return
    h = wt.HWND(hwnd)
    try:
        if _user32.IsIconic(h):
            _user32.ShowWindow(h, SW_RESTORE)
        _user32.ShowWindow(h, SW_SHOW)
        _user32.SetForegroundWindow(h)
    except Exception:
        pass
    _post_js('window.focus()')


def _start_server():
    port = _free_port(PORT_RANGE[0])
    if port is None:
        print('[KolidUI] no free port in range', file=sys.stderr)
        sys.exit(1)
    server = ThreadingHTTPServer(('127.0.0.1', port), HandshakeHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    _state['server'] = server
    _write_discovery(port)
    print(f'[KolidUI] handshake server on 127.0.0.1:{port}, discovery: {DISCOVERY_FILE}')
    return port


def _set_window_icon():
    """给窗口设图标(任务栏/Alt-Tab 读 WM_SETICON 的 ICON_BIG)。
    优先 script 旁的 client/icon.ico —— 源码直跑也生效;打包时 --icon 把同一枚
    打进 exe 资源(--add-data 保证 _MEIPASS 里也有),两条路任取其一。"""
    native = _native()
    if native is None:
        return
    try:
        hwnd = int(native.Handle.ToInt64())
        ico = Path(__file__).resolve().parent / 'icon.ico'
        big = small = None
        if ico.is_file():
            big = _user32.LoadImageW(None, str(ico), IMAGE_ICON, 32, 32, LR_LOADFROMFILE)
            small = _user32.LoadImageW(None, str(ico), IMAGE_ICON, 16, 16, LR_LOADFROMFILE)
        if not big and getattr(sys, 'frozen', False):
            big = small = _shell32.ExtractIconW(None, sys.executable, 0)
        if big:
            _user32.SendMessageW(wt.HWND(hwnd), WM_SETICON, 0, small or big)   # ICON_SMALL
            _user32.SendMessageW(wt.HWND(hwnd), WM_SETICON, 1, big)            # ICON_BIG
        else:
            print('[KolidUI] window icon: no icon source found', file=sys.stderr)
    except Exception as e:
        print(f'[KolidUI] set icon failed: {e}', file=sys.stderr)


def _on_loaded():
    """loaded 事件线程(pywebview 每个事件 set 都新起一线程)。这里只做纯 ctypes
    引导:找主窗体 → 挂窗口过程链 → PostMessage(WM_APP_SETUP) 把收尾交给 UI
    线程 —— 不碰 .NET(跨线程读 property 有 AV 先例;且 pywebview 的消息泵在
    .NET 新建的 STA 线程上,不是本进程主线程)。"""
    if _state.get('loaded'):
        return
    _state['loaded'] = True
    hwnd = _find_main_hwnd()
    if hwnd:
        _install_chain(hwnd)
        _user32.PostMessageW(wt.HWND(hwnd), WM_APP_SETUP, 0, 0)


def _focus_existing(timeout_s=3.0):
    """发现文件指向活着的实例就聚焦它并返回 True;文件缺失/陈旧返回 False。"""
    if not DISCOVERY_FILE.exists():
        return False
    try:
        import urllib.request
        info = json.loads(DISCOVERY_FILE.read_text(encoding='utf-8'))
        port = int(info['port'])
    except Exception:
        return False
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            req = urllib.request.Request(f'http://127.0.0.1:{port}/focus', data=b'{}', method='POST')
            with urllib.request.urlopen(req, timeout=1):
                print('[KolidUI] already running — focused existing window')
                return True
        except Exception:
            time.sleep(0.3)
    return False


def main():
    # 二次启动:已有实例在跑就聚焦它,然后退出
    if _focus_existing():
        return

    _load_ui_state()
    port = _start_server()
    # 上次运行留下的 WebView2 profile 此刻已无锁(上个进程已死) —— 后台删,
    # 不占启动时间;正常关闭的运行也走这条路,删的是上一次的目录
    threading.Thread(target=_sweep_old_profiles, daemon=True).start()
    atexit.register(_clear_discovery)

    win = webview.create_window(
        WINDOW_TITLE,
        # 壳页面走本地 HTTP 供页:与 /pull 同源(JS 队列靠页面长轮询自取)
        url='http://127.0.0.1:%d/shell' % port,
        js_api=Api(),
        width=1440, height=900,
        min_size=(MIN_W, MIN_H),
        frameless=True,   # 无原生标题栏;标题栏由壳自绘,行为转交系统
        easy_drag=False,  # 关掉 pywebview 的整页 JS 拖动(它会从任意位置拖走窗口,且与 app-region 原生拖动打架)
        hidden=True,      # 样式补丁与恢复逻辑就绪后再显示
        background_color='#101012',
    )
    _state['window'] = win
    win.events.loaded += _on_loaded
    # 注意:不要订阅 moved/resized/maximized/restored/minimized —— pywebview 每个
    # 事件 set() 都新起一个线程(webview/event.py:57),原生拖动一次产生上百条
    # WM_MOVE → 线程风暴 + pythonnet GC 竞态 → 进程 AccessViolation / UI 卡死。
    # 位置落盘与最大化同步都改在 _form_wndproc(WM_SIZE/WM_EXITSIZEMOVE/WM_CLOSE)
    # 里同步做,零线程。closed 也不订阅:它在关窗瞬间起线程,改在 start() 返回后
    # 同步清理(见下),把最终化期的线程和分配降到最少。

    webview.start(gui='edgechromium' if sys.platform == 'win32' else None)
    _clear_discovery()
    # 硬退出:跳过解释器最终化与 pythonnet 的 PythonEngine.Shutdown —— 3.0.5 在那
    # 里的 PyGC_Collect 会偶发 AV(窗口已正常关闭,退出码却是 0xC0000005)。
    # 此时 .NET 侧已随 start() 返回拆干净,唯一跳过的是会导致崩溃的收尾。
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    _hard_exit(0)


if __name__ == '__main__':
    main()
