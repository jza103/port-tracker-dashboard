// Fetches stars, activity and releases for GitHub and GitLab projects.
//
// With a GITHUB_TOKEN (always present on GitHub Actions) it uses one GraphQL
// query per 30 repos. Without one it falls back to the public ungh.cc mirror,
// which is slower but needs no account.

import { fetchJson, fetchWithRetry, mapLimit, sleep } from './util.mjs';

const RELEASE_FIELDS = `tagName name publishedAt createdAt url isPrerelease isDraft
  releaseAssets(first: 15) { nodes { name downloadUrl size downloadCount } }`;

const REPO_FIELDS = `nameWithOwner url description homepageUrl stargazerCount pushedAt isArchived isFork
  repositoryTopics(first: 12) { nodes { topic { name } } }
  latestRelease { ${RELEASE_FIELDS} }
  releases(first: 12, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${RELEASE_FIELDS} } }`;

async function graphql(token, query, variables = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchWithRetry('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    }, { retries: 2, timeout: 60000 });
    if (res.status === 403 || res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 30);
      console.warn(`  GitHub rate limit, waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error('GitHub GraphQL: still rate limited after retries');
}

function normRelease(r, host = 'github') {
  if (!r) return null;
  if (host === 'github') {
    return {
      tag: r.tagName,
      name: r.name || r.tagName,
      date: r.publishedAt || r.createdAt,
      url: r.url,
      prerelease: !!r.isPrerelease,
      assets: (r.releaseAssets?.nodes || []).map((a) => ({
        name: a.name, url: a.downloadUrl, size: a.size, downloads: a.downloadCount,
      })),
    };
  }
  return r;
}

/** Choose the release to show, and the latest stable one if that's different. */
export function pickReleases(all, latestStable, tagPattern) {
  let list = all.filter(Boolean);
  let stable = latestStable;
  if (tagPattern) {
    const re = new RegExp(tagPattern, 'i');
    list = list.filter((r) => re.test(r.tag));
    stable = list.find((r) => !r.prerelease) || null;
  }
  list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const newest = list[0] || stable || null;
  if (!stable) stable = list.find((r) => !r.prerelease) || null;
  return {
    release: newest,
    stable: stable && newest && stable.tag !== newest.tag ? stable : null,
  };
}

function normGithubRepo(node) {
  const releases = (node.releases?.nodes || []).filter((r) => !r.isDraft).map((r) => normRelease(r));
  return {
    canonical: node.nameWithOwner,
    url: node.url,
    description: node.description || '',
    homepage: node.homepageUrl || '',
    stars: node.stargazerCount,
    pushedAt: node.pushedAt,
    archived: node.isArchived,
    fork: node.isFork,
    topics: (node.repositoryTopics?.nodes || []).map((n) => n.topic.name),
    releases,
    latestStable: normRelease(node.latestRelease),
  };
}

async function fetchGithubGraphql(paths, token) {
  const out = new Map();
  const runBatch = async (batch) => {
    const parts = batch.map((p, i) => {
      const [owner, name] = p.split('/');
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ...F }`;
    });
    const query = `query { ${parts.join('\n')} rateLimit { remaining } }\nfragment F on Repository { ${REPO_FIELDS} }`;
    let json;
    try {
      json = await graphql(token, query);
      if (json.errors && !json.data) throw new Error(json.errors[0].message);
    } catch (err) {
      // Big batches can time out on GitHub's side: split and try again.
      if (batch.length > 3) {
        const half = Math.ceil(batch.length / 2);
        await runBatch(batch.slice(0, half));
        await runBatch(batch.slice(half));
        return;
      }
      throw err;
    }
    const missing = new Set((json.errors || []).filter((e) => e.type === 'NOT_FOUND').map((e) => e.path?.[0]));
    batch.forEach((p, i) => {
      const node = json.data?.[`r${i}`];
      if (node) out.set(p, normGithubRepo(node));
      else out.set(p, { error: missing.has(`r${i}`) ? 'Repository not found (deleted, renamed or private)' : 'Could not load' });
    });
    return json.data?.rateLimit?.remaining;
  };
  for (let i = 0; i < paths.length; i += 30) {
    const left = await runBatch(paths.slice(i, i + 30));
    if ((i / 30) % 5 === 4) console.log(`  ...${Math.min(i + 30, paths.length)}/${paths.length} repos, rate limit left: ${left ?? '?'}`);
  }
  return out;
}

async function fetchGithubUngh(paths) {
  const out = new Map();
  const retry = { retries: 4, timeout: 30000 };
  const one = async (p) => {
    try {
      const { repo } = await fetchJson(`https://ungh.cc/repos/${p}`, {}, retry);
      let releases = [];
      try {
        const rel = await fetchJson(`https://ungh.cc/repos/${p}/releases`, {}, retry);
        releases = (rel.releases || []).filter((r) => !r.draft).slice(0, 12).map((r) => ({
          tag: r.tag,
          name: r.name || r.tag,
          date: r.publishedAt || r.createdAt,
          url: `https://github.com/${p}/releases/tag/${encodeURIComponent(r.tag)}`,
          prerelease: !!r.prerelease,
          assets: (r.assets || []).slice(0, 15).map((a) => ({
            name: decodeURIComponent(String(a.downloadUrl).split('/').pop()),
            url: a.downloadUrl, size: a.size, downloads: a.downloadCount,
          })),
        }));
      } catch { /* repo without releases */ }
      out.set(p, {
        canonical: repo.repo || p,
        url: `https://github.com/${repo.repo || p}`,
        description: repo.description || '',
        homepage: '',
        stars: repo.stars,
        pushedAt: repo.pushedAt,
        archived: false,
        fork: false,
        topics: [],
        releases,
        latestStable: null,
      });
    } catch (err) {
      out.set(p, { error: /404/.test(err.message) ? 'Repository not found (deleted, renamed or private)' : 'Could not load' });
    }
  };
  await mapLimit(paths, 4, one);
  // The mirror rate-limits bursts: give failures a second, slower pass.
  const failed = paths.filter((p) => out.get(p).error === 'Could not load');
  if (failed.length) {
    console.log(`  retrying ${failed.length} repos`);
    await sleep(5000);
    await mapLimit(failed, 2, one);
  }
  return out;
}

async function fetchGitlab(paths) {
  const out = new Map();
  await mapLimit(paths, 4, async (p) => {
    const enc = encodeURIComponent(p);
    try {
      const info = await fetchJson(`https://gitlab.com/api/v4/projects/${enc}`);
      let releases = [];
      try {
        const rel = await fetchJson(`https://gitlab.com/api/v4/projects/${enc}/releases?per_page=12`);
        releases = rel.filter((r) => !r.upcoming_release).map((r) => ({
          tag: r.tag_name,
          name: r.name || r.tag_name,
          date: r.released_at || r.created_at,
          url: r._links?.self || `${info.web_url}/-/releases/${encodeURIComponent(r.tag_name)}`,
          prerelease: false,
          assets: (r.assets?.links || []).map((a) => ({ name: a.name, url: a.direct_asset_url || a.url })),
        }));
      } catch { /* no releases */ }
      out.set(p, {
        canonical: info.path_with_namespace,
        url: info.web_url,
        description: info.description || '',
        homepage: '',
        stars: info.star_count,
        pushedAt: info.last_activity_at,
        archived: !!info.archived,
        fork: !!info.forked_from_project,
        topics: info.topics || [],
        releases,
        latestStable: null,
      });
    } catch (err) {
      out.set(p, { error: /404/.test(err.message) ? 'Project not found on GitLab' : 'Could not load' });
    }
  });
  return out;
}

/** repos: [{host, path}] -> Map("host:path" -> info) */
export async function fetchRepoInfo(repos, token) {
  const gh = [...new Set(repos.filter((r) => r.host === 'github').map((r) => r.path))];
  const gl = [...new Set(repos.filter((r) => r.host === 'gitlab').map((r) => r.path))];
  console.log(`Fetching ${gh.length} GitHub repos (${token ? 'GraphQL' : 'ungh.cc mirror, no token'}) and ${gl.length} GitLab projects`);
  const github = async () => {
    if (!token) return fetchGithubUngh(gh);
    try {
      return await fetchGithubGraphql(gh, token);
    } catch (err) {
      console.warn(`  GitHub GraphQL failed (${err.message.slice(0, 120)}), falling back to ungh.cc`);
      return fetchGithubUngh(gh);
    }
  };
  const [ghInfo, glInfo] = await Promise.all([github(), fetchGitlab(gl)]);
  const out = new Map();
  for (const [p, v] of ghInfo) out.set(`github:${p}`, v);
  for (const [p, v] of glInfo) out.set(`gitlab:${p}`, v);
  return out;
}

/** GitHub repository search (needs a token). Returns [{path, info}]. */
export async function searchGithub(query, token) {
  const q = `query($q: String!) { search(query: $q, type: REPOSITORY, first: 30) { nodes { ... on Repository { ${REPO_FIELDS} } } } }`;
  const json = await graphql(token, q, { q: query });
  if (json.errors && !json.data) throw new Error(json.errors[0].message);
  return (json.data?.search?.nodes || []).filter(Boolean).map((n) => ({ path: n.nameWithOwner, info: normGithubRepo(n) }));
}
