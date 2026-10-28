# -*- coding: utf-8 -*-
"""工具目录的**热读契约**。

工具面的 schema 真源在前端 `ui/sampler_node/src/agent/toolSchemas.ts`，构建时转成
`nodes/workbench/agent_tools.json`，后端按 mtime 读它。这套安排有三个必须成立的承诺，
少一个就会退回"改一句 description 也要重启 ComfyUI"或者"工具悄悄消失":

  1. 目录就是源码那份（条数、名字、sha 对得上，且产物没落后于 TS）；
  2. 文件变了（重新构建）⇒ 下一次读到的是新表，**不需要重启进程**；
  3. 文件读坏（有人手改、或构建写到一半）⇒ 保留上一份，而不是让正在跑的 agent 一个工具都没有。

跑法：`python tests/test_agent_tool_catalog.py`（也接受 pytest）。
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, 'nodes/workbench/agent_backend.py')
TOOLS_JSON = os.path.join(ROOT, 'nodes/workbench/agent_tools.json')
GEN = os.path.join(ROOT, 'tools/gen_agent_tools.cjs')


def _backend():
    """把 agent_backend.py 当普通模块加载（相对导入走 fallback，不碰 ComfyUI）。"""
    spec = importlib.util.spec_from_file_location('kolid_agent_backend_under_test', BACKEND)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _tool_doc(names, sha='test'):
    return {'sha': sha, 'tools': [
        {'type': 'function',
         'function': {'name': n, 'description': '', 'parameters':
                      {'type': 'object', 'properties': {}, 'required': []}}}
        for n in names]}


def test_catalog_is_the_source():
    mod = _backend()
    tools, names = mod.load_agent_tools()
    disk = json.load(open(TOOLS_JSON, encoding='utf-8'))
    assert len(tools) == disk['tool_count'] > 0
    assert len(names) == len(tools)
    assert {t['function']['name'] for t in tools} == {t['function']['name'] for t in disk['tools']}
    # OpenAI 形状：MCP 那边直接把它当 inputSchema 用，缺一层就是空参数表
    assert all(t['type'] == 'function' for t in tools)
    assert all(isinstance(t['function'].get('parameters'), dict) for t in tools)
    assert mod.tool_catalog_meta()['count'] == len(tools)


def test_catalog_json_not_stale():
    """产物落后于 toolSchemas.ts 就让测试红 —— 意味着有人只改了 TS 没构建。"""
    r = subprocess.run(['node', GEN, '--check'], cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, (r.stdout + r.stderr).strip()


def test_hot_reload_without_restarting():
    mod = _backend()
    tmp = os.path.join(tempfile.mkdtemp(prefix='kolid-tools-'), 'agent_tools.json')
    mod._TOOLS_FILE = tmp

    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(_tool_doc(['one'], sha='aaaa'), f)
    first, _ = mod.load_agent_tools()
    assert [t['function']['name'] for t in first] == ['one']

    # 同一个进程里再读一次：文件换了就必须看到新表（这就是"不用重启后端"）
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(_tool_doc(['one', 'two'], sha='bbbb'), f)
    second, names = mod.load_agent_tools()
    assert [t['function']['name'] for t in second] == ['one', 'two']
    assert sorted(names) == ['one', 'two']
    assert mod.tool_catalog_meta()['sha'] == 'bbbb'

    # 内容没变时不许重建（否则每个请求都要解析一遍 64 条 schema）
    assert mod.load_agent_tools()[0] is second


def test_corrupt_file_keeps_last_good_catalog():
    mod = _backend()
    tmp = os.path.join(tempfile.mkdtemp(prefix='kolid-tools-'), 'agent_tools.json')
    mod._TOOLS_FILE = tmp
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(_tool_doc(['keep']), f)
    assert [t['function']['name'] for t in mod.load_agent_tools()[0]] == ['keep']

    with open(tmp, 'w', encoding='utf-8') as f:
        f.write('{ not json')  # 手改坏了 / 构建写了一半
    tools, names = mod.load_agent_tools()
    assert [t['function']['name'] for t in tools] == ['keep'], '读坏了必须保留上一份，不能清空工具表'
    assert set(names) == {'keep'}


def test_missing_file_says_empty_not_crash():
    mod = _backend()
    mod._TOOLS_FILE = os.path.join(tempfile.mkdtemp(), 'nope.json')
    tools, names = mod.load_agent_tools()
    assert tools == [] and names == frozenset()


if __name__ == '__main__':
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_')]
    bad = 0
    for fn in fns:
        try:
            fn()
            print('  ok   ' + fn.__name__)
        except AssertionError as e:
            bad += 1
            print('  FAIL ' + fn.__name__ + ': ' + str(e))
        except Exception as e:  # noqa: BLE001
            bad += 1
            print('  ERR  ' + fn.__name__ + ': ' + repr(e))
    print('\n%d/%d passed' % (len(fns) - bad, len(fns)))
    raise SystemExit(1 if bad else 0)
