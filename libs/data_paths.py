"""用户内容的唯一落点：<pack>/data/<kind>/，永远在包目录里面。

10-05 之前有两种写法：assets_node.py 用双 `..`，结果落到 `custom_nodes/data/` —— 仓库外一级，
搬包/重装/换机器都不会带上那 1.4 GB 媒体；prompt_node 用单 `..`，是对的。现在两种都收进这两个
函数，包里没有第二个地方知道 data/ 在哪。

data_dir 会把 legacy `custom_nodes/data/<kind>` 逐个条目并进包里那份：同名以已迁过去的为准；
正被占用的文件（工作台里还在播的视频）留到下次再并，不让整趟搬家失败。
"""
import os
import shutil

PACK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_ROOT = os.path.join(PACK_ROOT, 'data')
LEGACY_DATA_ROOT = os.path.join(os.path.dirname(PACK_ROOT), 'data')


def data_dir(kind):
    """<pack>/data/<kind>，目录现建；legacy 仓库外那一份逐条目并进来。"""
    target = os.path.join(DATA_ROOT, kind)
    os.makedirs(target, exist_ok=True)
    legacy = os.path.join(LEGACY_DATA_ROOT, kind)
    if os.path.isdir(legacy):
        for entry in sorted(os.listdir(legacy)):
            dst = os.path.join(target, entry)
            if os.path.exists(dst):
                continue
            try:
                shutil.move(os.path.join(legacy, entry), dst)
            except OSError:
                break
        try:
            os.rmdir(legacy)
        except OSError:
            pass
    return target


def data_file(kind, name):
    """<pack>/data/<kind>/<name> —— 单个持久化文件（目录同上，现建并搬家）。"""
    return os.path.join(data_dir(kind), name)
