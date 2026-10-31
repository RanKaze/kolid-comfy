"""KaPluginWorker 的生命周期 —— 插件**只**在这个进程里加载，别再往宿主进程里塞。

为什么要有它：本机真插件里有一个一开就把整个进程带崩的（AGT 附近那个）。崩在 ComfyUI 里
等于连人带所有工程一起没；崩在 worker 里，宿主看到的是心跳停了、命令返回 -92 ——
一件本来就该看得见的事，不会被"整台进程没了"给盖掉。

通道的形状（ka_shm.h）：一块共享内存里同时放命令槽与音频 ring。命令是一次一条的
「填参数 → 敲事件 → 等回执」；音频是 worker 有空就往 ring 里推、宿主按自己节奏取，
**谁都不等谁**。

用法：

    w = PluginWorker(tag='bridge123_s0', slot=0)   # 起进程 + 连第 0 个槽
    w.dll.ka_vst3_scan(path)                       # 先把 DLL 选到这一槽再调
    w.stop()

**一支实例一个槽**：一条 MIDI 轨要自己的音色，就给它自己的 worker（2b）。槽号只是宿主那边
的下标（ka_plug_select 选中的是"命令走哪一槽"），真正的隔离靠 tag 分开的共享内存与进程。

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

# 与 ka_shm.h 的 KA_WORKER_EXIT_TAG 对齐：这个名字已经被另一支活着的 worker 占着。
# 一个名字两支进程 = 两件乐器弹同一串音（重复音），所以后到的那支直接拒绝启动。
ERR_EXIT_TAG = 5


class PluginWorker(object):
    """一个 worker 进程 + 一条到**某个槽**的通道。

    2b 之后一个宿主会有好几个（一条轨一个），所以通道要按槽认：DLL 那边的导出都带
    `_s` 后缀，`slot` 就是 ka_plug_slot 的下标。tag 仍然决定共享内存的名字 —— 每个槽
    一个，互不打架（同一个 tag 被两个进程用就是"连到别人的内存"，见 ka_shm.h）。
    """

    def __init__(self, tag=None, wait=15.0, slot=0):
        self.tag = tag or ('%d' % os.getpid())
        self.slot = int(slot)
        self.proc = None
        self.dll = None
        if not os.path.isfile(EXE):
            raise RuntimeError('KaPluginWorker.exe 还没编：%s（跑 build_worker.ps1）' % EXE)
        if not os.path.isfile(DLL):
            raise RuntimeError('KolidAudio.dll 不在：%s' % DLL)

        self.dll = ctypes.CDLL(DLL)
        if not hasattr(self.dll, 'ka_plug_attach_s'):
            raise RuntimeError('这份 KolidAudio.dll 还没有多实例槽（重启 ComfyUI 让它换成新编的那份）')
        self.dll.ka_plug_attach_s.argtypes = [ctypes.c_int, ctypes.c_wchar_p]
        self.dll.ka_plug_attach_s.restype = ctypes.c_int
        self.dll.ka_plug_ready_s.argtypes = [ctypes.c_int]
        self.dll.ka_plug_ready_s.restype = ctypes.c_int
        self.dll.ka_plug_heartbeat_s.argtypes = [ctypes.c_int]
        self.dll.ka_plug_heartbeat_s.restype = ctypes.c_int
        self.dll.ka_plug_detach_s.argtypes = [ctypes.c_int]
        self.dll.ka_plug_detach_s.restype = ctypes.c_int

        self.proc = subprocess.Popen([EXE, self.tag])

        # worker 要先建好 file mapping，这边才 attach 得上。轮询，别 sleep 一个魔法数 ——
        # 慢机器上"建好"这件事本身要多久是没准的。
        t0 = time.time()
        rc = -2
        while time.time() - t0 < wait:
            rc = self.dll.ka_plug_attach_s(self.slot, self.tag)
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
            if code == ERR_EXIT_TAG:
                raise RuntimeError('tag %r 已经被另一支 worker 占着（退出码 %d）—— '
                                   '上一支还没退干净' % (self.tag, ERR_EXIT_TAG))
            raise RuntimeError('attach 失败 rc=%d（worker 退出码 %s）' % (rc, code))

    # ── 状态 ──────────────────────────────────────────────────────────────────
    def attached(self):
        return bool(self.dll) and self.dll.ka_plug_ready_s(self.slot) == 1

    def running(self):
        """进程还在吗。attach 过但进程没了 = 插件把它带崩了（心跳也就停了）。"""
        return self.proc is not None and self.proc.poll() is None

    def alive(self, grace=0.06):
        """心跳还在动吗。取两次比一次可靠：一次只能看出"它此刻是多少"。"""
        if not self.attached():
            return False
        b = self.dll.ka_plug_heartbeat_s(self.slot)
        if b < 0:
            return False
        time.sleep(grace)
        return self.dll.ka_plug_heartbeat_s(self.slot) != b

    # ── 收尾 ──────────────────────────────────────────────────────────────────
    def stop(self):
        if self.dll is not None:
            try:
                self.dll.ka_plug_detach_s(self.slot)
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
                    # kill 之后**必须再等一次退出**：进程没走完，它手里那块共享内存
                    # （按 tag 命名）还活着，同 tag 的新 worker 会因此拒绝启动（退出码 5）。
                    try:
                        self.proc.wait(timeout=3)
                    except Exception:
                        pass
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
