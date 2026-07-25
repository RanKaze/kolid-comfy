with open('nodes/prompt_node/src/components/AppShell.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace(
    "source: isFromParsing ? 'parsing' : 'normal'",
    "source: isFromParsing ? 'parsing' as const : 'normal' as const"
)

with open('nodes/prompt_node/src/components/AppShell.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print('Done')
