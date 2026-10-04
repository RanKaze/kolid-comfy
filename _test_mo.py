import ast, re

src = open('nodes/snapshot_sampler_node.py', encoding='utf-8').read()
ast.parse(src)
print('syntax OK')

m = re.search(r'@staticmethod\s+def _mark_model_only\(lora_items, mo_paths\):(.*?)\n    def ', src, re.S)
assert m, 'method not found'
ns = {}
exec('def _mark_model_only(lora_items, mo_paths):' + m.group(1), ns)
mark = ns['_mark_model_only']

mo = ['F:/ComfyDB/models/loras/要素/Krea2/krea2 pussy check up.safetensors']
items = [
  '<lora_path:F:/ComfyDB/models/loras/修正/Krea2/krea2 pussy check up.safetensors:1.0>',
  '<lora:krea2 pussy check up:0.8>',
  '<lora:krea2 pussy check up:0.8:tag1>',
  '<lora_path:F:/ComfyDB/models/loras/other/别的lora.safetensors:1.0>',
  '<lora_path:F:/ComfyDB/models/loras/要素/Krea2/krea2 pussy check up.safetensors:1.0:model_only>',
]
got = mark(items, mo)
for orig, new in zip(items, got):
    print(f'{new}')

# 强度必须保留 + 解析端能解出正确的 path/strength
for want_stem, expect_st in [(0, '1.0'), (1, '0.8'), (2, '0.8')]:
    s = got[want_stem][1:-1]
    body = s[len('lora_path:'):] if s.startswith('lora_path:') else s[len('lora:'):]
    last = body.rfind(':')
    assert body[last+1:] == 'model_only', s
    prev = body.rfind(':', 0, last)
    strength = body[prev+1:last]
    assert strength == expect_st, (s, strength)
assert got[3] == items[3]
assert got[4] == items[4]
assert all(x.count(':model_only') == 1 for i, x in enumerate(got) if i != 3)
print('all assertions passed — strength preserved, parse round-trip OK')
