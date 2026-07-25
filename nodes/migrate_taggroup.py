"""
Data migration script: Rename 'tags' to 'tag_groups' in library.json prefabs and SelectedPrefabItem data.

Also handles:
1. library.json — rename prefab 'tags' field to 'tag_groups'
2. applications.json — migrate old 'applications' key to 'programs' (already done, but kept for safety)
3. prompt.json — no changes needed (prompt.tags is a different concept: string[] of tag names)
"""
import json
import os
import shutil
from datetime import datetime

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "prompt")

def migrate_tag_group(old_group):
    """Convert old Tag[] to new TagGroup { tags, strength, is_from_parsing }"""
    if isinstance(old_group, dict):
        if 'tags' in old_group and 'strength' in old_group:
            return old_group
        return old_group
    if not isinstance(old_group, list):
        return old_group
    new_tags = []
    strength = 1.0
    is_from_parsing = False
    for tag in old_group:
        if not isinstance(tag, dict):
            continue
        new_tag = {
            'name': tag.get('name', ''),
            'prompt': tag.get('prompt', ''),
            'category': tag.get('category', ''),
        }
        new_tags.append(new_tag)
        if tag.get('strength') is not None:
            strength = tag['strength']
        if tag.get('is_from_parsing') is not None:
            is_from_parsing = tag['is_from_parsing']
    return {
        'tags': new_tags,
        'strength': strength,
        'is_from_parsing': is_from_parsing,
    }

def migrate_file(filepath, name):
    if not os.path.exists(filepath):
        print(f"  SKIP: {name} not found")
        return False
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    original = json.dumps(data, ensure_ascii=False, sort_keys=True)
    changes = 0

    if name == 'library.json':
        for lib_name, lib_data in data.items():
            if not isinstance(lib_data, dict):
                continue
            prefabs = lib_data.get('prefabs', [])
            for pf in prefabs:
                if not isinstance(pf, dict):
                    continue
                # Rename 'tags' -> 'tag_groups' if it exists
                if 'tags' in pf and 'tag_groups' not in pf:
                    old_tags = pf.pop('tags')
                    # Also migrate old Tag[] format to new TagGroup format
                    new_tag_groups = []
                    for group in old_tags:
                        new_group = migrate_tag_group(group)
                        new_tag_groups.append(new_group)
                        changes += 1
                    pf['tag_groups'] = new_tag_groups
                elif 'tags' in pf and 'tag_groups' in pf:
                    # Both exist — remove old 'tags'
                    del pf['tags']
                    changes += 1

    elif name == 'applications.json':
        if isinstance(data, dict):
            for cat_name, cat_data in data.items():
                if isinstance(cat_data, dict) and 'applications' in cat_data and 'programs' not in cat_data:
                    cat_data['programs'] = cat_data.pop('applications')
                    changes += 1
                if isinstance(cat_data, dict) and 'applications' in cat_data and 'programs' in cat_data:
                    del cat_data['applications']
                    changes += 1

    new_json = json.dumps(data, ensure_ascii=False, sort_keys=True)
    if new_json != original:
        backup = filepath + f'.bak.{datetime.now().strftime("%Y%m%d%H%M%S")}'
        shutil.copy2(filepath, backup)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"  MIGRATED: {name} ({changes} changes) -> backup: {os.path.basename(backup)}")
        return True
    else:
        print(f"  OK: {name} (no changes needed)")
        return False

def main():
    print("=== TagGroup Field Rename Migration ===")
    print(f"Data dir: {DATA_DIR}")
    print()
    files = [
        ('library.json', os.path.join(DATA_DIR, 'library.json')),
        ('applications.json', os.path.join(DATA_DIR, 'applications.json')),
        ('prompt.json', os.path.join(DATA_DIR, 'prompt.json')),
    ]
    for name, path in files:
        print(f"Processing: {name}")
        migrate_file(path, name)
    print()
    print("=== Migration complete ===")

if __name__ == '__main__':
    main()
