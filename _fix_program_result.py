import re

with open('nodes/prompt_node/src/components/AppShell.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace property names
content = content.replace('programResult.filteredTags', 'programResult.resultTags')
content = content.replace('programResult.filteredLoras', 'programResult.resultLoras')
content = content.replace('programResult.filteredPrefabs', 'programResult.resultPrefabs')
content = content.replace('programResult.filteredCustomPrompts', 'programResult.resultCustomPrompts')

# Replace removedTagKeys with filter_tag_groups check
content = content.replace(
    "g && programResult.removedTagKeys.has(tagsToDisplayString(g)) ? ' program-filtered' : ''",
    "g && programResult.filter_tag_groups.some(fg => tagsToDisplayString(fg) === tagsToDisplayString(g)) ? ' program-filtered' : ''"
)
content = content.replace(
    "const programFiltered = programResult.removedTagKeys.has(tagsToDisplayString(group));",
    "const programFiltered = programResult.filter_tag_groups.some(fg => tagsToDisplayString(fg) === tagsToDisplayString(group));"
)

# Replace removedLoraPaths with filter_loras check
content = content.replace(
    "isProgramFiltered={programResult.removedLoraPaths.has(lora.file_path)}",
    "isProgramFiltered={programResult.filter_loras.some(fl => fl.file_path === lora.file_path)}"
)

# Replace removedPrefabGuids with filter_prefabs check
content = content.replace(
    "programResult.removedPrefabGuids.has(node.guid) ? 'program-filtered' : ''",
    "programResult.filter_prefabs.some(fp => fp.guid === node.guid) ? 'program-filtered' : ''"
)

with open('nodes/prompt_node/src/components/AppShell.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print('Done')
