// FPGA core catalogs: MiSTer (with update_all status) and Analogue Pocket (openFPGA).

import zlib from 'node:zlib';
import { fetchText, fetchJson, fetchWithRetry, parseRepoUrl, repoId, slugify, uniq, gameKey } from './util.mjs';

export const MISTER = 'MiSTer FPGA';
export const POCKET = 'Analogue Pocket';

// MiSTer and the Pocket name the same systems differently. One name for each,
// so both cores land on the same card.
const SYSTEMS = {
  'Nintendo Entertainment System (NES)': ['NES', 'Famicom'],
  'Super Nintendo (SNES)': ['SNES', 'Super NES', 'Super Famicom', 'Super Nintendo Entertainment System (SNES)'],
  'Sega Genesis / Mega Drive': ['Genesis', 'Mega Drive', 'Sega Mega Drive/Genesis'],
  'Game Boy / Game Boy Color': ['Game Boy', 'Game Boy Color', 'Game Boy, Game Boy Color'],
  'Sega Master System / Game Gear': ['Master System', 'Game Gear', 'Sega Master System, Game Gear'],
  'TurboGrafx-16 / PC Engine': ['PC Engine', 'PC Engine CD', 'TurboGrafx-16/PC Engine'],
  'Neo Geo': ['Neo Geo MVS/AES'],
  'Atari 2600 / 7800': ['Atari VCS (2600)', 'Atari 7800 ProSystem', 'Atari 7800, 2600'],
  'Atari Lynx': ['Lynx'],
  'ColecoVision / SG-1000': ['ColecoVision', 'SG-1000', 'ColecoVision, SG-1000'],
  'PlayStation': ['PlayStation (PSX)'],
  'Commodore Amiga': ['Amiga'],
  'Commodore 64': ['C64', 'Commodore 64, Ultimax'],
  'Sega CD / Mega-CD': ['MegaCD', 'Sega CD/Mega-CD'],
  'Sega 32X': ['32X'],
  'WonderSwan': ['WonderSwan Color'],
  'Magnavox Odyssey²': ['Odyssey 2'],
  'Emerson Arcadia 2001': ['Arcadia 2001'],
  'Fairchild Channel F': ['Channel F'],
  'VTech CreatiVision': ['CreatiVision'],
  'Watara SuperVision': ['Supervision'],
  'Super Game Boy': ['Super Gameboy'],
  'Game & Watch': ['Game and Watch'],
  'Bally Astrocade': ['Astrocade'],
  'Interton VC4000': ['VC 4000'],
  'Apple Macintosh LC': ['Macintosh LC'],
  'Atari ST/STe': ['Atari ST'],
  'BBC Micro B, Master': ['BBC Micro'],
  'Amstrad CPC 6128': ['Amstrad CPC'],
  'Philips CD-i': ['CD-i'],
};
const SYSTEM_BY_KEY = new Map();
for (const [name, alts] of Object.entries(SYSTEMS)) for (const n of [name, ...alts]) SYSTEM_BY_KEY.set(gameKey(n), name);
export const systemName = (name) => SYSTEM_BY_KEY.get(gameKey(name)) || name;

// ---------------------------------------------------------------- MiSTer

const WIKI_CORES = 'https://raw.githubusercontent.com/wiki/MiSTer-devel/Wiki_MiSTer/Cores.md';
const MAIN_DB = 'https://raw.githubusercontent.com/MiSTer-devel/Distribution_MiSTer/main/db.json.zip';
const UNOFFICIAL_CSV = 'https://raw.githubusercontent.com/theypsilon/Distribution_Unofficial_MiSTer/main/external_mister_repos.csv';

/**
 * The other databases update_all can install cores from, as listed in its
 * src/update_all/databases.py. "default" ones are switched on out of the box;
 * the rest are opt-in in update_all's settings.
 */
export const UPDATE_ALL_DBS = [
  { id: 'jtcores', title: 'JTCORES for MiSTer', repo: 'jotego/jtcores', url: 'https://raw.githubusercontent.com/jotego/jtcores_mister/main/jtbindb.json.zip', default: true, game: 'JTCORES (Jotego arcade cores)' },
  { id: 'coinop', title: 'Coin-Op Collection', repo: 'Coin-OpCollection/Distribution-MiSTerFPGA', url: 'https://raw.githubusercontent.com/Coin-OpCollection/Distribution-MiSTerFPGA/db/db.json.zip', default: true, game: 'Coin-Op Collection (arcade cores)' },
  { id: 'llapi', title: 'LLAPI Folder', repo: 'MiSTer-LLAPI/LLAPI_folder_MiSTer', url: 'https://raw.githubusercontent.com/MiSTer-LLAPI/LLAPI_folder_MiSTer/main/llapidb.json.zip', game: 'LLAPI cores (Blisster controllers)' },
  { id: 'retroachievements', title: 'RetroAchievements Cores', repo: 'theypsilon/RetroAchievementsDB_MiSTer', url: 'https://raw.githubusercontent.com/theypsilon/RetroAchievementsDB_MiSTer/db/db.json.zip', game: 'RetroAchievements cores' },
  { id: 'yc', title: 'Y/C Builds', repo: 'MikeS11/YC_Builds-MiSTer', url: 'https://raw.githubusercontent.com/MikeS11/YC_Builds-MiSTer/db/db.json.zip', game: 'Y/C builds (S-Video/composite cores)' },
  { id: 'altcores', title: 'Alt Cores', repo: 'ajgowans/alt-cores', url: 'https://raw.githubusercontent.com/ajgowans/alt-cores/db/db.json.zip', game: 'Alt cores' },
  { id: 'dualram', title: 'Dual RAM Console Cores', repo: 'TheJesusFish/Dual-Ram-Console-Cores', url: 'https://raw.githubusercontent.com/TheJesusFish/Dual-Ram-Console-Cores/db/db.json.zip', game: 'Dual RAM console cores' },
];

/** First file of a .zip (downloader databases hold a single db.json). */
export function unzipFirst(buf) {
  // The central directory has reliable sizes even when local headers don't.
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip compression ${method}`);
}

async function fetchDb(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return JSON.parse((/\.zip$/i.test(url) ? unzipFirst(buf) : buf).toString('utf8'));
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Core files in a downloader database: normalized name -> { file, date, url }. */
export function dbCores(db) {
  const out = new Map();
  const base = String(db.base_files_url || '').replace(/\/?$/, '/');
  for (const file of Object.keys(db.files || {})) {
    if (!/\.rbf$/i.test(file)) continue;
    const m = file.split('/').pop().match(/^(.*?)(?:_(\d{8}))?\.rbf$/i);
    const key = norm(m[1]);
    const date = m[2] ? `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}` : '';
    const prev = out.get(key);
    if (!prev || date > prev.date) out.set(key, { file, date, url: base ? base + file.split('/').map(encodeURIComponent).join('/') : '' });
  }
  return out;
}

const md = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

/** The core tables on the wiki's Cores page: what the main distribution (and so update_all) installs. */
export function parseWikiCores(text) {
  const cores = [];
  let mode = null;
  let section = '';
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const lower = line.toLowerCase();
    if (lower.includes('cores_list_start')) { mode = 'cores'; continue; }
    if (lower.includes('arcade_list_start')) { mode = 'arcade'; section = 'Arcade'; continue; }
    if (lower.includes('_list_end')) { mode = null; continue; }
    if (!mode) continue;
    if (line.startsWith('##')) { if (mode === 'cores') section = line.replace(/#/g, '').trim(); continue; }
    const cols = line.split('|');
    const link = (cols[1] || '').match(/\[(.*?)\]\((https:\/\/github\.com\/mister-devel\/[^)\s]+)\)/i);
    if (!link || /Menu_MiSTer/i.test(link[2])) continue;
    cores.push({
      name: md(link[1]),
      url: link[2],
      section,
      home: mode === 'cores' ? md(cols[2]) : '',
      extra: mode === 'arcade' ? md(cols[2]) : '',
    });
  }
  return cores;
}

const SECTION_LABEL = { Computers: 'computer', Consoles: 'console', 'Other Systems': 'other system', Arcade: 'arcade', Service: 'utility' };

/** One project per wiki core, with its newest .rbf from the main distribution when we can match it. */
export function parseMister({ wiki, mainDb, dbs = [], unofficial = [] }) {
  const cores = parseWikiCores(wiki);
  if (cores.length < 50) throw new Error(`MiSTer: only ${cores.length} cores on the wiki page (layout may have changed)`);
  const files = mainDb ? dbCores(mainDb) : new Map();
  const perRepo = new Map();
  for (const c of cores) { const r = parseRepoUrl(c.url); if (r) perRepo.set(repoId(r), (perRepo.get(repoId(r)) || 0) + 1); }

  const projects = cores.map((c) => {
    const repo = parseRepoUrl(c.url);
    const branch = (c.url.match(/\/tree\/([^/?#]+)/) || [])[1];
    const shared = perRepo.get(repoId(repo)) > 1;
    const repoName = repo.path.split('/')[1].replace(/_mister$/i, '').replace(/^arcade-/i, '');
    const rbf = [branch, repoName, c.home, c.name].map(norm).map((k) => files.get(k)).find(Boolean);
    const slug = slugify(branch || c.name);
    return {
      id: repoId(repo) + (shared ? `#${slug}` : ''),
      aliases: [`mister:${slug}`],
      name: `${c.name} (MiSTer)`,
      game: systemName(c.name),
      categories: [MISTER],
      type: 'core',
      tags: ['FPGA'],
      repo,
      description: [`MiSTer ${SECTION_LABEL[c.section] || 'core'}`, c.extra && `also runs ${c.extra}`].filter(Boolean).join(' · '),
      developer: 'MiSTer-devel',
      updateAll: 'default',
      updateAllDb: 'Main Distribution',
      catalogVersion: rbf?.date || '',
      catalogDate: rbf?.date || '',
      download: rbf?.url ? { label: `Core ${rbf.date || ''}`.trim(), url: rbf.url } : null,
      links: [{ label: 'MiSTer wiki', url: 'https://github.com/MiSTer-devel/Wiki_MiSTer/wiki/Cores' }],
      sources: ['mister'],
    };
  });

  // Other update_all databases: one project each (they're collections).
  for (const { def, db } of dbs) {
    const repo = { host: 'github', path: def.repo };
    const n = db ? dbCores(db).size : 0;
    const ts = db?.timestamp ? new Date(db.timestamp * 1000).toISOString().slice(0, 10) : '';
    projects.push({
      id: repoId(repo),
      aliases: [`mister:${def.id}`],
      name: def.title,
      game: def.game,
      categories: [MISTER],
      type: 'core',
      tags: ['FPGA'],
      repo,
      description: `${n ? `${n} cores · ` : ''}${def.default ? 'installed by update_all by default' : 'optional database in update_all settings'}`,
      developer: def.repo.split('/')[0],
      updateAll: def.default ? 'default' : 'optional',
      updateAllDb: def.title,
      catalogDate: ts,
      links: [],
      sources: ['mister'],
    });
  }
  // Repos the "Unofficial Distribution" database pulls from.
  for (const u of unofficial) {
    const repo = parseRepoUrl(u.url);
    if (!repo) continue;
    projects.push({
      id: repoId(repo),
      aliases: [`mister:${slugify(repo.path)}`],
      name: repo.path.split('/')[1],
      game: repo.path.split('/')[1].replace(/[-_](bin|mister)$/i, ''),
      categories: [MISTER],
      type: 'core',
      tags: ['FPGA'],
      repo,
      description: 'Unofficial Distribution (optional database in update_all settings)',
      developer: repo.path.split('/')[0],
      updateAll: 'optional',
      updateAllDb: 'Unofficial Distribution',
      links: [],
      sources: ['mister'],
    });
  }
  return projects;
}

export function parseCsvRepos(text) {
  return String(text).split('\n').slice(1)
    .map((line) => line.split(',').map((s) => s.trim()))
    .filter((cols) => /^https?:\/\//.test(cols[0] || ''))
    .map(([url, category]) => ({ url, category }));
}

export async function loadMister() {
  const [wiki, mainDb, unofficialCsv, ...dbs] = await Promise.all([
    fetchText(WIKI_CORES),
    fetchDb(MAIN_DB).catch(() => null),
    fetchText(UNOFFICIAL_CSV).catch(() => ''),
    ...UPDATE_ALL_DBS.map((def) => fetchDb(def.url).then((db) => ({ def, db })).catch(() => ({ def, db: null }))),
  ]);
  return parseMister({ wiki, mainDb, dbs, unofficial: parseCsvRepos(unofficialCsv) });
}

// --------------------------------------------------- Analogue Pocket

const POCKET_API = 'https://openfpga-cores-inventory.github.io/analogue-pocket/api/v2/cores.json';

export function parsePocket(cores) {
  const repoOf = (c) => (c.repository?.platform === 'github' && c.repository.owner && c.repository.name
    ? { host: 'github', path: `${c.repository.owner}/${c.repository.name}` } : null);
  const perRepo = new Map();
  for (const c of cores) { const r = repoOf(c); if (r) perRepo.set(repoId(r), (perRepo.get(repoId(r)) || 0) + 1); }

  return cores.filter((c) => c.identifier).map((c) => {
    const repo = repoOf(c);
    const shared = repo && perRepo.get(repoId(repo)) > 1;
    const slug = slugify(c.identifier);
    const [author] = c.identifier.split('.');
    const platform = c.platform || {};
    return {
      id: repo ? repoId(repo) + (shared ? `#${slug}` : '') : `pocket:${slug}`,
      aliases: [`pocket:${slug}`],
      name: `${c.identifier} (Pocket)`,
      game: systemName(platform.name || c.identifier.split('.').pop()),
      categories: [POCKET],
      type: 'core',
      tags: uniq(['FPGA', c.requires_license ? 'License required' : null]),
      repo,
      description: [platform.category && `openFPGA ${String(platform.category).toLowerCase()} core`,
        [platform.manufacturer, platform.year].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
      developer: author,
      targets: ['Analogue Pocket'],
      catalogVersion: c.version || '',
      catalogDate: c.release_date || '',
      download: c.download_url ? { label: c.version ? `Pocket ${c.version}` : 'Pocket core', url: c.download_url } : null,
      links: [{ label: 'openFPGA inventory', url: 'https://openfpga-cores-inventory.github.io/analogue-pocket/' }],
      sources: ['pocket'],
    };
  }).filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i); // listed twice: keep the first
}

export async function loadPocket(cat) {
  const d = await fetchJson(cat.api || POCKET_API);
  if (!Array.isArray(d?.data) || !d.data.length) throw new Error('openFPGA inventory: no cores in response');
  return parsePocket(d.data);
}

// ------------------------------------------------------- discovery

/** A repo that looks like an FPGA core: which of our two categories it belongs in, or null. */
export function fpgaCategory(text) {
  const t = String(text || '');
  if (/_mister\b|\bmister[- ]?fpga\b|\bmister\b.*\bcore\b|\bcore\b.*\bmister\b/i.test(t)) return MISTER;
  if (/\bopen[- ]?fpga\b|analogue pocket|\bpocket\b.*\bcore\b/i.test(t)) return POCKET;
  return null;
}
