# -*- coding: utf-8 -*-
"""Prompt program engine — run prompt-node applications (programs) on the backend.

The prompt node UI resolves its applications (programs) in the FRONTEND: useProgram.ts
compiles each program's JS body with `new Function(tag_groups, loras, prefabs,
custom_prompts, prompts_data, all_tags, prefab_context, lora_context, tag_context,
prefab_builtin, lora_builtin, tag_group_builtin)` and lets it filter/generate items on
the current selection. What lands in SnapshotPromptServer.selected_prompts is already
post-program, so the normal run path never needs this file.

Prompt BLOCKS (pipeline blocks of type 'prompt') changed that: their programs must run
at RUN TIME over the *merged* selection (prompt node's global result + the block's own
raw selection), so the engine — chain resolution, context building, filter/gen
accumulation — is ported here 1:1 from useProgram.ts and the program bodies execute
through quickjs (same `new Function` shape, JSON in / JSON out).

Anything a program can touch is plain JSON: no DOM, no host objects. quickjs supports
the ES2020 subset the existing programs use (const/let, arrow functions, Array methods).
"""
import json
import copy
import threading

try:
    import quickjs
    _QJS_ERR = None
except Exception as _e:  # pragma: no cover - dependency missing
    quickjs = None
    _QJS_ERR = str(_e)


# JS driver: same signature as useProgram.ts. Accepts the program as either a bare
# function BODY (the stored convention: statements ending in `return {...}`) or a full
# function expression — both compile. Result is JSON-stringified back to Python.
_RUN_PROGRAM_JS = """
function run_program(code, args_json) {
  var params = ['tag_groups','loras','prefabs','custom_prompts','prompts_data','all_tags',
                'prefab_context','lora_context','tag_context',
                'prefab_builtin','lora_builtin','tag_group_builtin'];
  var args = JSON.parse(args_json);
  var fn = null;
  try { fn = new Function(params, code); } catch (e) { fn = null; }
  if (!fn) { fn = new Function('return (' + code + ')')(); }
  var result = fn(
    args.tag_groups, args.loras, args.prefabs, args.custom_prompts, args.prompts_data, args.all_tags,
    args.prefab_context, args.lora_context, args.tag_context,
    args.prefab_builtin, args.lora_builtin, args.tag_group_builtin
  );
  return JSON.stringify(result === undefined ? null : result);
}
"""

# quickjs runtimes are single-threaded; programs may run while ComfyUI worker threads
# touch the engine. One process-wide lock around every execution.
_QJS_LOCK = threading.Lock()


def _to_list(v):
    """Port of useProgram.toList: 'a, b' | [..] -> lowercase str list."""
    if isinstance(v, list):
        return [str(s).lower() for s in v]
    if isinstance(v, str):
        return [s.strip().lower() for s in v.split(',') if s.strip()]
    return []


def tags_to_display_string(group):
    """Port of useSelection.tagsToDisplayString: decoration brackets + (text:strength)."""
    tags = group.get('tags') or []
    parts = []
    n = len(tags)
    for i, tag in enumerate(tags):
        if not isinstance(tag, dict):
            continue
        prompt = tag.get('prompt', '')
        deco = n - 1 - i
        parts.append(('[' * deco) + prompt + (']' * deco) if deco > 0 else prompt)
    text = ' '.join(parts)
    strength = group.get('strength', 1.0)
    if strength != 1.0:
        return f"({text}:{strength})"
    return text


def _find_prompt_name(prompt_text, all_prompts):
    for _cat, cat_data in (all_prompts or {}).items():
        for p in (cat_data.get('prompts') or []) if isinstance(cat_data, dict) else []:
            if p.get('prompt') == prompt_text:
                return p.get('name') or prompt_text
    return prompt_text


def _find_prompt_category(prompt_text, all_prompts):
    for cat, cat_data in (all_prompts or {}).items():
        for p in (cat_data.get('prompts') or []) if isinstance(cat_data, dict) else []:
            if p.get('prompt') == prompt_text:
                return cat
    return ''


def _find_prompt_by_name(name_text, all_prompts):
    for cat, cat_data in (all_prompts or {}).items():
        for p in (cat_data.get('prompts') or []) if isinstance(cat_data, dict) else []:
            if p.get('name') == name_text:
                return {'name': p.get('name'), 'prompt': p.get('prompt'), 'category': cat}
    return None


def _create_tag(prompt_text, all_prompts):
    name = _find_prompt_name(prompt_text, all_prompts)
    category = _find_prompt_category(prompt_text, all_prompts)
    if name == prompt_text:
        by_name = _find_prompt_by_name(prompt_text, all_prompts)
        if by_name:
            return by_name
    return {'name': name, 'prompt': prompt_text, 'category': category}


def parse_string_to_tags(s, all_prompts):
    """Port of useSelection.parseStringToTags: display string -> TagGroup dict."""
    import re
    strength = 1.0
    body = s
    m = re.match(r'^\((.*):(\d*\.?\d+)\)$', s)
    if m:
        body = m.group(1).strip()
        strength = float(m.group(2))

    tags = []
    pos = 0
    while pos < len(body):
        m2 = re.match(r'^(\[+)([^\]]+)\]+', body[pos:])
        if m2:
            tags.append(_create_tag(m2.group(2).strip(), all_prompts))
            pos += m2.end()
        else:
            remaining = body[pos:]
            nxt = remaining.find('[')
            if nxt == -1:
                text = remaining.strip()
                if text:
                    tags.append(_create_tag(text, all_prompts))
                break
            text = remaining[:nxt].strip()
            if text:
                tags.append(_create_tag(text, all_prompts))
            pos += nxt
    return {'tags': tags, 'strength': strength, 'source': 'normal'}


def build_all_tags_lookup(all_prompts):
    """Port of buildAllTagsLookup: prompt text (lowercase) -> {name, prompt, category, tags}."""
    all_tags = {}
    for cat, cat_data in (all_prompts or {}).items():
        if not isinstance(cat_data, dict):
            continue
        cat_tags = _to_list(cat_data.get('tags'))
        for p in (cat_data.get('prompts') or []):
            prompt = p.get('prompt') if isinstance(p, dict) else None
            if not prompt:
                continue
            key = prompt.lower()
            p_tags = _to_list(p.get('tags')) if isinstance(p, dict) else []
            all_tags[key] = {
                'name': p.get('name') or prompt,
                'prompt': prompt,
                'category': cat,
                'tags': list(dict.fromkeys(cat_tags + p_tags)),
            }
    return all_tags


def enrich_tag_groups(selected_tags, all_tags):
    """Port of enrichTagGroups: fill each Tag's decoration tags from the lookup."""
    out = []
    for g in selected_tags:
        g = copy.deepcopy(g)
        for t in g.get('tags') or []:
            info = all_tags.get((t.get('prompt') or '').lower())
            t['tags'] = list(info['tags']) if info else []
        out.append(g)
    return out


class PromptProgramEngine:
    """One engine bound to a SnapshotPromptServer (data source) — stateless per run."""

    def __init__(self, prompt_server):
        self.ps = prompt_server
        self._run_fn = None

    # ------------------------------------------------------------------
    # Data sources (read fresh each run — libraries/programs are editable)
    # ------------------------------------------------------------------
    def _all_programs(self):
        return getattr(self.ps, 'programs_data', None) or {}

    def _all_prompts(self):
        return getattr(self.ps, 'prompts_data', None) or {}

    def _all_libraries(self):
        return getattr(self.ps, 'libraries_data', None) or {}

    def _lora_lookup(self):
        lookup = {}
        for items in (getattr(self.ps, 'lora_data', None) or {}).values():
            for item in items or []:
                if isinstance(item, dict) and item.get('file_path'):
                    lookup[item['file_path']] = item
        return lookup

    def _prefab_data_map(self):
        data_map = {}
        for lib_data in (self._all_libraries() or {}).values():
            if isinstance(lib_data, dict):
                for pf in (lib_data.get('prefabs') or []):
                    guid = pf.get('guid') if isinstance(pf, dict) else None
                    if guid:
                        data_map[guid] = pf
        return data_map

    # ------------------------------------------------------------------
    # Program chain resolution (port of resolvePrograms in useProgram.ts)
    # ------------------------------------------------------------------
    @staticmethod
    def _program_by_id_map(all_programs):
        program_by_id = {}
        for cat_data in (all_programs or {}).values():
            for app in (cat_data.get('programs') or []) if isinstance(cat_data, dict) else []:
                if isinstance(app, dict) and app.get('id'):
                    program_by_id[app['id']] = app
        return program_by_id

    def _resolve_program_chain(self, selected_programs):
        program_by_id = self._program_by_id_map(self._all_programs())
        active_programs = []

        def resolve(items, resolved, depth=0, inherited_ctx=None):
            for item in items:
                if not isinstance(item, dict):
                    continue
                pid = item.get('id')
                if not pid or pid in resolved:
                    continue
                resolved.add(pid)
                app = program_by_id.get(pid)
                if not app:
                    continue
                ctx_source = {
                    'context_prefab_guids': item.get('context_prefab_guids'),
                    'context_lora_paths': item.get('context_lora_paths'),
                    'context_tag_texts': item.get('context_tag_texts'),
                    'context_prefab_inactive': item.get('context_prefab_inactive'),
                    'context_lora_inactive': item.get('context_lora_inactive'),
                    'context_tag_inactive': item.get('context_tag_inactive'),
                    'enable_prefab_context': app.get('enable_prefab_context'),
                    'enable_lora_context': app.get('enable_lora_context'),
                    'enable_tag_context': app.get('enable_tag_context'),
                    'prefab_builtin_guids': app.get('prefab_builtin_guids'),
                    'lora_builtin_paths': app.get('lora_builtin_paths'),
                    'tag_group_builtin_texts': app.get('tag_group_builtin_texts'),
                    'prefab_builtin_inactive': app.get('prefab_builtin_inactive'),
                    'lora_builtin_inactive': app.get('lora_builtin_inactive'),
                    'tag_group_builtin_inactive': app.get('tag_group_builtin_inactive'),
                }
                sub_programs = [sp for sp in (app.get('selected_programs') or [])
                                if isinstance(sp, dict) and sp.get('active') is not False]
                if sub_programs:
                    resolve([{
                        'id': sp.get('id'),
                        'context_prefab_guids': sp.get('context_prefab_guids', ctx_source['context_prefab_guids']),
                        'context_lora_paths': sp.get('context_lora_paths', ctx_source['context_lora_paths']),
                        'context_tag_texts': sp.get('context_tag_texts', ctx_source['context_tag_texts']),
                        'context_prefab_inactive': sp.get('context_prefab_inactive', ctx_source['context_prefab_inactive']),
                        'context_lora_inactive': sp.get('context_lora_inactive', ctx_source['context_lora_inactive']),
                        'context_tag_inactive': sp.get('context_tag_inactive', ctx_source['context_tag_inactive']),
                    } for sp in sub_programs], resolved, depth + 1, ctx_source)
                code = app.get('code') or ''
                if code.strip():
                    active_programs.append({'code': code, 'name': app.get('name') or '', 'ctx': ctx_source})

        for sa in selected_programs or []:
            if isinstance(sa, dict) and sa.get('active') is not False:
                resolve([sa], set())
        return active_programs

    # ------------------------------------------------------------------
    # Context builders (port of the per-program ctx assembly)
    # ------------------------------------------------------------------
    def _build_merged_prefab(self, item, prefab_data_map):
        pf_data = prefab_data_map.get(item.get('guid')) or {}
        tag_groups = pf_data.get('tag_groups') or []
        norm_groups = []
        for g in tag_groups:
            if isinstance(g, dict) and 'tags' in g:
                norm_groups.append({**g, 'tags': [copy.deepcopy(t) for t in g.get('tags') or []]})
            elif isinstance(g, list):
                norm_groups.append([copy.deepcopy(t) for t in g])
            else:
                norm_groups.append(copy.deepcopy(g))
        return {
            'guid': item.get('guid'),
            'active': item.get('active', True),
            'tag_states': [copy.deepcopy(t) for t in (item.get('tag_groups') or [])],
            'lora_states': [copy.deepcopy(l) for l in (item.get('loras') or [])],
            'name': pf_data.get('name', ''),
            'tag_groups': norm_groups,
            'loras': [copy.deepcopy(l) for l in (pf_data.get('loras') or [])],
            'custom_prompts': pf_data.get('custom_prompts') or '',
            'preview': pf_data.get('preview') or '',
            'children': [self._build_merged_prefab(c, prefab_data_map) for c in (item.get('children') or [])],
        }

    def _build_program_context(self, cs, base_loras, prefab_data_map, lora_lookup):
        """Build one program's context variables from its ctxSource. Mirrors useProgram.ts."""
        prefab_context, lora_context, tag_context = [], [], []
        prefab_builtin, lora_builtin, tag_group_builtin = [], [], []
        if not cs:
            return prefab_context, lora_context, tag_context, prefab_builtin, lora_builtin, tag_group_builtin

        lora_strength = {l.get('file_path'): l for l in base_loras if isinstance(l, dict)}
        all_prompts = self._all_prompts()

        def lora_entry(fp, inactive):
            if fp in inactive:
                return None
            item = lora_lookup.get(fp)
            if not item:
                return None
            base = lora_strength.get(fp)
            return {
                'file_path': fp,
                'name': item.get('name'),
                'strength': (base or {}).get('strength', 1.0),
                'active_tags': (base or {}).get('active_tags', item.get('tags') or []),
                'active': True,
                'split_mode': (base or {}).get('split_mode'),
            }

        if cs.get('enable_prefab_context') and cs.get('context_prefab_guids'):
            inactive = set(cs.get('context_prefab_inactive') or [])
            for guid in cs['context_prefab_guids']:
                pf = prefab_data_map.get(guid)
                if not pf:
                    continue
                prefab_context.append({'guid': guid, 'name': pf.get('name') or '',
                                       'tag_groups': pf.get('tag_groups') or [], 'loras': pf.get('loras') or [],
                                       'custom_prompts': pf.get('custom_prompts') or '', 'preview': pf.get('preview') or '',
                                       'active': guid not in inactive})
        if cs.get('enable_lora_context') and cs.get('context_lora_paths'):
            inactive = set(cs.get('context_lora_inactive') or [])
            for fp in cs['context_lora_paths']:
                e = lora_entry(fp, inactive)
                if e:
                    lora_context.append(e)
        if cs.get('enable_tag_context') and cs.get('context_tag_texts'):
            inactive = set(cs.get('context_tag_inactive') or [])
            for text in cs['context_tag_texts']:
                tg = parse_string_to_tags(text, all_prompts)
                tg['active'] = text not in inactive
                tag_context.append(tg)
        if cs.get('prefab_builtin_guids'):
            inactive = set(cs.get('prefab_builtin_inactive') or [])
            for guid in cs['prefab_builtin_guids']:
                pf = prefab_data_map.get(guid)
                if not pf:
                    continue
                prefab_builtin.append({'guid': guid, 'name': pf.get('name') or '',
                                       'tag_groups': pf.get('tag_groups') or [], 'loras': pf.get('loras') or [],
                                       'custom_prompts': pf.get('custom_prompts') or '', 'preview': pf.get('preview') or '',
                                       'active': guid not in inactive})
        if cs.get('lora_builtin_paths'):
            inactive = set(cs.get('lora_builtin_inactive') or [])
            for fp in cs['lora_builtin_paths']:
                e = lora_entry(fp, inactive)
                if e:
                    lora_builtin.append(e)
        if cs.get('tag_group_builtin_texts'):
            inactive = set(cs.get('tag_group_builtin_inactive') or [])
            for text in cs['tag_group_builtin_texts']:
                tg = parse_string_to_tags(text, all_prompts)
                tg['active'] = text not in inactive
                tag_group_builtin.append(tg)
        return prefab_context, lora_context, tag_context, prefab_builtin, lora_builtin, tag_group_builtin

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------
    def _run_js(self, code, args):
        if quickjs is None:
            raise RuntimeError(f"quickjs unavailable ({_QJS_ERR}) — install it to use prompt-block programs")
        if self._run_fn is None:
            self._run_fn = quickjs.Function('run_program', _RUN_PROGRAM_JS)
        with _QJS_LOCK:
            out = self._run_fn(code, json.dumps(args, ensure_ascii=False))
        return json.loads(out)

    def run(self, selected_programs, base_tags, base_loras, base_prefabs, custom_prompts):
        """Port of useProgram(): resolve the chain, execute over the merged selection,
        accumulate filter/gen results, return the final ProgramResult dict.

        base_tags:   [TagGroup] merged raw selection (program-sourced items already stripped)
        base_loras:  [LoraSelectionData]
        base_prefabs:[prefab instance refs]
        """
        all_prompts = self._all_prompts()
        all_tags = build_all_tags_lookup(all_prompts)
        prefab_data_map = self._prefab_data_map()
        lora_lookup = self._lora_lookup()

        active_programs = self._resolve_program_chain(selected_programs or [])

        ctx_tags = enrich_tag_groups(base_tags or [], all_tags)
        ctx_loras = copy.deepcopy(base_loras or [])
        ctx_prefabs = [self._build_merged_prefab(p, prefab_data_map) for p in (base_prefabs or [])]
        ctx_custom = custom_prompts or ''

        all_filter_tags, all_filter_loras, all_filter_prefabs = [], [], []
        all_gen_tags, all_gen_loras, all_gen_prefabs = [], [], []

        for prog in active_programs:
            (pf_ctx, lora_ctx, tag_ctx,
             pf_builtin, lora_builtin, tag_builtin) = self._build_program_context(
                prog.get('ctx'), base_loras or [], prefab_data_map, lora_lookup)
            args = {
                'tag_groups': copy.deepcopy(ctx_tags),
                'loras': copy.deepcopy(ctx_loras),
                'prefabs': copy.deepcopy(ctx_prefabs),
                'custom_prompts': ctx_custom,
                'prompts_data': all_prompts,
                'all_tags': all_tags,
                'prefab_context': pf_ctx,
                'lora_context': lora_ctx,
                'tag_context': tag_ctx,
                'prefab_builtin': pf_builtin,
                'lora_builtin': lora_builtin,
                'tag_group_builtin': tag_builtin,
            }
            try:
                result = self._run_js(prog['code'], args)
            except Exception as e:
                print(f"[PromptProgramEngine] Error in '{prog.get('name')}': {e}")
                continue
            if not isinstance(result, dict):
                continue
            for key, acc in (('filter_tag_groups', all_filter_tags), ('filter_loras', all_filter_loras),
                             ('filter_prefabs', all_filter_prefabs), ('gen_tag_groups', all_gen_tags),
                             ('gen_loras', all_gen_loras), ('gen_prefabs', all_gen_prefabs)):
                if isinstance(result.get(key), list):
                    acc.extend(result[key])
            if isinstance(result.get('custom_prompts'), str):
                ctx_custom = result['custom_prompts']

        def group_key(g):
            return tags_to_display_string(g) if isinstance(g, dict) else str(g)

        filter_tag_keys = {group_key(g) for g in all_filter_tags}
        ctx_tags = [g for g in ctx_tags if group_key(g) not in filter_tag_keys]
        ctx_tags = ctx_tags + [{**g, 'source': 'program'} for g in all_gen_tags]

        filter_lora_paths = {l.get('file_path') for l in all_filter_loras if isinstance(l, dict)}
        ctx_loras = [l for l in ctx_loras if l.get('file_path') not in filter_lora_paths]
        ctx_loras = ctx_loras + [{**l, 'source': 'program'} for l in all_gen_loras]

        filter_prefab_guids = {p.get('guid') for p in all_filter_prefabs if isinstance(p, dict)}
        ctx_prefabs = [p for p in ctx_prefabs if p.get('guid') not in filter_prefab_guids]
        ctx_prefabs = ctx_prefabs + [{**p, 'source': 'program'} for p in all_gen_prefabs]

        return {
            'result_tags': ctx_tags,
            'result_loras': ctx_loras,
            'result_prefabs': ctx_prefabs,
            'result_custom_prompts': ctx_custom,
            'filter_tag_groups': all_filter_tags,
            'filter_loras': all_filter_loras,
            'filter_prefabs': all_filter_prefabs,
            'gen_tag_groups': all_gen_tags,
            'gen_loras': all_gen_loras,
            'gen_prefabs': all_gen_prefabs,
        }
