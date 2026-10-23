import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import { parseChanges, applyChanges } from '../apply-changes.mjs';
import { parseRepoUrl, extractRepos, gameKey, guessType, guessPlatform } from '../lib/util.mjs';
import { pickReleases } from '../lib/repos.mjs';
import { parseFeed, keywordRegex } from '../lib/news.mjs';

const config = fs.readFileSync(new URL('../../config/projects.yml', import.meta.url), 'utf8');

test('dashboard JSON changes are applied and comments survive', () => {
  const body = '### Changes\n\n```json\n{"hide":["sm64pc/sm64ex"],"pin":["harbourmasters/shipwright"],"add":[{"repo":"https://github.com/foo/BarRecomp","game":"Bar","category":"Nintendo 64"}]}\n```';
  const changes = parseChanges(body);
  const { text, summary } = applyChanges(config, changes);
  const doc = YAML.parse(text);
  assert.deepEqual(doc.hidden, ['sm64pc/sm64ex']);
  assert.deepEqual(doc.pinned, ['harbourmasters/shipwright']);
  assert.equal(doc.projects.at(-1).repo, 'https://github.com/foo/BarRecomp');
  assert.match(text, /# Projects you never want to see/);
  assert.equal(summary.length, 3);
  // Applying twice changes nothing.
  assert.equal(applyChanges(text, changes).summary.length, 0);
});

test('unhide and follow undo hide', () => {
  const hiddenText = applyChanges(config, parseChanges('### Changes\n\n{"hide":["a/b","c/d"]}')).text;
  const { text } = applyChanges(hiddenText, parseChanges('### Changes\n\n{"unhide":["a/b"],"follow":["c/d"]}'));
  const doc = YAML.parse(text);
  assert.deepEqual(doc.hidden, []);
  assert.deepEqual(doc.follow, ['c/d']);
});

test('track-project issue form is parsed', () => {
  const body = '### Repo or link\n\nhttps://github.com/x/y\n\n### Name\n\n_No response_\n\n### Game\n\nGoldenEye 007\n\n### Category\n\nNintendo 64\n\n### Type\n\nGuess\n\n### VR port\n\n- [X] This is a VR port (also list it under VR Ports)';
  const c = parseChanges(body);
  assert.deepEqual(c.add, [{ repo: 'https://github.com/x/y', game: 'GoldenEye 007', tags: ['VR'], categories: ['Nintendo 64', 'VR Ports'] }]);
});

test('bad ids and fields are ignored', () => {
  const { summary } = applyChanges(config, { hide: ['ok/id', 'bad id; rm -rf'], unhide: [], pin: [], unpin: [], follow: [], add: [{ url: 'javascript:alert(1)' }] });
  assert.deepEqual(summary, ['Hid ok/id']);
});

test('repo URLs', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/HarbourMasters/Shipwright/releases/latest'), { host: 'github', path: 'HarbourMasters/Shipwright' });
  assert.deepEqual(parseRepoUrl('https://gitlab.com/sonicdcer/MarioKart64Recomp'), { host: 'gitlab', path: 'sonicdcer/MarioKart64Recomp' });
  assert.deepEqual(parseRepoUrl('https://gitlab.com/group/sub/proj/-/releases'), { host: 'gitlab', path: 'group/sub/proj' });
  assert.equal(parseRepoUrl('https://github.com/sponsors/someone'), null);
  assert.equal(parseRepoUrl('https://github.com/user-attachments/assets'), null);
  assert.deepEqual(extractRepos('see <a href="https://github.com/a/b.git">x</a> and https://github.com/a/b).').map((r) => r.path), ['a/b']);
});

test('games with different spellings group together', () => {
  assert.equal(gameKey("The Legend of Zelda: Majora’s Mask"), gameKey("The Legend of Zelda: Majora's Mask"));
  assert.equal(gameKey('Super Mario 64 [Co-op DX]'), gameKey('Super Mario 64'));
  assert.equal(gameKey('Super Smash Bros.'), gameKey('Super Smash Bros'));
});

test('type and platform guesses', () => {
  assert.equal(guessType('AC6_recomp'), 'recompilation');
  assert.equal(guessType('Zelda64Recomp'), 'recompilation');
  assert.equal(guessType('sotn-decomp'), 'decompilation');
  assert.equal(guessType('decomposition tool'), 'port');
  assert.equal(guessPlatform('A PS2 static recompilation'), 'PlayStation 2');
  assert.equal(guessPlatform('Xbox 360 port via ReXGlue'), 'Xbox 360');
  assert.equal(guessPlatform('PlayStation 2 game'), 'PlayStation 2');
  assert.equal(guessPlatform('PlayStation classic'), 'PlayStation');
});

test('releases: newest shown, stable kept, tag patterns for shared repos', () => {
  const rel = (tag, date, prerelease = false) => ({ tag, date, prerelease, assets: [] });
  const all = [rel('nightly', '2026-10-20', true), rel('v1.2', '2026-09-01'), rel('v1.1', '2026-05-01')];
  const r = pickReleases(all, all[1]);
  assert.equal(r.release.tag, 'nightly');
  assert.equal(r.stable.tag, 'v1.2');
  const shared = [rel('hotd-v0.1.1', '2026-10-10'), rel('vcop-v0.2.2', '2026-10-12'), rel('v0.2.6', '2026-10-01')];
  assert.equal(pickReleases(shared, null, '^hotd-v?\\d').release.tag, 'hotd-v0.1.1');
  assert.equal(pickReleases(shared, null, '^v?\\d').release.tag, 'v0.2.6');
  assert.equal(pickReleases([], null).release, null);
});

test('feeds: RSS and Atom', () => {
  const rss = '<rss><channel><item><title>Zelda gets a native PC port</title><link>https://ex.com/a</link><pubDate>Tue, 21 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Repo at <a href="https://github.com/x/y">GitHub</a></p>]]></description></item></channel></rss>';
  const [a] = parseFeed(rss);
  assert.equal(a.url, 'https://ex.com/a');
  assert.equal(a.date, '2026-10-21T10:00:00.000Z');
  assert.match(a.html, /github\.com\/x\/y/);
  const atom = '<feed><entry><title>T</title><link rel="alternate" href="https://ex.com/b"/><updated>2026-10-01T00:00:00Z</updated><summary>s</summary></entry></feed>';
  assert.equal(parseFeed(atom)[0].url, 'https://ex.com/b');
  const kw = keywordRegex(['decomp(ilation|iled)?', '(native|unofficial|fan) (pc )?port', { 'not a': 'string' }]);
  assert.ok(kw.test('A native PC port of Tekken 6'));
  assert.ok(!kw.test('Official PC port announced'));
  assert.ok(!kw.test('decomposition'));
});

test('Discord invites', async () => {
  const { findDiscordInvites, isDiscordUrl } = await import('../lib/util.mjs');
  const readme = '[![Discord](https://img.shields.io/discord/1234)](https://discord.gg/AbC123) ... https://discord.gg/AbC123 and http://discordapp.com/invite/other1';
  assert.deepEqual(findDiscordInvites(readme), ['https://discord.gg/AbC123', 'https://discord.com/invite/other1']);
  assert.deepEqual(findDiscordInvites('https://img.shields.io/discord/1234 only a badge'), []);
  assert.ok(isDiscordUrl('https://discord.gg/x1'));
  assert.ok(!isDiscordUrl('https://discord.com/channels/1/2'));
});
