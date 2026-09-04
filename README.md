t# Rocket Cast

Broadcast overlays and a control panel for Rocket League casters. Rocket Cast
reads live match state from the game, serves overlays over HTTP for OBS to pick
up as browser sources, and gives you one panel to drive team names, colours,
logos, scores and series state while you cast.

This repository is the **free build**. It runs standalone, no account, no
sign-in, nothing to pay for. Everything that needs an account lives in a
separate module that is not part of this repo; see
[Rocket Cast +](#rocket-cast-) below.

---

## What's in the free build

| | |
|---|---|
| **Match Settings** | Team names, abbreviations, colours, logos, series length, series score, header text, pushed to every connected overlay live |
| **Overlays** | A broadcast overlay included (RLCS), plus any custom overlay folder you drop in |
| **Live game data** | Reads Rocket League over its TCP/WebSocket bridge and relays state, goals and replays to overlays over Socket.IO |
| **Stats** | Live scoreboard and player stats for the match in progress |
| **Options** | Themes, keybinds, port configuration, media storage location |
| **Multi-Seat** | Host your panel on the local network (or a tunnel) so a co-caster can drive it — up to 4 guest seats |
| **Keybind Compatibility** | Easy Access for switching overlays with a click |
| **Universal overlay control** | Toggle elements and edit text and colours live on *any* overlay, including ones never written for Rocket Cast |

## Getting started

You'll need [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone https://github.com/SnorklzSucks/RocketCast_App.git
cd RocketCast_App
npm install
npm start
```

That launches the Electron app with the control panel. The panel starts the
overlay server automatically.

To build a Windows installer:

```bash
npm run dist
```

### Point OBS at an overlay

The app serves overlays from the control port (3000 by default). Add a
**Browser Source** in OBS pointing at the overlay you want:

```
http://localhost:3000/RLCS/
```

The trailing slash matters. Set the source to 1920×1080. Any custom overlay
folder you add shows up at `http://localhost:3000/<FolderName>/`.

There is also a switchable source that always renders whichever overlay is
currently active, so you only need one browser source in your scene:

```
http://localhost:3000/browser-source
```

### Ports

| Port | Serves |
|------|--------|
| `3000` | Control panel and overlays |
| `3001` | Media (clips and highlight reels) |
| `3101` | Internal IPC bridge |

Override any of them with `PORT` / `RC_CONTROL_PORT`, `RC_MEDIA_PORT`,
`RC_BRACKET_PORT` and `RC_IPC_PORT`. If a port is taken the app finds the next
free one and tells you in the panel.

## Adding your own overlay

An overlay is a folder with an `overlay.html` in it, dropped into the app's
overlay directory (**Overlays → Open overlays folder** in the panel). It gets a
Socket.IO connection to the control server automatically:

```js
const socket = io();

// Match state: score, clock, players, replays.
socket.on("state", packet => {
  switch (packet.Event) {
    case "UpdateState":   /* packet.Data.Game, packet.Data.Players */ break;
    case "GoalScored":    break;
    case "MatchEnded":    break;
  }
});

// Anything set in Match Settings: names, colours, logos, series score.
socket.on("overrides", overrides => {
  // overrides.blueName, overrides.orangeColor, overrides.seriesLen, ...
});
```

Overlays that don't implement `applyOverrides()` still work — the panel detects
their scoreboard, team names and colours from the live DOM and drives them
anyway, and flags anything it couldn't find.

## Rocket Cast +

A few things are part of the paid tier and ship as a separate module that isn't
in this repository. The free build runs perfectly well without it: the loader
looks for the module, doesn't find it, and every hook falls back to free
behaviour.

Not included here:

- Accounts, sign-in and subscription billing
- The Overlay Builder
- Goal capture, highlight reels, OBS recording integration and match history
- Unlimited guest seats

If you're reading the source and wondering where a route went: anything under
`/api/web/auth`, `/api/web/billing`, `/api/web/admin`, `/api/bracket`,
`/api/matches`, `/api/reels` or `/api/recording` belongs to that module and
answers `404` in this build.

## Repository layout

```
main.js          Electron main process
preload.js       Renderer bridge
server.js        Control + overlay server (free build)
index.html       Control panel
renderer.js      Panel-side helpers
overlays/        Bundled overlays (RLCS, Bracket -- Bracket needs Rocket Cast +)
public/          Landing page, loader, universal overlay control
build/           Icons and panel artwork
```

## Notes

- `package.json` still lists `stripe`, `pg` and `imapflow` as dependencies.
  They're only used by the Rocket Cast + module, but they stay in the manifest
  so `npm ci` matches the committed lockfile.
- Rocket Cast reads the game through a local bridge and never sends match data
  anywhere. See the privacy policy at
  [rocketcast.net/privacy](https://rocketcast.net/privacy).

## Support

Questions and bug reports: **snorklzcasts@gmail.com**
