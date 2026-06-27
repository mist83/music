# Music Spec — `music.master.v1`

The music-domain analogue of the data-tools **universal spec** (`DataTools.Media` / `UniversalFeedRoot`).
It is the *perfect music format*: one packed JSON document of nodes and the edges between them,
rich enough to drive any music display without being tied to any one display.

This document is the contract. The data-tools **`music` domain pack** (`music.pack.json` / `DataTools.Pack.Music`)
validates against it; the deterministic builder (`build-music-master.mjs`) emits it; the translator turns it into
v3 display feeds.

---

## 1. Design, in one breath

A music catalog is a graph. We store the **nodes** as top-level arrays and the **edges** as id references
on those nodes — exactly the foreign-key style the universal spec uses (`seriesId`, `genreIds[]`, `credits[]`).
Flat top-level arrays (not nested feeds) so a data-tools pack can address each collection by a simple `path`.

```
genres ── labels ── artists ── works ── releases ── tracks
   ▲         ▲         ▲          ▲          ▲          ▲
   └─────────┴─────────┴── ids cross-reference ────────┘
```

Every node id is namespaced and **derived from a stable upstream id** (MusicBrainz MBID) so the same input
always produces the same id: `artist:<mbid>`, `release:<rg-mbid>`, `track:<recording-mbid>`,
`work:<work-mbid>`, `label:<label-mbid>`, `genre:<slug>`.

---

## 2. Document shape

```jsonc
{
  "specVersion": "music.master.v1",
  "generatedAt": "<ISO-8601>",          // build stamp (informational, not part of identity)
  "sourceId": "mullmania-music",
  "provenance": { /* §6 — sources, licenses, attribution. Required. */ },
  "counts":   { "genres": N, "labels": N, "artists": N, "works": N, "releases": N, "tracks": N },

  "genres":   [ Genre,  ... ],   // config nodes
  "labels":   [ Label,  ... ],
  "artists":  [ Artist, ... ],   // every artist-entity: acts AND credited individuals (producers, writers…)
  "works":    [ Work,   ... ],
  "releases": [ Release,... ],
  "tracks":   [ Track,  ... ]
}
```

> **Producers are not a separate node table — and that is on purpose.** In real catalogs (and in MusicBrainz)
> a producer is an *artist entity* that appears in a *credit role*. So a producer is an `Artist` whose `roles[]`
> includes `"producer"`, reached through a `Track.credits[]` edge. "Producer nodes" therefore exist as a
> first-class **view** (`artists` where `roles` contains `producer`) plus the edges that connect them to tracks
> and releases — which is the honest, de-duplicated model and keeps every credit pointing at one `artists` table.

---

## 3. Node types

### Genre  (`genres[]`)
| field | type | notes |
|---|---|---|
| `id` | string | `genre:<slug>` |
| `label` | string | display name |

### Label  (`labels[]`)
| field | type | notes |
|---|---|---|
| `id` | string | `label:<mbid>` |
| `name` | string | required |
| `type` | string? | e.g. `Original Production`, `Holding` |
| `country` | string? | ISO code |
| `parentLabelId` | string? | → `labels` (label graph) |
| `releaseIds` | string[] | → `releases` (back-edge, optional) |

### Artist  (`artists[]`) — the node table for acts *and* credited people
| field | type | notes |
|---|---|---|
| `id` | string | `artist:<mbid>` |
| `name` | string | required |
| `sortName` | string? | |
| `type` | string? | `Person` \| `Group` \| `Orchestra` \| `Choir` |
| `country` | string? | |
| `lifeSpan` | object? | `{ begin, end, ended }` |
| `roles` | string[] | distinct roles observed: `performer`, `producer`, `engineer`, `mix`, `vocal`, `instrument`, `composer`, `writer` |
| `genreIds` | string[] | → `genres` |
| `bio` | object? | `{ text, source, url, license, attribution }` — see §6 |
| `image` | object? | `{ url, source, license, attribution, rights }` \| null |
| `memberIds` | string[] | → `artists` (members of this group) |
| `memberOfIds` | string[] | → `artists` (groups this person belongs to) |
| `releaseIds` | string[] | → `releases` (primary-artist releases) |
| `externalIds` | object[] | `[{ type: "musicbrainz", id }]` |

### Work  (`works[]`) — the song/composition, distinct from any one recording
| field | type | notes |
|---|---|---|
| `id` | string | `work:<mbid>` |
| `title` | string | required |
| `type` | string? | `Song`, `Composition`, … |
| `language` | string? | |
| `writerIds` | string[] | → `artists` (composer/lyricist) |
| `recordingIds` | string[] | → `tracks` |

### Release  (`releases[]`) — album / EP / single, at release-group grain
| field | type | notes |
|---|---|---|
| `id` | string | `release:<release-group-mbid>` |
| `title` | string | required |
| `primaryArtistId` | string | → `artists` |
| `artistCredits` | object[] | `[{ artistId, name, joinPhrase }]` (handles collaborations) |
| `type` | string? | `Album` \| `EP` \| `Single` \| `Compilation` \| `Live` |
| `firstReleaseDate` | string? | `YYYY` or `YYYY-MM-DD` |
| `genreIds` | string[] | → `genres` |
| `labelIds` | string[] | → `labels` |
| `trackIds` | string[] | → `tracks` (ordered) |
| `coverImage` | object? | `{ url, source: "cover-art-archive", rights }` \| null — §6 |
| `externalIds` | object[] | `[{ type, id }]` |

### Track  (`tracks[]`) — a recording, positioned on a release
| field | type | notes |
|---|---|---|
| `id` | string | `track:<recording-mbid>` |
| `title` | string | required |
| `releaseId` | string | → `releases` |
| `position` | number? | track number |
| `lengthMs` | number? | duration |
| `primaryArtistId` | string? | → `artists` |
| `workId` | string? | → `works` (the song this records) |
| `credits` | object[] | **the producer/performer edges** — `[{ artistId, role, attributes? }]`, `artistId` → `artists` |
| `externalIds` | object[] | `[{ type: "isrc", id }]` |

---

## 4. Edges (cross-references) — the whole point

| edge | from → to | carried by |
|---|---|---|
| performed / produced / engineered | `artist → track` | `Track.credits[].artistId` + `role` |
| band membership | `artist → artist` | `Artist.memberIds` / `memberOfIds` |
| released by | `release → artist` | `Release.primaryArtistId`, `artistCredits[]` |
| released on | `release → label` | `Release.labelIds` |
| contains | `release → track` | `Release.trackIds` |
| recording of | `track → work` | `Track.workId` |
| written by | `work → artist` | `Work.writerIds` |
| genre of | `* → genre` | `*.genreIds` |

A consumer builds the producer view as: `tracks.flatMap(t => t.credits).filter(c => c.role === 'producer')`,
joined to `artists` by `artistId` — no separate table, no duplication.

---

## 5. Map to data-tools collections

`music.pack.json` declares one collection per node table (`artists`, `releases`, `tracks`, `works`, `labels`,
`genres`) with `requiredFields` rules and `reference` rules on the **scalar** foreign keys
(`releases.primaryArtistId → artists`, `tracks.releaseId → releases`, `tracks.workId → works`).
Array-valued edges (`genreIds`, `labelIds`, `credits[].artistId`) are documented here and enforced by the
compiled `DataTools.Pack.Music` validator, which can walk arrays the declarative validator cannot.

---

## 6. Provenance & licensing — required, and honest

The one dimension that is *not* uniformly free is **images**. The spec records the truth per field instead of
pretending otherwise.

```jsonc
"provenance": {
  "builtBy": "build-music-master.mjs",
  "sources": [
    { "id": "musicbrainz",     "name": "MusicBrainz",       "license": "CC0-1.0",
      "use": "core metadata + relationships (artists, releases, tracks, works, labels, producer/performer credits)",
      "url": "https://musicbrainz.org" },
    { "id": "coverartarchive", "name": "Cover Art Archive",
      "license": "owners-retain-copyright",
      "rights": "Cover images are copyright their respective owners. Referenced by URL for display/identification only — NOT redistributed in this dataset.",
      "url": "https://coverartarchive.org" },
    { "id": "wikipedia",       "name": "Wikipedia",         "license": "CC BY-SA 4.0",
      "use": "artist bios (text). Attribution + share-alike apply to the bio text only.",
      "url": "https://en.wikipedia.org" }
  ],
  "snapshot": { "accessedAt": "<ISO>", "rawCacheSha256": "<digest of cached source bytes>" }
}
```

- **Metadata, relationships, ids** → MusicBrainz, **CC0** — free, commercial-safe, deterministic.
- **Bio text** → carries `license: "CC BY-SA 4.0"` + `attribution` per record; keep it on the `bio` field only.
- **Cover images** → stored as a *URL reference* with `rights`, never rebundled. Records may carry no image;
  the display layer is expected to supply a deterministic generated fallback so every tile still renders.

---

## 7. Determinism

Same inputs → byte-identical output. Achieved by: (a) a **pinned, ordered seed set**; (b) an on-disk **raw
cache** of every upstream response (rebuilds read cache, not network); (c) **stable sort** of every array by id;
(d) ids derived from upstream MBIDs, never from wall-clock or random. `generatedAt` is the only non-identity field.

---

## 8. Display subsets (what the translator emits)

The master is *not* a display format. The translator slices it into v3-shaped feeds
(`{ specVersion, rows[], entries[] }`) — e.g. `by-genre`, `by-decade`, `producers`, `labels` — addressable as
`music.mullmania.com?filter1=a&filter2=b`. The master stays display-agnostic; v3 stays canonical.
