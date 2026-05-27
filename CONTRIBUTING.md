# Contributing

Thanks for your interest! This project started as an hour-long experiment (see the README), so contributions that polish the rough edges are very welcome.

## Getting started

```bash
git clone https://github.com/cdrguru/sonos.git
cd sonos
npm install
npm run web        # runs the app in simulation mode — no hardware needed
```

To work against real Sonos hardware, also run the LAN bridge in a second terminal:

```bash
cd bridge
npm install
npm start
```

The bridge must run on a machine on the same network as your speakers. The app connects to `ws://localhost:8765` automatically.

## Before opening a PR

- Typecheck both packages — CI runs these and they must pass:
  ```bash
  npx tsc --noEmit
  cd bridge && npm run typecheck
  ```
- There is no linter, formatter, or test runner configured. Match the existing code style.
- Keep changes focused. If you're adding a feature, the "What Needs To Be Built Next" section in `CLAUDE.md` lists good candidates.

## Project layout

- `core/` — discovery, CRDT sync engine, state store, bridge client/protocol, megaphone.
- `components/` — the UI (mixing board, channel strips, transport bar, turntable).
- `bridge/` — the standalone Node service for real Sonos LAN control.
- `research.md` — protocol reference used as the spec.
- `CLAUDE.md` — deeper architecture notes (helpful for AI-assisted development).

## Constraints

- Expo SDK 54, new architecture enabled. Check the [versioned Expo docs](https://docs.expo.dev/versions/v54.0.0/) before adding packages or native APIs.
- Managed Expo project — no `/ios` or `/android` folders; use config plugins / Expo APIs, not native edits.
- TypeScript `strict` is on.

## Reporting issues

Open a GitHub issue with steps to reproduce, whether you were in simulation or real-LAN mode, and your platform (web / iOS / Android).

## Note

This is an unofficial project and is not affiliated with Sonos, Inc.
