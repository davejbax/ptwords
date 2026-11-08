# Palavras — European Portuguese → Anki

A small installable PWA (app ~5 KB gzipped, plus a one-off 4.3 MB dictionary download). Type a Portuguese word to get live dictionary matches, with inflected forms
resolved to the dictionary form (`está` → `estar`, `fui` → `ser`/`ir`). Tap a sense to add it as an Anki
card through AnkiWeb, and your phone's Anki picks it up on its next sync.

## How it works

- **Dictionary**: English Wiktionary's Portuguese entries (via [kaikki.org](https://kaikki.org)), filtered for
  European Portuguese (`scripts/build_dict.py`). Senses marked Brazil-only are dropped, Brazilian and pre-1990
  spellings point to the EP word, the IPA is the Portugal pronunciation, and results are ranked by an EP
  (OpenSubtitles `pt`) frequency list. It ships as one gzipped binary file (`/dict/ptdict-<hash>.bin`). The app downloads it on first open,
  with a progress bar, and keeps it in IndexedDB with persistent storage requested. **All lookups run on the device**,
  with no server involved: a binary search over raw UTF-8 bytes takes a few ms per keystroke.
  If a later deploy ships a new dictionary, the app keeps using the old one while the new one downloads in the background.
- **Worker** (`src/worker`, Hono), deployed with the [`cf` CLI](https://blog.cloudflare.com/cf-cli-local-explorer/) from
  `cloudflare.config.ts`. Cloudflare serves the static files directly; the Worker only handles `/api/*`, a small
  AnkiWeb relay. AnkiWeb has no public API, so the relay uses the same internal endpoints as
  AnkiWeb's own "Add" page. The Worker stores nothing. The browser keeps the AnkiWeb session cookie, and your
  password is only used once, to log in.
- **Client** (`client/`, plain TypeScript): a service worker precaches every asset, so after the first visit the app
  opens without network. Cards added while offline (or before logging in) are queued in `localStorage` and
  sent when the app is next opened or the connection comes back.

Card: **Front** = word + gender/plural + IPA; **Back** = English translation, definition, usage labels, and an example.
Pick the deck and note type in ⚙ (it defaults to "Basic"; the 1st field gets the word, the 2nd the meaning).
Notes are tagged `ptwords`.

## Setup / deploy

Tools come from `mise.toml` (`mise install`). Run the commands below with `mise exec --` (or with mise activated in your shell).

```sh
npm install
npm run dict:fetch            # ~600 MB download into data/
npm run dict:build            # -> out/ptdict-<hash>.bin + out/dict.json (the build bundles it)

npx cf auth login
npm run deploy                # cf deploy (builds first)
```

Local dev: `npm run dev`.

Optional: uncomment `ALLOWED_USERS` in `cloudflare.config.ts` so nobody else can use your deployment as an AnkiWeb
login relay. To serve the app on your own domain, add `domains: ["words.example.com"]` there.

## Caveats

- AnkiWeb's internal API is undocumented and may change. If adding cards breaks, compare `src/worker/anki.ts`
  against the protobuf schemas in AnkiWeb's frontend JavaScript.
- Fully offline after the first open: search runs on the device, and new cards are queued until there's a connection.
