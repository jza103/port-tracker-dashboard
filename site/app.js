// Port Tracker front end. Reads data.json (built by scripts/update.mjs) and
// keeps your hide/pin/follow choices in this browser until you save them to
// GitHub, which turns them into a commit to config/projects.yml.

const DAY = 86400000;
const PAGE = 60;
const CATEGORY_ORDER = [
  'Nintendo 64', 'GameCube', 'Wii', 'Wii U', 'Nintendo Switch', 'SNES', 'NES', 'Game Boy', 'Game Boy Color',
  'Game Boy Advance', 'Nintendo DS', 'Nintendo 3DS', 'Virtual Boy', 'PlayStation', 'PlayStation 2', 'PlayStation 3',
  'PlayStation 4', 'PlayStation Portable', 'Xbox', 'Xbox 360', 'Dreamcast', 'Sega Saturn', 'Mega Drive', 'Arcade',
  'PC', 'Mobile', 'VR Ports', 'Tools & Recompilers', 'Other',
];
// Extra choices under "Decomp" in the type filter: value -> [label, progress status].
const PROGRESS_FILTERS = {
  'decomp:complete': ['Decomp: complete', 'complete'],
  'decomp:in-progress': ['Decomp: in progress', 'in-progress'],
  'decomp:unknown': ['Decomp: progress not published', 'unknown'],
};
const TYPE_LABELS = {
  decompilation: 'Decomp', recompilation: 'Recomp', port: 'Port', 'source-port': 'Source port',
  reimplementation: 'Reimplementation', mod: 'Mod', tool: 'Tool', emulator: 'Emulator', wrapper: 'Wrapper',
};

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`pt.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`pt.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

let data = null;
let byId = new Map();
let changes = store.get('changes', { hide: [], unhide: [], pin: [], unpin: [], follow: [], add: [] });
const ui = {
  tab: 'projects', cat: 'All', type: '', sort: 'activity', activeOnly: false, dlOnly: false,
  newsSource: '', newsMine: false, ...store.get('ui', {}), q: '', shown: PAGE,
};
const lastVisit = store.get('lastVisit', 0);
const device = detectDevice();

// ------------------------------------------------------------------ utils

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || '')) ? esc(u) : '#';
}
function ago(iso) {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / DAY;
  if (d < 1 / 24) return 'just now';
  if (d < 1) return `${Math.round(d * 24)}h ago`;
  if (d < 45) return `${Math.round(d)}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${(d / 365).toFixed(1).replace('.0', '')}y ago`;
}
function shortDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(iso).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}
function fmtStars(n) {
  if (n == null) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}
const icon = {
  star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
  dl: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 4 3v2H6v-2l4-3zM12 15v6"/></svg>',
  hide: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.6 3.2M6.6 6.6C4.3 8.2 3 12 3 12s4 6 9 6a8.6 8.6 0 0 0 4.4-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  show: '<svg viewBox="0 0 24 24"><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="3"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};

function detectDevice() {
  const ua = navigator.userAgent;
  if (/OculusBrowser|Quest/i.test(ua)) return 'Quest';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad/i.test(ua)) return 'iOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return '';
}

/** Put a friendly platform name on a release file. */
function assetLabel(name, isVr) {
  const n = name.toLowerCase();
  if (/\.apk$/.test(n)) return isVr || /quest/.test(n) ? 'Quest APK' : 'Android';
  if (/\.(nro|nsp)$|switch/.test(n)) return 'Switch';
  if (/\.vpk$|vita/.test(n)) return 'Vita';
  if (/\.(cia|3dsx)$|3ds/.test(n)) return '3DS';
  if (/\.ipa$|\bios\b/.test(n)) return 'iOS';
  if (/\.dmg$|mac|osx|darwin|apple/.test(n)) return 'macOS';
  if (/\.appimage$|\.flatpak$|\.deb$|\.rpm$|linux|steamdeck|steam-deck/.test(n)) return 'Linux';
  if (/\.exe$|\.msi$|win|windows|x64|x86/.test(n)) return 'Windows';
  if (/android/.test(n)) return 'Android';
  return null;
}
function deviceMatches(label) {
  if (!device || !label) return false;
  if (device === 'Quest') return label === 'Quest APK' || label === 'Android';
  return label === device || (device === 'Android' && label === 'Quest APK');
}

// -------------------------------------------------------- effective state

function isHidden(p) {
  if (changes.hide.includes(p.id)) return true;
  if (changes.unhide.includes(p.id)) return false;
  return p.hidden;
}
function isPinned(p) {
  if (changes.pin.includes(p.id)) return true;
  if (changes.unpin.includes(p.id)) return false;
  return p.pinned;
}
function isFollowed(p) {
  return p.followed || changes.follow.includes(p.id);
}
function activity(p) {
  if (p.archived) return { cls: 'dead', label: 'Archived' };
  if (p.error) return { cls: 'dead', label: 'Unavailable' };
  if (!p.lastActivity) return { cls: 'dormant', label: p.repo ? 'Unknown' : 'External' };
  const days = (Date.now() - Date.parse(p.lastActivity)) / DAY;
  if (days <= (data.settings.activeDays || 120)) return { cls: 'active', label: `Active · ${ago(p.lastActivity)}` };
  if (days <= 365) return { cls: 'slow', label: `Updated ${ago(p.lastActivity)}` };
  return { cls: 'dormant', label: `Dormant · ${ago(p.lastActivity)}` };
}
function isActive(p) {
  return activity(p).cls === 'active';
}
function isNew(p) {
  const seeded = Date.parse(data.settings.seededAt || 0) + 3600000;
  const first = Date.parse(p.firstSeen || 0);
  return first > seeded && Date.now() - first < (data.settings.newDays || 14) * DAY;
}
function hasDownloads(p) {
  return !!(p.download || p.release?.assets?.length);
}
/** How strongly to recommend a project among others for the same game. */
function score(p) {
  const days = p.lastActivity ? (Date.now() - Date.parse(p.lastActivity)) / DAY : 9999;
  return Math.log10((p.stars || 0) + 1) * 2
    + (days <= (data.settings.activeDays || 120) ? 3 : days <= 365 ? 1 : 0)
    + (hasDownloads(p) ? 1.5 : 0)
    + (p.type === 'decompilation' ? -0.5 : 0)
    - (p.archived || p.error ? 6 : 0)
    - (p.fork ? 1 : 0);
}

// ----------------------------------------------------------------- render

function render() {
  store.set('ui', { tab: ui.tab, cat: ui.cat, type: ui.type, sort: ui.sort, activeOnly: ui.activeOnly, dlOnly: ui.dlOnly, newsSource: ui.newsSource, newsMine: ui.newsMine });
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab));
  for (const s of document.querySelectorAll('.tab-panel')) s.hidden = s.id !== `tab-${ui.tab}`;
  renderCounts();
  if (ui.tab === 'projects') renderProjects();
  if (ui.tab === 'releases') renderReleases();
  if (ui.tab === 'news') renderNews();
  if (ui.tab === 'discovered') renderDiscovered();
  if (ui.tab === 'hidden') renderHidden();
  renderSavebar();
}

function visibleProjects() {
  return data.projects.filter((p) => isFollowed(p) && !isHidden(p));
}

function matchesQuery(p, q) {
  if (!q) return true;
  const hay = `${p.name} ${p.game} ${p.developer} ${p.description} ${p.repo?.path || ''} ${p.categories.join(' ')} ${p.tags.join(' ')}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function renderCounts() {
  const vis = visibleProjects();
  $('#c-projects').textContent = new Set(vis.map((p) => p.gameKey)).size;
  $('#c-releases').textContent = recentReleases().length || '';
  $('#c-news').textContent = data.news.length || '';
  const inbox = data.projects.filter((p) => !isFollowed(p) && !isHidden(p)).length;
  const fresh = vis.filter(isNew).length;
  const dc = $('#c-discovered');
  dc.textContent = inbox + fresh || '';
  dc.classList.toggle('badge', fresh > 0);
  $('#c-hidden').textContent = data.projects.filter(isHidden).length || '';
}

function renderProjects() {
  const q = ui.q.trim().toLowerCase();
  const base = visibleProjects();

  // Category chips (counts are games, not projects).
  const catGames = new Map();
  for (const p of base) for (const c of p.categories) {
    if (!catGames.has(c)) catGames.set(c, new Set());
    catGames.get(c).add(p.gameKey);
  }
  const cats = [...catGames.keys()].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a); const ib = CATEGORY_ORDER.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
  });
  if (ui.cat !== 'All' && !catGames.has(ui.cat)) ui.cat = 'All';
  $('#cats').innerHTML = [['All', new Set(base.map((p) => p.gameKey)).size], ...cats.map((c) => [c, catGames.get(c).size])]
    .map(([c, n]) => `<button class="chip" data-cat="${esc(c)}" aria-pressed="${c === ui.cat}">${esc(c)}<span class="n">${n}</span></button>`).join('');

  const types = [...new Set(base.map((p) => p.type))].sort();
  const opts = [['', 'All types'], ...types.map((t) => [t, TYPE_LABELS[t] || t])];
  if (types.includes('decompilation')) {
    const at = opts.findIndex(([v]) => v === 'decompilation') + 1;
    opts.splice(at, 0, ...Object.entries(PROGRESS_FILTERS).map(([v, [label]]) => [v, `\u00a0\u00a0${label}`]));
  }
  $('#type').innerHTML = opts.map(([v, label]) => `<option value="${esc(v)}"${v === ui.type ? ' selected' : ''}>${esc(label)}</option>`).join('');
  $('#sort').value = ui.sort;
  $('#active-only').checked = ui.activeOnly;
  $('#dl-only').checked = ui.dlOnly;

  const filtered = base.filter((p) => (ui.cat === 'All' || p.categories.includes(ui.cat))
    && (!ui.type || (PROGRESS_FILTERS[ui.type] ? p.progress?.status === PROGRESS_FILTERS[ui.type][1] : p.type === ui.type))
    && (!ui.activeOnly || isActive(p))
    && (!ui.dlOnly || hasDownloads(p))
    && matchesQuery(p, q));

  // Group by game; best project first.
  const groups = new Map();
  for (const p of filtered) {
    if (!groups.has(p.gameKey)) groups.set(p.gameKey, []);
    groups.get(p.gameKey).push(p);
  }
  let list = [...groups.entries()].map(([key, ps]) => {
    ps.sort((a, b) => (isPinned(b) - isPinned(a)) || score(b) - score(a));
    return { key, projects: ps, game: gameTitle(ps) };
  });
  const latest = (g) => Math.max(...g.projects.map((p) => Date.parse(p.lastActivity || 0)));
  const sorters = {
    activity: (a, b) => latest(b) - latest(a),
    stars: (a, b) => Math.max(...b.projects.map((p) => p.stars || 0)) - Math.max(...a.projects.map((p) => p.stars || 0)),
    added: (a, b) => Math.max(...b.projects.map((p) => Date.parse(p.firstSeen || 0))) - Math.max(...a.projects.map((p) => Date.parse(p.firstSeen || 0))) || latest(b) - latest(a),
    name: (a, b) => a.game.localeCompare(b.game),
    progress: (a, b) => bestProgress(b) - bestProgress(a) || latest(b) - latest(a),
  };
  list.sort(sorters[ui.sort] || sorters.activity);

  $('#result-count').textContent = `${list.length} games · ${filtered.length} projects`;
  const shown = list.slice(0, ui.shown);
  if (shown.length) layoutCards(shown.map(renderGame));
  else $('#games').innerHTML = `<div class="empty">Nothing matches. ${base.length ? 'Try clearing the filters.' : 'No projects yet: run the updater.'}</div>`;
  $('#more').hidden = list.length <= ui.shown;
  $('#more').textContent = `Show more (${list.length - ui.shown} left)`;
}

/** Highest decomp progress in a game group, for sorting (no data sorts last). */
function bestProgress(g) {
  return Math.max(-1, ...g.projects.map((p) => (p.progress?.status === 'complete' ? 100 : p.progress?.percent ?? -1)));
}

/** Masonry layout: each card goes into the currently shortest column, in order. */
let lastCards = [];
function layoutCards(cards) {
  lastCards = cards;
  const root = $('#games');
  const minCol = 400;
  const gap = 14;
  const n = Math.max(1, Math.floor((root.clientWidth + gap) / (minCol + gap)));
  root.innerHTML = '';
  root.dataset.cols = n;
  const cols = Array.from({ length: n }, () => root.appendChild(Object.assign(document.createElement('div'), { className: 'col' })));
  const tpl = document.createElement('template');
  for (const html of cards) {
    tpl.innerHTML = html;
    const shortest = cols.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));
    shortest.append(tpl.content);
  }
}
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const root = $('#games');
    const n = Math.max(1, Math.floor((root.clientWidth + 14) / 414));
    if (ui.tab === 'projects' && lastCards.length && String(n) !== root.dataset.cols) layoutCards(lastCards);
  }, 150);
});

function gameTitle(ps) {
  // Most common spelling of the game name in the group.
  const counts = new Map();
  for (const p of ps) counts.set(p.game, (counts.get(p.game) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function renderGame(g) {
  const [top, ...rest] = g.projects;
  // Show other projects inline when they're also active and reasonably popular.
  // Projects with something to download win the inline spots over source-only ones.
  const isStrong = (p) => isPinned(p) || (isActive(p) && ((p.stars || 0) >= Math.max(25, (top.stars || 0) * 0.15)
    || (hasDownloads(p) && p.categories.includes('VR Ports') !== top.categories.includes('VR Ports'))));
  const inlineIds = new Set(rest.filter(isStrong)
    .sort((a, b) => (isPinned(b) - isPinned(a)) || (hasDownloads(b) - hasDownloads(a)) || score(b) - score(a))
    .slice(0, 2).map((p) => p.id));
  const inline = rest.filter((p) => inlineIds.has(p.id));
  const folded = rest.filter((p) => !inlineIds.has(p.id));
  const cats = [...new Set(g.projects.flatMap((p) => p.categories))];
  const img = g.projects.find((p) => p.image)?.image;
  const news = data.news.filter((a) => a.games.some((x) => x.key === g.key)).slice(0, 3);

  return `<article class="game">
    <div class="game-head">
      ${img ? `<img class="thumb" src="${safeUrl(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : `<div class="thumb blank">${esc(g.game[0] || '?')}</div>`}
      <div class="game-title">
        <h3>${esc(g.game)}</h3>
        <div class="cats">${cats.map((c) => `<span class="tag${c === 'VR Ports' ? ' vr' : ''}">${esc(c)}</span>`).join('')}</div>
      </div>
    </div>
    ${renderProject(top, true)}
    ${inline.map((p) => renderProject(p, false)).join('')}
    ${folded.length ? `<details class="alts"><summary>${folded.length} more project${folded.length > 1 ? 's' : ''} for this game</summary>${folded.map((p) => renderProject(p, false)).join('')}</details>` : ''}
    ${news.length ? `<div class="game-news">${news.map((a) => `<a href="${safeUrl(a.url)}" target="_blank" rel="noopener">📰 ${esc(a.title)} <span class="src">· ${esc(a.outlet || a.source)} · ${esc(ago(a.date))}</span></a>`).join('')}</div>` : ''}
  </article>`;
}

function renderDownloads(p) {
  const vr = p.categories.includes('VR Ports') || p.tags.includes('VR');
  const btns = [];
  const seen = new Set();
  for (const a of p.release?.assets || []) {
    const label = assetLabel(a.name, vr);
    const key = label || a.name;
    if (seen.has(key)) continue;
    seen.add(key);
    btns.push({ label: label || a.name, url: a.url, title: a.name, mine: deviceMatches(label) });
  }
  // The catalog's direct link is only a fallback when the release has no recognisable files.
  if (p.download && !btns.some((b) => b.url === p.download.url || assetLabel(b.title, vr))) {
    btns.unshift({ label: p.download.label || 'Download', url: p.download.url, title: p.download.url, mine: device === 'Quest' });
  }
  btns.sort((a, b) => b.mine - a.mine);
  const max = 5;
  const parts = btns.slice(0, max).map((b) => `<a class="dl${b.mine ? ' mine' : ''}" href="${safeUrl(b.url)}" title="${esc(b.title)}" rel="noopener">${icon.dl}<span>${esc(b.label)}</span></a>`);
  if (p.release && (btns.length > max || (p.release.assets || []).length > btns.length)) {
    parts.push(`<a class="dl ghost" href="${safeUrl(p.release.url)}" target="_blank" rel="noopener"><span>All files</span></a>`);
  }
  return parts.join('');
}

function renderProgress(p) {
  const pr = p.progress;
  if (!pr) return '';
  if (pr.status === 'unknown') {
    return '<div class="progress unknown"><span class="tag" title="No progress tracker or badge found for this project">Progress not published</span></div>';
  }
  const done = pr.status === 'complete';
  const details = [pr.data != null && `data ${pr.data}%`, pr.functions != null && `functions ${pr.functions}%`].filter(Boolean).join(' · ');
  const label = pr.version ? `${pr.source} (${pr.version} version)` : pr.source;
  const src = pr.url ? `<a href="${safeUrl(pr.url)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label);
  return `<div class="progress${done ? ' done' : ''}">
    <div class="progress-line">
      <span class="tag ${done ? 'good' : 'warn'}">${done ? 'Complete' : 'In progress'}</span>
      <strong>${esc(pr.percent)}%</strong><span class="muted">${done ? 'decompiled' : 'code decompiled'}${details ? ` · ${esc(details)}` : ''} · ${src}</span>
    </div>
    <div class="bar" role="progressbar" aria-valuenow="${esc(pr.percent)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(0, Math.min(100, Number(pr.percent) || 0))}%"></span></div>
  </div>`;
}

function renderProject(p, primary) {
  const act = activity(p);
  const pin = isPinned(p);
  const rel = p.release;
  const extraLinks = [
    p.repo && { label: p.repo.host === 'gitlab' ? 'GitLab' : 'GitHub', url: p.repo.url },
    ...p.links,
  ].filter(Boolean);
  const dls = renderDownloads(p);

  return `<div class="proj" data-id="${esc(p.id)}">
    <div class="proj-top">
      <div class="proj-name">
        <a class="name" href="${safeUrl(p.repo?.url || p.links[0]?.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>
        ${p.developer ? `<span class="by">by ${esc(p.developer)}</span>` : ''}
      </div>
      <div class="proj-actions">
        <button class="icon-btn${pin ? ' on' : ''}" data-act="${pin ? 'unpin' : 'pin'}" title="${pin ? 'Unpin' : 'Pin to top of this game'}">${icon.pin}</button>
        <button class="icon-btn" data-act="hide" title="Unfollow / hide">${icon.hide}</button>
      </div>
    </div>
    <div class="meta">
      <span><span class="dot ${act.cls}"></span>${esc(act.label)}</span>
      ${p.stars != null ? `<span title="Stars">★ ${fmtStars(p.stars)}</span>` : ''}
      <span class="tag type">${esc(TYPE_LABELS[p.type] || p.type)}</span>
      ${p.tags.includes('VR') && !p.categories.includes('VR Ports') ? '<span class="tag vr">VR</span>' : ''}
      ${p.status ? `<span class="tag">${esc(p.status)}</span>` : ''}
      ${isNew(p) ? '<span class="tag new">NEW</span>' : ''}
      ${p.fork ? '<span class="tag">Fork</span>' : ''}
      ${p.targets.length ? `<span>${esc(p.targets.join(', '))}</span>` : ''}
    </div>
    ${primary && p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
    ${renderProgress(p)}
    ${rel ? `<div class="rel">
        <div class="rel-line">
          <a class="ver" href="${safeUrl(rel.url)}" target="_blank" rel="noopener">${esc(rel.name && rel.name !== rel.tag ? `${rel.tag} · ${rel.name}` : rel.tag)}</a>
          ${rel.prerelease ? '<span class="tag warn">Pre-release</span>' : ''}
          <span class="when">${esc(shortDate(rel.date))} (${esc(ago(rel.date))})</span>
          ${p.stable ? `<a class="when" href="${safeUrl(p.stable.url)}" target="_blank" rel="noopener">${Date.parse(p.stable.date) > Date.parse(rel.date) ? 'Newer build' : 'Stable'}: ${esc(p.stable.tag)}</a>` : ''}
        </div>
        ${dls ? `<div class="dls">${dls}</div>` : ''}
      </div>`
    : dls ? `<div class="rel"><div class="dls">${dls}</div></div>`
      : `<div class="norel">${p.repo ? 'No releases yet: build from source or check the links.' : 'Downloads on the project page.'}</div>`}
    ${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}
    <div class="links">${extraLinks.map((l) => `<a href="${safeUrl(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}</div>
  </div>`;
}

function recentReleases() {
  const cutoff = Date.now() - 90 * DAY;
  const out = [];
  for (const p of visibleProjects()) {
    for (const r of [p.release, p.stable]) {
      if (r && Date.parse(r.date) > cutoff) out.push({ p, r });
    }
  }
  return out.sort((a, b) => Date.parse(b.r.date) - Date.parse(a.r.date));
}

function renderReleases() {
  const q = ui.q.trim().toLowerCase();
  const list = recentReleases().filter(({ p }) => matchesQuery(p, q));
  $('#releases').innerHTML = list.length ? list.slice(0, 300).map(({ p, r }) => {
    const unseen = Date.parse(r.date) > lastVisit && lastVisit > 0;
    const dls = renderDownloads({ ...p, release: r, download: null });
    return `<div class="row${unseen ? ' unseen' : ''}" data-id="${esc(p.id)}">
      <div class="when">${esc(shortDate(r.date))}</div>
      <div class="body">
        <a class="title" href="${safeUrl(r.url)}" target="_blank" rel="noopener">${esc(p.name)} ${esc(r.tag)}</a>
        ${r.prerelease ? ' <span class="tag warn">Pre-release</span>' : ''}${unseen ? ' <span class="tag new">Since last visit</span>' : ''}
        <div class="line2">${esc(p.game)} · ${esc(p.categories.join(', '))}</div>
        ${dls ? `<div class="dls">${dls}</div>` : ''}
      </div>
    </div>`;
  }).join('') : '<div class="empty">No releases in the last 90 days.</div>';
}

function renderNews() {
  const sources = [...new Set(data.news.map((a) => a.outlet || a.source))].sort();
  if (ui.newsSource && !sources.includes(ui.newsSource)) ui.newsSource = '';
  $('#news-source').innerHTML = `<option value="">All outlets</option>${sources.map((s) => `<option${s === ui.newsSource ? ' selected' : ''}>${esc(s)}</option>`).join('')}`;
  $('#news-mine').checked = ui.newsMine;
  const q = ui.q.trim().toLowerCase();
  const trackedGames = new Set(visibleProjects().map((p) => p.gameKey));
  const list = data.news.filter((a) => (!ui.newsSource || (a.outlet || a.source) === ui.newsSource)
    && (!ui.newsMine || a.projects.some((id) => byId.has(id) && isFollowed(byId.get(id)) && !isHidden(byId.get(id))) || a.games.some((x) => trackedGames.has(x.key)))
    && (!q || `${a.title} ${a.summary}`.toLowerCase().includes(q)));
  $('#news').innerHTML = list.length ? list.slice(0, 300).map((a) => {
    const projs = a.projects.map((id) => byId.get(id)).filter(Boolean);
    const games = a.games.filter((x) => !projs.some((p) => p.gameKey === x.key));
    const chips = [...projs.map((p) => p.name), ...games.map((x) => x.name)].slice(0, 6);
    return `<div class="row">
      ${a.image ? `<img class="news-img" src="${safeUrl(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <div class="body">
        <a class="title" href="${safeUrl(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>
        <div class="line2">${esc(a.outlet || a.source)} · ${esc(shortDate(a.date))} (${esc(ago(a.date))})</div>
        ${a.summary ? `<div class="line2">${esc(a.summary.slice(0, 220))}${a.summary.length > 220 ? '…' : ''}</div>` : ''}
        ${chips.length ? `<div class="chips">${chips.map((n) => `<button class="chip" data-search="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      </div>
    </div>`;
  }).join('') : '<div class="empty">No news matches.</div>';
}

function discoveredRow(p, actions) {
  const from = p.discoveredFrom;
  const src = from
    ? from.kind === 'news'
      ? `Linked in <a href="${safeUrl(from.url)}" target="_blank" rel="noopener">${esc(from.title)}</a> (${esc(from.source || '')})`
      : `GitHub search: <code>${esc(from.title)}</code>`
    : `From ${esc(p.sources.join(', '))}`;
  return `<div class="row" data-id="${esc(p.id)}">
    <div class="when">${esc(ago(p.firstSeen))}</div>
    <div class="body">
      <a class="title" href="${safeUrl(p.repo?.url || p.links[0]?.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>
      ${p.stars != null ? `<span class="by"> ★ ${fmtStars(p.stars)}</span>` : ''}
      <div class="line2">${esc(p.game)} · ${esc(p.categories.join(', '))} · ${esc(TYPE_LABELS[p.type] || p.type)}</div>
      ${p.description ? `<div class="line2">${esc(p.description)}</div>` : ''}
      <div class="line2">${src}</div>
    </div>
    <div class="side">${actions}</div>
  </div>`;
}

function renderDiscovered() {
  const fresh = visibleProjects().filter(isNew).sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen));
  const inbox = data.projects.filter((p) => !isFollowed(p) && !isHidden(p)).sort((a, b) => (b.stars || 0) - (a.stars || 0));
  const pending = changes.add;
  let html = '';
  if (pending.length) {
    html += `<h2 class="section">Waiting to be saved (${pending.length})</h2><div class="list">${pending.map((a, i) => `<div class="row"><div class="body"><span class="title">${esc(a.name || a.repo || a.url)}</span><div class="line2">${esc(a.repo || a.url)} · ${esc(a.game || 'game: guess')} · ${esc(a.category || 'category: guess')}</div></div><div class="side"><button class="btn small" data-unadd="${i}">Remove</button></div></div>`).join('')}</div>`;
  }
  html += `<h2 class="section">New in the last ${data.settings.newDays || 14} days (${fresh.length})</h2>`;
  html += fresh.length
    ? `<div class="list">${fresh.map((p) => discoveredRow(p, `<button class="btn small" data-act="hide">${icon.hide} Unfollow</button>`)).join('')}</div>`
    : '<p class="hint">Nothing new yet. New projects from catalogs and news articles show up here automatically.</p>';
  html += `<h2 class="section">Suggestions (${inbox.length})</h2><p class="hint">Found by GitHub searches or linked from news, but not clearly a port. Follow the ones you want.</p>`;
  html += inbox.length
    ? `<div class="list">${inbox.map((p) => discoveredRow(p, `<button class="btn small primary" data-act="follow">${icon.plus} Follow</button><button class="btn small" data-act="hide">Dismiss</button>`)).join('')}</div>`
    : '<p class="hint">No suggestions right now.</p>';
  $('#discovered').innerHTML = html;
}

function renderHidden() {
  const list = data.projects.filter(isHidden).sort((a, b) => a.game.localeCompare(b.game));
  $('#hidden-list').innerHTML = list.length
    ? list.map((p) => discoveredRow(p, `<button class="btn small" data-act="unhide">${icon.show} Unhide</button>`)).join('')
    : '<div class="empty">Nothing hidden.</div>';
}

function renderSavebar() {
  const n = changes.hide.length + changes.unhide.length + changes.pin.length + changes.unpin.length + changes.follow.length + changes.add.length;
  $('#savebar').hidden = n === 0;
  $('#savebar-text').textContent = `${n} unsaved change${n === 1 ? '' : 's'}`;
}

function renderFooter() {
  const s = data.sources;
  const feedsOk = s.feeds.filter((f) => f.ok).length;
  $('#foot').innerHTML = `<details>
    <summary>Sources: ${s.catalogs.map((c) => esc(c.name)).join(', ')} and ${feedsOk}/${s.feeds.length} news feeds · updated ${esc(ago(data.generatedAt))}${data.errors.length ? ` · <span class="bad">${data.errors.length} warning${data.errors.length > 1 ? 's' : ''}</span>` : ''}</summary>
    <ul>
      ${s.catalogs.map((c) => `<li${c.ok ? '' : ' class="bad"'}><a href="${safeUrl(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>: ${c.count} projects${c.ok ? '' : ` (${esc(c.error)})`}</li>`).join('')}
      ${s.feeds.map((f) => `<li${f.ok ? '' : ' class="bad"'}>${esc(f.name)}: ${f.ok ? `${f.relevant} relevant of ${f.items}` : esc(f.error)}</li>`).join('')}
    </ul>
    ${data.errors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')}
    ${data.repo ? `<p>Edit what's tracked in <a href="https://github.com/${esc(data.repo)}/blob/main/config/projects.yml" target="_blank" rel="noopener">config/projects.yml</a> and sources in <a href="https://github.com/${esc(data.repo)}/blob/main/config/sources.yml" target="_blank" rel="noopener">config/sources.yml</a>.</p>` : ''}
  </details>`;
}

// ---------------------------------------------------------------- changes

function setChange(act, id) {
  const opposite = { hide: 'unhide', unhide: 'hide', pin: 'unpin', unpin: 'pin' };
  const p = byId.get(id);
  if (opposite[act]) {
    changes[opposite[act]] = changes[opposite[act]].filter((x) => x !== id);
    // Only keep a change if it differs from what the server already has.
    const serverHas = act === 'hide' ? p?.hidden : act === 'unhide' ? !p?.hidden : act === 'pin' ? p?.pinned : !p?.pinned;
    if (!serverHas && !changes[act].includes(id)) changes[act].push(id);
  } else if (act === 'follow' && !changes.follow.includes(id)) {
    changes.follow.push(id);
    changes.hide = changes.hide.filter((x) => x !== id);
  }
  store.set('changes', changes);
  render();
}

/** Drop queued changes the published data already reflects. */
function pruneChanges() {
  const has = (id) => byId.has(id);
  changes.hide = changes.hide.filter((id) => has(id) && !byId.get(id).hidden);
  changes.unhide = changes.unhide.filter((id) => has(id) && byId.get(id).hidden);
  changes.pin = changes.pin.filter((id) => has(id) && !byId.get(id).pinned);
  changes.unpin = changes.unpin.filter((id) => has(id) && byId.get(id).pinned);
  changes.follow = changes.follow.filter((id) => has(id) && !byId.get(id).followed);
  const known = new Set(data.projects.flatMap((p) => [p.id, p.repo?.url?.toLowerCase()]));
  changes.add = changes.add.filter((a) => !known.has(normalizeRef(a.repo || a.url)));
  store.set('changes', changes);
}
function normalizeRef(ref) {
  const s = String(ref || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const gh = s.match(/github\.com\/([^/]+\/[^/#?]+)/i);
  if (gh) return gh[1].toLowerCase();
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s.toLowerCase();
  return s.toLowerCase();
}

function saveToGitHub() {
  if (!data.repo) { toast('Set settings.repo in config/sources.yml first'); return; }
  const payload = {};
  for (const k of ['hide', 'unhide', 'pin', 'unpin', 'follow', 'add']) if (changes[k].length) payload[k] = changes[k];
  const json = JSON.stringify(payload, null, 1);
  const n = Object.values(payload).reduce((s, v) => s + v.length, 0);
  const url = `https://github.com/${data.repo}/issues/new?template=dashboard-change.yml`
    + `&title=${encodeURIComponent(`[dashboard] ${n} change${n === 1 ? '' : 's'}`)}`
    + `&changes=${encodeURIComponent(json)}`;
  window.open(url, '_blank', 'noopener');
  toast('Submit the issue on GitHub. The dashboard updates a minute or two later.');
}

// ----------------------------------------------------------------- events

function bind() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    ui.tab = b.dataset.tab;
    render();
    window.scrollTo({ top: 0 });
  });
  $('#cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    ui.cat = b.dataset.cat;
    ui.shown = PAGE;
    render();
  });
  let t;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { ui.q = e.target.value; ui.shown = PAGE; render(); }, 120);
  });
  $('#type').addEventListener('change', (e) => { ui.type = e.target.value; ui.shown = PAGE; render(); });
  $('#sort').addEventListener('change', (e) => { ui.sort = e.target.value; render(); });
  $('#active-only').addEventListener('change', (e) => { ui.activeOnly = e.target.checked; ui.shown = PAGE; render(); });
  $('#dl-only').addEventListener('change', (e) => { ui.dlOnly = e.target.checked; ui.shown = PAGE; render(); });
  $('#news-source').addEventListener('change', (e) => { ui.newsSource = e.target.value; render(); });
  $('#news-mine').addEventListener('change', (e) => { ui.newsMine = e.target.checked; render(); });
  $('#more').addEventListener('click', () => { ui.shown += PAGE; renderProjects(); });
  $('#save').addEventListener('click', saveToGitHub);
  $('#discard').addEventListener('click', () => {
    changes = { hide: [], unhide: [], pin: [], unpin: [], follow: [], add: [] };
    store.set('changes', changes);
    render();
  });

  document.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const id = act.closest('[data-id]')?.dataset.id;
      if (!id) return;
      setChange(act.dataset.act, id);
      if (act.dataset.act === 'hide') toast(`Hidden: ${byId.get(id)?.name}. Undo from the Hidden tab.`);
      return;
    }
    const s = e.target.closest('[data-search]');
    if (s) {
      ui.q = s.dataset.search;
      $('#q').value = ui.q;
      ui.tab = 'projects';
      ui.cat = 'All';
      render();
      return;
    }
    const un = e.target.closest('[data-unadd]');
    if (un) {
      changes.add.splice(Number(un.dataset.unadd), 1);
      store.set('changes', changes);
      render();
    }
  });

  const dlg = $('#add-dialog');
  $('#add-btn').addEventListener('click', () => {
    $('#game-list').innerHTML = [...new Set(data.projects.map((p) => p.game))].sort().map((g) => `<option value="${esc(g)}">`).join('');
    $('#cat-list').innerHTML = [...new Set(data.projects.flatMap((p) => p.categories))].sort().map((c) => `<option value="${esc(c)}">`).join('');
    $('#add-form').reset();
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const f = new FormData($('#add-form'));
    const ref = String(f.get('ref') || '').trim();
    if (!ref) return;
    const isRepo = /github\.com|gitlab\.com|^[\w.-]+\/[\w.-]+$/i.test(ref);
    const entry = { [isRepo ? 'repo' : 'url']: ref };
    for (const k of ['name', 'game', 'category', 'type']) if (f.get(k)) entry[k] = String(f.get(k)).trim();
    if (f.get('vr')) {
      entry.tags = ['VR'];
      entry.categories = [entry.category, 'VR Ports'].filter(Boolean);
      delete entry.category;
    }
    if (known(ref)) { toast('Already tracked. Search for it, or check the Hidden tab.'); return; }
    changes.add.push(entry);
    store.set('changes', changes);
    render();
    toast('Added. Press "Save to GitHub" to make it permanent.');
  });
}

function known(ref) {
  const n = normalizeRef(ref);
  return data.projects.some((p) => p.id === n || p.repo?.url?.toLowerCase().includes(n));
}

// ------------------------------------------------------------------- boot

async function boot() {
  bind();
  try {
    const res = await fetch(`data.json?v=${Math.floor(Date.now() / 300000)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    $('#updated').textContent = 'data not available';
    $('#games').innerHTML = `<div class="empty">Couldn't load data.json (${esc(err.message)}). Run <code>npm run update</code> first.</div>`;
    return;
  }
  byId = new Map(data.projects.map((p) => [p.id, p]));
  pruneChanges();
  $('#updated').textContent = `updated ${ago(data.generatedAt)}`;
  $('#updated').title = new Date(data.generatedAt).toLocaleString();
  renderFooter();
  render();
  // Remember the visit a little later so "since last visit" survives a quick reload.
  setTimeout(() => store.set('lastVisit', Date.now()), 15000);
}

boot();
