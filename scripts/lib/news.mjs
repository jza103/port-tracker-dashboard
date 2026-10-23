// Reads RSS/Atom feeds, keeps relevant articles, and finds the repos they link to.

import { XMLParser } from 'fast-xml-parser';
import { fetchText, stripHtml, extractRepos, mapLimit } from './util.mjs';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  processEntities: true,
  htmlEntities: true,
});

function txt(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') return txt(v['#cdata'] ?? v['#text'] ?? v['@_href'] ?? '');
  return String(v);
}

function atomLink(link) {
  const links = Array.isArray(link) ? link : [link];
  const alt = links.find((l) => l && typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate'));
  return txt(alt || links[0]);
}

export function parseFeed(xml) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel || doc?.['rdf:RDF'];
  const rawItems = channel?.item || doc?.['rdf:RDF']?.item || doc?.feed?.entry || [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  return items.map((it) => {
    const content = txt(it['content:encoded']) || txt(it.content) || '';
    const summary = txt(it.description) || txt(it.summary) || '';
    const date = txt(it.pubDate) || txt(it.published) || txt(it.updated) || txt(it['dc:date']);
    const parsed = Date.parse(date);
    return {
      title: stripHtml(txt(it.title)),
      url: (it.link ? atomLink(it.link) : '') || txt(it.guid),
      date: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
      summary: stripHtml(summary).slice(0, 400),
      html: content || summary,
      outlet: txt(it.source) || '',
      image: it['media:content']?.['@_url'] || it['media:thumbnail']?.['@_url'] || it.enclosure?.['@_url'] || null,
    };
  }).filter((a) => a.title && a.url);
}

export function keywordRegex(keywords) {
  return new RegExp(`\\b(?:${keywords.filter((k) => typeof k === 'string').join('|')})\\b`, 'i');
}

/** Try to keep only the article body so site-wide footer links don't count. */
function articleBody(html) {
  const m = html.match(/<article[\s\S]*?<\/article>/i);
  if (m && m[0].length > 2000) return m[0];
  const start = html.search(/<h1[\s>]/i);
  const end = html.search(/<footer[\s>]|id=["']comments|class=["'][^"']*comments/i);
  return html.slice(Math.max(0, start), end > start ? end : undefined);
}

/**
 * Loads every feed. Returns { articles, feedStatus }. Each article carries the
 * repos it links to (from the feed text, plus the page itself for new articles).
 */
export async function loadNews(newsCfg, knownUrls) {
  const kw = keywordRegex(newsCfg.keywords || []);
  const feedStatus = [];
  const articles = [];

  await mapLimit(newsCfg.feeds || [], 6, async (feed) => {
    try {
      const xml = await fetchText(feed.url, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
      const items = parseFeed(xml);
      let kept = 0;
      for (const a of items) {
        const text = `${a.title} ${stripHtml(a.html).slice(0, 3000)}`;
        if (feed.filter !== 'all' && !kw.test(text)) continue;
        kept++;
        // Google News titles end in " - Outlet".
        if (feed.aggregator && a.outlet && a.title.endsWith(` - ${a.outlet}`)) a.title = a.title.slice(0, -(a.outlet.length + 3));
        // Aggregator summaries just repeat the headline.
        if (feed.aggregator) a.summary = '';
        articles.push({
          ...a,
          source: feed.name,
          outlet: feed.aggregator ? (a.outlet || feed.name) : feed.name,
          aggregator: !!feed.aggregator,
          text,
          repos: feed.aggregator ? [] : extractRepos(a.html),
        });
      }
      feedStatus.push({ name: feed.name, url: feed.url, ok: true, items: items.length, relevant: kept });
    } catch (err) {
      feedStatus.push({ name: feed.name, url: feed.url, ok: false, error: err.message.slice(0, 160) });
    }
  });

  // For new articles, open the page itself to find repo links the feed left out.
  const fresh = articles.filter((a) => !a.aggregator && !knownUrls.has(a.url)).slice(0, 30);
  await mapLimit(fresh, 5, async (a) => {
    try {
      const html = await fetchText(a.url, {}, { retries: 1, timeout: 20000 });
      const seen = new Set(a.repos.map((r) => `${r.host}:${r.path.toLowerCase()}`));
      for (const r of extractRepos(articleBody(html))) {
        if (!seen.has(`${r.host}:${r.path.toLowerCase()}`)) a.repos.push(r);
      }
    } catch { /* page blocked or slow: feed text is enough */ }
  });

  for (const a of articles) delete a.html;
  return { articles, feedStatus };
}
