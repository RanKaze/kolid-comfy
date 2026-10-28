import type { BlendDocAsset } from '../../types';
import { type VidAsset, sameAsset, usedByCount } from './model';

// 一份文档的资产清单 → 窗里那一叠卡。纯数据，不碰 React —— 所以能直接测。
//
// 文档里有两种货，**存储方式不同**，窗里因此也有两种卡：
//   内嵌件（groupDocAssets）：图层 / 指导卡 / 图池的像素。字节写进 .cud，换台机器也能开。
//   引用件（clipCards）：时间线在播的视频 / 音频。.cud 只存哈希与 URL，字节留在仓库里 ——
//     素材动辄几百兆，内嵌一份就把文件撑爆，而仓库本来就有那一份，没有第二份的必要。
//
// 为什么要合并：同一张图常常被好几个人用（复制图层共享同一份像素、图池那张又被拖成了一层）。
// 窗里它只该有一张脸，旁边写一句"3 layers"。顺序按第一次出现（页面是按图层自底向上给的），
// 所以同一份文档每次看到的排列都一样。
export type DocAssetGroup = {
  hash: string;
  name: string;
  /** 图层原生像素（同哈希的几份取第一份非零的）。 */
  w: number;
  h: number;
  /** 引用它的图层/条目数。 */
  count: number;
  /** 用它的那几种用途，按 layer → guidance → staging 排。 */
  roles: BlendDocAsset['role'][];
  /** 每种用途各被用了几次（"3 layers" 与 "1 guidance" 分得清，不混成一个数）。 */
  counts: Record<BlendDocAsset['role'], number>;
  /** Video 档：都在哪几段（段的 layerKey；'' = 活跃段）。 */
  setKeys: string[];
};

const ROLE_ORDER: BlendDocAsset['role'][] = ['layer', 'guidance', 'staging'];

export function groupDocAssets(list: readonly BlendDocAsset[]): DocAssetGroup[] {
  const byHash = new Map<string, DocAssetGroup>();
  for (const a of list) {
    if (!a || !a.hash) continue;
    const hit = byHash.get(a.hash);
    if (!hit) {
      byHash.set(a.hash, {
        hash: a.hash, name: a.name, w: a.w, h: a.h,
        count: 1, roles: [a.role], counts: { layer: 0, guidance: 0, staging: 0, [a.role]: 1 } as DocAssetGroup['counts'],
        setKeys: a.setKey ? [a.setKey] : [],
      });
      continue;
    }
    hit.count++;
    hit.counts[a.role]++;
    if (!hit.roles.includes(a.role)) hit.roles.push(a.role);
    if (a.setKey && !hit.setKeys.includes(a.setKey)) hit.setKeys.push(a.setKey);
    if (!hit.w && a.w) { hit.w = a.w; hit.h = a.h; }
    if (!hit.name && a.name) hit.name = a.name;
  }
  for (const g of byHash.values()) g.roles.sort((x, y) => ROLE_ORDER.indexOf(x) - ROLE_ORDER.indexOf(y));
  return [...byHash.values()];
}

/** 卡片副行那句"在哪"：用途 + 段名（Video 档）。措辞归这一侧，页面只交事实。 */
export function whereText(g: DocAssetGroup, setNames?: (key: string) => string): string {
  const parts: string[] = [];
  for (const r of g.roles) {
    const n = g.counts[r];
    if (r === 'layer') parts.push(n > 1 ? `${n} layers` : 'layer');
    else if (r === 'guidance') parts.push(n > 1 ? `${n} guidances` : 'guidance');
    else parts.push('staging');
  }
  if (g.setKeys.length && setNames) {
    const names = g.setKeys.map(k => (k ? setNames(k) : 'active')).filter(Boolean);
    if (names.length) parts.push(names.join(' · '));
  }
  return parts.join(' · ');
}

// ── 引用件：时间线在播的视频 / 音频 ───────────────────────────────────────────────────────────
// 这些字节**不进 .cud**（文件里只有哈希与 URL），但它们确实是"这份文档在用的东西"，所以
// Video 档要看得见它们 —— 只是卡片上写清楚是 REF，不是 IN DOC：删掉仓库里那份字节，文件
// 就跟着废（这是引用的代价，也是不内嵌换来的体积）。

export type DocClipCard = {
  key: string;
  id: string;
  name: string;
  kind: 'video' | 'audio';
  /** 可播地址。转码过的片子原件浏览器咬不动，`play` 那份代理才是能播的字节。 */
  url: string;
  /** 仓库身份：原件哈希 / 代理哈希。relink 与拖拽都认这两个。 */
  asset: string;
  play: string;
  /** 入库时那条持久 URL（`/api/vid_media/…`），哈希取不到字节时还能靠它。 */
  src: string;
  duration: number;
  hasAudio: boolean;
  /** 时间线上有几个片段在引用它（按三个身份并集算）。 */
  uses: number;
  /** 引用的字节不在仓库里了 → 卡片标 MISSING，回形针能接回来。 */
  missing: boolean;
};

/** 仓库里那一件的可播地址。 */
export const storeUrlOf = (hash: string): string => '/api/asset_media/' + encodeURIComponent(hash);

type ClipSeed = {
  id: string; name: string; kind: 'video' | 'audio';
  asset: string; play: string; src: string;
  duration: number; hasAudio: boolean;
};

export function clipCards(
  assets: readonly VidAsset[],
  useIdx: Map<string, Set<string>>,
  missing: ReadonlySet<string>,
): DocClipCard[] {
  // 同一件货在工程表里可能有两行（老存档里重复认领过）。按身份并成一张 —— 判据与
  // `addAsset` / `importToTrack` 用的 `sameAsset` 同一把尺子，别在这儿另立一套。
  const seeds: ClipSeed[] = [];
  for (const a of assets) {
    if (!a || typeof a !== 'object') continue;
    const asset = typeof a.asset === 'string' ? a.asset : '';
    const play = typeof a.play === 'string' ? a.play : '';
    const src = typeof a.src === 'string' ? a.src : '';
    // 三个地址一个都没有 = 没有字节可指（脏行），给卡也是一张点不开的白卡。
    if (!asset && !play && !src) continue;
    const hit = seeds.find(s => sameAsset(s, { asset, play, src }));
    if (hit) {
      // 名字留第一行（那是用户认过的）；身份互补 —— 哪一行带了哈希就用哪一行，
      // 于是"老行只有 src、新行有哈希"这种半个身份的存档也能认全。
      if (!hit.asset && asset) hit.asset = asset;
      if (!hit.play && play) hit.play = play;
      if (!hit.src && src) hit.src = src;
      if (!hit.duration && Number.isFinite(a.duration)) hit.duration = Number(a.duration) || 0;
      continue;
    }
    seeds.push({
      id: String(a.id || ''),
      name: String(a.name || asset.slice(0, 8) || play.slice(0, 8) || 'clip'),
      kind: a.kind === 'audio' ? 'audio' : 'video',
      asset, play, src,
      duration: Number.isFinite(a.duration) ? Math.max(0, Number(a.duration)) : 0,
      hasAudio: a.hasAudio === true,
    });
  }
  // 缺失的判据是"**能播的那份**字节没了"，不是"引到的某个哈希没了"：转过码的片子
  // 引着两个哈希（原件 + 代理），原件被清掉时代理还在、时间线照样能播 —— 那种情况标红
  // 是谎报。所以先挑出真正要用的那份字节，再看它在不在。
  const gone = (h: string) => !!h && missing.has(h);
  return seeds.map(s => {
    const useHash = s.play
      ? (gone(s.play) && s.asset && !gone(s.asset) ? s.asset : s.play)
      : s.asset;
    return {
      key: 'c:' + (s.id || s.asset || s.play || s.src || s.name),
      id: s.id,
      name: s.name,
      kind: s.kind,
      url: useHash ? storeUrlOf(useHash) : s.src,
      asset: s.asset,
      play: s.play,
      src: s.src,
      duration: s.duration,
      hasAudio: s.hasAudio,
      uses: usedByCount(useIdx, s.asset, s.play, s.src),
      missing: !!useHash && gone(useHash),
    };
  });
}
