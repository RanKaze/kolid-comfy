import type { CategoryDisplayModes, CategorySizeModes, AllLibraries } from '../types';

export class GroupModule {
  type: 'category' | 'library';
  label: string;

  constructor(type: 'category' | 'library') {
    this.type = type;
    this.label = type === 'category' ? 'Category' : 'Library';
  }

  get endpoints() {
    const t = this.type;
    return {
      add: t === 'category' ? '/add_category' : '/add_library',
      update: t === 'category' ? '/update_category' : '/update_library',
      delete: t === 'category' ? '/delete_category' : '/delete_library',
      reorder: t === 'category' ? '/reorder_categories' : '/reorder_libraries',
    };
  }

  async add(name: string) {
    const resp = await fetch(this.endpoints.add, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) throw new Error(`HTTP error! status: ${resp.status}`);
    return resp.json();
  }

  async update(oldName: string, newName: string, extra: Record<string, unknown> = {}) {
    const body = { old_name: oldName, new_name: newName, ...extra };
    const resp = await fetch(this.endpoints.update, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP error! status: ${resp.status}`);
    return resp.json();
  }

  async delete(name: string) {
    const resp = await fetch(this.endpoints.delete, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) throw new Error(`HTTP error! status: ${resp.status}`);
    return resp.json();
  }

  async reorder(from: string, to: string | null, position = 'at') {
    const fromKey = this.type === 'category' ? 'from_category' : 'from_library';
    const toKey = this.type === 'category' ? 'to_category' : 'to_library';
    const resp = await fetch(this.endpoints.reorder, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fromKey]: from, [toKey]: to, position }),
    });
    if (!resp.ok) throw new Error(`HTTP error! status: ${resp.status}`);
    return resp.json();
  }
}

export class DisplayModeModule {
  type: 'category' | 'library';

  constructor(type: 'category' | 'library') {
    this.type = type;
  }

  get endpoint() {
    return this.type === 'category'
      ? '/update_category_display_mode'
      : '/update_library_display_mode';
  }

  getMode(
    name: string,
    categoryModes: CategoryDisplayModes,
    libraries: AllLibraries,
  ): string {
    if (this.type === 'category') return categoryModes[name] || 'horizontal';
    return (libraries[name] || {}).display_mode || 'horizontal';
  }

  getSize(
    name: string,
    categorySizes: CategorySizeModes,
    libraries: AllLibraries,
  ): string {
    if (this.type === 'category') return categorySizes[name] || 'normal';
    return (libraries[name] || {}).size_mode || 'normal';
  }

  setLocal(
    name: string,
    mode: string,
    size: string,
    categoryModes: CategoryDisplayModes,
    categorySizes: CategorySizeModes,
    libraries: AllLibraries,
  ) {
    if (this.type === 'category') {
      categoryModes[name] = mode;
      categorySizes[name] = size;
    } else if (libraries[name]) {
      libraries[name].display_mode = mode;
      libraries[name].size_mode = size;
    }
  }

  async save(name: string, mode: string, size: string) {
    const nameKey = this.type === 'category' ? 'category' : 'library';
    const resp = await fetch(this.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [nameKey]: name, display_mode: mode, size_mode: size }),
    });
    return resp.json();
  }
}

export const categoryGroup = new GroupModule('category');
export const libraryGroup = new GroupModule('library');
export const categoryDisplay = new DisplayModeModule('category');
export const libraryDisplay = new DisplayModeModule('library');
