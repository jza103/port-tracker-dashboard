// Decompilation progress, taken from where each project publishes it:
//   1. decomp.dev's report for the repo (code/data/function percentages)
//   2. a progress badge in the README (shields.io "endpoint" JSON or a decomp.dev badge)
//   3. a sentence in the README such as "100.0% Complete" or "fully decompiled"
// Projects with none of these get { status: 'unknown' }.

import { fetchWithRetry, mapLimit } from './util.mjs';

const round = (n) => Math.round(n * 100) / 100;
const DECOMP_DEV_PLATFORMS = {
  n64: 'Nintendo 64', gc: 'GameCube', wii: 'Wii', switch: 'Nintendo Switch', gba: 'Game Boy Advance', gb: 'Game Boy',
  gbc: 'Game Boy Color', nds: 'Nintendo DS', '3ds': 'Nintendo 3DS', ps: 'PlayStation', psx: 'PlayStation', ps1: 'PlayStation',
  ps2: 'PlayStation 2', ps3: 'PlayStation 3', psp: 'PlayStation Portable', xbox: 'Xbox', x360: 'Xbox 360', saturn: 'Sega Saturn',
  dc: 'Dreamcast', pc: 'PC', win32: 'PC', snes: 'SNES', nes: 'NES',
};

function result(percent, source, extra = {}) {
  const p = Math.max(0, Math.min(100, Number(percent)));
  return { status: p >= 99.995 ? 'complete' : 'in-progress', percent: round(p), source, ...extra };
}

async function getJson(url) {
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } }, { retries: 1, timeout: 20000 });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

async function getText(url, headers = {}) {
  const res = await fetchWithRetry(url, { headers }, { retries: 1, timeout: 20000 });
  return res.ok ? res.text() : null;
}

/** decomp.dev keeps serving reports for projects it already tracked. */
async function fromDecompDev(path) {
  const data = await getJson(`https://decomp.dev/${path}.json`);
  const m = data?.measures;
  if (!m || typeof m.matched_code_percent !== 'number') return null;
  return result(m.matched_code_percent, 'decomp.dev', {
    url: `https://decomp.dev/${path}`,
    // Which game version the numbers are for, when a project tracks several.
    version: data.default_version || null,
    game: data.name || null,
    platform: DECOMP_DEV_PLATFORMS[String(data.platform || '').toLowerCase()] || null,
    data: typeof m.matched_data_percent === 'number' ? round(m.matched_data_percent) : null,
    functions: typeof m.matched_functions_percent === 'number' ? round(m.matched_functions_percent) : null,
  });
}

async function readme(path, token) {
  if (token) {
    const text = await getText(`https://api.github.com/repos/${path}/readme`, {
      Authorization: `bearer ${token}`, Accept: 'application/vnd.github.raw',
    }).catch(() => null);
    if (text) return text;
  }
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README']) {
    const text = await getText(`https://raw.githubusercontent.com/${path}/HEAD/${name}`).catch(() => null);
    if (text) return text;
  }
  return null;
}

const percentOf = (s) => {
  const m = String(s || '').match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
};

/** Progress badges in a README: shields.io endpoint JSON, or decomp.dev SVG badges. */
async function fromBadges(text, path) {
  const urls = [...text.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)].map((m) => m[0].replace(/&amp;/g, '&'));
  for (const u of urls) {
    // shields.io endpoint badges point at a small JSON file with the number in "message".
    if (/img\.shields\.io\/endpoint/i.test(u)) {
      const target = new URL(u).searchParams.get('url');
      if (!target || !/progress|decomp|complete|match/i.test(target) || /fn_|function/i.test(target)) continue;
      const json = await getJson(target).catch(() => null);
      const p = percentOf(json?.message);
      if (p != null) return result(p, new URL(target).hostname, { url: target });
    }
    // A decomp.dev badge for another repo name (e.g. the project moved).
    const dd = u.match(/decomp\.dev\/([\w.-]+\/[\w.-]+?)(?:\.svg|\.json|[/?#]|$)/i);
    if (dd && dd[1].toLowerCase() !== path.toLowerCase()) {
      const r = await fromDecompDev(dd[1]).catch(() => null);
      if (r) return r;
    }
  }
  return null;
}

/** A plain-text claim in the README. */
function fromText(text) {
  const plain = text.replace(/<[^>]+>/g, ' ');
  const pct = plain.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:complete|decompiled|matched|matching|done)\b/i);
  if (pct) return result(pct[1], 'README');
  if (/\b(?:is|now|been)\s+(?:fully|100%|completely)\s+(?:decompiled|matched|matching)\b|\bdecompilation is (?:now )?complete\b|\bfully matching decompilation\b/i.test(plain)) {
    return result(100, 'README');
  }
  return null;
}

export async function progressFor(path, token) {
  try {
    const dd = await fromDecompDev(path);
    if (dd) return dd;
    const text = await readme(path, token);
    if (text) {
      const fromBadge = await fromBadges(text, path);
      if (fromBadge) return fromBadge;
      const claim = fromText(text);
      if (claim) return claim;
    }
  } catch { /* fall through */ }
  return { status: 'unknown' };
}

/** paths: GitHub "owner/repo" strings. Returns Map(path -> progress). */
export async function fetchProgress(paths, token) {
  const out = new Map();
  await mapLimit([...new Set(paths)], 6, async (p) => out.set(p, await progressFor(p, token)));
  return out;
}

/** A value set by hand in config/projects.yml: "complete" or a percentage. */
export function manualProgress(value, source = 'your config') {
  if (String(value).toLowerCase() === 'complete') return result(100, source);
  const p = percentOf(`${value}%`);
  return p == null ? { status: 'unknown' } : result(p, source);
}

export const _test = { fromText, percentOf };
