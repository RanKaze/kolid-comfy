import re

with open('nodes/prompt_node/src/components/AppShell.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace all fallback patterns: sa.xxx ?? app.xxx ?? [] -> sa.xxx ?? []
content = content.replace('sa.context_prefab_guids ?? app.context_prefab_guids ?? []', 'sa.context_prefab_guids ?? []')
content = content.replace('sa.context_lora_paths ?? app.context_lora_paths ?? []', 'sa.context_lora_paths ?? []')
content = content.replace('sa.context_prompt_texts ?? app.context_prompt_texts ?? []', 'sa.context_prompt_texts ?? []')
content = content.replace('sa.context_prefab_inactive ?? app.context_prefab_inactive ?? []', 'sa.context_prefab_inactive ?? []')
content = content.replace('sa.context_lora_inactive ?? app.context_lora_inactive ?? []', 'sa.context_lora_inactive ?? []')
content = content.replace('sa.context_prompt_inactive ?? app.context_prompt_inactive ?? []', 'sa.context_prompt_inactive ?? []')

# Replace edit button: remove app.context_xxx references, use [] as defaults
content = content.replace(
    "setModalCtxPrefabGuids([...(app.context_prefab_guids || [])]); setModalCtxLoraPaths([...(app.context_lora_paths || [])]); setModalCtxPromptTexts([...(app.context_prompt_texts || [])])",
    "setModalCtxPrefabGuids([]); setModalCtxLoraPaths([]); setModalCtxPromptTexts([])"
)

# Replace restorePoint ctx fields that reference app.context_xxx
content = content.replace('ctxPrefabGuids: [...(app.context_prefab_guids || [])]', 'ctxPrefabGuids: sa.context_prefab_guids ?? []')
content = content.replace('ctxLoraPaths: [...(app.context_lora_paths || [])]', 'ctxLoraPaths: sa.context_lora_paths ?? []')
content = content.replace('ctxPromptTexts: [...(app.context_prompt_texts || [])]', 'ctxPromptTexts: sa.context_prompt_texts ?? []')

with open('nodes/prompt_node/src/components/AppShell.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print('Done')
