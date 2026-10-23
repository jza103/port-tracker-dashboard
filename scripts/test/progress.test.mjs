import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _test, manualProgress, progressFor } from '../lib/progress.mjs';
import { pickReleases } from '../lib/repos.mjs';

test('README progress claims', () => {
  assert.deepEqual(_test.fromText('| US 1.0 | 100.0% Complete |\n| PAL | 69.02% Complete |'), { status: 'complete', percent: 100, source: 'README', url: null });
  assert.equal(_test.fromText('Currently 45.5% decompiled.').percent, 45.5);
  assert.equal(_test.fromText('The game is now fully decompiled!').status, 'complete');
  assert.equal(_test.fromText('This is a decompilation of Pokémon Emerald.'), null);
});

test('manual progress values', () => {
  assert.equal(manualProgress('complete').status, 'complete');
  assert.equal(manualProgress(75).percent, 75);
  assert.equal(manualProgress('75%').status, 'in-progress');
  assert.equal(manualProgress('soon').status, 'unknown');
});

test('decomp.dev report, then README badge', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://decomp.dev/a/tracked.json') return Response.json({ measures: { matched_code_percent: 79.7416, matched_data_percent: 91.1, matched_functions_percent: 84 } });
    if (u.startsWith('https://decomp.dev/')) return new Response('not found', { status: 404 });
    if (u === 'https://raw.githubusercontent.com/a/badge/HEAD/README.md') return new Response('[![](https://img.shields.io/endpoint?url=https://ex.com/progress-shield.json)](x)');
    if (u === 'https://ex.com/progress-shield.json') return Response.json({ message: '100%' });
    return new Response('', { status: 404 });
  };
  try {
    const tracked = await progressFor('a/tracked');
    assert.deepEqual([tracked.status, tracked.percent, tracked.data, tracked.source], ['in-progress', 79.74, 91.1, 'decomp.dev']);
    const badge = await progressFor('a/badge');
    assert.deepEqual([badge.status, badge.source, badge.url], ['complete', 'ex.com', 'https://github.com/a/badge#readme']);
    assert.equal((await progressFor('a/nothing')).status, 'unknown');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a stable release with files beats a newer one without', () => {
  const beta = { tag: 'beta', date: '2026-10-23', prerelease: true, assets: [] };
  const stable = { tag: 'v1', date: '2026-09-01', prerelease: false, assets: [{ name: 'x-win.zip' }] };
  const r = pickReleases([beta, stable], stable);
  assert.equal(r.release.tag, 'v1');
  assert.equal(r.stable.tag, 'beta');
});

test('progress links go to the page a badge points at', async () => {
  const { badgeLink } = await import('../lib/progress.mjs');
  const badge = 'https://img.shields.io/endpoint?url=https://ex.com/p.json';
  assert.equal(badgeLink(`[![P][pb]][pl]\n\n[pl]: https://ex.com/progress\n[pb]: ${badge}\n`, badge), 'https://ex.com/progress');
  assert.equal(badgeLink(`[![P](${badge})](https://ex.com/inline)`, badge), 'https://ex.com/inline');
  assert.equal(badgeLink(`<a href="https://ex.com/html"><img src="${badge}"></a>`, badge), 'https://ex.com/html');
  assert.equal(badgeLink(`![P](${badge})`, badge), null);
});
