// Adapters for curated catalog sites. Each returns a list of project
// definitions in the dashboard's own shape.

import {
  fetchText, fetchJson, parseRepoUrl, parseRepoRef, repoId, guessType, guessPlatform, uniq, slugify, mapLimit,
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
      // Everything in PortsDR is a playable port; it's either recompiled or built on a decomp.
      type: guessType(`${name} ${full}`) === 'recompilation' ? 'recompilation' : 'port',
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
  // QuestPorts' "decompilation" means a VR port built on a decomp, not the decomp itself.
  decompilation: 'port',
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

// ---------------------------------------------------------- Quiver Launcher

const QUIVER_PLATFORMS = {
  pc: 'PC', mobile: 'Mobile', arcade: 'Arcade',
  n64: 'Nintendo 64', gcn: 'GameCube', wii: 'Wii', wiiu: 'Wii U', switch: 'Nintendo Switch',
  nes: 'NES', snes: 'SNES', gb: 'Game Boy', gbc: 'Game Boy Color', gba: 'Game Boy Advance',
  nds: 'Nintendo DS', '3ds': 'Nintendo 3DS', vb: 'Virtual Boy',
  ps1: 'PlayStation', ps2: 'PlayStation 2', ps3: 'PlayStation 3', ps4: 'PlayStation 4', ps5: 'PlayStation 5',
  psp: 'PlayStation Portable', 'og xbox': 'Xbox', x360: 'Xbox 360',
  dreamcast: 'Dreamcast', saturn: 'Sega Saturn', gen: 'Mega Drive', '32x': 'Sega 32X', gg: 'Game Gear',
  cdi: 'Philips CD-i',
};
const QUIVER_OS = { windows: 'Windows', linux: 'Linux', macos: 'macOS', android: 'Android', ios: 'iOS' };

/**
 * Quiver's list endpoint has everything but the repo, which comes from each
 * app's own page. `repos` maps app slug -> { host, path } or null.
 */
export function parseQuiver(apps, repos) {
  return apps.map((a) => {
    const repo = repos[a.slug] || null;
    const tags = (a.tags || []).map((t) => String(t).toLowerCase());
    const text = `${a.projectName} ${a.description || ''}`;
    let type = 'port';
    if (a.projectType === 'emulator' || a.projectType === 'tool') type = a.projectType;
    else if (tags.includes('recompilation') || tags.includes('recomp') || guessType(text) === 'recompilation') type = 'recompilation';
    else if (tags.includes('recreation')) type = 'reimplementation';

    return {
      id: repo ? repoId(repo) : `quiver:${a.slug}`,
      aliases: [`quiver:${a.slug}`],
      name: a.projectName || a.name,
      game: a.games?.[0]?.title || a.name,
      categories: [QUIVER_PLATFORMS[a.basedOn?.console || a.consoles?.[0]] || 'Other'],
      type,
      repo,
      description: a.description || '',
      developer: a.developer?.name || '',
      targets: uniq((a.supportedOS || []).map((o) => QUIVER_OS[o])),
      catalogVersion: a.lastReleaseVersion || '',
      links: [{ label: 'Quiver', url: `https://quiverlauncher.com/apps/${a.slug}` }],
      image: a.libraryArt?.capsule || a.artwork || null,
      sources: ['quiver'],
    };
  });
}

async function loadQuiver(cat, previous = []) {
  const api = (cat.api || 'https://api.quiverlauncher.com/api/v1').replace(/\/$/, '');
  const apps = [];
  for (let cursor = '', page = 0; page < 50; page++) {
    const d = await fetchJson(`${api}/apps?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!Array.isArray(d?.items)) throw new Error('Quiver: unexpected API response');
    apps.push(...d.items);
    if (d.isDone || !d.nextCursor || !d.items.length) break;
    cursor = d.nextCursor;
  }
  if (!apps.length) throw new Error('Quiver: no apps returned');

  // Repos hardly ever change, so only apps we haven't seen are looked up.
  const repos = {};
  for (const p of previous) {
    const slug = (p.aliases || []).find((x) => x.startsWith('quiver:'))?.slice(7);
    if (slug && p.repo) repos[slug] = p.repo;
  }
  const todo = apps.filter((a) => !(a.slug in repos));
  await mapLimit(todo, 8, async (a) => {
    try {
      const d = await fetchJson(`${api}/apps/${encodeURIComponent(a.slug)}`, {}, { retries: 1 });
      const pr = d?.project;
      if (pr?.repository) repos[a.slug] = pr.provider === 'gitlab' ? parseRepoRef(`gitlab:${pr.repository}`) : parseRepoRef(pr.repository);
    } catch { /* try again next run */ }
  });
  return parseQuiver(apps, repos);
}

// ------------------------------------------------------- PCVR Mods Hub

/**
 * Reads the PowerShell literals the PCVR Mods Installer Hub keeps its catalog in:
 * strings, @(...) lists, @{...} tables, $true/$false and numbers. Anything else
 * (variables, expressions) comes back as null.
 */
export function parsePsLiteral(src, start) {
  let i = start;
  const ws = () => {
    for (;;) {
      while (i < src.length && /[\s;,]/.test(src[i])) i++;
      if (src[i] === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (src.startsWith('<#', i)) { const e = src.indexOf('#>', i); i = e < 0 ? src.length : e + 2; continue; }
      return;
    }
  };
  const value = () => {
    const c = src[i];
    if (c === '"') {
      let out = '';
      for (i++; i < src.length; i++) {
        if (src[i] === '`') { out += src[++i]; continue; }
        if (src[i] === '"') { if (src[i + 1] === '"') { out += '"'; i++; continue; } i++; break; }
        out += src[i];
      }
      return out;
    }
    if (c === "'") {
      let out = '';
      for (i++; i < src.length; i++) {
        if (src[i] === "'") { if (src[i + 1] === "'") { out += "'"; i++; continue; } i++; break; }
        out += src[i];
      }
      return out;
    }
    if (src.startsWith('@(', i)) {
      i += 2;
      const out = [];
      for (;;) {
        ws();
        if (i >= src.length || src[i] === ')') { i++; return out; }
        const v = value();
        if (v !== null) out.push(v);
      }
    }
    if (src.startsWith('@{', i)) {
      i += 2;
      const out = {};
      for (;;) {
        ws();
        if (i >= src.length || src[i] === '}') { i++; return out; }
        const key = (src.slice(i).match(/^['"]?([A-Za-z_][\w-]*)['"]?\s*=\s*/) || [])[0];
        if (!key) { skipExpr(); continue; }
        i += key.length;
        out[key.replace(/['"\s=]/g, '')] = value();
      }
    }
    const m = src.slice(i).match(/^(\$true|\$false|\$null|-?\d+(?:\.\d+)?)\b/i);
    if (m) { i += m[0].length; return { '$true': true, '$false': false, '$null': null }[m[0].toLowerCase()] ?? Number(m[0]); }
    skipExpr();
    return null;
  };
  // Skip something we don't understand up to the end of its statement, keeping brackets balanced.
  const skipExpr = () => {
    if (')}]'.includes(src[i])) { i++; return; } // stray closer: step over it so loops always advance
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'") { value(); i--; continue; }
      if ('({['.includes(c)) depth++;
      else if (')}]'.includes(c)) { if (depth === 0) return; depth--; }
      else if (depth === 0 && (c === '\n' || c === ';' || c === ',')) return;
    }
  };
  i = start;
  const v = value();
  return { value: v, end: i };
}

/** Every top-level `$name = @(...)` list of tables in a PowerShell file. */
function psArrays(src, names) {
  const out = {};
  for (const name of names) {
    const m = src.match(new RegExp(`^[ \\t]*\\$${name}\\s*=\\s*@\\(`, 'm'));
    if (m) out[name] = parsePsLiteral(src, m.index + m[0].length - 2).value || [];
  }
  return out;
}

const HUB_URL = 'https://github.com/Mr-Nlce/PCVR-Mods-Installer-Hub';

function hubRepo(g) {
  if (g.GithubRepo) return parseRepoRef(g.GithubRepo);
  for (const u of [g.Url, g.ModPageUrl, g.InfoUrl, g.DownloadUrl]) {
    const r = parseRepoUrl(String(u || '').replace(/^https:\/\/api\.github\.com\/repos\//i, 'https://github.com/'));
    if (r && !/PCVR-Mods-Installer-Hub/i.test(r.path)) return r;
  }
  return null;
}

/** "Alien: Isolation VR (motion controls)" -> "Alien: Isolation" */
function hubGameName(g) {
  return String(g.TileTitle || g.Title)
    .replace(/\[[^\]]*\]|\((?:motion controls|n64 rom|[^)]*\bmod\b[^)]*)\)/gi, '')
    .replace(/\s+(VR|XR)\b(?=\s*(?:$|[(:+-]))/i, '')
    .replace(/\bSpiderman\b/g, 'Spider-Man')
    .replace(/\s+/g, ' ').trim();
}

/**
 * `catalog` is Core/Modules/Catalog.ps1, `index` (optional) is CatalogIndex.ps1,
 * which has a stable id and the latest release date for each title.
 */
export function parsePcvrHub(catalog, index = '') {
  const lists = psArrays(catalog, ['ownGames', 'ownGamesGP', 'externalGames']);
  const games = Object.values(lists).flat().filter((g) => g && typeof g === 'object' && g.Title);
  if (!games.length) throw new Error('PCVR Mods Hub: no games found in catalog (file layout may have changed)');

  const meta = new Map();
  for (const m of index.matchAll(/@\{\s*Id\s*=\s*'([^']+)';\s*Title\s*=\s*'((?:[^']|'')*)';\s*Released\s*=\s*'([^']*)'/g)) {
    meta.set(m[2].replace(/''/g, "'").toLowerCase(), { id: m[1], released: m[3] });
  }

  // Frameworks like UEVR or REFramework serve many games from one repo: those
  // get one project per game.
  const perRepo = new Map();
  for (const g of games) { const r = hubRepo(g); if (r) perRepo.set(repoId(r), (perRepo.get(repoId(r)) || 0) + 1); }

  return games.map((g) => {
    const info = meta.get(String(g.Title).toLowerCase()) || {};
    const slug = g.Id || info.id || slugify(g.Title);
    const repo = hubRepo(g);
    const shared = repo && perRepo.get(repoId(repo)) > 1;
    const tags = (Array.isArray(g.Tags) ? g.Tags : []).map((t) => String(t).toLowerCase());
    const platform = guessPlatform(g.Title);
    const version = (String(g.Mod || '').match(/\bv?(\d+(?:\.\d+)+[a-z]?|\d{4})\b/i) || [])[0] || '';
    const controls = { MC: 'motion controls', GP: 'gamepad', BOTH: 'motion controls or gamepad' }[g.Controls];

    const links = [];
    const add = (label, url) => {
      if (!url || !/^https?:\/\//i.test(url) || parseRepoUrl(url) || /api\.github\.com|discord\.com\/channels/i.test(url)) return;
      if (!links.some((l) => l.url === url)) links.push({ label: label || linkLabel(url), url });
    };
    add(null, g.ModPageUrl);
    add(null, g.InfoUrl);
    add(null, g.DownloadUrl);
    add(null, g.Url);
    add('Video', g.VideoUrl);
    links.push({ label: 'PCVR Hub', url: HUB_URL });

    return {
      id: repo ? repoId(repo) + (shared ? `#${slug}` : '') : `pcvrhub:${slug}`,
      aliases: [`pcvrhub:${slug}`],
      name: String(g.Title).replace(/\s*\((?:motion controls)\)/i, '').trim(),
      game: hubGameName(g),
      categories: [platform || 'PC', 'VR Ports'],
      // Universal injectors (UEVR and friends) have no game of their own.
      type: tags.includes('emulator') ? 'emulator' : g.CountAsGame === false && !g.SteamId ? 'tool' : 'mod',
      tags: ['VR'],
      repo,
      description: [String(g.Mod || '').replace(/\s*\(auto-update\)/i, ''), controls, g.Description]
        .filter(Boolean).join(' · '),
      developer: g.Author || '',
      status: g.Wip || /\bwip\b/i.test(g.Title) ? 'In development' : '',
      targets: ['PC VR'],
      catalogVersion: version,
      catalogDate: info.released || '',
      links,
      image: g.SteamId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.SteamId}/library_600x900.jpg` : null,
      sources: ['pcvrhub'],
    };
  });
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

/** `previous` is the last good copy of this catalog, for adapters that can reuse it. */
export async function loadCatalog(cat, previous) {
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
  if (cat.type === 'quiver') return loadQuiver(cat, previous);
  if (cat.type === 'pcvrhub') {
    const base = (cat.raw || 'https://raw.githubusercontent.com/Mr-Nlce/PCVR-Mods-Installer-Hub/HEAD/Core/Modules').replace(/\/$/, '');
    const [catalog, index] = await Promise.all([
      fetchText(`${base}/Catalog.ps1`),
      fetchText(`${base}/CatalogIndex.ps1`).catch(() => ''),
    ]);
    return parsePcvrHub(catalog, index);
  }
  throw new Error(`Unknown catalog type "${cat.type}"`);
}
