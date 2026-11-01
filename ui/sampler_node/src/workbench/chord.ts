// 行上那枚键徽章要跟着 Key Bindings 走：表住在 localStorage，React 看不见，靠订阅转成重渲染。
// 一条命令可以绑多个键（目前没有），徽章只写第一个 —— 那枚就是按下去会响的那个。
import { useEffect, useState } from 'react';
import { chordsOf, displayChord, onKeymapChange } from '../keybindings';

export const useChord = (id: string): string => {
  const [, bump] = useState(0);
  useEffect(() => onKeymapChange(() => bump(v => v + 1)), []);
  const chords = chordsOf(id);
  return chords.length ? displayChord(chords[0]) : '—';
};
