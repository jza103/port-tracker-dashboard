// Adapters for curated catalog sites. Each returns a list of project
// definitions in the dashboard's own shape.

import {
  fetchText, fetchJson, parseRepoUrl, repoId, guessType, uniq, slugify,
} from './util.mjs';

// ---------------------------------------------------------------- PortsDR

const PORTSDR_PLATFORMS = { Others: 'Other' };

/** PortsDR embeds its whole list as schema.org JSON-LD on the home page. */
export function parsePortsDR(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  let items = [];
  for (const [, json] of blocks) {
    try {
      const data = JSON.parse(json);
      const list = data?.mainEntity?.itemListElement;
      if (Array.isArray(list)) items = items.concat(list.map((x) => x.item).filter(Boolean));
    } catch { /* not the block we want */ }
  }
  if (!items.length) throw new Error('PortsDR: no catalog data found on page (site layout may have changed)');

  return items.map((it) => {
    // Names look like "Game - Project". Game names can contain " - " too,
    // so split on the last one.
    const full = String(it.name || '').trim();
    const cut = full.lastIndexOf(' - ');
    let game = cut > 0 ? full.slice(0, cut).trim() : full;
    let name = cut > 0 ? full.slice(cut + 3).trim() : full;
    // A few entries are written the other way round ("Mother3Recomp - MOTHER 3").
    if (/recomp|decomp/i.test(game) && !/recomp|decomp/i.test(name)) [game, name] = [name, game];

    const platform = (String(it.description || '').match(/Original platform: ([^.]+)/) || [])[1]?.trim();
    const links = uniq([it.url, ...(it.sameAs || [])]);
    const repo = links.map(parseRepoUrl).find(Boolean) || null;
    const others = links.filter((u) => !parseRepoUrl(u) && !/^https?:\/\/(www\.)?example\.(com|org)/i.test(u));
    const id = repo ? repoId(repo) : `portsdr:${slugify(full)}`;

    return {
      id,
      name,
      game,
      categories: [PORTSDR_PLATFORMS[platform] || platform || 'Other'],
      type: guessType(`${name} ${full}`),
      repo,
      links: others.map((url) => ({ label: linkLabel(url), url })),
      targets: String(it.operatingSystem || '').split(',').map((s) => s.trim()).filter(Boolean),
      image: it.image || null,
      sources: ['portsdr'],
    };
  });
}

// ------------------------------------------------------------- QuestPorts

const QP_TYPES = {
  decompilation: 'decompilation',
  source_port: 'source-port',
  engine_recreation: 'reimplementation',
  emulator: 'emulator',
  game_mod: 'mod',
  vr_injection: 'mod',
  wrapper: 'wrapper',
};

const QP_STATUS = {
  released: 'Released',
  playable_beta: 'Playable beta',
  in_development: 'In development',
};

/** Nuxt payloads are "devalue" encoded: a flat array where values point at other indexes. */
export function decodeNuxtPayload(arr) {
  const memo = new Map();
  const wrappers = new Set(['ShallowReactive', 'Reactive', 'Ref', 'ShallowRef', 'EmptyRef', 'Set', 'Map']);
  const resolve = (i) => {
    if (typeof i !== 'number') return i;
    if (i < 0) return undefined;
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    let out;
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string' && wrappers.has(v[0])) out = resolve(v[1]);
      else { out = []; memo.set(i, out); for (const x of v) out.push(resolve(x)); return out; }
    } else if (v && typeof v === 'object') {
      out = {};
      memo.set(i, out);
      for (const [k, x] of Object.entries(v)) out[k] = resolve(x);
      return out;
    } else out = v;
    memo.set(i, out);
    return out;
  };
  return resolve(0);
}

export function parseQuestPorts(ports, category = 'VR Ports') {
  // Several ports can share one repo (each game gets its own release tags).
  const byRepo = new Map();
  for (const p of ports) {
    const r = parseRepoUrl(p.port_download_url);
    if (r) byRepo.set(repoId(r), (byRepo.get(repoId(r)) || 0) + 1);
  }

  return ports.map((p) => {
    const repo = parseRepoUrl(p.port_download_url);
    const shared = repo && byRepo.get(repoId(repo)) > 1;
    const id = repo ? repoId(repo) + (shared ? `#${p.slug}` : '') : `questports:${p.slug}`;
    const tag = (String(p.port_download_url || '').match(/\/releases\/download\/([^/]+)\//) || [])[1];
    const isDirect = /\.(apk|zip|7z|xdelta|obb)(\?|$)/i.test(p.port_download_url || '');
    const links = [{ label: 'QuestPorts', url: `https://questports.vercel.app/ports/${p.slug}` }];
    if (!repo && p.port_download_url) links.unshift({ label: linkLabel(p.port_download_url), url: p.port_download_url });

    return {
      id,
      aliases: [`questports:${p.slug}`],
      name: p.title,
      game: guessGameFromVrTitle(p.title),
      categories: [category],
      type: QP_TYPES[p.category] || 'port',
      tags: ['VR'],
      repo,
      tagPattern: shared && tag ? `^${escapeRe(tag.replace(/v?\d.*$/i, ''))}v?\\d` : undefined,
      description: p.short_description || '',
      developer: p.developer || '',
      status: QP_STATUS[p.status] || p.status || '',
      targets: p.supported_hardware || [],
      download: isDirect ? { label: p.latest_version ? `Download ${p.latest_version}` : 'Download', url: p.port_download_url } : null,
      catalogVersion: p.latest_version || '',
      links,
      image: p.cover_image_url || null,
      sources: ['questports'],
    };
  });
}

/** "Lambda1VR (Half-Life 1)" -> "Half-Life 1"; "GoldenEye VR (007)" -> "GoldenEye". Overrides fix the rest. */
function guessGameFromVrTitle(title) {
  const paren = (String(title).match(/\(([^)]+)\)/) || [])[1];
  if (paren && paren.length > 4 && !/port|quest|standalone|build|vr\b/i.test(paren)) return paren.trim();
  return String(title).replace(/\(.*?\)/g, '').replace(/\b(VR|XR|Quest|Standalone)\b/gi, '').replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------- shared

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function linkLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (/itch\.io$/.test(host)) return 'itch.io';
    if (/patreon\.com$/.test(host)) return 'Patreon';
    if (/sidequestvr\.com$/.test(host)) return 'SideQuest';
    if (/gamebanana\.com$/.test(host)) return 'GameBanana';
    if (/evilgames\.eu$/.test(host)) return 'Texture pack';
    if (/discord\.(gg|com)$/.test(host)) return 'Discord';
    if (/github\.io$/.test(host)) return 'Website';
    return host;
  } catch {
    return 'Link';
  }
}

export async function loadCatalog(cat) {
  if (cat.type === 'portsdr') {
    return parsePortsDR(await fetchText(cat.url));
  }
  if (cat.type === 'questports') {
    const html = await fetchText(cat.url);
    const href = (html.match(/href="(\/_payload\.json[^"]*)"/) || [])[1];
    if (!href) throw new Error('QuestPorts: payload link not found (site layout may have changed)');
    const payload = decodeNuxtPayload(await fetchJson(new URL(href.replace(/&amp;/g, '&'), cat.url).href));
    const ports = payload?.data?.ports;
    if (!Array.isArray(ports)) throw new Error('QuestPorts: no ports in payload');
    return parseQuestPorts(ports, cat.category);
  }
  throw new Error(`Unknown catalog type "${cat.type}"`);
}
