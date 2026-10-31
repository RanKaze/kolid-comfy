"""KaPluginWorker 的生命周期 —— 插件**只**在这个进程里加载，别再往宿主进程里塞。

为什么要有它：本机真插件里有一个一开就把整个进程带崩的（AGT 附近那个）。崩在 ComfyUI 里
等于连人带所有工程一起没；崩在 worker 里，宿主看到的是心跳停了、命令返回 -92 ——
一件本来就该看得见的事，不会被"整台进程没了"给盖掉。

通道的形状（ka_shm.h）：一块共享内存里同时放命令槽与音频 ring。命令是一次一条的
「填参数 → 敲事件 → 等回执」；音频是 worker 有空就往 ring 里推、宿主按自己节奏取，
**谁都不等谁**。

用法：

    w = PluginWorker()            # 起进程 + 连共享内存
    w.dll.ka_vst3_scan(path)      # 之后所有 ka_vst3_* 照旧，签名一个没变
    w.stop()

宿主进程没了的话 worker 会在 5 秒后自己退（看 host_beat），所以就算这边忘了 stop
也不会留一堆孤儿占着插件。
"""

import ctypes
import os
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
EXE = os.path.join(HERE, 'KaPluginWorker.exe')
DLL = os.path.join(HERE, 'KolidAudio.dll')

# 与 ka_shm.h 对齐：这几个是**通道**的错误码，不是插件的
ERR_NO_WORKER = -91
ERR_DEAD = -92
ERR_TIMEOUT = -93
ERR_SHAPE = -94
ERR_BUSY = -95


class PluginWorker(object):
    """一个 worker 进程 + 一条到它的通道。一个宿主进程只需要一个。"""

    def __init__(self, tag=None, wait=15.0):
        self.tag = tag or ('%d' % os.getpid())
        self.proc = None
        self.dll = None
        if not os.path.isfile(EXE):
            raise RuntimeError('KaPluginWorker.exe 还没编：%s（跑 build_worker.ps1）' % EXE)
        if not os.path.isfile(DLL):
            raise RuntimeError('KolidAudio.dll 不在：%s' % DLL)

        self.dll = ctypes.CDLL(DLL)
        self.dll.ka_plug_attach.argtypes = [ctypes.c_wchar_p]
        self.dll.ka_plug_attach.restype = ctypes.c_int
        self.dll.ka_plug_ready.restype = ctypes.c_int
        self.dll.ka_plug_heartbeat.restype = ctypes.c_int
        self.dll.ka_plug_detach.restype = ctypes.c_int

        self.proc = subprocess.Popen([EXE, self.tag])

        # worker 要先建好 file mapping，这边才 attach 得上。轮询，别 sleep 一个魔法数 ——
        # 慢机器上"建好"这件事本身要多久是没准的。
        t0 = time.time()
        rc = -2
        while time.time() - t0 < wait:
            rc = self.dll.ka_plug_attach(self.tag)
            if rc == 0 or rc == 1:
                break
            if rc not in (-2, -3):
                break                      # 别的错误码是"连上了但不对"，重试也没用
            if self.proc.poll() is not None:
                break                      # 进程已经没了
            time.sleep(0.02)
        if rc not in (0, 1):
            code = (self.proc.poll() if self.proc else None)
            self.stop()
            raise RuntimeError('attach 失败 rc=%d（worker 退出码 %s）' % (rc, code))

    # ── 状态 ──────────────────────────────────────────────────────────────────
    def attached(self):
        return bool(self.dll) and self.dll.ka_plug_ready() == 1

    def alive(self, grace=0.06):
        """心跳还在动吗。取两次比一次可靠：一次只能看出"它此刻是多少"。"""
        if not self.attached():
            return False
        b = self.dll.ka_plug_heartbeat()
        if b < 0:
            return False
        time.sleep(grace)
        return self.dll.ka_plug_heartbeat() != b

    # ── 收尾 ──────────────────────────────────────────────────────────────────
    def stop(self):
        if self.dll is not None:
            try:
                self.dll.ka_plug_detach()
            except Exception:
                pass
            self.dll = None
        if self.proc is not None:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=3)
                except Exception:
                    self.proc.kill()
            self.proc = None

    def __del__(self):
        try:
            self.stop()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.stop()
        return False
