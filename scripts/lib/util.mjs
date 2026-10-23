// Small helpers shared by the updater scripts.

export const UA = 'PortTrackerDashboard/1.0 (+https://github.com/jza103/Dashboard)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(url, opts = {}, { retries = 2, timeout = 25000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      // Retry server errors and rate limits; return everything else to the caller.
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function fetchText(url, opts, retryOpts) {
  const res = await fetchWithRetry(url, opts, retryOpts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function fetchJson(url, opts, retryOpts) {
  const res = await fetchWithRetry(url, opts, retryOpts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Run fn over items with at most `limit` running at once. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// GitHub paths that look like owner/repo but are not repositories.
const NOT_OWNERS = new Set([
  'about', 'apps', 'collections', 'contact', 'customer-stories', 'enterprise', 'events',
  'explore', 'features', 'login', 'marketplace', 'new', 'notifications', 'orgs', 'organizations',
  'pricing', 'readme', 'security', 'settings', 'site', 'sponsors', 'topics', 'trending',
  'user-attachments', 'users', 'join', 'signup', 'codespaces', 'pulls', 'issues', 'search',
  'github', 'resources', 'solutions', 'team', 'premium-support', 'mobile',
]);

/** Parse a GitHub or GitLab project URL into { host, path } or null. */
export function parseRepoUrl(url) {
  if (!url) return null;
  let m = String(url).match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (m) {
    const owner = m[1];
    const name = m[2].replace(/\.git$/i, '');
    if (NOT_OWNERS.has(owner.toLowerCase()) || !name || name.startsWith('.')) return null;
    return { host: 'github', path: `${owner}/${name}` };
  }
  m = String(url).match(/^(?:https?:\/\/)?(?:www\.)?gitlab\.com\/((?:[A-Za-z0-9_.-]+\/)+?[A-Za-z0-9_.-]+?)(?:\.git)?(?:\/-\/.*|\/?$|[?#].*)/i);
  if (m) {
    const path = m[1];
    if (path.split('/').length < 2 || /^(users|explore|help|dashboard)\//i.test(path)) return null;
    return { host: 'gitlab', path };
  }
  return null;
}

/** Bare owner/repo shorthand ("zeldaret/oot") or a full URL. */
export function parseRepoRef(ref) {
  if (!ref) return null;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref)) return { host: 'github', path: ref };
  if (/^gitlab:/i.test(ref)) return { host: 'gitlab', path: ref.slice(7) };
  return parseRepoUrl(ref);
}

export function repoId(repo) {
  if (!repo) return null;
  return repo.host === 'github' ? repo.path.toLowerCase() : `${repo.host}:${repo.path.toLowerCase()}`;
}

export function repoUrl(repo) {
  return repo.host === 'github' ? `https://github.com/${repo.path}` : `https://gitlab.com/${repo.path}`;
}

/** Key used to put different projects for the same game together. */
export function gameKey(game) {
  return String(game || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function slugify(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every GitHub/GitLab repo linked from a chunk of HTML or text. */
export function extractRepos(text) {
  const found = new Map();
  const re = /https?:\/\/(?:www\.)?(?:github|gitlab)\.com\/[A-Za-z0-9_.\/-]+/gi;
  for (const m of String(text || '').matchAll(re)) {
    const repo = parseRepoUrl(m[0].replace(/[.)\],]+$/, ''));
    if (repo) found.set(repoId(repo), repo);
  }
  return [...found.values()];
}

const PLATFORM_RULES = [
  [/\bnintendo 64\b|\bn64\b|n64recomp/i, 'Nintendo 64'],
  [/\bgamecube\b|\bngc\b/i, 'GameCube'],
  [/\bwii u\b/i, 'Wii U'],
  [/\bwii\b/i, 'Wii'],
  [/\bswitch\b/i, 'Nintendo Switch'],
  [/\b3ds\b/i, 'Nintendo 3DS'],
  [/\bnintendo ds\b|\bnds\b|pokediamond|pokeplatinum|pokeheartgold/i, 'Nintendo DS'],
  [/\bsnes\b|super nintendo/i, 'SNES'],
  [/\bgame ?boy advance\b|\bgba\b|pokeemerald|pokefirered|pokeruby/i, 'Game Boy Advance'],
  [/\bgame ?boy\b|\bgbc?\b/i, 'Game Boy'],
  [/\bnes\b|famicom/i, 'NES'],
  [/\bps2\b|playstation 2|ps2recomp/i, 'PlayStation 2'],
  [/\bps3\b|playstation 3/i, 'PlayStation 3'],
  [/\bps4\b|playstation 4/i, 'PlayStation 4'],
  [/\bpsp\b|playstation portable/i, 'PlayStation Portable'],
  [/\bps1\b|\bpsx\b|playstation(?! ?\d| portable)/i, 'PlayStation'],
  [/xbox 360|\bx360\b|xenonrecomp|rexglue/i, 'Xbox 360'],
  [/\bxbox\b/i, 'Xbox'],
  [/dreamcast/i, 'Dreamcast'],
  [/\bsaturn\b/i, 'Sega Saturn'],
  [/mega ?drive|genesis/i, 'Mega Drive'],
  [/\barcade\b|\bmame\b/i, 'Arcade'],
];

/** Best guess at the original platform from free text. */
export function guessPlatform(text) {
  const t = String(text).replace(/[-_]+/g, ' ');
  for (const [re, name] of PLATFORM_RULES) if (re.test(t)) return name;
  return null;
}

export function isVrText(text) {
  return /\b(vr|xr|openxr|quest ?[23]?|meta quest|6dof|virtual reality)\b/i.test(text);
}

export function guessType(text) {
  // No leading \b so "AC6_recomp" and "Zelda64Recomp" match too.
  if (/recomp(?!ens)/i.test(text)) return 'recompilation';
  if (/decomp(?!os)/i.test(text)) return 'decompilation';
  if (/\bsource port\b/i.test(text)) return 'source-port';
  if (/\b(re-?implementation|reimplement\w*|engine recreation|open[- ]source engine)\b/i.test(text)) return 'reimplementation';
  return 'port';
}

/** "Zelda64Recomp" -> "Zelda64 Recomp", "sm64coopdx" stays as is. */
export function prettyRepoName(name) {
  return String(name).replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

export function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}
