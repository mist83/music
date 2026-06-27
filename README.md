# music — the Mullmania music backbone

One real, cross-referenced music catalog that feeds the TV — and anything else that wants music data.
Display stays canonical in v3; the data that feeds it does not.

```
 [1] BUILDER                [2] SPEC                  [3] TRANSLATOR              [4] DISPLAY
 build-music-master.mjs  →  music.master.v1       →   DataTools.Pack.Music    →   v3.mullmania.com
 deterministic, 1 file      data-tools plugin         (.NET, data-tools libs)     music.mullmania.com
 free real sources          nodes + edges + rules     master → v3 feed subsets    ?filter1=a&filter2=b
```

## What this is

- **`build-music-master.mjs`** — a single-file, dependency-free, deterministic builder. It pulls genuinely
  free, real sources and assembles a graph of artists, releases, tracks, works, labels, and the
  producer/engineer/performer credit edges between them.
- **`spec/music-spec.md` + `spec/music.pack.json`** — the *music spec*, the music-domain analogue of the
  data-tools universal spec. The `.pack.json` is a real [data-tools](https://data-tools.mullmania.com) domain
  pack (installed alongside `retail.pack.json` / `DataTools.Pack.Media`), so the master validates against it.
- **`data/music-master.json`** — the master file the builder emits (the "big packed JSON").

## Sources — free, real, and honest about the one catch

| source | gives | license | in the file as |
|---|---|---|---|
| MusicBrainz | artists, releases, tracks, works, labels, **producer/performer credits** | CC0 | the whole graph |
| Cover Art Archive | release cover images | owners keep copyright | a URL reference, display-only (not redistributed) |
| Wikipedia (REST) | artist bios (text) | CC BY-SA 4.0 | `bio` field, attributed per record |

The one dimension that is **not** uniformly free is images: there is no bulk, freely-redistributable album-art
corpus at scale. So covers are *referenced* by URL for display, never rebundled, and the display layer is
expected to supply a deterministic generated fallback so every tile still renders. Metadata, relationships,
and ids are CC0 and fully reusable.

## Run it

```sh
node build-music-master.mjs                       # default verify slice (8 seeds)
node build-music-master.mjs --seeds=24 --albums=5 # the full pinned seed graph
node build-music-master.mjs --source=fma          # 100k spine from the FMA frozen dump (heavy: 342MB)
```

Determinism: pinned seed list → MBIDs resolved once and cached → on-disk raw cache of every upstream
response (`cache/`) → every array stable-sorted by id. Re-runs read the cache, not the network, and emit
byte-identical content (only `generatedAt` varies). The builder prints a `rawCacheSha256` receipt.

The builder also self-checks referential integrity: every `releaseId`, `workId`, `primaryArtistId`, and
credit `artistId` must resolve to a node, or the run reports the broken edges.

## Scale

The seeded MusicBrainz path is rich on credits but bounded to the seed acts (grow it by adding names; it
crawls at MusicBrainz's 1 req/sec). The **100k** target is `--source=fma`: the frozen FMA dump
(106,574 tracks / 16,341 artists / 14,854 albums / 161 genres, CC BY 4.0) as the scale spine, with the
MusicBrainz credit graph layered on top. FMA is thin on producers; MusicBrainz is where producers live —
hence the two together.

## Status

- [x] Music spec (`music.master.v1`) + data-tools pack, installed in data-tools
- [x] Deterministic builder, proven on real data (producers, bios, covers, intact edges)
- [ ] `DataTools.Pack.Music` — .NET translator: master → validated music format → v3 feed subsets
- [ ] `music.mullmania.com?filter1=a&filter2=b` — parameterized source endpoint
- [ ] v3 `music` source, shipped live
