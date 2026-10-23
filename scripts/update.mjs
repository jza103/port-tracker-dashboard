#!/usr/bin/env node
// Builds site/data.json: every tracked project with its latest release and
// download links, plus related news. Run by GitHub Actions every few hours,
// or locally with `npm run update`.
//
// Persistent state lives in data/ and is committed by the workflow:
//   data/registry.json  projects found through news/search, first-seen dates
//   data/news.json      rolling archive of relevant articles
//   data/catalogs.json  last good copy of each catalog (used if a site is down)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadCatalog } from './lib/catalogs.mjs';
import { fetchRepoInfo, pickReleases, searchGithub } from './lib/repos.mjs';
import { loadNews, keywordRegex } from './lib/news.mjs';
import {
  parseRepoRef, parseRepoUrl, repoId, repoUrl, gameKey, guessPlatform, guessType, isVrText,
  prettyRepoName, uniq, slugify,
} from './lib/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...parts) => path.join(ROOT, ...parts);
const DAY = 86400000;
const now = new Date();
const nowIso = now.toISOString();
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const readYaml = (f) => YAML.parse(fs.readFileSync(p(f), 'utf8')) || {};
const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(p(f), 'utf8')); } catch { return fallback; }
};
/** Write only when content changed, so the workflow doesn't commit noise. */
const writeJson = (f, data, pretty = true) => {
  const text = JSON.stringify(data, null, pretty ? 1 : 0) + '\n';
  fs.mkdirSync(path.dirname(p(f)), { recursive: true });
  const old = fs.existsSync(p(f)) ? fs.readFileSync(p(f), 'utf8') : null;
  if (old !== text) fs.writeFileSync(p(f), text);
};

const sources = readYaml('config/sources.yml');
const prefs = readYaml('config/projects.yml');
const settings = { newsDays: 120, activeDays: 120, newDays: 14, ...(sources.settings || {}) };
const registry = readJson('data/registry.json', { firstSeen: {}, found: {}, meta: {} });
const newsArchive = readJson('data/news.json', { articles: [] });
const catalogCache = readJson('data/catalogs.json', {});
const errors = [];

const hidden = new Set((prefs.hidden || []).map(String));
const pinned = new Set((prefs.pinned || []).map(String));
const followList = new Set((prefs.follow || []).map(String));
const kwRe = keywordRegex(sources.news?.keywords || ['decomp']);
// What a linked repo has to look like to count as a port project.
const strongRepoRe = /recomp|decomp|\b(pc|native|source|vr|quest|fan|unofficial) port\b|\bport (of|for)\b|\bported\b|re-?implementation|reimplement|reverse[- ]engineer|\b(vr|xr|openxr)\b/i;
const weakRepoRe = /\b(port|ports|engine|remake|native)\b/i;
const notPortRe = /emulat|\btranslation\b|fan ?translat|fpga|mister|\bcore\b|retroarch|libretro|romhack|rom hack|\bpatch(es)?\b/i;
// Tools for making ports, not ports: suggest at most.
const toolRe = /\btool(kit|chain|s)?\b|\bsdk\b|disassembl|decompiler\b|\bdiff(ing)?\b|binary ?ninja|ghidra|\bida\b|\bmcp\b|agent skill|\bplugin\b|\bframework\b|\blibrary\b|website|\.(me|wtf|dev)\b|leaderboard/i;
// Link collections: never.
const listRe = /(^|\/)awesome[-_]|\bawesome list\b|curated list|\blist of\b/i;

/** 'strong' (follow automatically), 'weak' (suggest only) or 'reject'. */
function classifyRepo(path, ri) {
  const text = `${path} ${ri.description} ${ri.topics.join(' ')}`;
  if (listRe.test(text) || ri.fork) return 'reject';
  if (notPortRe.test(text)) return weakRepoRe.test(text) || strongRepoRe.test(text) ? 'weak' : 'reject';
  if (strongRepoRe.test(text) || kwRe.test(text)) return toolRe.test(text) ? 'weak' : 'strong';
  return weakRepoRe.test(text) ? 'weak' : 'reject';
}

// ------------------------------------------------------------------ helpers

function mergeInto(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v == null || v === '') continue;
    if (['categories', 'tags', 'sources', 'aliases', 'targets'].includes(k)) target[k] = uniq([...(target[k] || []), ...v]);
    else if (k === 'links') {
      const seen = new Set((target.links || []).map((l) => l.url));
      target.links = [...(target.links || []), ...v.filter((l) => !seen.has(l.url))];
    } else if (target[k] == null || target[k] === '') target[k] = v;
  }
  return target;
}

function applyOverride(proj, ov) {
  const { category, categories, ...rest } = ov;
  if (categories) proj.categories = [...categories];
  if (category) proj.categories = uniq([category, ...(proj.categories || []).filter((c) => c !== category)]);
  Object.assign(proj, rest);
}

/** Turn an entry from config/projects.yml into a project definition. */
function manualProject(entry) {
  const repo = parseRepoRef(entry.repo || '') || parseRepoUrl(entry.url || '');
  const id = entry.id || (repo ? repoId(repo) : `manual:${slugify(entry.name || entry.url || 'project')}`);
  const name = entry.name || (repo ? prettyRepoName(repo.path.split('/').pop()) : entry.url);
  const links = [...(entry.links || [])];
  if (!repo && entry.url) links.unshift({ label: 'Website', url: entry.url });
  return {
    id,
    name,
    game: entry.game || name,
    categories: entry.categories || (entry.category ? [entry.category] : []),
    type: entry.type || guessType(`${name} ${entry.description || ''}`),
    tags: entry.tags || [],
    repo,
    links,
    description: entry.description || '',
    download: entry.download ? { label: 'Download', url: entry.download } : null,
    tagPattern: entry.tagPattern,
    sources: ['manual'],
  };
}

/** A project found in an article or a search, guessed from the repo itself. */
function discoveredProject(repo, info, from) {
  const own = `${repo.path} ${info?.description || ''} ${(info?.topics || []).join(' ')}`;
  // An article's headline helps; a search query doesn't describe the repo.
  const text = from.kind === 'news' ? `${own} ${from.title || ''}` : own;
  const vr = isVrText(`${repo.path} ${info?.description || ''} ${(info?.topics || []).join(' ')}`);
  const platform = guessPlatform(text);
  return {
    id: repoId(repo),
    name: prettyRepoName(repo.path.split('/').pop()),
    game: prettyRepoName(repo.path.split('/').pop()),
    categories: uniq([platform || 'Other', vr ? 'VR Ports' : null]),
    type: guessType(text),
    tags: vr ? ['VR'] : [],
    repo,
    links: [],
    sources: [from.kind],
    discoveredFrom: from,
  };
}

const repoKey = (repo) => `${repo.host}:${repo.path}`;

// ------------------------------------------------------------- 1. catalogs

const projects = new Map();
const catalogStatus = [];

const catalogResults = await Promise.all((sources.catalogs || []).map(async (cat) => {
  try {
    const list = await loadCatalog(cat);
    const unchanged = JSON.stringify(catalogCache[cat.id]?.projects) === JSON.stringify(list);
    catalogCache[cat.id] = { updatedAt: unchanged ? catalogCache[cat.id].updatedAt : nowIso, projects: list };
    catalogStatus.push({ name: cat.name, url: cat.url, ok: true, count: list.length });
    return list;
  } catch (err) {
    const cached = catalogCache[cat.id];
    const msg = `${cat.name}: ${err.message}${cached ? ` (using saved copy from ${cached.updatedAt.slice(0, 10)})` : ''}`;
    errors.push(msg);
    catalogStatus.push({ name: cat.name, url: cat.url, ok: false, error: msg, count: cached?.projects.length || 0 });
    return cached?.projects || [];
  }
}));
for (const list of catalogResults) {
  for (const proj of list) {
    if (projects.has(proj.id)) mergeInto(projects.get(proj.id), proj);
    else projects.set(proj.id, structuredClone(proj));
  }
}
console.log(`Catalogs: ${projects.size} projects`);

// --------------------------------------------- 2. found earlier + manual

for (const [id, proj] of Object.entries(registry.found || {})) {
  if (!projects.has(id)) projects.set(id, structuredClone(proj));
}
for (const entry of prefs.projects || []) {
  const proj = manualProject(entry);
  if (projects.has(proj.id)) {
    const existing = projects.get(proj.id);
    // Your own settings win over what a catalog says.
    for (const [k, v] of Object.entries(proj)) {
      if (k === 'sources' || k === 'links') mergeInto(existing, { [k]: v });
      else if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) existing[k] = v;
    }
  } else projects.set(proj.id, proj);
}

const aliasIndex = new Map();
for (const proj of projects.values()) for (const a of proj.aliases || []) aliasIndex.set(a, proj.id);
for (const [key, ov] of Object.entries(prefs.overrides || {})) {
  const proj = projects.get(key) || projects.get(aliasIndex.get(key));
  if (proj && ov) applyOverride(proj, ov);
}
// Lists in projects.yml may use aliases too.
const resolveId = (id) => (projects.has(id) ? id : aliasIndex.get(id) || id);
for (const set of [hidden, pinned, followList]) for (const id of [...set]) set.add(resolveId(id));

// ----------------------------------------------------------------- 3. news

const knownUrls = new Set((newsArchive.articles || []).map((a) => a.url));
const { articles: freshArticles, feedStatus } = await loadNews(sources.news || {}, knownUrls);
const articles = new Map((newsArchive.articles || []).map((a) => [a.url, a]));
for (const a of freshArticles) {
  const prev = articles.get(a.url);
  articles.set(a.url, {
    title: a.title,
    url: a.url,
    date: prev?.date || a.date || nowIso,
    source: a.source,
    outlet: a.outlet,
    summary: a.summary,
    image: a.image,
    text: a.text.slice(0, 1500),
    repos: uniq([...(prev?.repos || []), ...a.repos.map(repoKey)]),
    firstSeen: prev?.firstSeen || nowIso,
  });
}
const newsCutoff = now - settings.newsDays * DAY;
for (const [url, a] of articles) if (Date.parse(a.date) < newsCutoff) articles.delete(url);
console.log(`News: ${freshArticles.length} relevant in feeds, ${articles.size} in archive`);

// Repos linked from articles that we don't know yet become candidates.
const candidates = new Map();
for (const a of articles.values()) {
  for (const key of a.repos || []) {
    const [host, ...rest] = key.split(':');
    const repo = { host, path: rest.join(':') };
    const id = repoId(repo);
    if (projects.has(id) || candidates.has(id) || registry.rejected?.[id]) continue;
    candidates.set(id, { repo, from: { kind: 'news', title: a.title, url: a.url, source: a.outlet || a.source, date: a.date } });
  }
}

// ------------------------------------------------------------- 4. search

const preloaded = new Map();
const searchDue = token && (!registry.meta?.lastSearchAt || now - Date.parse(registry.meta.lastSearchAt) > 20 * 3600000);
if (searchDue && sources.discovery?.searches?.length) {
  let added = 0;
  for (const q of sources.discovery.searches) {
    try {
      await new Promise((r) => setTimeout(r, 2500)); // stay under the search rate limit
      for (const { path: rp, info } of await searchGithub(q, token)) {
        const repo = { host: 'github', path: rp };
        const id = repoId(repo);
        preloaded.set(repoKey(repo), info);
        if (projects.has(id) || candidates.has(id) || registry.rejected?.[id] || info.fork) continue;
        candidates.set(id, { repo, from: { kind: 'search', title: q, date: nowIso } });
        added++;
      }
    } catch (err) {
      errors.push(`GitHub search "${q}": ${err.message}`);
    }
  }
  registry.meta = { ...registry.meta, lastSearchAt: nowIso };
  console.log(`Search: ${added} new candidates`);
}

// ------------------------------------------------------ 5. repo details

const allRepos = [...projects.values(), ...[...candidates.values()].map((c) => ({ repo: c.repo }))]
  .map((x) => x.repo).filter(Boolean).filter((r) => !preloaded.has(repoKey(r)));
const info = await fetchRepoInfo(allRepos, token);
for (const [k, v] of preloaded) info.set(k, v);

// Decide what to do with each candidate now that we know what the repo is.
registry.found ||= {};
registry.rejected ||= {};
const autoStars = sources.discovery?.autoFollowStars ?? 300;
for (const [id, c] of candidates) {
  const ri = info.get(repoKey(c.repo));
  if (!ri) continue;
  if (ri.error) {
    // Only give up on repos that don't exist; network hiccups get retried next run.
    if (/not found/i.test(ri.error)) registry.rejected[id] = nowIso.slice(0, 10);
    continue;
  }
  const kind = classifyRepo(c.repo.path, ri);
  if (kind === 'reject') { registry.rejected[id] = nowIso.slice(0, 10); continue; }
  const proj = discoveredProject(c.repo, ri, c.from);
  proj.autoFollow = kind === 'strong' && (c.from.kind === 'news' || (ri.stars || 0) >= autoStars);
  registry.found[id] = proj;
  projects.set(id, structuredClone(proj));
}
// Re-check earlier finds too, so improved rules clean up past mistakes.
for (const [id, proj] of Object.entries(registry.found)) {
  if (candidates.has(id) || followList.has(id) || !proj.repo) continue;
  const ri = info.get(repoKey(proj.repo));
  if (!ri || ri.error) continue;
  // If you also added it by hand, your entry is what's shown: leave it alone.
  const onlyFound = projects.get(id)?.sources?.every((s) => s === 'news' || s === 'search');
  const kind = classifyRepo(proj.repo.path, ri);
  if (kind === 'reject') {
    delete registry.found[id];
    registry.rejected[id] = nowIso.slice(0, 10);
    if (onlyFound) projects.delete(id);
    continue;
  }
  const fresh = discoveredProject(proj.repo, ri, proj.discoveredFrom || { kind: 'search' });
  const updated = { ...proj, categories: fresh.categories, type: fresh.type, tags: fresh.tags,
    autoFollow: kind === 'strong' && (proj.discoveredFrom?.kind === 'news' || (ri.stars || 0) >= autoStars) };
  registry.found[id] = updated;
  if (onlyFound && !prefs.overrides?.[id]) projects.set(id, structuredClone(updated));
}

// ---------------------------------------------------- 6. assemble output

registry.firstSeen ||= {};
const firstRun = !registry.meta?.seededAt;
if (firstRun) registry.meta = { ...registry.meta, seededAt: nowIso };

const byCanonical = new Map();
const out = [];
for (const proj of projects.values()) {
  const ri = proj.repo ? info.get(repoKey(proj.repo)) : null;
  if (ri && !ri.error && ri.canonical && !proj.tagPattern) {
    // Renamed/moved repos can show up under two names: keep one.
    const canon = `${proj.repo.host}:${ri.canonical.toLowerCase()}`;
    const dupe = byCanonical.get(canon);
    if (dupe) { mergeInto(dupe, proj); continue; }
    byCanonical.set(canon, proj);
    proj.repo = { ...proj.repo, path: ri.canonical };
  }
  // Found projects whose repo disappeared are dropped quietly.
  if (ri?.error && registry.found[proj.id]) { delete registry.found[proj.id]; continue; }

  registry.firstSeen[proj.id] ||= nowIso;
  const { release, stable } = ri && !ri.error ? pickReleases(ri.releases, ri.latestStable, proj.tagPattern) : {};
  const lastActivity = [ri?.pushedAt, release?.date].filter(Boolean).sort().pop() || null;
  const links = [...(proj.links || [])];
  if (ri?.homepage && !/github\.com|gitlab\.com/.test(ri.homepage) && !links.some((l) => l.url === ri.homepage)) {
    links.unshift({ label: 'Website', url: ri.homepage });
  }

  out.push({
    id: proj.id,
    name: proj.name,
    game: proj.game || proj.name,
    gameKey: gameKey(proj.game || proj.name),
    categories: proj.categories?.length ? proj.categories : ['Other'],
    type: proj.type || 'port',
    tags: proj.tags || [],
    repo: proj.repo ? { ...proj.repo, url: ri?.url || repoUrl(proj.repo) } : null,
    description: proj.description || ri?.description || '',
    developer: proj.developer || (proj.repo ? proj.repo.path.split('/')[0] : ''),
    status: proj.status || '',
    targets: proj.targets || [],
    image: proj.image || null,
    links,
    download: proj.download || null,
    catalogVersion: proj.catalogVersion || '',
    sources: proj.sources || [],
    discoveredFrom: proj.discoveredFrom || null,
    followed: !proj.sources?.every((s) => s === 'news' || s === 'search') || !!proj.autoFollow || followList.has(proj.id),
    hidden: hidden.has(proj.id),
    pinned: pinned.has(proj.id),
    firstSeen: registry.firstSeen[proj.id],
    stars: ri?.stars ?? null,
    pushedAt: ri?.pushedAt || null,
    archived: !!ri?.archived,
    fork: !!ri?.fork,
    lastActivity,
    release: trimRelease(release),
    stable: trimRelease(stable),
    error: ri?.error || null,
  });
}

function trimRelease(r) {
  if (!r) return null;
  const junk = /\.(sha\d*|md5|sig|asc|pdb|sym|json|txt|md)$|checksums?|sha\d*sums?|^readme|^license/i;
  return { ...r, assets: (r.assets || []).filter((a) => !junk.test(a.name)).slice(0, 12) };
}

// --------------------------------------------- 7. connect news to projects

const norm = (s) => String(s).replace(/[’`´]/g, "'").toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const distinctiveName = (n) => {
  const s = String(n || '').trim();
  if (s.length < 6) return false;
  if (/\s/.test(s)) return s.split(/\s+/).length >= 2 && s.length >= 8;
  return /[a-z][A-Z]|\d/.test(s); // CamelCase or digits: "SpaghettiKart", "Zelda64Recomp"
};
const matchers = [];
const gameNames = new Map();
for (const proj of out) {
  for (const n of uniq([proj.name, proj.repo?.path.split('/').pop()])) {
    if (distinctiveName(n) && gameKey(n) !== proj.gameKey) matchers.push({ re: new RegExp(`\\b${esc(norm(n))}\\b`), project: proj.id, game: proj.gameKey });
  }
  if (!gameNames.has(proj.gameKey)) gameNames.set(proj.gameKey, proj.game);
}
for (const [key, game] of gameNames) {
  const variants = [game.replace(/\s*\[.*?\]/g, '')];
  const sub = game.split(/:\s+/)[1];
  if (sub) variants.push(sub);
  for (const v of variants) {
    if (v.split(/\s+/).length >= 2 || v.length >= 8) matchers.push({ re: new RegExp(`\\b${esc(norm(v.trim()))}\\b`), game: key });
  }
}

const newsOut = [];
for (const a of [...articles.values()].sort((x, y) => String(y.date).localeCompare(String(x.date)))) {
  const text = norm(`${a.title} ${a.text || ''}`);
  const projectIds = new Set();
  const games = new Set();
  for (const m of matchers) {
    if (m.re.test(text)) {
      if (m.project) projectIds.add(m.project);
      games.add(m.game);
    }
  }
  for (const key of a.repos || []) {
    const [host, ...rest] = key.split(':');
    const id = repoId({ host, path: rest.join(':') });
    const proj = out.find((x) => x.id === id);
    if (proj) { projectIds.add(id); games.add(proj.gameKey); }
  }
  newsOut.push({
    title: a.title, url: a.url, date: a.date, source: a.source, outlet: a.outlet,
    summary: a.summary, image: a.image, projects: [...projectIds], games: [...games].map((key) => ({ key, name: gameNames.get(key) })),
  });
}

// ---------------------------------------------------------------- 8. write

const data = {
  generatedAt: nowIso,
  repo: process.env.GITHUB_REPOSITORY || settings.repo || '',
  settings: { activeDays: settings.activeDays, newDays: settings.newDays, seededAt: registry.meta.seededAt },
  projects: out,
  news: newsOut,
  sources: { catalogs: catalogStatus, feeds: feedStatus.sort((a, b) => a.name.localeCompare(b.name)) },
  errors,
};

writeJson('site/data.json', data, false);
writeJson('data/registry.json', {
  meta: registry.meta,
  firstSeen: Object.fromEntries(Object.entries(registry.firstSeen).sort()),
  found: Object.fromEntries(Object.entries(registry.found).sort()),
  rejected: Object.fromEntries(Object.entries(registry.rejected).sort()),
});
writeJson('data/news.json', { articles: [...articles.values()].sort((x, y) => String(y.date).localeCompare(String(x.date))) });
writeJson('data/catalogs.json', catalogCache);

const withRelease = out.filter((x) => x.release).length;
console.log(`Done: ${out.length} projects (${withRelease} with releases), ${newsOut.length} articles, ${errors.length} warnings`);
for (const e of errors) console.warn(`  ! ${e}`);
