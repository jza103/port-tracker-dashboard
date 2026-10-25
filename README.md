# Port Tracker

A self-updating dashboard for decompilation, recompilation, native-port and VR-port projects:
latest releases with direct download buttons, grouped by game and platform, plus news from the
outlets that cover the scene.

- **Updates itself every 4 hours** on GitHub Actions and publishes to GitHub Pages (free for public repos).
- **Finds new projects automatically** from four curated catalogs ([PortsDR](https://portsdr.com/)
  and [Quiver Launcher](https://quiverlauncher.com/) for decomps/recomps/native ports,
  [QuestPorts](https://questports.vercel.app/) for Quest VR ports, and the
  [PCVR Mods Installer Hub](https://github.com/Mr-Nlce/PCVR-Mods-Installer-Hub) for PC VR mods of flat
  games), from GitHub links in news articles and YouTube video descriptions, and from GitHub searches.
- **Groups every project for the same game.** The most active/popular one is shown first, other
  active ones underneath, and the rest are folded away. Pin the one you prefer, hide the ones you don't want.
- **Categories** by original platform (Nintendo 64, PlayStation 4, Xbox 360, …) plus *VR Ports* and
  *Tools & Recompilers*. VR ports appear both under VR Ports and under their game's platform.
- **News** from ReadOnlyMemo, Time Extension, UploadVR, Road to VR, GamingOnLinux, Nintendo Life,
  Push Square, Pure Xbox, PC Gamer, VGC, Retro Dodo, Google News and more, plus YouTube channels
  that cover flat-to-VR mods (Beardo Benjo, FastLawyer, NotAGameAddict, Gamertag VR, Flat2VR…),
  filtered for decomp/recomp/port/VR-mod stories and linked to the games they mention.
- Download buttons are labelled by platform (Windows, Linux, macOS, Quest APK…). The one matching
  the device you're browsing on is highlighted.
- **On a Quest headset** the page opens on *VR Ports* with *Runs on Quest* ticked: ports built for
  Quest hardware or shipping an APK, without PC-only VR mods. That's only the first visit; after that
  the headset remembers whatever filters you pick.

## Turn it on (one time, ~2 minutes)

1. **Merge this into `main`.** Scheduled workflows only run on the default branch.
2. **Enable Pages:** repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Run it once:** **Actions → Update dashboard → Run workflow**.

Your dashboard is then at `https://<your-username>.github.io/<repo>/`
(for this repo: https://jza103.github.io/port-tracker-dashboard/). Bookmark it, or use "Add to Home Screen" on your phone.

## Adding, hiding and following projects

**From the dashboard** (works from your phone):
- The eye button hides (unfollows) a project. The pin button keeps it first for its game.
- **Add project** lets you paste any GitHub/GitLab repo or link.
- **Discovered** lists what's new, plus suggestions you can Follow or Dismiss.
- These changes take effect in your browser immediately. Press **Save to GitHub** to make them permanent:
  it opens a pre-filled issue; submit it, and a workflow commits the change to
  `config/projects.yml` and rebuilds the site (about 2 minutes).
  Only issues opened by you, the repo owner, are applied.

**By editing files** (on github.com with the pencil icon, or locally):
- [`config/projects.yml`](config/projects.yml) holds your hidden/pinned/followed lists, projects
  you add by hand, and overrides (e.g. fix a game name or category).
- [`config/sources.yml`](config/sources.yml) holds the catalogs, news feeds, news keywords and
  GitHub searches. Add an RSS feed there to follow another outlet, or a YouTube channel with
  `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` and `video: true`.

Every project's id is `owner/repo` for GitHub, `gitlab:owner/repo` for GitLab, or
`<catalog>:<slug>` for catalog entries without a repo.

## Running it at home instead

Needs [Node.js](https://nodejs.org) 20 or newer.

```sh
npm install
npm start            # fetch everything, then serve at http://localhost:8080
```

- `npm run update` refreshes the data; `npm run serve` just serves it.
- `HOST=0.0.0.0 npm run serve` makes it reachable from other devices on your network.
- Without a token the updater uses the public ungh.cc GitHub mirror (slower). For faster, more
  complete updates set `GITHUB_TOKEN` to a [personal access token](https://github.com/settings/tokens)
  (no scopes needed). The token also turns on the GitHub-search discovery.
- To keep it fresh, schedule `npm run update` with cron or Task Scheduler, e.g. every 4 hours.

## How it works

```
config/            what to track (you edit these)
scripts/update.mjs builds site/data.json from catalogs, GitHub/GitLab and news feeds
scripts/apply-changes.mjs  applies "[dashboard]" issues to config/projects.yml
site/              the static dashboard (plain HTML/CSS/JS, no build step)
data/              state kept between runs: discovered projects, news archive, catalog backup
```

If a catalog or feed is down, the last good copy is used and a warning shows at the bottom of the page.

`npm test` runs the unit tests.
