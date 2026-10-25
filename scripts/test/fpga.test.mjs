import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { parseWikiCores, parseMister, parsePocket, dbCores, unzipFirst, fpgaCategory, systemName, UPDATE_ALL_DBS } from '../lib/fpga.mjs';

const wiki = `# FPGA cores for MiSTer
<!-- cores_list_start -->
## Consoles
|Core| Home&nbsp;folder| SDRAM | Comments |
|:---|:---|:---:|:---:|
| [Super Nintendo Entertainment System (SNES)](https://github.com/MiSTer-devel/SNES_MiSTer) |SNES| Yes | |
| [Nintendo 64](https://github.com/MiSTer-devel/N64_MiSTer) |N64| Yes | |
| [Menu](https://github.com/MiSTer-devel/Menu_MiSTer) |menu| No | |
| [Someone else](https://github.com/other/Thing_MiSTer) |x| No | |
<!-- cores_list_end -->
<!-- arcade_list_start -->
## Arcades
|Core| Additional&nbsp;arcades | SDRAM | Comments |
| [Aleck64](https://github.com/MiSTer-devel/N64_MiSTer/tree/Aleck64) | Eleven Beat | Yes | |
| [Galaga](https://github.com/MiSTer-devel/Arcade-Galaga_MiSTer) | | No | |
<!-- arcade_list_end -->`;

test('MiSTer wiki core list', () => {
  const cores = parseWikiCores(wiki);
  assert.deepEqual(cores.map((c) => c.name), ['Super Nintendo Entertainment System (SNES)', 'Nintendo 64', 'Aleck64', 'Galaga']);
  assert.equal(cores[0].home, 'SNES');
  assert.equal(cores[2].section, 'Arcade');
});

test('MiSTer cores get update_all status and their newest .rbf', () => {
  const big = wiki.replace('<!-- cores_list_end -->', Array.from({ length: 60 }, (_, i) => `| [Core ${i}](https://github.com/MiSTer-devel/C${i}_MiSTer) |C${i}| No | |`).join('\n') + '\n<!-- cores_list_end -->');
  const mainDb = {
    base_files_url: 'https://raw.example/dist/',
    files: { '_Console/SNES_20260101.rbf': {}, '_Console/SNES_20260823.rbf': {}, '_Arcade/cores/Galaga_20240525.rbf': {}, '_Console/N64_20261001.rbf': {} },
  };
  const jt = UPDATE_ALL_DBS.find((d) => d.id === 'jtcores');
  const yc = UPDATE_ALL_DBS.find((d) => d.id === 'yc');
  const list = parseMister({ wiki: big, mainDb, dbs: [{ def: jt, db: { files: { 'a/jt1942.rbf': {} }, timestamp: 1790000000 } }, { def: yc, db: null }], unofficial: [{ url: 'https://github.com/GX400-Friends/gx400-bin' }] });
  const snes = list.find((p) => p.repo.path === 'MiSTer-devel/SNES_MiSTer');
  assert.equal(snes.updateAll, 'default');
  assert.equal(snes.game, 'Super Nintendo (SNES)');
  assert.equal(snes.catalogDate, '2026-08-23');
  assert.equal(snes.download.url, 'https://raw.example/dist/_Console/SNES_20260823.rbf');
  // Two wiki entries in one repo (N64 and its Aleck64 branch) stay apart.
  assert.ok(list.some((p) => p.id === 'mister-devel/n64_mister#aleck64'));
  assert.equal(list.find((p) => p.name.startsWith('Galaga')).catalogDate, '2024-05-25');
  assert.ok(!list.some((p) => /other\/Thing/.test(p.repo.path)), 'only MiSTer-devel repos are in the distribution');
  assert.equal(list.find((p) => p.id === 'jotego/jtcores').updateAll, 'default');
  assert.equal(list.find((p) => p.id === 'mikes11/yc_builds-mister').updateAll, 'optional');
  assert.equal(list.find((p) => p.id === 'gx400-friends/gx400-bin').updateAllDb, 'Unofficial Distribution');
  assert.throws(() => parseMister({ wiki }), /only 4 cores/);
});

test('downloader databases are read from zips', () => {
  const json = Buffer.from(JSON.stringify({ files: { '_Console/NES_20250101.rbf': {} } }));
  const data = zlib.deflateRawSync(json);
  const name = Buffer.from('db.json');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(json.length, 24); cd.writeUInt16LE(name.length, 28);
  const cdStart = 30 + name.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt32LE(cdStart, 16);
  const zip = Buffer.concat([local, name, data, cd, name, eocd]);
  const db = JSON.parse(unzipFirst(zip));
  assert.equal(dbCores(db).get('nes').date, '2025-01-01');
});

test('Pocket inventory', () => {
  const core = (identifier, owner, name, platform) => ({ identifier, repository: { platform: 'github', owner, name }, download_url: `https://github.com/${owner}/${name}/releases/download/v1/x.zip`, version: '1.0', release_date: '2026-09-10', platform });
  const list = parsePocket([
    core('Spiritualized.GBA', 'spiritualized1997', 'openFPGA-GBA', { name: 'Game Boy Advance', category: 'Handheld' }),
    core('agg23.SNES', 'agg23', 'openfpga-SNES', { name: 'SNES', category: 'Console' }),
    core('jotego.jt1942', 'jotego', 'jtbin', { name: '1942', category: 'Arcade' }),
    core('jotego.jtgng', 'jotego', 'jtbin', { name: "Ghosts'n Goblins", category: 'Arcade' }),
    core('jotego.jtgng', 'jotego', 'jtbin', { name: "Ghosts'n Goblins", category: 'Arcade' }),
  ]);
  assert.equal(list.length, 4);
  assert.equal(list[1].game, 'Super Nintendo (SNES)');
  assert.equal(list[2].id, 'jotego/jtbin#jotego-jt1942');
  assert.equal(list[0].download.label, 'Pocket 1.0');
  assert.equal(list[0].updateAll, undefined);
});

test('FPGA repos are recognised', () => {
  assert.equal(fpgaCategory('someone/Foo_MiSTer FPGA core'), 'MiSTer FPGA');
  assert.equal(fpgaCategory('agg23/openfpga-SNES SNES for Analogue Pocket'), 'Analogue Pocket');
  assert.equal(fpgaCategory('A mister of disguise'), null);
  assert.equal(systemName('Genesis'), systemName('Sega Mega Drive/Genesis'));
});
