#!/usr/bin/env node
// build-music-master.mjs
// -----------------------------------------------------------------------------
// Deterministic builder for the Mullmania music master file (spec: music.master.v1).
// ONE file. No npm dependencies (Node 18+ global fetch, fs, crypto only).
//
// It scrapes genuinely FREE, REAL sources and assembles a cross-referenced graph:
//   - MusicBrainz  (CC0)            -> artists, releases, tracks, works, labels,
//                                       and the producer/engineer/performer credit edges
//   - Cover Art Archive            -> release cover image URLs (display-only; owners keep rights)
//   - Wikipedia REST               -> artist bios (CC BY-SA 4.0, attributed per record)
//
// Determinism: pinned seed list -> resolved-and-cached MBIDs -> on-disk raw cache of
// every upstream response -> stable sort of every array by id. Re-runs read the cache,
// not the network, and emit byte-identical content (only `generatedAt` varies).
//
// Sources / modes:
//   --source=musicbrainz   (default) seeded MusicBrainz graph crawl. Rich producers. Runs now.
//   --source=fma           FMA frozen dump spine for ~100k scale (artists/releases/tracks/genres).
//                          Thin on producers; layer --enrich=musicbrainz onto the top artists.
//
// Usage:
//   node build-music-master.mjs                       # default verify slice (8 seeds)
//   node build-music-master.mjs --seeds=24 --albums=8 # bigger MusicBrainz graph
//   node build-music-master.mjs --source=fma          # full 100k spine (heavy: 342MB download)
//
// The 100k full run is the same builder at scale; see SEEDS / FMA_DUMP below.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(ROOT, 'cache');
const DATA_DIR = join(ROOT, 'data');
const CONTACT = 'mist83@gmail.com';
const USER_AGENT = `MullmaniaMusicBuilder/0.1 ( ${CONTACT} )`;

// ----- args -------------------------------------------------------------------
const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const SOURCE = ARGS.source || 'musicbrainz';
const SEED_COUNT = Math.max(1, parseInt(ARGS.seeds || '8', 10));
const ALBUMS_PER_ARTIST = Math.max(1, parseInt(ARGS.albums || '5', 10));

// Pinned, ordered seed acts. Diverse on purpose so the credit graph is rich
// (rock / electronic / jazz / hip-hop / soul / trip-hop / alt). Add names to grow it;
// each name resolves to an MBID once and is then cached, so the pin stays stable.
const SEEDS = [
  'The Beatles',
  'Daft Punk',
  'Miles Davis',
  'Kendrick Lamar',
  'Fleetwood Mac',
  'Radiohead',
  'Nina Simone',
  'Massive Attack',
  'Stevie Wonder',
  'Aphex Twin',
  'Outkast',
  'Talking Heads',
  'Björk',
  'A Tribe Called Quest',
  'Portishead',
  'David Bowie',
  'Kraftwerk',
  'Frank Ocean',
  'The Clash',
  'Herbie Hancock',
  'Tame Impala',
  'D’Angelo',
  'New Order',
  'The Roots',
];

// Full-scale spine (used by --source=fma). Frozen, versioned, CC BY 4.0 metadata.
const FMA_DUMP = {
  url: 'https://os.unil.cloud.switch.ch/fma/fma_metadata.zip',
  note: '106,574 tracks / 16,341 artists / 14,854 albums / 161 genres. metadata CC BY 4.0; no album art.',
};

// MusicBrainz: relationships + tracks + labels + works in one release call.
const MB_INC = 'recordings+artist-credits+labels+recording-level-rels+artist-rels+work-rels';

// ----- tiny rate-limited, cached HTTP ----------------------------------------
const lastHit = new Map(); // host -> ms
const MIN_INTERVAL = { 'musicbrainz.org': 1100, 'coverartarchive.org': 300, 'en.wikipedia.org': 300 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cachePath(url) {
  return join(CACHE_DIR, createHash('sha1').update(url).digest('hex') + '.json');
}

async function getJson(url, { allow404 = false } = {}) {
  const cp = cachePath(url);
  if (existsSync(cp)) {
    const c = JSON.parse(readFileSync(cp, 'utf8'));
    if (c.status === 404) return allow404 ? null : null;
    return c.body;
  }
  const host = new URL(url).host;
  const gap = MIN_INTERVAL[host] || 300;
  const wait = (lastHit.get(host) || 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());

  let status = 0;
  let body = null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    status = res.status;
    if (res.ok) body = await res.json();
    else if (status === 404) body = null;
    else throw new Error(`HTTP ${status} for ${url}`);
  } catch (err) {
    if (!allow404) throw err;
    status = status || 599;
  }
  writeFileSync(cp, JSON.stringify({ url, status, body }));
  return status === 404 ? null : body;
}

// ----- shared graph maps ------------------------------------------------------
const G = {
  genres: new Map(),
  labels: new Map(),
  artists: new Map(),
  works: new Map(),
  releases: new Map(),
  tracks: new Map(),
};

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function upsertArtist(mb, role) {
  if (!mb || !mb.id) return null;
  const id = `artist:${mb.id}`;
  let a = G.artists.get(id);
  if (!a) {
    a = {
      id,
      name: mb.name || mb['sort-name'] || 'Unknown',
      sortName: mb['sort-name'] || null,
      type: mb.type || undefined,
      country: mb.country || mb.area?.['iso-3166-1-codes']?.[0] || null,
      lifeSpan: mb['life-span'] || null,
      roles: [],
      genreIds: [],
      bio: null,
      image: null,
      memberIds: [],
      memberOfIds: [],
      releaseIds: [],
      externalIds: [{ type: 'musicbrainz', id: mb.id }],
    };
    G.artists.set(id, a);
  }
  if (role && !a.roles.includes(role)) a.roles.push(role);
  return a;
}

function upsertLabel(mb) {
  if (!mb || !mb.id) return null;
  const id = `label:${mb.id}`;
  if (!G.labels.has(id)) {
    G.labels.set(id, {
      id,
      name: mb.name || 'Unknown',
      type: mb.type || null,
      country: mb.country || null,
      parentLabelId: null,
      releaseIds: [],
    });
  }
  return G.labels.get(id);
}

function upsertGenre(name) {
  const id = `genre:${slug(name)}`;
  if (!id || id === 'genre:') return null;
  if (!G.genres.has(id)) G.genres.set(id, { id, label: name });
  return G.genres.get(id);
}

function upsertWork(mb) {
  if (!mb || !mb.id) return null;
  const id = `work:${mb.id}`;
  if (!G.works.has(id)) {
    G.works.set(id, {
      id,
      title: mb.title || 'Untitled',
      type: mb.type || null,
      language: mb.language || mb.languages?.[0] || null,
      writerIds: [],
      recordingIds: [],
    });
  }
  return G.works.get(id);
}

// MB relation type -> our role label
function roleFor(relType) {
  const t = String(relType || '').toLowerCase();
  if (t.includes('produc')) return 'producer';
  if (t.includes('engineer')) return 'engineer';
  if (t.includes('mix')) return 'mix';
  if (t.includes('vocal')) return 'vocal';
  if (t.includes('instrument')) return 'instrument';
  if (t.includes('compos')) return 'composer';
  if (t.includes('writ') || t.includes('lyric')) return 'writer';
  if (t.includes('arrang')) return 'arranger';
  if (t.includes('perform')) return 'performer';
  return t.replace(/\s+/g, '-') || 'credit';
}

// ----- enrichment: bios + cover art ------------------------------------------
async function attachBio(artist, mbid) {
  const meta = await getJson(`https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels+genres&fmt=json`, { allow404: true });
  if (!meta) return;
  for (const g of meta.genres || []) {
    const node = upsertGenre(g.name);
    if (node && !artist.genreIds.includes(node.id)) artist.genreIds.push(node.id);
  }
  // find a wikipedia page from url relationships
  let wikiTitle = null;
  for (const rel of meta.relations || []) {
    const url = rel.url?.resource || '';
    const m = url.match(/https?:\/\/en\.wikipedia\.org\/wiki\/([^?#]+)/);
    if (m) { wikiTitle = decodeURIComponent(m[1]); break; }
  }
  if (!wikiTitle) wikiTitle = artist.name.replace(/ /g, '_');
  const sum = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiTitle)}`, { allow404: true });
  if (sum && sum.extract) {
    artist.bio = {
      text: sum.extract,
      source: 'wikipedia',
      url: sum.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${wikiTitle}`,
      license: 'CC BY-SA 4.0',
      attribution: `Bio text from Wikipedia (“${sum.title}”), CC BY-SA 4.0.`,
    };
    if (sum.thumbnail?.source && !artist.image) {
      artist.image = {
        url: sum.thumbnail.source,
        source: 'wikipedia',
        license: 'see-source',
        rights: 'Image via Wikipedia/Wikimedia; licensing varies per file. Referenced for display only.',
      };
    }
  }
}

async function coverFor(rgId) {
  const caa = await getJson(`https://coverartarchive.org/release-group/${rgId}`, { allow404: true });
  if (!caa || !Array.isArray(caa.images)) return null;
  const front = caa.images.find((i) => i.front) || caa.images[0];
  if (!front) return null;
  const url = front.thumbnails?.['500'] || front.thumbnails?.large || front.image;
  if (!url) return null;
  return {
    url,
    source: 'cover-art-archive',
    rights: 'Cover image copyright its respective owner. Referenced for display/identification only, not redistributed.',
  };
}

// ----- crawl one seed artist into the graph ----------------------------------
async function crawlArtist(mbid) {
  const root = await getJson(`https://musicbrainz.org/ws/2/artist/${mbid}?fmt=json`, { allow404: true });
  if (!root) return;
  const artist = upsertArtist(root, 'performer');
  await attachBio(artist, mbid);

  const rgResp = await getJson(
    `https://musicbrainz.org/ws/2/release-group?artist=${mbid}&type=album&limit=100&fmt=json`,
    { allow404: true },
  );
  let groups = (rgResp?.['release-groups'] || []).filter((g) => (g['primary-type'] || '') === 'Album');
  groups.sort((a, b) => String(a['first-release-date'] || '9999').localeCompare(String(b['first-release-date'] || '9999')) || a.id.localeCompare(b.id));
  groups = groups.slice(0, ALBUMS_PER_ARTIST);

  for (const rg of groups) {
    let rel = await pickRelease(rg.id, true);
    if (!rel) rel = await pickRelease(rg.id, false);
    if (!rel) continue;

    const releaseId = `release:${rg.id}`;
    const credits = (rel['artist-credit'] || []).map((c) => ({
      artistId: upsertArtist(c.artist, 'performer')?.id,
      name: c.name || c.artist?.name,
      joinPhrase: c.joinphrase || '',
    })).filter((c) => c.artistId);

    const labelIds = [];
    for (const li of rel['label-info'] || []) {
      const lab = upsertLabel(li.label);
      if (lab && !labelIds.includes(lab.id)) { labelIds.push(lab.id); lab.releaseIds.push(releaseId); }
    }

    const cover = await coverFor(rg.id);
    const release = {
      id: releaseId,
      title: rg.title || rel.title,
      primaryArtistId: artist.id,
      artistCredits: credits,
      type: rg['primary-type'] || 'Album',
      firstReleaseDate: rg['first-release-date'] || rel.date || null,
      genreIds: [...artist.genreIds],
      labelIds,
      trackIds: [],
      coverImage: cover,
      externalIds: [{ type: 'musicbrainz-release-group', id: rg.id }],
    };
    G.releases.set(releaseId, release);
    if (!artist.releaseIds.includes(releaseId)) artist.releaseIds.push(releaseId);

    for (const medium of rel.media || []) {
      for (const tr of medium.tracks || []) {
        const rec = tr.recording || {};
        if (!rec.id) continue;
        const trackId = `track:${rec.id}`;
        const trackCredits = [];
        let workId = null;
        for (const rl of rec.relations || []) {
          if (rl.work && String(rl.type).toLowerCase() === 'performance') {
            const w = upsertWork(rl.work);
            if (w) { workId = w.id; if (!w.recordingIds.includes(trackId)) w.recordingIds.push(trackId); }
          } else if (rl.artist) {
            const role = roleFor(rl.type);
            const credited = upsertArtist(rl.artist, role);
            if (credited) {
              trackCredits.push({ artistId: credited.id, role, attributes: rl.attributes || [] });
              if (role === 'writer' || role === 'composer') {
                const w = workId ? G.works.get(workId) : null;
                if (w && !w.writerIds.includes(credited.id)) w.writerIds.push(credited.id);
              }
            }
          }
        }
        const existing = G.tracks.get(trackId);
        const track = existing || {
          id: trackId,
          title: rec.title || tr.title,
          releaseId,
          position: tr.position || Number(tr.number) || null,
          lengthMs: tr.length || rec.length || null,
          primaryArtistId: artist.id,
          workId,
          credits: trackCredits,
          externalIds: rec.isrcs?.map((i) => ({ type: 'isrc', id: i })) || [],
        };
        if (existing) {
          // merge credits if the recording recurs across releases
          for (const c of trackCredits) if (!existing.credits.some((x) => x.artistId === c.artistId && x.role === c.role)) existing.credits.push(c);
        } else {
          G.tracks.set(trackId, track);
        }
        if (!release.trackIds.includes(trackId)) release.trackIds.push(trackId);
      }
    }
  }
}

async function pickRelease(rgId, officialOnly) {
  const statusFilter = officialOnly ? '&status=official' : '';
  const resp = await getJson(
    `https://musicbrainz.org/ws/2/release?release-group=${rgId}&inc=${MB_INC}${statusFilter}&limit=1&fmt=json`,
    { allow404: true },
  );
  return (resp?.releases || [])[0] || null;
}

// ----- seed resolution (name -> mbid, cached) --------------------------------
async function resolveSeed(name) {
  const resp = await getJson(
    `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent('artist:"' + name + '"')}&limit=1&fmt=json`,
    { allow404: true },
  );
  const hit = (resp?.artists || [])[0];
  return hit ? { name, mbid: hit.id, matched: hit.name } : null;
}

// ----- assemble + verify + emit ----------------------------------------------
function sortById(map) {
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function verifyMaster(master) {
  const ids = {
    artists: new Set(master.artists.map((x) => x.id)),
    releases: new Set(master.releases.map((x) => x.id)),
    works: new Set(master.works.map((x) => x.id)),
    labels: new Set(master.labels.map((x) => x.id)),
    genres: new Set(master.genres.map((x) => x.id)),
  };
  const broken = [];
  const check = (cond, msg) => { if (!cond) broken.push(msg); };
  for (const r of master.releases) {
    check(ids.artists.has(r.primaryArtistId), `release ${r.id} -> missing artist ${r.primaryArtistId}`);
    for (const l of r.labelIds) check(ids.labels.has(l), `release ${r.id} -> missing label ${l}`);
  }
  for (const t of master.tracks) {
    check(ids.releases.has(t.releaseId), `track ${t.id} -> missing release ${t.releaseId}`);
    if (t.workId) check(ids.works.has(t.workId), `track ${t.id} -> missing work ${t.workId}`);
    for (const c of t.credits) check(ids.artists.has(c.artistId), `track ${t.id} credit -> missing artist ${c.artistId}`);
  }
  return broken;
}

// ----- FMA spine: Free Music Archive frozen dump (CC BY 4.0 metadata) ---------
const FMA_EX = join(ROOT, 'fma', 'ex');
const FMA_DIR = join(FMA_EX, 'fma_metadata');
const FMA_ZIP = join(ROOT, 'fma', 'fma_metadata.zip');

// The FMA zip is bzip2-compressed (zip method 12); Node has no bzip2, so extract via python.
function ensureFmaExtracted() {
  if (existsSync(join(FMA_DIR, 'raw_tracks.csv'))) return;
  if (!existsSync(FMA_ZIP)) {
    console.error('[fma] downloading pinned dump...', FMA_DUMP.url);
    execFileSync('curl', ['-sL', '-o', FMA_ZIP, FMA_DUMP.url], { stdio: 'inherit' });
  }
  console.error('[fma] extracting CSVs via python zipfile (bzip2)...');
  execFileSync('python3', ['-c',
    'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);' +
    "[z.extract('fma_metadata/'+n,sys.argv[2]) for n in ['genres.csv','raw_artists.csv','raw_albums.csv','raw_tracks.csv']]",
    FMA_ZIP, FMA_EX], { stdio: 'inherit' });
}

// Streaming, quote-aware CSV reader (handles commas + newlines inside quoted fields).
function streamCsv(path, onRow) {
  const text = readFileSync(path, 'utf8');
  let header = null, row = [], field = '', q = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (header === null) header = row;
    else if (row.length > 1 || row[0] !== '') {
      const o = {};
      for (let c = 0; c < header.length; c++) o[header[c]] = row[c] ?? '';
      onRow(o);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') endField();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) endRow();
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
function parseFmaDate(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}
function parseDuration(s) {
  const p = String(s || '').split(':').map(Number);
  if (p.length < 2 || p.some(Number.isNaN)) return null;
  const sec = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  return sec > 0 ? sec * 1000 : null;
}
function parseFmaGenres(s) {
  const out = []; const re = /'genre_id':\s*'(\d+)'/g; let m;
  while ((m = re.exec(String(s || '')))) out.push(m[1]);
  return out;
}
function fmaArtist(id, name) {
  return { id, name: name || 'Unknown', sortName: null, type: undefined, country: null, lifeSpan: null,
    roles: ['performer'], genreIds: [], bio: null, image: null, memberIds: [], memberOfIds: [],
    releaseIds: [], externalIds: [{ type: 'fma-artist', id: id.slice('artist:fma-'.length) }] };
}

function parseFmaInto() {
  ensureFmaExtracted();
  console.error('[fma] genres...');
  streamCsv(join(FMA_DIR, 'genres.csv'), (r) => {
    if (r.genre_id && r.title) { const id = `genre:fma-${r.genre_id}`; if (!G.genres.has(id)) G.genres.set(id, { id, label: r.title }); }
  });
  console.error('[fma] artists...');
  streamCsv(join(FMA_DIR, 'raw_artists.csv'), (r) => {
    if (!r.artist_id) return;
    const id = `artist:fma-${r.artist_id}`;
    const a = fmaArtist(id, r.artist_name);
    const bio = stripHtml(r.artist_bio);
    if (bio) a.bio = { text: bio.slice(0, 600), source: 'freemusicarchive', url: 'https://freemusicarchive.org', license: 'CC (per artist)', attribution: 'Artist bio via Free Music Archive.' };
    if (/^https?:\/\//.test(r.artist_image_file || '')) a.image = { url: r.artist_image_file, source: 'freemusicarchive', license: 'CC (per artist)', rights: 'Free Music Archive artist image; CC license varies.' };
    G.artists.set(id, a);
  });
  console.error('[fma] albums...');
  streamCsv(join(FMA_DIR, 'raw_albums.csv'), (r) => {
    if (!r.album_id) return;
    const id = `release:fma-${r.album_id}`;
    G.releases.set(id, { id, title: r.album_title || 'Untitled', primaryArtistId: null, artistCredits: [],
      type: 'Album', firstReleaseDate: parseFmaDate(r.album_date_released), genreIds: [], labelIds: [], trackIds: [],
      coverImage: /^https?:\/\//.test(r.album_image_file || '') ? { url: r.album_image_file, source: 'freemusicarchive', rights: 'Free Music Archive album image; CC license varies.' } : null,
      externalIds: [{ type: 'fma-album', id: r.album_id }] });
  });
  console.error('[fma] tracks (streaming)...');
  let n = 0;
  streamCsv(join(FMA_DIR, 'raw_tracks.csv'), (r) => {
    if (!r.track_id || !r.album_id) return; // releaseId is required by the schema
    const id = `track:fma-${r.track_id}`;
    const releaseId = `release:fma-${r.album_id}`;
    const artistId = r.artist_id ? `artist:fma-${r.artist_id}` : null;
    if (artistId && !G.artists.has(artistId)) G.artists.set(artistId, fmaArtist(artistId, r.artist_name));
    let rel = G.releases.get(releaseId);
    if (!rel) { rel = { id: releaseId, title: r.album_title || 'Untitled', primaryArtistId: null, artistCredits: [], type: 'Album', firstReleaseDate: null, genreIds: [], labelIds: [], trackIds: [], coverImage: null, externalIds: [{ type: 'fma-album', id: r.album_id }] }; G.releases.set(releaseId, rel); }
    G.tracks.set(id, { id, title: r.track_title || 'Untitled', releaseId, position: Number(r.track_number) || null, lengthMs: parseDuration(r.track_duration), primaryArtistId: artistId, workId: null, credits: [], externalIds: [] });
    if (!rel.primaryArtistId && artistId) rel.primaryArtistId = artistId;
    rel.trackIds.push(id);
    const a = artistId ? G.artists.get(artistId) : null;
    for (const g of parseFmaGenres(r.track_genres)) {
      const gid = `genre:fma-${g}`;
      if (!G.genres.has(gid)) continue;
      if (!rel.genreIds.includes(gid)) rel.genreIds.push(gid);
      if (a && !a.genreIds.includes(gid)) a.genreIds.push(gid);
    }
    if (a && !a.releaseIds.includes(releaseId)) a.releaseIds.push(releaseId);
    if (++n % 25000 === 0) console.error(`[fma]   ${n} tracks...`);
  });
  console.error(`[fma] parsed ${n} tracks`);
}

// Drop records that would break referential integrity (release needs an artist; track needs a release).
function pruneIntegrity() {
  for (const [id, r] of [...G.releases]) if (!r.primaryArtistId || !G.artists.has(r.primaryArtistId)) G.releases.delete(id);
  for (const [id, t] of [...G.tracks]) {
    if (!t.releaseId || !G.releases.has(t.releaseId)) { G.tracks.delete(id); continue; }
    if (t.primaryArtistId && !G.artists.has(t.primaryArtistId)) t.primaryArtistId = null;
    if (t.workId && !G.works.has(t.workId)) t.workId = null;
  }
  for (const [, r] of G.releases) r.trackIds = r.trackIds.filter((tid) => G.tracks.has(tid));
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });

  const seeds = SEEDS.slice(0, SEED_COUNT);
  console.error(`[mb] resolving ${seeds.length} seeds...`);
  const resolved = [];
  for (const name of seeds) {
    const r = await resolveSeed(name);
    if (r) { resolved.push(r); console.error(`  ${name} -> ${r.mbid} (${r.matched})`); }
    else console.error(`  ${name} -> NOT FOUND`);
  }

  let i = 0;
  for (const r of resolved) {
    i += 1;
    console.error(`[mb] (${i}/${resolved.length}) crawling ${r.name}`);
    await crawlArtist(r.mbid);
  }

  if (SOURCE === 'fma') parseFmaInto();
  pruneIntegrity();

  const master = {
    specVersion: 'music.master.v1',
    generatedAt: new Date().toISOString(),
    sourceId: 'mullmania-music',
    provenance: {
      builtBy: 'build-music-master.mjs',
      sources: [
        { id: 'musicbrainz', name: 'MusicBrainz', license: 'CC0-1.0', url: 'https://musicbrainz.org',
          use: 'core metadata + relationships (artists, releases, tracks, works, labels, producer/performer credits)' },
        { id: 'coverartarchive', name: 'Cover Art Archive', license: 'owners-retain-copyright', url: 'https://coverartarchive.org',
          rights: 'Cover images are copyright their respective owners. Referenced by URL for display only — not redistributed.' },
        { id: 'wikipedia', name: 'Wikipedia', license: 'CC BY-SA 4.0', url: 'https://en.wikipedia.org',
          use: 'artist bios (text). Attribution + share-alike apply to the bio text only.' },
        ...(SOURCE === 'fma' ? [{ id: 'freemusicarchive', name: 'Free Music Archive', license: 'CC BY 4.0 (metadata)', url: 'https://freemusicarchive.org',
          use: 'bulk artists/albums/tracks/genres spine (the ~100k records); audio is per-track CC, metadata CC BY 4.0' }] : []),
      ],
      seeds: resolved,
      snapshot: { accessedAt: new Date().toISOString() },
    },
    counts: {},
    genres: sortById(G.genres),
    labels: sortById(G.labels),
    artists: sortById(G.artists),
    works: sortById(G.works),
    releases: sortById(G.releases),
    tracks: sortById(G.tracks),
  };
  master.counts = {
    genres: master.genres.length, labels: master.labels.length, artists: master.artists.length,
    works: master.works.length, releases: master.releases.length, tracks: master.tracks.length,
  };

  // determinism receipt: hash of the raw cache bytes
  const cacheFiles = readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')).sort();
  const h = createHash('sha256');
  for (const f of cacheFiles) h.update(readFileSync(join(CACHE_DIR, f)));
  master.provenance.snapshot.rawCacheSha256 = h.digest('hex');
  master.provenance.snapshot.rawCacheFiles = cacheFiles.length;

  const broken = verifyMaster(master);
  const outPath = join(DATA_DIR, 'music-master.json');
  writeFileSync(outPath, JSON.stringify(master, null, SOURCE === 'fma' ? 0 : 2));

  const producerCredits = master.tracks.reduce((n, t) => n + t.credits.filter((c) => c.role === 'producer').length, 0);
  console.error('\n=== music-master.json ===');
  console.error('counts:', JSON.stringify(master.counts));
  console.error('producer credits:', producerCredits, '| total credits:', master.tracks.reduce((n, t) => n + t.credits.length, 0));
  console.error('bios:', master.artists.filter((a) => a.bio).length, '| cover images:', master.releases.filter((r) => r.coverImage).length);
  console.error('referential integrity:', broken.length === 0 ? 'OK (all edges resolve)' : `${broken.length} BROKEN`);
  if (broken.length) console.error(broken.slice(0, 10).join('\n'));
  console.error('rawCacheSha256:', master.provenance.snapshot.rawCacheSha256);
  console.error('wrote', outPath, `(${(JSON.stringify(master).length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
