with open('nodes/prompt_node/src/components/AppShell.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

replacements = [
    ('group.is_from_parsing === true', "group.source === 'parsing'"),
    ('group.is_from_parsing !== true', "group.source !== 'parsing'"),
    ('group[0]?.is_from_parsing', 'group.source'),
    ('.is_from_parsing: true', ".source: 'parsing'"),
    ('.is_from_parsing: false', ".source: 'normal'"),
    ('.is_from_parsing = false', ".source = 'normal'"),
    ('is_from_parsing: isFromParsing', "source: isFromParsing ? 'parsing' : 'normal'"),
    ('is_from_parsing: false', "source: 'normal'"),
    ("group[0]?.source === true", "group.source === 'parsing'"),
    ('g[0]?.is_from_parsing', 'g.source'),
    ('g.is_from_parsing', 'g.source'),
    ('g.source === true', "g.source === 'parsing'"),
    ('group[0]?.source', 'group.source'),
]

for old, new in replacements:
    content = content.replace(old, new)

with open('nodes/prompt_node/src/components/AppShell.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

remaining = content.count('is_from_parsing')
print(f'Remaining is_from_parsing: {remaining}')
