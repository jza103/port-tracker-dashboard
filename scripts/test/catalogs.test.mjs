import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuiver, parsePsLiteral, parsePcvrHub } from '../lib/catalogs.mjs';
import { parseFeed, keywordRegex } from '../lib/news.mjs';
import { gameKey } from '../lib/util.mjs';

test('Quiver apps become projects', () => {
  const app = {
    slug: 'spider-man-edge-of-time-edgeoftimerecompiled', name: 'Spider-Man: Edge of Time', projectName: 'EdgeOfTimeRecompiled',
    projectType: 'port', basedOn: { console: 'x360' }, consoles: ['x360'], games: [{ title: 'Spider-Man: Edge of Time' }],
    developer: { name: 'Graine25' }, supportedOS: ['macos', 'windows', 'linux'], tags: ['recomp', 'x360'],
    lastReleaseVersion: 'v1.0.0', libraryArt: { capsule: 'https://img/c.png' }, description: 'A PC port.',
  };
  const [p] = parseQuiver([app], { [app.slug]: { host: 'github', path: 'goliathret/EdgeOfTimeRecomp' } });
  assert.equal(p.id, 'goliathret/edgeoftimerecomp');
  assert.deepEqual(p.aliases, [`quiver:${app.slug}`]);
  assert.deepEqual(p.categories, ['Xbox 360']);
  assert.equal(p.type, 'recompilation');
  assert.deepEqual(p.targets, ['macOS', 'Windows', 'Linux']);
  assert.equal(p.links[0].url, `https://quiverlauncher.com/apps/${app.slug}`);
  const [q] = parseQuiver([{ ...app, slug: 'x', tags: ['recreation'], projectName: 'OpenThing', consoles: ['pc'], basedOn: {} }], {});
  assert.equal(q.id, 'quiver:x');
  assert.equal(q.type, 'reimplementation');
  assert.deepEqual(q.categories, ['PC']);
});

test('PowerShell literals', () => {
  const src = `$x = @(
    @{ Title="A \`"quoted\`" VR"; Tags=@("a", 'b''s'); On=$true; N=3 } # comment
    @{
        Title = 'B'
        # Path = "commented out"
        Paths = @((Join-Path $env:X 'y'), 'D:\\z')
        Weird = $script:Something
    }
  )`;
  const { value } = parsePsLiteral(src, src.indexOf('@('));
  assert.deepEqual(value[0], { Title: 'A "quoted" VR', Tags: ['a', "b's"], On: true, N: 3 });
  assert.equal(value[1].Title, 'B');
  assert.equal(value[1].Path, undefined);
  assert.deepEqual(value[1].Paths, ['D:\\z']);
  assert.equal(value[1].Weird, null);
});

test('PCVR Mods Hub catalog', () => {
  const catalog = `$ownGames = @(
    @{ Controls="MC"; Title="Spider-Man Remastered VR"; TileTitle="Spider-Man Remastered"; Id="spidy"; Wip=$true; SteamId="1817070"; Mod="Spidy VR"; Author="Ilya"; GithubRepo="IlyaMez/SpidyVR"; VideoUrl="https://youtu.be/x"; Tags=@("openxr") }
    @{ Controls="GP"; Title="Stray VR"; Mod="UEVR (auto-update)"; Author="praydog"; InfoUrl="https://github.com/praydog/UEVR"; Tags=@() }
    @{ Controls="GP"; Title="Hogwarts Legacy VR"; Mod="UEVR (auto-update)"; Author="praydog"; InfoUrl="https://github.com/praydog/UEVR" }
  )
  $ownGamesGP = @(
    @{ Controls="GP"; Title="Spiderman Remastered"; SteamId="1817070"; Mod="R.E.A.L. v2607"; Author="Luke Ross"; InfoUrl="https://www.patreon.com/realvr"; DownloadUrl="https://discord.com/channels/1/2" }
  )
  $externalGames = @()`;
  const index = `@{ Id = 'stray-vr'; Title = 'Stray VR'; Released = '2026-10-01'; Added = '' }`;
  const list = parsePcvrHub(catalog, index);
  assert.equal(list.length, 4);
  const [spidy, stray, hogwarts, real] = list;
  assert.equal(spidy.id, 'ilyamez/spidyvr');
  assert.equal(spidy.status, 'In development');
  assert.deepEqual(spidy.categories, ['PC', 'VR Ports']);
  assert.equal(spidy.links.find((l) => l.label === 'Video').url, 'https://youtu.be/x');
  // One repo serving several games: one project per game.
  assert.equal(stray.id, 'praydog/uevr#stray-vr');
  assert.equal(stray.catalogDate, '2026-10-01');
  assert.equal(hogwarts.id, 'praydog/uevr#hogwarts-legacy-vr');
  assert.equal(hogwarts.game, 'Hogwarts Legacy');
  // No repo: a catalog id, and no login-only Discord links.
  assert.equal(real.id, 'pcvrhub:spiderman-remastered');
  assert.equal(real.catalogVersion, 'v2607');
  assert.ok(!real.links.some((l) => /discord\.com\/channels/.test(l.url)));
  // Both Spider-Man spellings group together.
  assert.equal(gameKey(real.game), gameKey(spidy.game));
  assert.throws(() => parsePcvrHub('nothing here'), /no games/);
});

test('YouTube channel feeds', () => {
  const xml = `<feed xmlns:media="http://search.yahoo.com/mrss/"><entry><title>Dead Space 2 in FULL VR</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc"/><published>2026-10-20T10:00:00+00:00</published>
    <media:group><media:title>Dead Space 2 in FULL VR</media:title><media:thumbnail url="https://i.ytimg.com/vi/abc/hqdefault.jpg" width="480" height="360"/>
    <media:description>Mod: https://github.com/chortdev/DeadSpace2VR</media:description></media:group></entry></feed>`;
  const [v] = parseFeed(xml);
  assert.equal(v.url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(v.image, 'https://i.ytimg.com/vi/abc/hqdefault.jpg');
  assert.match(v.html, /github\.com\/chortdev\/DeadSpace2VR/);
  const kw = keywordRegex(['in (full |true |native |proper |real )?(6dof )?vr']);
  assert.ok(kw.test(v.title));
  assert.ok(!kw.test('Top 10 Quest games this week'));
});
