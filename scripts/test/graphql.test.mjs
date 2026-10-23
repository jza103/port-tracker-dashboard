import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRepoInfo } from '../lib/repos.mjs';

const node = (nameWithOwner) => ({
  nameWithOwner, url: `https://github.com/${nameWithOwner}`, description: 'A PC port', homepageUrl: '',
  stargazerCount: 42, pushedAt: '2026-10-20T00:00:00Z', isArchived: false, isFork: false,
  repositoryTopics: { nodes: [{ topic: { name: 'n64' } }] },
  latestRelease: { tagName: 'v1', name: 'v1', publishedAt: '2026-10-01T00:00:00Z', url: 'u', isPrerelease: false, isDraft: false, releaseAssets: { nodes: [{ name: 'Game-Win64.zip', downloadUrl: 'd', size: 1, downloadCount: 2 }] } },
  releases: { nodes: [{ tagName: 'v1', name: 'v1', publishedAt: '2026-10-01T00:00:00Z', url: 'u', isPrerelease: false, isDraft: false, releaseAssets: { nodes: [] } }] },
});

test('GraphQL batches: found, not found, and splitting after a failed batch', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    const { query } = JSON.parse(opts.body);
    const aliases = [...query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)];
    // Fail any batch bigger than 20 to exercise the split path.
    if (aliases.length > 20) return new Response('timeout', { status: 502 });
    const data = { rateLimit: { remaining: 4999 } };
    const errors = [];
    for (const [, alias, owner, name] of aliases) {
      if (name === 'missing') { data[alias] = null; errors.push({ type: 'NOT_FOUND', path: [alias], message: 'nope' }); } else data[alias] = node(`${owner}/${name}`);
    }
    return new Response(JSON.stringify({ data, errors: errors.length ? errors : undefined }), { status: 200 });
  };
  try {
    const repos = Array.from({ length: 30 }, (_, i) => ({ host: 'github', path: `o/r${i}` }));
    repos.push({ host: 'github', path: 'o/missing' });
    const info = await fetchRepoInfo(repos, 'token');
    assert.equal(info.size, 31);
    assert.equal(info.get('github:o/r0').stars, 42);
    assert.equal(info.get('github:o/r0').releases[0].tag, 'v1');
    assert.equal(info.get('github:o/r0').latestStable.assets[0].name, 'Game-Win64.zip');
    assert.match(info.get('github:o/missing').error, /not found/i);
    assert.ok(calls > 2, 'failed batch was split');
  } finally {
    globalThis.fetch = realFetch;
  }
});
