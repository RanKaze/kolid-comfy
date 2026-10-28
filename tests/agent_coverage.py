#!/usr/bin/env python
"""agent 工具面的覆盖面体检 —— "用户能做的"与"agent 能做的"差多少，一眼看完。

三条机械尺（不需要谁记得更新文档，全部从源码算出来）：

  G1 动作目录不落后     `nodes/workbench/ui_actions.json` 与 `uiActions.generated.ts` 必须是
                        `ui/sampler_node/src/types.ts` 当前的样子（重跑 `tools/gen_ui_actions.cjs`）。
                        界面加一个按钮、改了动作键，这里立刻红。
  G2 schema ↔ 执行体      `agent/toolSchemas.ts` 的名字集合 必须等于 `agent/tools.ts` 里
                        `case '<name>':` 的集合。这一条其实**编译期就有更硬的**（`tsc` 的
                        switch 穷尽检查），留在这里是为了不装 node_modules 也能体检。
  G2b 产物不落后          `nodes/workbench/agent_tools.json` 必须与 `toolSchemas.ts` 一致
                        （构建会自动重写；有人只改 TS 不构建，后端就会拿着旧表）。
  G3 账本不烂            `agent_coverage.json` 里写的每个 `tool` 必须真的存在；每个 `missing`
                        必须有一句 `why`（欠账要写清楚补什么，不能只留一个空）。

两条软报告（`--strict` 时也变硬）：

  R1 宿主侧写口           `model.ts` 里导出、但 `tools.ts` 一次都没用到的纯函数 —— 那就是
                        "用户能做、agent 做不到"的雷达（复制粘贴、合并段、关键帧都在那儿）。
  R2 账本欠账            按组列出 missing。

用法：
    python tests/agent_coverage.py            # 报告
    python tests/agent_coverage.py --strict   # 有欠账/有雷达项就退 1（将来可以挂进 CI）
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TYPES = os.path.join(ROOT, 'ui/sampler_node/src/types.ts')
TOOLS_TS = os.path.join(ROOT, 'ui/sampler_node/src/agent/tools.ts')
MODEL_TS = os.path.join(ROOT, 'ui/sampler_node/src/workbench/video/model.ts')
SCHEMAS_TS = os.path.join(ROOT, 'ui/sampler_node/src/agent/toolSchemas.ts')
TOOLS_JSON = os.path.join(ROOT, 'nodes/workbench/agent_tools.json')
GEN_TOOLS = os.path.join(ROOT, 'tools/gen_agent_tools.cjs')
ACTIONS_JSON = os.path.join(ROOT, 'nodes/workbench/ui_actions.json')
LEDGER = os.path.join(ROOT, 'nodes/workbench/agent_coverage.json')
GEN = os.path.join(ROOT, 'tools/gen_ui_actions.cjs')

STRICT = '--strict' in sys.argv
fail = []


def read(p: str) -> str:
    with open(p, encoding='utf-8') as f:
        return f.read()


# ── G1 动作目录 ──────────────────────────────────────────────────────────────
def gate_catalog():
    r = subprocess.run(['node', GEN, '--check'], cwd=ROOT, capture_output=True, text=True)
    ok = r.returncode == 0
    detail = (r.stdout or r.stderr).strip().splitlines()
    print(('  ok   ' if ok else '  FAIL ') + 'G1 动作目录与 types.ts 同步' + (': ' + detail[-1] if detail else ''))
    if not ok:
        fail.append('G1 动作目录落后：node tools/gen_ui_actions.cjs')
    return json.loads(read(ACTIONS_JSON))


# ── G2 schema ↔ 执行体 ──────────────────────────────────────────────────────
def gate_schema_vs_executor():
    schema = set(re.findall(r"\n    name: '([a-z0-9_]+)',", read(SCHEMAS_TS)))
    executed = set(re.findall(r"case '([a-z0-9_]+)':", read(TOOLS_TS)))
    only_schema = sorted(schema - executed)
    only_exec = sorted(executed - schema)
    ok = not only_schema and not only_exec
    print(('  ok   ' if ok else '  FAIL ') + f'G2 schema ↔ 执行体：{len(schema)} ↔ {len(executed)}')
    if only_schema:
        print('       只有 schema、没人执行（tsc 也会先拦）：' + ', '.join(only_schema))
        fail.append('G2 只有 schema：' + ', '.join(only_schema))
    if only_exec:
        print('       只有执行、没有 schema（模型看不见这个工具）：' + ', '.join(only_exec))
        fail.append('G2 只有执行：' + ', '.join(only_exec))
    return schema


def gate_catalog_json():
    r = subprocess.run(['node', GEN_TOOLS, '--check'], cwd=ROOT, capture_output=True, text=True)
    ok = r.returncode == 0
    detail = (r.stdout or r.stderr).strip().splitlines()
    print(('  ok   ' if ok else '  FAIL ') + 'G2b 工具产物与 toolSchemas.ts 同步'
          + (': ' + detail[0] if detail else ''))
    if not ok:
        for line in detail[1:4]:
            print('       ' + line.strip())
        fail.append('G2b agent_tools.json 落后：cd ui && npm run build -w sampler_node')


# ── G3 账本 ─────────────────────────────────────────────────────────────────
def gate_ledger(schema: set[str]):
    led = json.loads(read(LEDGER))
    bad_tool, no_why = [], []
    covered = []
    missing = []
    for g in led['groups']:
        for a in g.get('actions', []):
            if a.get('tool'):
                if a['tool'] not in schema:
                    bad_tool.append(f"{a['id']} → {a['tool']}")
                else:
                    covered.append((g['id'], g['label'], a))
            else:
                missing.append((g['id'], g['label'], a))
                if not (a.get('why') or '').strip():
                    no_why.append(a['id'])
    ok = not bad_tool and not no_why
    print(('  ok   ' if ok else '  FAIL ') + f'G3 账本：covered {len(covered)} / missing {len(missing)}')
    if bad_tool:
        print('       账本指向了不存在的工具：' + '; '.join(bad_tool))
        fail.append('G3 账本指向不存在的工具')
    if no_why:
        print('       这些欠账没写 why（补什么要写清楚）：' + ', '.join(no_why))
        fail.append('G3 欠账缺 why')
    return covered, missing


# ── R1 宿主侧写口雷达 ────────────────────────────────────────────────────────
def radar_unused_model():
    src = read(MODEL_TS)
    names = re.findall(r'^export const ([a-z][A-Za-z0-9]*) =', src, re.M)
    tools = read(TOOLS_TS)
    # 纯格式化/默认值这类不算"用户操作"，别刷屏
    skip = {
        'fmtTime', 'rulerStep', 'isVideoName', 'isAudioName', 'newVidId', 'vidDuration',
        'defaultVidProject', 'normalizeVidProject', 'clampFps', 'createVidTransport',
        'createSeekCoalescer', 'vidAssetRefs', 'sameAsset', 'trackOf', 'clipAt', 'clipsByTrack',
        'clipAtSolo', 'audioAudible', 'clipUseIndex', 'usedByCount', 'kfSpan', 'kfU', 'kfSec',
        'kfEpsFor', 'kfMigrate', 'kfSnapshotMeta', 'kfSlice', 'kfTimes', 'kfLocalTimes',
        'kfSample', 'kfIsDefaultValue', 'kfFirstPassValues', 'kfChangedValues', 'kfSnapshotValues',
        'kfRecord', 'kfMoveKey', 'kfRemoveKey', 'kfRemoveChannel', 'kfChannelInfo', 'kfRemapLayerIds',
        'vgenDurationOf', 'vgenWithDuration', 'vgenResolutionOf', 'vgenFpsOf', 'vgenGet', 'vgenWith',
        'vgenChainPrevOf', 'canVgenChain', 'outputClipOf', 'vgenChainTo', 'vgenSeamsOf',
        'outputTrackOf', 'procSlotBusy', 'saveVidProject', 'loadVidProject', 'ensureVideoGenTrack',
        'snapPlace', 'probeVidMerge', 'vidMergeStructure', 'placeImport', 'importToTrack',
        'addAsset', 'setVideoGenTrackCfg', 'setVideoGenTrackPreset', 'applyProcSettings',
        'placeProcAssets', 'placeProcPlaceholders', 'placeProcVideoSegs', 'placeVideoGenSegment',
        'placeVideoGenOutput', 'placeProcOutput', 'pruneVgenChains', 'replaceVidClipsWithMerged',
        'unlinkGroup',
    }
    unused = [n for n in names if n not in skip and not re.search(r'\b' + re.escape(n) + r'\b', tools)]
    print(f'  R1 宿主写口雷达：model.ts 导出 {len(names)} 个，{len(unused)} 个没被工具用到')
    if unused:
        print('       ' + ', '.join(unused))
    return unused


# ── 报告 ────────────────────────────────────────────────────────────────────
def main():
    print('== 闸 ==')
    cat = gate_catalog()
    schema = gate_schema_vs_executor()
    gate_catalog_json()
    covered, missing = gate_ledger(schema)

    print('\n== 覆盖面 ==')
    n_actions = len(cat['actions'])
    print(f'  页面动作键 {n_actions} 条 —— 全部可执行（ui_action），目录随 types.ts 自动生成')
    semantic = set(re.findall(r"\buiSend\('([a-z0-9-]+)'", read(TOOLS_TS)))
    print(f'    其中 {len(semantic)} 条另有语义化工具直接调用（其余走 ui_action 兜底）')

    groups = {}
    for gid, glabel, a in covered:
        groups.setdefault((gid, glabel), [0, 0])[0] += 1
    for gid, glabel, a in missing:
        groups.setdefault((gid, glabel), [0, 0])[1] += 1
    tot_c = len(covered)
    tot_m = len(missing)
    tot = tot_c + tot_m
    print(f'\n  非动作键操作 {tot} 条：covered {tot_c} / missing {tot_m}'
          f'（{round(100 * tot_c / tot) if tot else 100}%）')
    for (gid, glabel), (c, m) in groups.items():
        flag = '  ' if not m else '  ←'
        print(f'    {glabel:<44} {c:>3} covered / {m:>2} missing{flag}')

    if missing:
        print('\n== 欠账（下一批补什么）==')
        for gid, glabel, a in missing:
            print(f'  · {a["id"]:<26} {a["ui"]}')
            print(f'      {a.get("why", "")}')

    print()
    unused = radar_unused_model()

    print('\n== 结论 ==')
    if fail:
        print('  FAIL ' + str(len(fail)) + ' 条闸')
        for f in fail:
            print('    - ' + f)
    else:
        print('  闸全绿')
    if STRICT and (fail or missing or unused):
        print('  --strict：有欠账（missing %d / 雷达 %d）' % (len(missing), len(unused)))
        return 1
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
