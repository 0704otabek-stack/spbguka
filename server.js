import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import SEED_CATALOG from './catalog-seed.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3456;

process.on('uncaughtException', err => {
  console.error('Ignored uncaught exception:', err.message);
});
process.on('unhandledRejection', err => {
  console.error('Ignored unhandled rejection:', err?.message || err);
});

// Must use identical User-Agent across embed lookup and HLS segment proxy because upstream signs URLs with UA hash (hu=...)
const UPSTREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const UPSTREAM_ORIGIN = 'https://api.namy.ws';

const searchCache = new Map();
const streamCache = new Map();
const wikiCache = new Map();
const detailsCache = new Map();
const sourceCache = new Map();
const SOURCE_CACHE_TTL_MS = 15 * 60 * 1000;
let kinogoConfigCache = {
  ts: 0,
  origin: 'https://thermal.stravers.live',
  token: '0353340f069f0c189134e604e02d57'
};

function getMirrorList(preferredMirror = 'direct') {
  if (preferredMirror === 'kinogo') {
    return [
      'https://api.embf.net',
      'https://api.kinogram.best',
      'https://api.namy.ws',
      'https://api.embess.ws',
      'https://api.delivembd.ws'
    ];
  }
  if (preferredMirror === 'kinokino') {
    return [
      'https://kinokino.vip',
      'https://api.namy.ws',
      'https://api.kinogram.best',
      'https://api.embf.net',
      'https://api.embess.ws',
      'https://api.delivembd.ws'
    ];
  }
  if (preferredMirror === 'namy') {
    return [
      'https://api.namy.ws',
      'https://api.kinogram.best',
      'https://api.embf.net',
      'https://api.embess.ws',
      'https://api.delivembd.ws'
    ];
  }
  if (preferredMirror === 'delivembd') {
    return [
      'https://api.delivembd.ws',
      'https://api.kinogram.best',
      'https://api.embf.net',
      'https://api.embess.ws',
      'https://api.namy.ws'
    ];
  }
  return [
    'https://api.kinogram.best',
    'https://api.namy.ws',
    'https://api.embf.net',
    'https://api.embess.ws',
    'https://api.delivembd.ws'
  ];
}

function sendJson(res, status, data, req = null) {
  const jsonBuf = Buffer.from(JSON.stringify(data), 'utf8');
  const acceptEnc = (req?.headers?.['accept-encoding'] || res.req?.headers?.['accept-encoding'] || '').toLowerCase();
  if (acceptEnc.includes('gzip') && jsonBuf.length > 256) {
    zlib.gzip(jsonBuf, (err, gzBuf) => {
      if (err) {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(jsonBuf);
      }
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(gzBuf);
    });
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(jsonBuf);
}

function extractJsonArray(str, startIdx) {
  const firstBracket = str.indexOf('[', startIdx);
  if (firstBracket === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = firstBracket; i < str.length; i++) {
    const ch = str[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return str.slice(firstBracket, i + 1);
      }
    }
  }
  return null;
}

function normalizeAudioTracks(rawNames, rawOrder) {
  const names = Array.isArray(rawNames) && rawNames.length ? rawNames : ['Рус. Дублированный'];
  const entries = [];
  const seenCounts = new Map();

  const orderIndices = (Array.isArray(rawOrder) && rawOrder.length > 0)
    ? rawOrder.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < names.length)
    : names.map((_, idx) => idx);

  const orderedSet = new Set(orderIndices);
  for (let i = 0; i < names.length; i++) {
    if (!orderedSet.has(i)) orderIndices.push(i);
  }

  for (const rawIdx of orderIndices) {
    const labelRaw = String(names[rawIdx] || '').trim();
    if (!labelRaw || labelRaw.toLowerCase() === 'delete') continue;
    const key = labelRaw.toLowerCase();
    const count = (seenCounts.get(key) || 0) + 1;
    seenCounts.set(key, count);
    entries.push({
      name: count > 1 ? `${labelRaw} (${count})` : labelRaw,
      trackIndex: rawIdx
    });
  }

  return entries.length > 0 ? entries : [{ name: 'Рус. Дублированный', trackIndex: 0 }];
}

function extractAudioFromBlock(mkBlock) {
  let names = ['Рус. Дублированный'];
  let order = null;
  const namesKey = mkBlock.match(/["']?names["']?\s*:/);
  if (namesKey) {
    const arrStr = extractJsonArray(mkBlock, namesKey.index + namesKey[0].length);
    if (arrStr) {
      try { names = JSON.parse(arrStr); } catch (e) {}
    }
  }
  const orderKey = mkBlock.match(/["']?order["']?\s*:/);
  if (orderKey) {
    const arrStr = extractJsonArray(mkBlock, orderKey.index + orderKey[0].length);
    if (arrStr) {
      try { order = JSON.parse(arrStr); } catch (e) {}
    }
  }
  return normalizeAudioTracks(names, order);
}

function extractSubtitlesFromBlock(mkBlock) {
  try {
    const ccKey = mkBlock.match(/["']?cc["']?\s*:/);
    if (ccKey) {
      const arrStr = extractJsonArray(mkBlock, ccKey.index + ccKey[0].length);
      if (arrStr) {
        const parsed = JSON.parse(arrStr);
        if (Array.isArray(parsed)) {
          return parsed.map(c => ({
            name: c.name || 'Русские субтитры',
            url: c.url ? `/api/hls-proxy?url=${encodeURIComponent(c.url)}` : ''
          })).filter(c => c.url);
        }
      }
    }
  } catch (e) {}
  return [];
}

function parseMakePlayerFromHtml(html, embedUrl) {
  const mkIdx = html.lastIndexOf('makePlayer({');
  if (mkIdx === -1) return null;

  // Extract dynamic token appended to HLS URLs by VenomPlayer (e.g. var lok = 1, b21c6fc3 = "907cc0b0")
  const tokenMatch = html.match(/var\s+lok\s*=\s*\d+\s*,\s*\w+\s*=\s*"([^"]+)"/);
  const token = tokenMatch?.[1] || '';
  const mkBlock = html.slice(mkIdx);

  // Case 1: Series / Cartoon / Anime with playlist.seasons
  const sIdx = mkBlock.indexOf('seasons:');
  if (sIdx !== -1) {
    const jsonStr = extractJsonArray(mkBlock, sIdx);
    if (jsonStr) {
      const rawSeasons = JSON.parse(jsonStr);
      const seasonsMap = {};
      const allVoicesSet = new Set();

      for (const sObj of rawSeasons) {
        const sNum = Number(sObj.season) || 1;
        seasonsMap[sNum] = [];
        for (const ep of (sObj.episodes || [])) {
          const epNum = Number(ep.episode) || seasonsMap[sNum].length + 1;
          const voiceTracks = normalizeAudioTracks(ep.audio?.names, ep.audio?.order);
          const epVoices = voiceTracks.map(t => t.name);
          epVoices.forEach(v => allVoicesSet.add(v));

          const rawEpHls = ep.hls ? ep.hls.replace(/\\u0026/g, '&').replace(/\\\//g, '/') : '';
          const signedHls = rawEpHls ? (token ? `${rawEpHls}&${token}` : rawEpHls) : '';
          seasonsMap[sNum].push({
            season: sNum,
            episode: epNum,
            title: ep.title || `Серия ${epNum}`,
            duration: Math.round((ep.duration || 2700) / 60),
            hlsUrl: signedHls ? `/api/hls-proxy?url=${encodeURIComponent(signedHls)}` : '',
            rawHls: signedHls,
            voices: epVoices,
            voiceTracks,
            subtitles: (ep.cc || []).map(c => ({
              name: c.name,
              url: `/api/hls-proxy?url=${encodeURIComponent(c.url)}`
            }))
          });
        }
      }

      return {
        found: true,
        isSeries: true,
        embedUrl,
        seasons: seasonsMap,
        voices: Array.from(allVoicesSet)
      };
    }
  }

  // Case 2: Movie with source: { hls, audio, cc }
  const hlsMatch = mkBlock.match(/hls\s*:\s*"([^"]+)"/);
  if (hlsMatch) {
    const rawMovieHls = hlsMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const signedHls = token ? `${rawMovieHls}&${token}` : rawMovieHls;
    const voiceTracks = extractAudioFromBlock(mkBlock);
    const voices = voiceTracks.map(t => t.name);
    const hlsProxyUrl = `/api/hls-proxy?url=${encodeURIComponent(signedHls)}`;
    return {
      found: true,
      isSeries: false,
      embedUrl,
      voices,
      seasons: {
        1: [
          {
            season: 1,
            episode: 1,
            title: 'Полный фильм',
            duration: 130,
            hlsUrl: hlsProxyUrl,
            rawHls: signedHls,
            voices,
            voiceTracks,
            subtitles: extractSubtitlesFromBlock(mkBlock)
          }
        ]
      }
    };
  }

  return null;
}

async function fetchMakePlayerStream(embedUrl, extraHeaders = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const r = await fetch(embedUrl, {
      headers: { 'User-Agent': UPSTREAM_UA, ...extraHeaders },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!r.ok) return null;
    const html = await r.text();
    return parseMakePlayerFromHtml(html, embedUrl);
  } catch (e) {
    return null;
  }
}

// Parse real HLS streams, seasons, episodes, and Russian studio voiceover tracks from Namy / Kinogram / Embess / Delivembd balancers
async function parseLiveStreamBalancer(imdbId, kpId, preferredMirror = 'direct') {
  const cacheKey = `${imdbId || ''}:${kpId || ''}:${preferredMirror}`;
  const cached = streamCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 10 * 60 * 1000) {
    return cached.data;
  }

  const mirrors = getMirrorList(preferredMirror);

  const paths = [];
  if (imdbId) paths.push(`/embed/imdb/${imdbId}`);
  if (kpId) paths.push(`/embed/kp/${kpId}`);

  for (const mirror of mirrors) {
    for (const p of paths) {
      const result = await fetchMakePlayerStream(mirror + p);
      if (result && result.found) {
        streamCache.set(cacheKey, { ts: Date.now(), data: result });
        return result;
      }
    }
  }

  return { found: false };
}

// Translate IMDb IDs to Russian titles, Kinopoisk IDs, and Russian Wikipedia links via Wikidata SPARQL
async function enrichWithRussianMetadata(items) {
  const imdbIds = items.map(x => x.imdbId).filter(Boolean);
  if (imdbIds.length === 0) return items;

  const valuesClause = imdbIds.map(id => `"${id}"`).join(' ');
  const sparql = `SELECT ?imdb ?itemLabel ?itemDescription ?kpId ?sitelink WHERE {
    VALUES ?imdb { ${valuesClause} }
    ?item wdt:P345 ?imdb.
    OPTIONAL { ?item wdt:P2603 ?kpId. }
    OPTIONAL { ?sitelink schema:about ?item; schema:isPartOf <https://ru.wikipedia.org/>. }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,en". }
  }`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql), {
      headers: { 'User-Agent': 'SpbgukaMediaPortal/2.0' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!r.ok) return items;
    const j = await r.json();
    const bindings = j?.results?.bindings || [];
    const map = new Map();
    for (const b of bindings) {
      const imdb = b.imdb?.value;
      if (!imdb) continue;
      map.set(imdb, {
        ruTitle: b.itemLabel?.value,
        ruDesc: b.itemDescription?.value,
        kpId: b.kpId?.value,
        wikiUrl: b.sitelink?.value
      });
    }

    return items.map(item => {
      const meta = map.get(item.imdbId);
      if (meta) {
        if (meta.ruTitle && !/^Q\d+$/.test(meta.ruTitle)) {
          item.title = meta.ruTitle;
        }
        if (meta.kpId) item.kpId = meta.kpId;
        if (meta.wikiUrl) item.wikiUrl = meta.wikiUrl;
        if (meta.ruDesc && (!item.description || item.description.length < 30)) {
          item.description = meta.ruDesc.charAt(0).toUpperCase() + meta.ruDesc.slice(1) + '.';
        }
      }
      return item;
    });
  } catch (err) {
    return items;
  }
}

async function handleSearch(query) {
  const q = (query || '').trim();
  if (!q) return liveCatalog;

  const cacheKey = q.toLowerCase();
  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey);
  }

  const qLower = q.toLowerCase();
  const localMatches = liveCatalog.filter(item =>
    item.title.toLowerCase().includes(qLower) ||
    item.originalTitle.toLowerCase().includes(qLower) ||
    (item.cast || '').toLowerCase().includes(qLower) ||
    (item.genres || []).some(g => g.toLowerCase().includes(qLower))
  );

  let remoteItems = [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const imdbRes = await fetch(
      `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json`,
      {
        headers: { 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' },
        signal: controller.signal
      }
    );
    clearTimeout(timeout);

    if (imdbRes.ok) {
      const imdbData = await imdbRes.json();
      const rawList = (imdbData.d || []).filter(entry =>
        entry.id && entry.id.startsWith('tt') &&
        ['movie', 'tvSeries', 'tvMiniSeries', 'tvMovie', 'short', 'video'].includes(entry.qid || 'movie')
      ).slice(0, 12);

      remoteItems = rawList.map((entry, idx) => {
        const isSeries = ['tvSeries', 'tvMiniSeries'].includes(entry.qid);
        const posterUrl = entry.i?.imageUrl
          ? entry.i.imageUrl.replace(/\._V1_.*\.jpg$/i, '._V1_FMjpg_UX600_.jpg')
          : 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=600&q=80';

        return {
          id: entry.id,
          imdbId: entry.id,
          kpId: '',
          title: entry.l || q,
          originalTitle: entry.l || '',
          type: isSeries ? 'series' : 'movie',
          year: entry.y || 2024,
          yearRange: entry.yr || String(entry.y || 2024),
          ratingKp: Number((7.2 + ((idx * 3) % 18) / 10).toFixed(1)),
          ratingImdb: Number((7.4 + ((idx * 4) % 17) / 10).toFixed(1)),
          country: 'США / Мир',
          genres: isSeries ? ['Сериал', 'Драма'] : ['Фильм', 'Кино'],
          duration: isSeries ? '45 мин / серия' : '120 мин',
          director: 'Режиссёр проекта',
          cast: entry.s || 'Актёрский состав',
          poster: posterUrl,
          backdrop: posterUrl,
          isNew: (entry.y || 0) >= 2023,
          isPopular: (entry.rank || 9999) < 2500,
          seasonsCount: isSeries ? 3 : 1,
          episodesPerSeason: isSeries ? [10, 10, 10] : [1],
          voices: isSeries
            ? ['HDrezka Studio', 'LostFilm', 'Red Head Sound', 'Кубик в кубе', 'TVShows', 'Рус. Дублированный', 'Eng.Original']
            : ['Рус. Дублированный', 'Red Head Sound', 'HDrezka Studio', 'JASKIER', 'TVShows', 'Кубик в кубе', 'Eng.Original'],
          description: `Смотреть онлайн «${entry.l}» (${entry.yr || entry.y || '2024'}) в HD 1080p / 4K качестве без рекламы с выбором любой студии озвучки. В главных ролях: ${entry.s || 'известные актёры'}.`
        };
      });

      remoteItems = await enrichWithRussianMetadata(remoteItems);
    }
  } catch (e) {}

  const seen = new Set(localMatches.map(x => x.imdbId));
  const merged = [...localMatches];
  for (const rItem of remoteItems) {
    if (!seen.has(rItem.imdbId)) {
      seen.add(rItem.imdbId);
      merged.push(rItem);
    }
  }

  searchCache.set(cacheKey, merged);
  return merged;
}

async function handleDetails(imdbId, fallbackTitle, preferredMirror = 'direct', fastMode = false) {
  if (fastMode) {
    const fastCacheKey = `${imdbId}:fast`;
    const cachedDetails = detailsCache.get(fastCacheKey);
    if (cachedDetails && (Date.now() - cachedDetails.ts) < 30 * 60 * 1000) {
      return cachedDetails.data;
    }
  }

  let baseItem = liveCatalog.find(x => x.imdbId === imdbId);
  if (!baseItem) {
    for (const list of searchCache.values()) {
      const found = list.find(x => x.imdbId === imdbId);
      if (found) {
        baseItem = { ...found };
        break;
      }
    }
  }
  if (!baseItem) {
    baseItem = {
      id: imdbId,
      imdbId,
      kpId: '',
      title: fallbackTitle || imdbId,
      originalTitle: fallbackTitle || imdbId,
      type: 'movie',
      year: 2024,
      yearRange: '2024',
      ratingKp: 8.0,
      ratingImdb: 8.1,
      country: 'Мир',
      genres: ['Кино', 'Драма'],
      duration: '120 мин',
      director: 'Неизвестен',
      cast: '',
      poster: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=600&q=80',
      voices: ['Рус. Дублированный', 'Red Head Sound', 'HDrezka Studio', 'LostFilm', 'Кубик в кубе'],
      description: ''
    };
  } else {
    baseItem = { ...baseItem };
  }

  if (!baseItem.kpId && baseItem.imdbId) {
    const enriched = await enrichWithRussianMetadata([baseItem]);
    baseItem = enriched[0];
  }

  // Run Russian Wikipedia summary lookup (with 6h cache) and optional Live Balancer HLS extraction in parallel
  const [wikiExtract, liveStreamData] = await Promise.all([
    (async () => {
      try {
        let wikiPageTitle = '';
        if (baseItem.wikiUrl && baseItem.wikiUrl.includes('/wiki/')) {
          wikiPageTitle = decodeURIComponent(baseItem.wikiUrl.split('/wiki/')[1]);
        } else if (baseItem.title) {
          wikiPageTitle = baseItem.title;
        }
        if (!wikiPageTitle) return '';

        const cachedWiki = wikiCache.get(wikiPageTitle);
        if (cachedWiki && (Date.now() - cachedWiki.ts) < 6 * 60 * 60 * 1000) {
          return cachedWiki.extract;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const wikiRes = await fetch(
          `https://ru.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiPageTitle)}`,
          { signal: controller.signal }
        );
        clearTimeout(timeout);
        if (wikiRes.ok) {
          const wikiData = await wikiRes.json();
          if (wikiData.extract && wikiData.extract.length > 60) {
            wikiCache.set(wikiPageTitle, { ts: Date.now(), extract: wikiData.extract });
            return wikiData.extract;
          }
        }
        wikiCache.set(wikiPageTitle, { ts: Date.now(), extract: '' });
      } catch (e) {}
      return '';
    })(),
    fastMode
      ? Promise.resolve({ found: false })
      : parseLiveStreamBalancer(baseItem.imdbId, baseItem.kpId, preferredMirror)
  ]);

  if (wikiExtract) {
    baseItem.description = wikiExtract;
  }

  let seasonsMap = {};
  if (liveStreamData.found) {
    seasonsMap = liveStreamData.seasons;
    if (liveStreamData.voices && liveStreamData.voices.length > 0) {
      baseItem.voices = liveStreamData.voices;
    }
    if (liveStreamData.isSeries && baseItem.type === 'movie') {
      baseItem.type = 'series';
    }
    baseItem.embedUrl = liveStreamData.embedUrl;
  } else {
    // Minimal skeleton when server fast mode is enabled or stream will be resolved client-side
    seasonsMap = {
      1: [
        {
          season: 1,
          episode: 1,
          title: 'Основной поток',
          duration: 120,
          hlsUrl: '',
          voices: baseItem.voices || ['Рус. Дублированный']
        }
      ]
    };
  }

  const providers = [
    { id: 'direct', name: 'СПБГУКА Direct HLS (SSAI Ad-Shield)', badge: '1080p FHD / Multi-Audio', speed: '120 Мбит/с' },
    { id: 'animevost', name: 'AnimeVost (Прямой MP4 для аниме • 0% рекламы)', badge: '720p HD / MP4', speed: '115 Мбит/с' },
    { id: 'anilibria', name: 'AniLibria / AniLiberty (Чистый HLS • 0% рекламы)', badge: '1080p FHD / HLS', speed: '125 Мбит/с' },
    { id: 'kinogo', name: 'Kinogo / Киного (Прямой HLS • Без рекламы)', badge: '1080p FHD / HLS', speed: '115 Мбит/с' },
    { id: 'namy', name: 'Collaps HLS Mirror (Ad-Shield)', badge: '1080p FHD', speed: '110 Мбит/с' },
    { id: 'kinogram', name: 'Kinogram HLS Mirror (Ad-Shield)', badge: '1080p FHD', speed: '105 Мбит/с' },
    { id: 'delivembd', name: 'Delivembed HLS Mirror (Ad-Shield)', badge: '1080p FHD', speed: '98 Мбит/с' },
    { id: 'kinokino', name: 'Kinokino (kinokino.vip)', badge: '1080p / Embed', speed: '100 Мбит/с' }
  ];

  const qualities = ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD', '360p'];

  const detailsPayload = {
    ...baseItem,
    hasDirectHls: liveStreamData.found,
    seasons: seasonsMap,
    providers,
    qualities
  };

  if (fastMode) {
    detailsCache.set(`${imdbId}:fast`, { ts: Date.now(), data: detailsPayload });
  }

  return detailsPayload;
}

const AD_URL_RE = /(?:distribrey|getsdk|doubleclick|googlesyndication|adservice|adserver|stiven-king|deltarockme|vak345|vast|preroll|midroll|postroll|reklama|1xbet|fonbet|melbet|mostbet|vavada|pinup|\/ads?\/|\/advert\/|\/promo\/|[_-]adv?[_.-])/i;
const COLLAPS_HOST_RE = /interkh\.com|namy\.ws|kinogram\.best|embess\.ws|delivembd\.ws|embf\.net|collaps/i;
const ANILIBRIA_HOST_RE = /(?:^|\.)(?:libria\.fun|anilibria\.top|aniliberty\.top|anilibria\.tv)$/i;

function resolveHostDirKey(absUrl) {
  try {
    const u = new URL(absUrl);
    const dir = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
    return `${u.host}${dir}`;
  } catch (e) {
    return '';
  }
}

// Conservative HLS SSAI Ad-Stripper: removes CUE-OUT/ad-URL segments and short foreign-host discontinuity ad splices
function stripHlsAdSegments(rawText, baseUrl) {
  if (!rawText || !rawText.includes('#EXTINF:') || rawText.includes('#EXT-X-STREAM-INF')) {
    return { text: rawText, strippedCount: 0 };
  }

  const lines = rawText.split(/\r?\n/);
  const headerLines = [];
  let bodyStart = 0;
  for (; bodyStart < lines.length; bodyStart++) {
    const t = lines[bodyStart].trim();
    if (
      t.startsWith('#EXTINF:') ||
      t.startsWith('#EXT-X-DISCONTINUITY') ||
      t.startsWith('#EXT-X-CUE-OUT')
    ) {
      break;
    }
    if (lines[bodyStart] !== '') headerLines.push(lines[bodyStart]);
  }

  let hasEndlist = false;
  const blocks = [];
  let currentBlock = { segments: [] };
  let pendingTags = [];
  let pendingDuration = 0;
  let inCueOut = false;

  const flushBlock = () => {
    if (currentBlock.segments.length > 0) {
      blocks.push(currentBlock);
      currentBlock = { segments: [] };
    }
  };

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#EXT-X-ENDLIST')) {
      hasEndlist = true;
      break;
    }
    if (trimmed.startsWith('#EXT-X-CUE-OUT')) {
      inCueOut = true;
      continue;
    }
    if (trimmed.startsWith('#EXT-X-CUE-IN')) {
      inCueOut = false;
      continue;
    }
    if (trimmed.startsWith('#EXT-X-DISCONTINUITY') && !trimmed.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
      flushBlock();
      pendingTags = [];
      pendingDuration = 0;
      continue;
    }
    if (trimmed.startsWith('#EXT-X-DATERANGE') && /SCTE35-OUT|CLASS="[^"]*\bad\b/i.test(trimmed)) {
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#EXTINF:')) {
        const durVal = parseFloat(trimmed.slice(8));
        if (Number.isFinite(durVal) && durVal > 0) pendingDuration = durVal;
      }
      pendingTags.push(line);
      continue;
    }

    let absUrl = trimmed;
    try {
      absUrl = baseUrl ? new URL(trimmed, baseUrl).href : trimmed;
    } catch (e) {}

    const urlAd = AD_URL_RE.test(absUrl) || AD_URL_RE.test(trimmed);
    currentBlock.segments.push({
      tags: pendingTags,
      uri: trimmed,
      absUrl,
      hostDir: resolveHostDirKey(absUrl),
      duration: pendingDuration || 6,
      isAd: inCueOut || urlAd
    });
    pendingTags = [];
    pendingDuration = 0;
  }
  flushBlock();

  let strippedCount = 0;
  for (const blk of blocks) {
    const kept = [];
    for (const seg of blk.segments) {
      if (seg.isAd) strippedCount++;
      else kept.push(seg);
    }
    blk.segments = kept;
  }

  const nonEmptyBlocks = blocks.filter(b => b.segments.length > 0);
  if (nonEmptyBlocks.length > 1) {
    const dirDurations = new Map();
    let totalDur = 0;
    for (const blk of nonEmptyBlocks) {
      let blkDur = 0;
      const blkDirs = new Map();
      for (const seg of blk.segments) {
        blkDur += seg.duration;
        totalDur += seg.duration;
        if (seg.hostDir) {
          blkDirs.set(seg.hostDir, (blkDirs.get(seg.hostDir) || 0) + seg.duration);
          dirDurations.set(seg.hostDir, (dirDurations.get(seg.hostDir) || 0) + seg.duration);
        }
      }
      blk.blockDur = blkDur;
      let bestDir = '';
      let bestDirDur = -1;
      for (const [d, dur] of blkDirs.entries()) {
        if (dur > bestDirDur) { bestDirDur = dur; bestDir = d; }
      }
      blk.hostDir = bestDir;
    }

    let dominantHostDir = '';
    let dominantDur = 0;
    for (const [d, dur] of dirDurations.entries()) {
      if (dur > dominantDur) { dominantDur = dur; dominantHostDir = d; }
    }

    if (dominantHostDir && totalDur > 0 && (dominantDur >= 120 || dominantDur > totalDur * 0.5)) {
      for (const blk of nonEmptyBlocks) {
        if (blk.hostDir && blk.hostDir !== dominantHostDir && blk.blockDur <= 125) {
          blk.drop = true;
          strippedCount += blk.segments.length;
        }
      }
    }
  }

  const finalBlocks = nonEmptyBlocks.filter(b => !b.drop && b.segments.length > 0);
  const keptCount = finalBlocks.reduce((acc, b) => acc + b.segments.length, 0);
  if (keptCount === 0 || strippedCount === 0) {
    return { text: rawText, strippedCount: 0 };
  }

  const out = [...headerLines];
  finalBlocks.forEach((blk, idx) => {
    if (idx > 0) out.push('#EXT-X-DISCONTINUITY');
    for (const seg of blk.segments) {
      for (const t of seg.tags) out.push(t);
      out.push(seg.uri);
    }
  });
  if (hasEndlist) out.push('#EXT-X-ENDLIST');
  return { text: out.join('\n'), strippedCount };
}

// HLS Stream Proxy: Fetches master.m3u8, audio/video sub-playlists, and .ts/.vtt segments with CDN-aware headers & SSAI Ad-Shield
async function handleHlsProxy(req, res, targetUrl, audioIdxParam, singleAudioParam) {
  if (!targetUrl) {
    res.writeHead(400);
    return res.end('Missing url param');
  }

  try {
    let targetHost = '';
    try { targetHost = new URL(targetUrl).hostname; } catch (e) {}
    const isCollapsCdn = COLLAPS_HOST_RE.test(targetHost) || COLLAPS_HOST_RE.test(targetUrl);

    const upstreamHeaders = { 'User-Agent': UPSTREAM_UA };
    if (isCollapsCdn) {
      upstreamHeaders['Origin'] = UPSTREAM_ORIGIN;
      upstreamHeaders['Referer'] = `${UPSTREAM_ORIGIN}/`;
    }
    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    const r = await fetch(targetUrl, { headers: upstreamHeaders });
    if (!r.ok && r.status !== 206) {
      res.writeHead(r.status, { 'Access-Control-Allow-Origin': '*' });
      return res.end(`Upstream status ${r.status}`);
    }

    const contentType = r.headers.get('content-type') || '';
    const isM3u8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('x-mpegURL');

    if (isM3u8) {
      const rawText = await r.text();
      const cleaned = stripHlsAdSegments(rawText, targetUrl);
      const lines = cleaned.text.split(/\r?\n/);
      const outLines = [];

      const parsedAudioIdx = (audioIdxParam !== null && audioIdxParam !== undefined && audioIdxParam !== '')
        ? parseInt(audioIdxParam, 10)
        : -1;
      const audioLinesCount = lines.filter(l =>
        l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO') && !l.includes('GROUP-ID="failover-audio-0"')
      ).length;
      const effectiveAudioIdx = (Number.isInteger(parsedAudioIdx) && parsedAudioIdx >= 0 && audioLinesCount > 0)
        ? Math.min(parsedAudioIdx, audioLinesCount - 1)
        : -1;
      let audioCounter = 0;

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // Remove duplicate failover-audio-0 group so hls.audioTracks maps 1:1 to studio voiceover buttons
        if (line.includes('GROUP-ID="failover-audio-0"')) continue;
        if (line.includes('AUDIO="failover-audio-0"')) {
          i++; // skip URL line right after
          continue;
        }

        // For iOS Safari & Smart TVs native HLS: honor explicit audio track selection
        if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO') && effectiveAudioIdx >= 0) {
          const currentIdx = audioCounter++;
          if (singleAudioParam === '1' && currentIdx !== effectiveAudioIdx) {
            continue;
          }
          const isSelected = currentIdx === effectiveAudioIdx;
          const flagVal = isSelected ? 'YES' : 'NO';
          line = /DEFAULT=(YES|NO)/.test(line)
            ? line.replace(/DEFAULT=(YES|NO)/g, `DEFAULT=${flagVal}`)
            : `${line},DEFAULT=${flagVal}`;
          line = /AUTOSELECT=(YES|NO)/.test(line)
            ? line.replace(/AUTOSELECT=(YES|NO)/g, `AUTOSELECT=${flagVal}`)
            : `${line},AUTOSELECT=${flagVal}`;
        }

        // Rewrite URI="..." inside #EXT-X-MEDIA or #EXT-X-KEY or #EXT-X-MAP
        if (line.startsWith('#') && line.includes('URI="')) {
          line = line.replace(/URI="([^"]+)"/g, (_, uriVal) => {
            const absUrl = new URL(uriVal, targetUrl).href;
            return `URI="/api/hls-proxy?url=${encodeURIComponent(absUrl)}"`;
          });
          outLines.push(line);
          continue;
        }

        // Rewrite non-comment URL lines (sub-playlists or .ts segments)
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const absUrl = new URL(trimmed, targetUrl).href;
          outLines.push(`/api/hls-proxy?url=${encodeURIComponent(absUrl)}`);
        } else {
          outLines.push(line);
        }
      }

      const rewritten = outLines.join('\n');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'X-SPBGUKA-Ads-Stripped': String(cleaned.strippedCount)
      });
      return res.end(rewritten);
    }

    // Binary segment (.ts / .m4s / .mp4 / .vtt)
    const defaultCt = targetUrl.includes('.vtt')
      ? 'text/vtt; charset=utf-8'
      : (targetUrl.includes('.mp4') ? 'video/mp4' : 'video/mp2t');
    const resHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': contentType || defaultCt,
      'Cache-Control': 'public, max-age=3600'
    };
    const contentLength = r.headers.get('content-length');
    if (contentLength) resHeaders['Content-Length'] = contentLength;
    const contentRange = r.headers.get('content-range');
    if (contentRange) resHeaders['Content-Range'] = contentRange;
    const acceptRanges = r.headers.get('accept-ranges');
    if (acceptRanges) resHeaders['Accept-Ranges'] = acceptRanges;

    res.writeHead(r.status, resHeaders);
    if (r.body) {
      const nodeStream = Readable.fromWeb(r.body);
      nodeStream.on('error', () => {
        if (!res.destroyed) res.end();
      });
      res.on('close', () => {
        nodeStream.destroy();
      });
      nodeStream.pipe(res);
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      res.end(buf);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
      res.end('Proxy error: ' + err.message);
    }
  }
}

// Ad-Stripped Fallback Embed Proxy: strips VAST/pop/banner/tracking ad configs and routes HLS through /api/hls-proxy
async function handleEmbedClean(req, res, parsedUrl) {
  const imdb = parsedUrl.searchParams.get('imdb') || '';
  const kp = parsedUrl.searchParams.get('kp') || '';
  const mirrorParam = parsedUrl.searchParams.get('mirror') || 'namy';
  const season = parsedUrl.searchParams.get('season');
  const episode = parsedUrl.searchParams.get('episode');

  const mirrors = getMirrorList(mirrorParam);
  const query = (season && episode)
    ? `?season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`
    : '';
  const paths = [];
  if (imdb) paths.push(`/embed/imdb/${encodeURIComponent(imdb)}${query}`);
  if (kp) paths.push(`/embed/kp/${encodeURIComponent(kp)}${query}`);

  for (const mirror of mirrors) {
    for (const p of paths) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 7000);
        const r = await fetch(mirror + p, {
          headers: { 'User-Agent': UPSTREAM_UA },
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (!r.ok) continue;

        let html = await r.text();
        if (!html.includes('makePlayer({')) continue;

        html = html
          .replace(/<head([^>]*)>/i, `<head$1><base href="${mirror}/">`)
          .replace(/<script[^>]*data-name=["']?ss["']?[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<script[^>]*data-name=["']?ad["']?[^>]*>[\s\S]*?<\/script>/gi, '<script data-name="ad">var middleCount = 0, adTimeouts = {}, adsConfig = {};</script>')
          .replace(/ads:\s*adsConfig/g, 'ads: undefined')
          .replace(/distribrey\.com/gi, '')
          .replace(/getsdk\.online/gi, '')
          .replace(/deltarockme\.com/gi, '')
          .replace(/vak345\.com/gi, '')
          .replace(/api\.stiven-king\.com/gi, '')
          .replace(
            /else\s+o\[k\]\s*\+=\s*'&'\s*\+\s*(\w+);/,
            `else { o[k]+='&'+$1; if(k==='hls'){ o[k]=location.origin+'/api/hls-proxy?url='+encodeURIComponent(o[k]); delete o.dash; delete o.dasha; } }`
          );

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        return res.end(html);
      } catch (e) {
        // try next mirror/path
      }
    }
  }

  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end('<!DOCTYPE html><html><body style="margin:0;background:#09090b;color:#a1a1aa;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">Поток временно недоступен на выбранном зеркале. Попробуйте Прямой HLS.</body></html>');
}

// --- Independent Streaming Sources (AnimeVost, AniLibria / AniLiberty, Kinogo / Alloha) ---

const TITLE_STOPWORDS = new Set([
  'the', 'of', 'a', 'an', 'and', 'or', 'in', 'on', 'to', 'for', 'no', 'wa', 'ga', 'wo', 'ni',
  'season', 'part', 'movie', 'ova', 'ona', 'special', 'tv', 'final',
  'сезон', 'часть', 'фильм', 'тв', 'спешл', 'ова', 'полнометражный', 'короткометражный',
  'второй', 'третий', 'четвертый', 'пятый', 'шестой', 'первый', 'финал'
]);

function stripSeasonMarkers(str) {
  return String(str || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*(?:сезон|season|ova|ona|тв|tv|часть|part|финал|special|фильм)[^)]*\)/gi, ' ')
    .replace(/\b(?:\d+(?:st|nd|rd|th)?|final)\s*season\b/gi, ' ')
    .replace(/\bseason\s*\d+\b/gi, ' ')
    .replace(/\b\d+\s*сезон\b/gi, ' ')
    .replace(/\b(?:второй|третий|четвертый|четвёртый|пятый|шестой|первый)\s*сезон\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitlePlain(str) {
  return stripSeasonMarkers(str)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitleTokens(str) {
  const plain = normalizeTitlePlain(str);
  if (!plain) return [];
  return plain
    .split(' ')
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !TITLE_STOPWORDS.has(t));
}

function scoreSinglePair(qRaw, cRaw) {
  const qPlain = normalizeTitlePlain(qRaw);
  const cPlain = normalizeTitlePlain(cRaw);
  if (!qPlain || !cPlain) return 0;

  if (qPlain === cPlain) return 100;

  // Strip trailing colon subtitle differences when base title equals (e.g. "Атака титанов" vs "Attack on Titan: Final")
  const qTokens = normalizeTitleTokens(qRaw);
  const cTokens = normalizeTitleTokens(cRaw);
  if (qTokens.length === 0 || cTokens.length === 0) return 0;

  const qSet = new Set(qTokens);
  const cSet = new Set(cTokens);
  let overlap = 0;
  for (const t of qSet) {
    if (cSet.has(t)) overlap++;
  }
  if (overlap === 0) return 0;

  const recall = overlap / qSet.size;
  const precision = overlap / cSet.size;

  // For single-word titles, require strict whole match or base match with same single non-stopword token
  if (qSet.size === 1) {
    if (cSet.size === 1 && overlap === 1) return 92;
    if (cPlain.startsWith(qPlain + ' ') && precision >= 0.5) return 75;
    return 0;
  }

  if (recall >= 0.75 && precision >= 0.5) {
    return Math.round(55 + recall * 25 + precision * 15);
  }
  if (qPlain.length >= 6 && cPlain.startsWith(qPlain + ' ') && precision >= 0.45) {
    return 72;
  }
  return 0;
}

function computeTitleMatchScore(queryTitles, candidateTitles, targetYear = 0, candidateYear = 0) {
  let best = 0;
  for (const q of queryTitles) {
    if (!q) continue;
    for (const c of candidateTitles) {
      if (!c) continue;
      const s = scoreSinglePair(q, c);
      if (s > best) best = s;
    }
  }
  if (best <= 0) return 0;
  const ty = Number(targetYear) || 0;
  const cy = Number(candidateYear) || 0;
  if (ty > 0 && cy > 0 && Math.abs(ty - cy) <= 1) {
    best += 10;
  }
  return best;
}

const ANIMEVOST_ALIASES = {
  'атака титанов': ['Вторжение гигантов', 'Attack on Titan'],
  'attack on titan': ['Вторжение гигантов', 'Attack on Titan'],
  'наруто ураганные хроники': ['Ураганные хроники', 'Naruto Shippuuden'],
  'naruto shippuden': ['Ураганные хроники', 'Naruto Shippuuden'],
  'клинок рассекающий демонов': ['Клинок, рассекающий демонов', 'Kimetsu no Yaiba'],
  'demon slayer': ['Клинок, рассекающий демонов', 'Kimetsu no Yaiba'],
  'магическая битва': ['Магическая битва', 'Jujutsu Kaisen'],
  'jujutsu kaisen': ['Магическая битва', 'Jujutsu Kaisen'],
  'ван пис': ['One Piece', 'Ван Пис'],
  'one piece': ['One Piece', 'Ван Пис'],
  'провожающая в последний путь фрирен': ['Фрирен', 'Sousou no Frieren'],
  'frieren': ['Фрирен', 'Sousou no Frieren'],
  'человек бензопила': ['Chainsaw Man', 'Человек-бензопила'],
  'chainsaw man': ['Chainsaw Man', 'Человек-бензопила'],
  'тетрадь смерти': ['Death Note', 'Тетрадь смерти'],
  'death note': ['Death Note', 'Тетрадь смерти']
};

function parseAnimeVostEntryInfo(entry) {
  const rawTitle = String(entry?.title || '').replace(/\[[^\]]*\]/g, '').trim();
  const parts = rawTitle.split(' / ').map(p => p.trim()).filter(Boolean);
  const ruPart = parts[0] || rawTitle;
  const enPart = parts[1] || '';

  let seasonNum = null;
  const seasonSrc = `${entry?.title || ''}`;
  const ordRules = [
    [/первый\s*сезон|1st\s*season|\bseason\s*1\b/i, 1],
    [/второй\s*сезон|2nd\s*season|\bseason\s*2\b|\(\s*2\s*сезон\s*\)/i, 2],
    [/третий\s*сезон|3rd\s*season|\bseason\s*3\b|\(\s*3\s*сезон\s*\)/i, 3],
    [/четв[её]ртый\s*сезон|4th\s*season|\bseason\s*4\b|\(\s*4\s*сезон\s*\)/i, 4],
    [/пятый\s*сезон|5th\s*season|\bseason\s*5\b|\(\s*5\s*сезон\s*\)/i, 5],
    [/шестой\s*сезон|6th\s*season|\bseason\s*6\b|\(\s*6\s*сезон\s*\)/i, 6],
    [/final\s*season|финальный\s*сезон/i, 4]
  ];
  for (const [re, num] of ordRules) {
    if (re.test(seasonSrc)) {
      seasonNum = num;
      break;
    }
  }

  return {
    ruTitle: ruPart,
    enTitle: enPart,
    baseRu: normalizeTitlePlain(ruPart),
    baseEn: normalizeTitlePlain(enPart),
    seasonNum
  };
}

function upgradeToHttps(urlStr) {
  if (!urlStr) return '';
  return String(urlStr).replace(/^http:\/\//i, 'https://');
}

function parseEpisodeNumber(epName, fallbackIdx) {
  const m = String(epName || '').match(/(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallbackIdx;
}

async function resolveAnimeVostSource({ title = '', originalTitle = '', year = 0, type = 'anime' }) {
  const cacheKey = `animevost:${normalizeTitlePlain(title)}:${normalizeTitlePlain(originalTitle)}:${year}:${type}`;
  const cached = sourceCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < SOURCE_CACHE_TTL_MS) {
    return cached.data;
  }

  const hosts = ['https://api.animevost.org', 'https://api.animetop.info'];
  const aliasKeyRu = normalizeTitlePlain(title);
  const aliasKeyEn = normalizeTitlePlain(originalTitle);
  const rawQueries = [
    ...(ANIMEVOST_ALIASES[aliasKeyRu] || []),
    ...(ANIMEVOST_ALIASES[aliasKeyEn] || []),
    originalTitle,
    title.replace(/-/g, ' '),
    title.includes(':') ? title.split(':')[0].trim() : ''
  ];
  const queries = [];
  const seenQ = new Set();
  for (const q of rawQueries) {
    const clean = String(q || '').trim();
    if (clean.length >= 2 && !seenQ.has(clean.toLowerCase())) {
      seenQ.add(clean.toLowerCase());
      queries.push(clean);
    }
  }

  const targetTitles = [
    ...(ANIMEVOST_ALIASES[aliasKeyRu] || []),
    ...(ANIMEVOST_ALIASES[aliasKeyEn] || []),
    title,
    originalTitle
  ].filter(Boolean);

  const candidatesById = new Map();
  for (const q of queries) {
    let querySucceeded = false;
    for (const host of hosts) {
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 6000);
        const r = await fetch(`${host}/v1/search`, {
          method: 'POST',
          headers: { 'User-Agent': UPSTREAM_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `name=${encodeURIComponent(q)}`,
          signal: c.signal
        });
        clearTimeout(t);
        if (r.status === 404) {
          querySucceeded = true;
          break;
        }
        if (!r.ok) continue;
        const j = await r.json().catch(() => null);
        querySucceeded = true;
        if (Array.isArray(j?.data)) {
          for (const entry of j.data) {
            if (entry && entry.id && !candidatesById.has(entry.id)) {
              candidatesById.set(entry.id, entry);
            }
          }
        }
        break;
      } catch (e) {}
    }
    if (candidatesById.size >= 10 && querySucceeded) break;
  }

  if (candidatesById.size === 0) {
    const miss = { found: false, source: 'animevost' };
    sourceCache.set(cacheKey, { ts: Date.now(), data: miss });
    return miss;
  }

  const wantMovie = type === 'movie';
  const scored = [];
  for (const entry of candidatesById.values()) {
    const entryType = String(entry.type || '').toLowerCase();
    if (wantMovie) {
      if (!entryType.includes('фильм')) continue;
    } else {
      if (/ova|ona|фильм|спешл|спэшл|special/i.test(entryType)) continue;
    }

    const info = parseAnimeVostEntryInfo(entry);
    const score = computeTitleMatchScore(
      targetTitles,
      [info.ruTitle, info.enTitle].filter(Boolean),
      year,
      entry.year
    );
    if (score >= 70) {
      scored.push({ entry, info, score });
    }
  }

  if (scored.length === 0) {
    const miss = { found: false, source: 'animevost' };
    sourceCache.set(cacheKey, { ts: Date.now(), data: miss });
    return miss;
  }

  scored.sort((a, b) => (b.score - a.score) || ((Number(a.entry.year) || 9999) - (Number(b.entry.year) || 9999)));
  const topHit = scored[0];

  // Collect seasons belonging to the same franchise base title
  const sameFranchise = scored.filter(c =>
    c.entry.id === topHit.entry.id ||
    (topHit.info.baseEn && c.info.baseEn && c.info.baseEn === topHit.info.baseEn) ||
    (topHit.info.baseRu && c.info.baseRu && c.info.baseRu === topHit.info.baseRu)
  );
  sameFranchise.sort((a, b) => (Number(a.entry.year) || 9999) - (Number(b.entry.year) || 9999));

  const pickedEntries = sameFranchise.slice(0, wantMovie ? 1 : 6);
  const seasonAssigned = [];
  const usedSeasons = new Set();
  for (let i = 0; i < pickedEntries.length; i++) {
    let sNum = pickedEntries[i].info.seasonNum || (i + 1);
    while (usedSeasons.has(sNum)) sNum++;
    usedSeasons.add(sNum);
    seasonAssigned.push({ sNum, entry: pickedEntries[i].entry });
  }

  const playlistResults = await Promise.all(
    seasonAssigned.map(async ({ sNum, entry }) => {
      for (const host of hosts) {
        try {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 6000);
          const pr = await fetch(`${host}/v1/playlist`, {
            method: 'POST',
            headers: { 'User-Agent': UPSTREAM_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `id=${encodeURIComponent(String(entry.id))}`,
            signal: c.signal
          });
          clearTimeout(t);
          if (!pr.ok) continue;
          const plist = await pr.json().catch(() => null);
          if (Array.isArray(plist) && plist.length > 0) {
            return { sNum, plist };
          }
        } catch (e) {}
      }
      return { sNum, plist: [] };
    })
  );

  const seasonsMap = {};
  for (const { sNum, plist } of playlistResults) {
    if (!plist.length) continue;
    const eps = plist.map((ep, idx) => {
      const epNum = parseEpisodeNumber(ep.name, idx + 1);
      const mp4Hd = upgradeToHttps(ep.hd || '');
      const mp4Std = upgradeToHttps(ep.std || ep.hd || '');
      return {
        season: sNum,
        episode: epNum,
        title: ep.name || `Серия ${epNum}`,
        duration: wantMovie ? 110 : 24,
        streamType: 'mp4',
        mp4Hd: mp4Hd || mp4Std,
        mp4Std: mp4Std || mp4Hd,
        hlsUrl: '',
        rawHls: '',
        voices: ['AnimeVost'],
        voiceTracks: [{ name: 'AnimeVost', trackIndex: 0 }],
        subtitles: []
      };
    }).filter(e => e.mp4Hd || e.mp4Std);

    if (eps.length > 0) {
      eps.sort((a, b) => a.episode - b.episode);
      seasonsMap[sNum] = eps;
    }
  }

  if (Object.keys(seasonsMap).length === 0) {
    const miss = { found: false, source: 'animevost' };
    sourceCache.set(cacheKey, { ts: Date.now(), data: miss });
    return miss;
  }

  const result = {
    found: true,
    source: 'animevost',
    sourceTitle: topHit.entry.title,
    isSeries: !wantMovie,
    voices: ['AnimeVost'],
    qualities: ['Авто (720p HD)', '720p HD', '480p SD'],
    seasons: seasonsMap
  };
  sourceCache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

function cleanAniLibriaHlsUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return `https://${u.host}${u.pathname}`;
  } catch (e) {
    return '';
  }
}

async function fetchAniLibriaJson(pathAndQuery) {
  for (const host of ['https://aniliberty.top', 'https://anilibria.top']) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 6000);
      const r = await fetch(`${host}${pathAndQuery}`, {
        headers: { 'User-Agent': UPSTREAM_UA },
        signal: c.signal
      });
      clearTimeout(t);
      if (!r.ok) continue;
      return await r.json().catch(() => null);
    } catch (e) {}
  }
  return null;
}

async function resolveAniLibriaSource({ title = '', originalTitle = '', year = 0, type = 'anime' }) {
  const cacheKey = `anilibria:${normalizeTitlePlain(title)}:${normalizeTitlePlain(originalTitle)}:${year}:${type}`;
  const cached = sourceCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < SOURCE_CACHE_TTL_MS) {
    return cached.data;
  }

  const rawQueries = [
    title,
    originalTitle,
    title.includes(':') ? title.split(':')[0].trim() : ''
  ];
  const queries = [];
  const seenQ = new Set();
  for (const q of rawQueries) {
    const clean = String(q || '').trim();
    if (clean.length >= 2 && !seenQ.has(clean.toLowerCase())) {
      seenQ.add(clean.toLowerCase());
      queries.push(clean);
    }
  }

  const targetTitles = [title, originalTitle].filter(Boolean);
  const candidatesById = new Map();
  for (const q of queries) {
    const list = await fetchAniLibriaJson(`/api/v1/app/search/releases?query=${encodeURIComponent(q)}`);
    if (Array.isArray(list)) {
      for (const rel of list) {
        if (rel && rel.id && !candidatesById.has(rel.id)) {
          candidatesById.set(rel.id, rel);
        }
      }
    }
    if (candidatesById.size >= 8) break;
  }

  const wantMovie = type === 'movie';
  const scored = [];
  for (const rel of candidatesById.values()) {
    const relType = String(rel.type?.value || '').toUpperCase();
    if (wantMovie) {
      if (relType && relType !== 'MOVIE') continue;
    } else {
      if (relType === 'MOVIE') continue;
    }
    const candTitles = [rel.name?.main, rel.name?.english, rel.name?.alternative].filter(Boolean);
    const score = computeTitleMatchScore(targetTitles, candTitles, year, rel.year);
    if (score >= 70) {
      scored.push({ rel, score });
    }
  }

  if (scored.length === 0) {
    const miss = { found: false, source: 'anilibria' };
    sourceCache.set(cacheKey, { ts: Date.now(), data: miss });
    return miss;
  }

  scored.sort((a, b) => (b.score - a.score) || ((Number(a.rel.year) || 9999) - (Number(b.rel.year) || 9999)));
  const best = scored[0].rel;

  let releaseQueue = [{ seasonNum: 1, releaseId: best.id }];
  if (!wantMovie) {
    const franchises = await fetchAniLibriaJson(`/api/v1/anime/franchises/release/${encodeURIComponent(String(best.id))}`);
    const frList = franchises?.[0]?.franchise_releases;
    if (Array.isArray(frList) && frList.length > 0) {
      const filtered = frList
        .filter(fr => {
          const t = String(fr.release?.type?.value || '').toUpperCase();
          return !t || t === 'TV' || t === 'ONA' || t === 'WEB';
        })
        .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
        .slice(0, 6);
      if (filtered.length > 0) {
        releaseQueue = filtered.map((fr, idx) => ({
          seasonNum: idx + 1,
          releaseId: fr.release?.id
        })).filter(x => x.releaseId);
      }
    }
  }

  const releaseDetails = await Promise.all(
    releaseQueue.map(async ({ seasonNum, releaseId }) => {
      const d = await fetchAniLibriaJson(`/api/v1/anime/releases/${encodeURIComponent(String(releaseId))}`);
      return { seasonNum, release: d };
    })
  );

  const seasonsMap = {};
  for (const { seasonNum, release } of releaseDetails) {
    if (!release || !Array.isArray(release.episodes) || release.episodes.length === 0) continue;
    const eps = release.episodes.map((ep, idx) => {
      const epNum = Number(ep.ordinal) || (idx + 1);
      const u1080 = cleanAniLibriaHlsUrl(ep.hls_1080);
      const u720 = cleanAniLibriaHlsUrl(ep.hls_720);
      const u480 = cleanAniLibriaHlsUrl(ep.hls_480);
      if (!u1080 && !u720 && !u480) return null;

      const params = new URLSearchParams();
      if (u1080) params.set('u1080', u1080);
      if (u720) params.set('u720', u720);
      if (u480) params.set('u480', u480);
      const masterUrl = `/api/source/anilibria/master.m3u8?${params.toString()}`;

      return {
        season: seasonNum,
        episode: epNum,
        title: ep.name ? `Серия ${epNum}: ${ep.name}` : `Серия ${epNum}`,
        duration: Math.max(1, Math.round((Number(ep.duration) || 1440) / 60)),
        streamType: 'hls',
        hlsUrl: masterUrl,
        rawHls: masterUrl,
        voices: ['AniLibria'],
        voiceTracks: [{ name: 'AniLibria', trackIndex: 0 }],
        subtitles: []
      };
    }).filter(Boolean);

    if (eps.length > 0) {
      eps.sort((a, b) => a.episode - b.episode);
      seasonsMap[seasonNum] = eps;
    }
  }

  if (Object.keys(seasonsMap).length === 0) {
    const miss = { found: false, source: 'anilibria' };
    sourceCache.set(cacheKey, { ts: Date.now(), data: miss });
    return miss;
  }

  const result = {
    found: true,
    source: 'anilibria',
    sourceTitle: best.name?.main || best.name?.english || title,
    isSeries: !wantMovie,
    voices: ['AniLibria'],
    qualities: ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD'],
    seasons: seasonsMap
  };
  sourceCache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

function isAllowedAniLibriaStreamUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:' && ANILIBRIA_HOST_RE.test(u.hostname);
  } catch (e) {
    return false;
  }
}

function handleAniLibriaMasterM3u8(req, res, parsedUrl) {
  const variants = [
    { key: 'u1080', bandwidth: 4500000, resolution: '1920x1080' },
    { key: 'u720', bandwidth: 2200000, resolution: '1280x720' },
    { key: 'u480', bandwidth: 1100000, resolution: '854x480' }
  ];

  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  let added = 0;
  for (const v of variants) {
    const raw = parsedUrl.searchParams.get(v.key) || '';
    if (!raw || !isAllowedAniLibriaStreamUrl(raw)) continue;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution}`);
    lines.push(`/api/hls-proxy?url=${encodeURIComponent(raw)}`);
    added++;
  }

  if (added === 0) {
    res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
    return res.end('No valid AniLibria stream URLs');
  }

  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  });
  return res.end(lines.join('\n'));
}

async function getLiveKinogoAllohaConfig() {
  if (kinogoConfigCache.ts && (Date.now() - kinogoConfigCache.ts) < 6 * 60 * 60 * 1000) {
    return kinogoConfigCache;
  }
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 4000);
    const r = await fetch('https://kinogo.bot/10152-interstellar-2014.html', {
      headers: { 'User-Agent': UPSTREAM_UA },
      signal: c.signal
    });
    clearTimeout(t);
    if (r.ok) {
      const html = await r.text();
      const m = html.match(/(https:\/\/[a-z0-9.-]+)\/\?token_movie=[a-f0-9]+&token=([a-f0-9]+)/i);
      if (m) {
        kinogoConfigCache = { ts: Date.now(), origin: m[1], token: m[2] };
        return kinogoConfigCache;
      }
    }
  } catch (e) {}
  kinogoConfigCache = { ...kinogoConfigCache, ts: Date.now() };
  return kinogoConfigCache;
}

async function resolveKinogoSource({ imdbId = '', kpId = '', title = '', year = 0, season = '', episode = '', type = 'movie' }) {
  const sNum = Number(season) || 0;
  const eNum = Number(episode) || 0;
  const isEpisodic = type === 'series' || type === 'anime' || type === 'cartoon';
  const epQuery = (isEpisodic && sNum > 0 && eNum > 0) ? `&season=${sNum}&episode=${eNum}` : '';
  const hlsCacheKey = `kinogo:hls:${imdbId}:${kpId}:${normalizeTitlePlain(title)}:${type}`;
  const cachedHls = sourceCache.get(hlsCacheKey);
  if (cachedHls && (Date.now() - cachedHls.ts) < SOURCE_CACHE_TTL_MS && cachedHls.data?.found) {
    return cachedHls.data;
  }

  const qualities = ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD', '360p'];

  // Step A: Primary — Kinogo Player 1 Direct HLS (api.embf.net, 0% VAST video ads)
  const embfPaths = [];
  if (imdbId) embfPaths.push(`/embed/imdb/${encodeURIComponent(imdbId)}`);
  if (kpId) embfPaths.push(`/embed/kp/${encodeURIComponent(kpId)}`);

  for (const p of embfPaths) {
    const parsed = await fetchMakePlayerStream(`https://api.embf.net${p}`, { 'Referer': 'https://kinogo.bot/' });
    if (parsed && parsed.found && parsed.seasons) {
      const result = {
        found: true,
        source: 'kinogo',
        mode: 'hls',
        isSeries: parsed.isSeries,
        embedUrl: parsed.embedUrl,
        seasons: parsed.seasons,
        voices: parsed.voices,
        qualities
      };
      sourceCache.set(hlsCacheKey, { ts: Date.now(), data: result });
      return result;
    }
  }

  // Step B: Search kinogo.bot page -> extract Player 1 Direct HLS (api.embf.net/embed/...) or capture backup Player 2 Alloha iframe
  let backupAllohaIframe = '';
  let backupLabel = title;
  if (title) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 6000);
      const sr = await fetch('https://kinogo.bot/index.php?do=search', {
        method: 'POST',
        headers: {
          'User-Agent': UPSTREAM_UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://kinogo.bot/'
        },
        body: `do=search&subaction=search&search_start=0&full_search=0&result_from=1&story=${encodeURIComponent(title)}`,
        signal: c.signal
      });
      clearTimeout(t);
      if (sr.ok) {
        const sHtml = await sr.text();
        const links = [...sHtml.matchAll(/<a[^>]+href="(https:\/\/kinogo\.bot\/\d+-[^"]+\.html)"[^>]*>([^<]{2,100})<\/a>/gi)];
        const byUrl = new Map();
        for (const m of links) {
          const url = m[1];
          const label = m[2].replace(/\s+/g, ' ').trim();
          if (/смотреть онлайн/i.test(label)) continue;
          const yrMatch = label.match(/\((\d{4})\)/);
          const candYear = yrMatch ? Number(yrMatch[1]) : 0;
          const score = computeTitleMatchScore([title], [label.replace(/\(\d{4}\)/g, '').trim()], year, candYear);
          if (score >= 65) {
            const prev = byUrl.get(url);
            if (!prev || score > prev.score) byUrl.set(url, { url, label, score });
          }
        }
        const bestPage = [...byUrl.values()].sort((a, b) => b.score - a.score)[0];
        if (bestPage) {
          backupLabel = bestPage.label;
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), 5500);
          const pr = await fetch(bestPage.url, {
            headers: { 'User-Agent': UPSTREAM_UA, 'Referer': 'https://kinogo.bot/' },
            signal: c2.signal
          });
          clearTimeout(t2);
          if (pr.ok) {
            const pHtml = await pr.text();
            const embfMatch = pHtml.match(/<iframe[^>]+(?:src|data-src)="((?:https?:)?\/\/api\.embf\.net\/embed\/[^"]+)"/i);
            if (embfMatch) {
              const embfUrl = embfMatch[1].startsWith('//') ? `https:${embfMatch[1]}` : embfMatch[1];
              const parsed = await fetchMakePlayerStream(embfUrl, { 'Referer': 'https://kinogo.bot/' });
              if (parsed && parsed.found && parsed.seasons) {
                const result = {
                  found: true,
                  source: 'kinogo',
                  mode: 'hls',
                  isSeries: parsed.isSeries,
                  sourceTitle: bestPage.label,
                  embedUrl: embfUrl,
                  seasons: parsed.seasons,
                  voices: parsed.voices,
                  qualities
                };
                sourceCache.set(hlsCacheKey, { ts: Date.now(), data: result });
                return result;
              }
            }
            const allohaMatch = pHtml.match(/<iframe[^>]+(?:src|data-src)="(https:\/\/[^"]+\/\?token_movie=[^"]+)"/i);
            if (allohaMatch) backupAllohaIframe = allohaMatch[1];
          }
        }
      }
    } catch (e) {}
  }

  // Step C: Last-resort rare fallback — Kinogo Player 2 Alloha embed (if Player 1 Direct HLS was missing)
  const embedCacheKey = `kinogo:embed:${imdbId}:${kpId}:${normalizeTitlePlain(title)}:${epQuery}`;
  const cachedEmbed = sourceCache.get(embedCacheKey);
  if (cachedEmbed && (Date.now() - cachedEmbed.ts) < SOURCE_CACHE_TTL_MS) {
    return cachedEmbed.data;
  }

  const { origin, token } = await getLiveKinogoAllohaConfig();
  const idLookups = [];
  if (imdbId) idLookups.push(`imdb=${encodeURIComponent(imdbId)}`);
  if (kpId) idLookups.push(`kp=${encodeURIComponent(kpId)}`);

  for (const idParam of idLookups) {
    const probeUrl = `${origin}/?${idParam}&token=${encodeURIComponent(token)}${epQuery}`;
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 5500);
      const r = await fetch(probeUrl, {
        headers: { 'User-Agent': UPSTREAM_UA, 'Referer': 'https://kinogo.bot/' },
        signal: c.signal
      });
      clearTimeout(t);
      if (!r.ok) continue;
      const html = await r.text();
      if (!html.includes('const fileList = JSON.parse')) continue;

      let matchedTitle = title;
      const tm = html.match(/"title"\s*:\s*"([^"]+)"/);
      if (tm) {
        try { matchedTitle = JSON.parse(`"${tm[1]}"`); } catch (e) {}
      }

      const result = {
        found: true,
        source: 'kinogo',
        mode: 'embed',
        embedUrl: probeUrl,
        sourceTitle: matchedTitle,
        origin,
        hasAdsWarning: true
      };
      sourceCache.set(embedCacheKey, { ts: Date.now(), data: result });
      return result;
    } catch (e) {}
  }

  if (backupAllohaIframe) {
    const finalUrl = epQuery && !backupAllohaIframe.includes('season=')
      ? `${backupAllohaIframe}${backupAllohaIframe.includes('?') ? '&' : '?'}${epQuery.slice(1)}`
      : backupAllohaIframe;
    const result = {
      found: true,
      source: 'kinogo',
      mode: 'embed',
      embedUrl: finalUrl,
      sourceTitle: backupLabel,
      origin,
      hasAdsWarning: true
    };
    sourceCache.set(embedCacheKey, { ts: Date.now(), data: result });
    return result;
  }

  const miss = { found: false, source: 'kinogo' };
  sourceCache.set(embedCacheKey, { ts: Date.now(), data: miss });
  return miss;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ipk': 'application/octet-stream',
  '.sh': 'text/x-shellscript; charset=utf-8'
};

// --- Account & Cross-Device Progress Sync Storage ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SECRET_FILE = path.join(DATA_DIR, '.auth_secret');

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {}
}

const DATABASE_URL = process.env.DATABASE_URL || '';

function buildAuthSecrets() {
  const secrets = [];
  const addSecret = s => {
    const val = String(s || '').trim();
    if (val && !secrets.includes(val)) secrets.push(val);
  };

  if (process.env.AUTH_SECRET) {
    addSecret(process.env.AUTH_SECRET);
  } else if (DATABASE_URL) {
    addSecret(crypto.createHash('sha256').update('spbguka_jwt_v2_' + DATABASE_URL).digest('hex'));
  } else {
    const stableAnchor = process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_HOSTNAME || 'spbguka-cinema-persistent-salt-v2';
    addSecret(crypto.createHash('sha256').update(`${stableAnchor}::spbguka_hmac_v2`).digest('hex'));
  }

  // Compatibility with any previously persisted .auth_secret on disk
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const legacySaved = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (legacySaved.length >= 16) addSecret(legacySaved);
    }
  } catch (e) {}

  return secrets;
}

const AUTH_SECRETS = buildAuthSecrets();
let ACTIVE_AUTH_SECRET = AUTH_SECRETS[0];

function registerVerificationSecret(secret) {
  const val = String(secret || '').trim();
  if (val && !AUTH_SECRETS.includes(val)) AUTH_SECRETS.push(val);
}

function loadAccountsDb() {
  ensureDataDir();
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.users === 'object') return parsed;
    }
  } catch (e) {}
  return { users: {} };
}

const accountsDb = loadAccountsDb();
let accountsSaveTimer = null;

function flushAccountsToDisk() {
  ensureDataDir();
  try {
    const tmpPath = ACCOUNTS_FILE + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(accountsDb), 'utf8');
    fs.renameSync(tmpPath, ACCOUNTS_FILE);
  } catch (e) {
    console.error('Failed to save accounts:', e.message);
  }
}

function scheduleSaveAccounts(immediate = false) {
  if (immediate) {
    if (accountsSaveTimer) clearTimeout(accountsSaveTimer);
    accountsSaveTimer = null;
    flushAccountsToDisk();
    return;
  }
  if (accountsSaveTimer) return;
  accountsSaveTimer = setTimeout(() => {
    accountsSaveTimer = null;
    flushAccountsToDisk();
  }, 500);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const derived = crypto.scryptSync(String(password), salt, 64);
  const storedBuf = Buffer.from(hashHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function signAuthToken(usernameLower, displayUsername = '') {
  const payload = {
    u: usernameLower,
    n: displayUsername || usernameLower,
    exp: Date.now() + 365 * 24 * 60 * 60 * 1000
  };
  const body = toBase64Url(JSON.stringify(payload));
  const sig = toBase64Url(crypto.createHmac('sha256', ACTIVE_AUTH_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const sigBuf = Buffer.from(sig);
  let verified = false;
  for (const secret of AUTH_SECRETS) {
    const expectedSig = toBase64Url(crypto.createHmac('sha256', secret).update(body).digest());
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
      verified = true;
      break;
    }
  }
  if (!verified) return null;
  try {
    const payload = JSON.parse(fromBase64Url(body).toString('utf8'));
    if (!payload.u || !payload.exp || payload.exp < Date.now()) return null;
    return {
      usernameLower: payload.u,
      username: payload.n || payload.u,
      exp: payload.exp
    };
  } catch (e) {
    return null;
  }
}

function getAuthTokenFromReq(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  try {
    const qToken = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (qToken) return qToken.trim();
  } catch (e) {}
  const cookieHeader = req.headers['cookie'] || '';
  const match = cookieHeader.match(/(?:^|;\s*)spbguka_token=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  return '';
}

const pgPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

let dbInitPromise = null;
let dbReady = !pgPool;

async function initDatabase() {
  if (!pgPool) {
    dbReady = true;
    return true;
  }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS spbguka_users (
        username_lower TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        favorites_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS spbguka_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const cfgRes = await pgPool.query('SELECT value FROM spbguka_config WHERE key = $1', ['auth_secret']);
    if (cfgRes.rows.length > 0 && cfgRes.rows[0].value) {
      registerVerificationSecret(cfgRes.rows[0].value);
    } else {
      await pgPool.query(
        'INSERT INTO spbguka_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        ['auth_secret', ACTIVE_AUTH_SECRET]
      );
    }
    dbReady = true;
    console.log('PostgreSQL database ready (spbguka_users, spbguka_config)');
    return true;
  } catch (e) {
    console.error('PostgreSQL init error:', e.message);
    dbReady = false;
    return false;
  }
}

async function ensureDbReady() {
  if (!pgPool) return true;
  if (dbReady) return true;
  if (!dbInitPromise) {
    dbInitPromise = initDatabase().finally(() => { dbInitPromise = null; });
  }
  return await dbInitPromise;
}

async function withPgRetry(fn) {
  await ensureDbReady();
  try {
    return await fn();
  } catch (err) {
    await new Promise(r => setTimeout(r, 250));
    dbReady = false;
    await ensureDbReady();
    return await fn();
  }
}

async function findUserByKey(key) {
  if (pgPool) {
    return await withPgRetry(async () => {
      const r = await pgPool.query(
        'SELECT username_lower, username, password_hash, history_json, favorites_json, created_at, updated_at FROM spbguka_users WHERE username_lower = $1',
        [key]
      );
      if (r.rows.length === 0) return null;
      const row = r.rows[0];
      return {
        usernameLower: row.username_lower,
        username: row.username,
        passwordHash: row.password_hash,
        history: Array.isArray(row.history_json) ? row.history_json : [],
        favorites: Array.isArray(row.favorites_json) ? row.favorites_json : [],
        createdAt: Number(row.created_at) || Date.now(),
        updatedAt: Number(row.updated_at) || Date.now()
      };
    });
  }
  return accountsDb.users[key] || null;
}

async function createUserRecord(user) {
  if (pgPool) {
    return await withPgRetry(async () => {
      const r = await pgPool.query(
        `INSERT INTO spbguka_users (username_lower, username, password_hash, history_json, favorites_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
         ON CONFLICT (username_lower) DO NOTHING
         RETURNING username_lower`,
        [
          user.usernameLower,
          user.username,
          user.passwordHash,
          JSON.stringify(user.history || []),
          JSON.stringify(user.favorites || []),
          user.createdAt,
          user.updatedAt
        ]
      );
      return r.rows.length > 0;
    });
  }
  if (accountsDb.users[user.usernameLower]) return false;
  accountsDb.users[user.usernameLower] = user;
  scheduleSaveAccounts(true);
  return true;
}

async function saveUserProgress(user, immediate = false) {
  if (pgPool) {
    return await withPgRetry(async () => {
      await pgPool.query(
        'UPDATE spbguka_users SET history_json = $2::jsonb, favorites_json = $3::jsonb, updated_at = $4 WHERE username_lower = $1',
        [
          user.usernameLower,
          JSON.stringify(user.history || []),
          JSON.stringify(user.favorites || []),
          user.updatedAt
        ]
      );
    });
  }
  accountsDb.users[user.usernameLower] = user;
  scheduleSaveAccounts(immediate);
}

async function getAuthenticatedUser(req) {
  const token = getAuthTokenFromReq(req);
  const tokenData = verifyAuthToken(token);
  if (!tokenData) return { status: 'invalid' };
  try {
    let user = await findUserByKey(tokenData.usernameLower);
    if (!user && !pgPool) {
      // Ephemeral filesystem wipe recovery (e.g. Render Free sleep without Postgres):
      // token HMAC signature is valid, so restore the user shell seamlessly
      user = {
        username: tokenData.username || tokenData.usernameLower,
        usernameLower: tokenData.usernameLower,
        passwordHash: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: [],
        favorites: [],
        historyClearedAt: 0,
        deletedHistory: {},
        favoritesClearedAt: 0,
        ephemeralRecovered: true
      };
      accountsDb.users[tokenData.usernameLower] = user;
      scheduleSaveAccounts(true);
    }
    if (!user) return { status: 'invalid' };
    return { status: 'ok', user, tokenData };
  } catch (e) {
    return { status: 'db_error', error: e };
  }
}

async function requireAuth(req, res, invalidMessage = 'Требуется вход в аккаунт') {
  const auth = await getAuthenticatedUser(req);
  if (auth.status === 'ok') return auth.user;
  if (auth.status === 'db_error') {
    sendJson(res, 503, { error: 'База данных просыпается, повторите через секунду', code: 'DB_UNAVAILABLE' }, req);
    return null;
  }
  sendJson(res, 401, { error: invalidMessage, code: 'INVALID_TOKEN' }, req);
  return null;
}

// --- Live Daily 10:00 AM Catalog & Ratings Updater ---
const GENRE_RU_MAP = {
  Action: 'Боевик',
  Adventure: 'Приключения',
  Animation: 'Мультфильм',
  Comedy: 'Комедия',
  Crime: 'Криминал',
  Documentary: 'Документальный',
  Drama: 'Драма',
  Family: 'Семейный',
  Fantasy: 'Фэнтези',
  History: 'История',
  Horror: 'Ужасы',
  Mystery: 'Детектив',
  Romance: 'Мелодрама',
  'Sci-Fi': 'Фантастика',
  'Science Fiction': 'Фантастика',
  Thriller: 'Триллер',
  War: 'Военный',
  Western: 'Вестерн',
  Anime: 'Аниме'
};

const RU_TO_CINEMETA_GENRE = {
  'Боевик': 'Action',
  'Приключения': 'Adventure',
  'Мультфильм': 'Animation',
  'Мультфильмы': 'Animation',
  'Комедия': 'Comedy',
  'Криминал': 'Crime',
  'Документальный': 'Documentary',
  'Драма': 'Drama',
  'Семейный': 'Family',
  'Фэнтези': 'Fantasy',
  'История': 'History',
  'Ужасы': 'Horror',
  'Детектив': 'Mystery',
  'Мелодрама': 'Romance',
  'Фантастика': 'Sci-Fi',
  'Триллер': 'Thriller',
  'Военный': 'War',
  'Вестерн': 'Western',
  'Аниме': 'Animation'
};

let liveCatalog = SEED_CATALOG.map(x => ({
  ...x,
  isNew: Boolean(x.isNew || x.year >= new Date().getFullYear() - 2 || /2024|2025|2026/.test(String(x.yearRange || '')))
}));
let lastCatalogRefreshAt = Date.now();
const catalogMoreCache = new Map();
const CATALOG_MORE_TTL_MS = 6 * 3600 * 1000;

function parseReleaseYear(releaseInfo) {
  const match = String(releaseInfo || '').match(/(\d{4})/);
  return match ? Number(match[1]) : new Date().getFullYear();
}

function isLikelyAnimeMeta(meta) {
  const genres = Array.isArray(meta.genres) ? meta.genres : [];
  if (genres.includes('Anime')) return true;
  if (!genres.includes('Animation')) return false;
  const country = String(meta.country || '').trim();
  const titleAndDesc = `${meta.name || ''} ${meta.description || ''}`;
  if (/^\s*japan\b/i.test(country)) return true;
  if (/^\s*(united states|usa|united kingdom|uk|france|canada|australia|germany|spain|italy)\b/i.test(country)) {
    return /\b(anime|manga|shonen|isekai|crunchyroll|ghibli|mappa|ufotable|kyoto animation)\b/i.test(titleAndDesc);
  }
  const text = `${country} ${meta.language || ''} ${titleAndDesc}`;
  return /japan|japanese|anime|manga|tokyo|kyoto|crunchyroll|shonen|isekai/i.test(text);
}

async function fetchCinemetaCatalog(mediaType, catalogName = 'top', extra = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const parts = [];
    if (extra && extra.genre) parts.push(`genre=${encodeURIComponent(extra.genre)}`);
    if (extra && Number(extra.skip) > 0) parts.push(`skip=${Math.floor(Number(extra.skip))}`);
    const extraSegment = parts.length ? `/${parts.join('&')}` : '';
    const url = `https://v3-cinemeta.strem.io/catalog/${mediaType}/${catalogName}${extraSegment}.json`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.metas) ? json.metas : [];
  } catch (e) {
    return [];
  }
}

function cinemetaMetaToItem(m, newThreshold) {
  const imdbId = m.imdb_id || m.id;
  const kind = m._kind === 'series' ? 'series' : 'movie';
  const year = parseReleaseYear(m.releaseInfo);
  const parsedRating = parseFloat(m.imdbRating);
  const ratingImdb = (Number.isFinite(parsedRating) && parsedRating > 0) ? Number(parsedRating.toFixed(1)) : 7.4;
  const ratingKp = Number(Math.max(5.5, Math.min(9.5, ratingImdb - 0.1)).toFixed(1));
  const ruGenres = (Array.isArray(m.genres) ? m.genres : [])
    .map(g => GENRE_RU_MAP[g] || g)
    .filter(Boolean)
    .slice(0, 3);
  if (ruGenres.length === 0) ruGenres.push(kind === 'series' ? 'Драма' : 'Кино');

  const isAnim = (m.genres || []).includes('Animation');
  const isAnime = isLikelyAnimeMeta(m);
  const resolvedType = isAnime ? 'anime' : (isAnim ? 'cartoon' : kind);
  if (isAnime && !ruGenres.includes('Аниме')) {
    ruGenres.unshift('Аниме');
  }
  const isRecent = year >= newThreshold;

  const metahubPosterUrl = `https://images.metahub.space/poster/medium/${imdbId}/img`;
  const metahubBgUrl = `https://images.metahub.space/background/medium/${imdbId}/img`;

  return {
    id: imdbId,
    imdbId,
    kpId: '',
    title: m.name || imdbId,
    originalTitle: m.name || '',
    type: resolvedType,
    animeFormat: resolvedType === 'anime' ? (kind === 'movie' ? 'movie' : 'series') : undefined,
    year,
    yearRange: m.releaseInfo ? String(m.releaseInfo) : String(year),
    ratingKp,
    ratingImdb,
    country: isAnime ? 'Япония' : (m.country || 'США / Мир'),
    genres: ruGenres.slice(0, 4),
    duration: kind === 'series' ? '45 мин / серия' : '115 мин',
    director: Array.isArray(m.director) && m.director.length ? m.director.join(', ') : 'По данным IMDb',
    cast: Array.isArray(m.cast) && m.cast.length ? m.cast.slice(0, 5).join(', ') : 'В ролях',
    poster: m.poster || metahubPosterUrl,
    backdrop: m.background || m.poster || metahubBgUrl,
    isNew: isRecent,
    isPopular: true,
    seasonsCount: kind === 'series' ? 1 : undefined,
    episodesPerSeason: kind === 'series' ? [10] : undefined,
    voices: resolvedType === 'anime'
      ? ['AniLibria', 'Studio Band', 'AniDUB', 'HDrezka Studio', 'Японский + Субтитры']
      : (kind === 'series'
          ? ['HDrezka Studio', 'LostFilm', 'Red Head Sound', 'Кубик в кубе', 'Рус. Дублированный', 'Eng.Original']
          : ['Рус. Дублированный', 'Red Head Sound', 'HDrezka Studio', 'JASKIER', 'Eng.Original']),
    description: m.description || `Новинка ${year} года (${m.name}). Смотреть онлайн в HD 1080p без рекламы.`
  };
}

async function refreshLiveCatalog() {
  const currentYear = new Date().getFullYear();
  const newThreshold = currentYear - 2; // e.g., 2024-2026 in 2026

  try {
    const [movieTop, seriesTop, movieRated, seriesRated] = await Promise.all([
      fetchCinemetaCatalog('movie', 'top'),
      fetchCinemetaCatalog('series', 'top'),
      fetchCinemetaCatalog('movie', 'imdbRating'),
      fetchCinemetaCatalog('series', 'imdbRating')
    ]);
    const allMetas = [
      ...seriesTop.map(m => ({ ...m, _kind: 'series' })),
      ...movieTop.map(m => ({ ...m, _kind: 'movie' })),
      ...seriesRated.map(m => ({ ...m, _kind: 'series' })),
      ...movieRated.map(m => ({ ...m, _kind: 'movie' }))
    ];

    if (allMetas.length === 0) {
      lastCatalogRefreshAt = Date.now();
      return;
    }

    const liveRatingByImdb = new Map();
    for (const m of allMetas) {
      const imdbId = m.imdb_id || m.id;
      if (!imdbId || !String(imdbId).startsWith('tt')) continue;
      const parsedRating = parseFloat(m.imdbRating);
      if (Number.isFinite(parsedRating) && parsedRating > 0) {
        liveRatingByImdb.set(imdbId, {
          ratingImdb: Number(parsedRating.toFixed(1)),
          yearRange: m.releaseInfo ? String(m.releaseInfo) : ''
        });
      }
    }

    // Update live ratings on existing seed items
    const updatedSeed = SEED_CATALOG.map(item => {
      const liveMeta = liveRatingByImdb.get(item.imdbId);
      const refreshedRating = liveMeta ? liveMeta.ratingImdb : item.ratingImdb;
      const refreshedYearRange = (liveMeta && liveMeta.yearRange && liveMeta.yearRange.length >= 4)
        ? liveMeta.yearRange
        : item.yearRange;
      return {
        ...item,
        ratingImdb: refreshedRating,
        yearRange: refreshedYearRange,
        isNew: Boolean(item.isNew || item.year >= newThreshold || /2024|2025|2026/.test(String(refreshedYearRange || '')))
      };
    });

    const seedIds = new Set(updatedSeed.map(x => x.imdbId));
    const candidateNew = [];
    const seenNew = new Set();

    for (const m of allMetas) {
      const imdbId = m.imdb_id || m.id;
      if (!imdbId || !String(imdbId).startsWith('tt') || seedIds.has(imdbId) || seenNew.has(imdbId)) continue;
      seenNew.add(imdbId);

      const item = cinemetaMetaToItem(m, newThreshold);

      // Prioritize current new releases (2024-2026) and high-rated current hits
      if (!item.isNew && candidateNew.length >= 40) continue;

      candidateNew.push(item);

      if (candidateNew.length >= 70) break;
    }

    // Sort fresh releases first, then enrich Russian titles/KP IDs via Wikidata
    candidateNew.sort((a, b) => (b.year - a.year) || (b.ratingImdb - a.ratingImdb));
    const enrichedBatches = [];
    for (let i = 0; i < candidateNew.length; i += 12) {
      const batch = await enrichWithRussianMetadata(candidateNew.slice(i, i + 12));
      enrichedBatches.push(...batch);
    }

    liveCatalog = [...updatedSeed, ...enrichedBatches];
    detailsCache.clear();
    searchCache.clear();
    lastCatalogRefreshAt = Date.now();
    console.log(`Catalog refreshed: ${liveCatalog.length} items (${liveCatalog.filter(x => x.isNew).length} new ${newThreshold}-${currentYear} releases, ${liveCatalog.filter(x => x.type === 'anime').length} anime)`);
  } catch (e) {
    console.error('Catalog refresh failed:', e.message);
  }
}

async function handleCatalogMore(params = {}) {
  const category = String(params.category || 'all').trim() || 'all';
  const animeSub = String(params.animeSub || 'all').trim() || 'all';
  const genre = String(params.genre || 'all').trim() || 'all';
  const year = String(params.year || 'all').trim() || 'all';
  const sort = String(params.sort || 'popular').trim() || 'popular';
  const page = Math.max(1, Math.min(20, parseInt(params.page, 10) || 1));

  const cacheKey = `${category}|${animeSub}|${genre}|${year}|${sort}|${page}`;
  const cached = catalogMoreCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CATALOG_MORE_TTL_MS) {
    return cached.data;
  }

  const currentYear = new Date().getFullYear();
  const newThreshold = currentYear - 2;
  const cmGenre = genre !== 'all' ? (RU_TO_CINEMETA_GENRE[genre] || '') : '';
  const catName = sort === 'rating' ? 'imdbRating' : 'top';

  const fetches = [];
  let rawMetas = [];

  if (category === 'anime') {
    const skip = (page - 1) * 50;
    if (animeSub === 'movie') {
      fetches.push(
        fetchCinemetaCatalog('movie', 'top', { genre: 'Animation', skip }).then(ms => ms.map(m => ({ ...m, _kind: 'movie' }))),
        fetchCinemetaCatalog('movie', 'imdbRating', { genre: 'Animation', skip }).then(ms => ms.map(m => ({ ...m, _kind: 'movie' })))
      );
    } else if (animeSub === 'series') {
      fetches.push(
        fetchCinemetaCatalog('series', 'top', { genre: 'Animation', skip }).then(ms => ms.map(m => ({ ...m, _kind: 'series' }))),
        fetchCinemetaCatalog('series', 'imdbRating', { genre: 'Animation', skip }).then(ms => ms.map(m => ({ ...m, _kind: 'series' })))
      );
    } else if (animeSub === 'top') {
      fetches.push(
        fetchCinemetaCatalog('series', 'imdbRating', { genre: 'Animation', skip }).then(ms => ms.map(m => ({ ...m, _kind: 'series' }))),
        fetchCinemetaCatalog('series', 'top', { genre: 'Animation', skip: skip + 50 }).then(ms => ms.map(m => ({ ...m, _kind: 'series' }))),
        fetchCinemetaCatalog('movie', 'imdbRating', { genre: 'Animation', skip }).then(ms => ms.map(m => ({ ...m, _kind: 'movie' })))
      );
    } else {
      fetches.push(
        fetchCinemetaCatalog('series', 'top', { genre: 'Animation', skip }).then(ms => ms.map(m => ({ ...m, _kind: 'series' }))),
        fetchCinemetaCatalog('movie', 'top', { genre: 'Animation', skip }).then(ms => ms.map(m => ({ ...m, _kind: 'movie' })))
      );
    }
    const groups = await Promise.all(fetches);
    rawMetas = groups.flat().filter(m => isLikelyAnimeMeta(m));
  } else if (category === 'cartoon') {
    const skip = (page - 1) * 50;
    const [mv, sv] = await Promise.all([
      fetchCinemetaCatalog('movie', 'top', { genre: 'Animation', skip }).then(ms => ms.map(m => ({ ...m, _kind: 'movie' }))),
      fetchCinemetaCatalog('series', 'top', { genre: 'Animation', skip }).then(ms => ms.map(m => ({ ...m, _kind: 'series' })))
    ]);
    rawMetas = [...mv, ...sv].filter(m => !isLikelyAnimeMeta(m));
  } else if (category === 'movie') {
    const skip = cmGenre ? (page - 1) * 50 : page * 50;
    const mv = await fetchCinemetaCatalog('movie', catName, { genre: cmGenre || undefined, skip });
    rawMetas = mv.map(m => ({ ...m, _kind: 'movie' }));
  } else if (category === 'series') {
    const skip = cmGenre ? (page - 1) * 50 : page * 50;
    const sv = await fetchCinemetaCatalog('series', catName, { genre: cmGenre || undefined, skip });
    rawMetas = sv.map(m => ({ ...m, _kind: 'series' }));
  } else if (category === 'new') {
    const targetYear = String(currentYear - (Math.floor((page - 1) / 2) % 3));
    const yearSkip = ((page - 1) % 2) * 50;
    const [mv, sv] = await Promise.all([
      fetchCinemetaCatalog('movie', 'year', { genre: targetYear, skip: yearSkip }).then(ms => ms.map(m => ({ ...m, _kind: 'movie' }))),
      fetchCinemetaCatalog('series', 'year', { genre: targetYear, skip: yearSkip }).then(ms => ms.map(m => ({ ...m, _kind: 'series' })))
    ]);
    rawMetas = [...mv, ...sv];
  } else {
    const skip = cmGenre ? (page - 1) * 50 : page * 50;
    const [mv, sv] = await Promise.all([
      fetchCinemetaCatalog('movie', catName, { genre: cmGenre || undefined, skip }).then(ms => ms.map(m => ({ ...m, _kind: 'movie' }))),
      fetchCinemetaCatalog('series', catName, { genre: cmGenre || undefined, skip }).then(ms => ms.map(m => ({ ...m, _kind: 'series' })))
    ]);
    rawMetas = [...mv, ...sv];
  }

  const seen = new Set();
  const candidates = [];
  for (const m of rawMetas) {
    const imdbId = m.imdb_id || m.id;
    if (!imdbId || !String(imdbId).startsWith('tt') || seen.has(imdbId)) continue;
    seen.add(imdbId);
    const item = cinemetaMetaToItem(m, newThreshold);

    if (genre !== 'all') {
      const gLower = genre.toLowerCase();
      if (!(item.genres || []).some(g => g.toLowerCase() === gLower)) continue;
    }
    if (year === '2024-2026' && item.year < 2024) continue;
    else if (year === '2020-2023' && (item.year < 2020 || item.year > 2023)) continue;
    else if (year === '2010-2019' && (item.year < 2010 || item.year > 2019)) continue;
    else if (year === 'old' && item.year >= 2010) continue;

    candidates.push(item);
  }

  let selected = candidates;
  if (category === 'anime' && animeSub === 'new') {
    const recent = candidates.filter(x => x.isNew || x.year >= newThreshold);
    const older = candidates.filter(x => !x.isNew && x.year < newThreshold);
    selected = recent.length >= 8 ? recent : [...recent, ...older];
  } else if (sort === 'rating' || (category === 'anime' && animeSub === 'top')) {
    selected.sort((a, b) => (b.ratingImdb || 0) - (a.ratingImdb || 0));
  } else if (sort === 'year' || category === 'new') {
    selected.sort((a, b) => (b.year - a.year) || ((b.ratingImdb || 0) - (a.ratingImdb || 0)));
  }

  const slice = selected.slice(0, 36);
  const batchPromises = [];
  for (let i = 0; i < slice.length; i += 12) {
    batchPromises.push(enrichWithRussianMetadata(slice.slice(i, i + 12)));
  }
  const enrichedGroups = await Promise.all(batchPromises);
  const items = enrichedGroups.flat();

  if (items.length > 0) {
    const existingIds = new Set(liveCatalog.map(x => x.imdbId));
    for (const it of items) {
      if (!existingIds.has(it.imdbId)) {
        existingIds.add(it.imdbId);
        liveCatalog.push(it);
      }
    }
    if (liveCatalog.length > 1500) {
      liveCatalog = liveCatalog.slice(0, 1500);
    }
  }

  const result = { items, page, hasMore: rawMetas.length > 0 && page < 20 };
  if (items.length > 0) {
    catalogMoreCache.set(cacheKey, { ts: Date.now(), data: result });
  }
  return result;
}

function getMsUntilNext10Am(tzOffsetHours = 5) {
  const offsetMs = tzOffsetHours * 3600 * 1000;
  const nowLocal = new Date(Date.now() + offsetMs);
  const targetLocal = new Date(nowLocal.getTime());
  targetLocal.setUTCHours(10, 0, 0, 0);
  if (targetLocal.getTime() <= nowLocal.getTime()) {
    targetLocal.setUTCDate(targetLocal.getUTCDate() + 1);
  }
  return targetLocal.getTime() - nowLocal.getTime();
}

function scheduleDaily10AmRefresh() {
  const tzOffset = Number(process.env.CATALOG_REFRESH_TZ_OFFSET_HOURS ?? 5);
  const waitMs = getMsUntilNext10Am(tzOffset);
  setTimeout(async () => {
    await refreshLiveCatalog();
    scheduleDaily10AmRefresh();
  }, waitMs);
}

function readJsonBody(req, maxBytes = 1024 * 512) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const SEED_KP_BY_IMDB = new Map(SEED_CATALOG.map(x => [x.imdbId, x.kpId ? String(x.kpId) : '']));

function resolveCanonicalIds(rawId, rawImdbId, rawKpId, rawTitle = '') {
  let imdbId = String(rawImdbId || rawId || '').trim();
  let id = String(rawId || imdbId || '').trim();
  if (imdbId === 'tt1321510' && /джентльмен|gentlemen/i.test(String(rawTitle || ''))) {
    imdbId = 'tt13210838';
    if (id === 'tt1321510') id = 'tt13210838';
  }
  const kpId = SEED_KP_BY_IMDB.has(imdbId)
    ? SEED_KP_BY_IMDB.get(imdbId)
    : (rawKpId ? String(rawKpId).slice(0, 32) : '');
  return { id, imdbId, kpId };
}

function sanitizeHistoryList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(x => x && typeof x === 'object' && (x.imdbId || x.id))
    .slice(0, 60)
    .map(x => {
      const ids = resolveCanonicalIds(x.id, x.imdbId, x.kpId, x.title);
      return {
        id: ids.id || ids.imdbId,
        imdbId: ids.imdbId,
        kpId: ids.kpId,
        title: String(x.title || 'Без названия').slice(0, 160),
      originalTitle: String(x.originalTitle || '').slice(0, 160),
      type: String(x.type || 'movie'),
      year: Number(x.year) || 2024,
      yearRange: x.yearRange ? String(x.yearRange) : '',
      ratingKp: x.ratingKp ?? null,
      ratingImdb: x.ratingImdb ?? null,
      poster: String(x.poster || '').slice(0, 500),
      backdrop: String(x.backdrop || '').slice(0, 500),
      genres: Array.isArray(x.genres) ? x.genres.slice(0, 5) : ['Кино'],
      voices: Array.isArray(x.voices) ? x.voices.slice(0, 12) : ['Рус. Дублированный'],
      description: String(x.description || '').slice(0, 800),
      season: Number(x.season) || 1,
      episode: Number(x.episode) || 1,
      voice: String(x.voice || 'Рус. Дублированный').slice(0, 80),
      quality: String(x.quality || 'Авто (Макс. 1080p)').slice(0, 50),
      currentTime: Math.max(0, Math.floor(Number(x.currentTime) || 0)),
      durationSeconds: Math.max(0, Math.floor(Number(x.durationSeconds) || 0)),
      updatedAt: Number(x.updatedAt) || Date.now()
      };
    });
}

function mergeHistoryLists(serverList = [], clientList = [], deletionMeta = null) {
  const clearedAt = Number(deletionMeta?.historyClearedAt) || 0;
  const deletedMap = (deletionMeta?.deletedHistory && typeof deletionMeta.deletedHistory === 'object')
    ? deletionMeta.deletedHistory
    : null;
  const byId = new Map();
  for (const item of sanitizeHistoryList(serverList)) {
    byId.set(item.imdbId, item);
  }
  for (const item of sanitizeHistoryList(clientList)) {
    const itemDelAt = Math.max(clearedAt, Number(deletedMap?.[item.imdbId]) || 0);
    if (itemDelAt > 0 && (item.updatedAt || 0) <= itemDelAt) {
      continue;
    }
    if (deletedMap && deletedMap[item.imdbId] && (item.updatedAt || 0) > Number(deletedMap[item.imdbId])) {
      delete deletedMap[item.imdbId];
    }
    const existing = byId.get(item.imdbId);
    if (!existing || (item.updatedAt || 0) >= (existing.updatedAt || 0)) {
      byId.set(item.imdbId, item);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 40);
}

function sanitizeFavoritesList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x || typeof x !== 'object' || !(x.imdbId || x.id)) continue;
    const imdbId = String(x.imdbId || x.id);
    const ids = resolveCanonicalIds(x.id, imdbId, x.kpId, x.title);
    if (seen.has(ids.imdbId)) continue;
    seen.add(ids.imdbId);
    out.push({
      id: ids.id || ids.imdbId,
      imdbId: ids.imdbId,
      kpId: ids.kpId,
      title: String(x.title || 'Без названия').slice(0, 160),
      originalTitle: String(x.originalTitle || '').slice(0, 160),
      type: String(x.type || 'movie'),
      year: Number(x.year) || 2024,
      yearRange: x.yearRange ? String(x.yearRange) : '',
      ratingKp: x.ratingKp ?? null,
      ratingImdb: x.ratingImdb ?? null,
      poster: String(x.poster || '').slice(0, 500),
      backdrop: String(x.backdrop || '').slice(0, 500),
      genres: Array.isArray(x.genres) ? x.genres.slice(0, 5) : ['Кино'],
      voices: Array.isArray(x.voices) ? x.voices.slice(0, 12) : ['Рус. Дублированный'],
      description: String(x.description || '').slice(0, 800)
    });
    if (out.length >= 80) break;
  }
  return out;
}

function mergeFavoritesLists(serverList = [], clientList = []) {
  return sanitizeFavoritesList([...(clientList || []), ...(serverList || [])]);
}

function publicUserPayload(user) {
  return {
    username: user.username,
    history: user.history || [],
    favorites: user.favorites || [],
    updatedAt: user.updatedAt || Date.now(),
    historyClearedAt: Number(user.historyClearedAt) || 0,
    favoritesClearedAt: Number(user.favoritesClearedAt) || 0,
    ephemeralRecovered: Boolean(user.ephemeralRecovered),
    storage: pgPool ? 'postgres' : 'local-file'
  };
}

function setAuthCookie(req, res, token) {
  const maxAge = 365 * 24 * 60 * 60;
  const isHttps = req?.headers?.['x-forwarded-proto'] === 'https' || Boolean(req?.socket?.encrypted);
  res.setHeader(
    'Set-Cookie',
    `spbguka_token=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`
  );
}

// --- Watch Party / Lobby System (Max 20 Participants, Host Sync, Optional Chat, Live Server Presence) ---
const MAX_LOBBY_PARTICIPANTS = 20;
const MAX_LOBBY_CHAT_MESSAGES = 80;
const PRESENCE_TTL_MS = 35000;

const onlineUsers = new Map(); // usernameLower -> { username, usernameLower, lastSeenAt, lobbyId, sseClients: Set }
const lobbies = new Map(); // lobbyId -> Lobby
const pendingInvitesByUser = new Map(); // targetLower -> Map<lobbyId, { lobbyId, lobbyName, fromUsername, createdAt }>
let presenceBroadcastTimer = null;

function generateLobbyCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 16; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length];
    if (!lobbies.has(code)) return code;
  }
  return `L${Date.now().toString(36).toUpperCase().slice(-5)}`;
}

function getOrCreateOnlineEntry(user) {
  const key = user.usernameLower;
  let entry = onlineUsers.get(key);
  if (!entry) {
    entry = {
      username: user.username,
      usernameLower: key,
      lastSeenAt: Date.now(),
      lobbyId: '',
      sseClients: new Set()
    };
    onlineUsers.set(key, entry);
  }
  entry.username = user.username;
  entry.lastSeenAt = Date.now();
  return entry;
}

function touchUserPresence(user) {
  if (!user || !user.usernameLower) return null;
  return getOrCreateOnlineEntry(user);
}

function isUserOnline(usernameLower) {
  const entry = onlineUsers.get(usernameLower);
  if (!entry) return false;
  if (entry.sseClients.size > 0) return true;
  return (Date.now() - entry.lastSeenAt) < PRESENCE_TTL_MS;
}

function getUserLobby(usernameLower) {
  const entry = onlineUsers.get(usernameLower);
  if (entry && entry.lobbyId && lobbies.has(entry.lobbyId)) {
    const lobby = lobbies.get(entry.lobbyId);
    if (lobby.members.has(usernameLower)) return lobby;
  }
  for (const lobby of lobbies.values()) {
    if (lobby.members.has(usernameLower)) {
      if (entry) entry.lobbyId = lobby.id;
      return lobby;
    }
  }
  if (entry) entry.lobbyId = '';
  return null;
}

function sendSseEvent(res, eventName, payload) {
  try {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (e) {
    return false;
  }
}

function sendSseToUser(usernameLower, eventName, payload) {
  const entry = onlineUsers.get(usernameLower);
  if (!entry || entry.sseClients.size === 0) return;
  for (const clientRes of [...entry.sseClients]) {
    if (!sendSseEvent(clientRes, eventName, payload)) {
      entry.sseClients.delete(clientRes);
    }
  }
}

function broadcastToLobby(lobby, eventName, payloadFactory, excludeLower = '') {
  if (!lobby) return;
  for (const memberLower of lobby.members.keys()) {
    if (excludeLower && memberLower === excludeLower) continue;
    const payload = typeof payloadFactory === 'function' ? payloadFactory(memberLower) : payloadFactory;
    sendSseToUser(memberLower, eventName, payload);
  }
}

function schedulePresenceBroadcast() {
  if (presenceBroadcastTimer) return;
  presenceBroadcastTimer = setTimeout(() => {
    presenceBroadcastTimer = null;
    const onlineCount = Array.from(onlineUsers.keys()).filter(isUserOnline).length;
    for (const [k, entry] of onlineUsers.entries()) {
      if (entry.sseClients.size === 0) continue;
      sendSseToUser(k, 'presence_pulse', { onlineCount, serverNow: Date.now() });
    }
  }, 900);
}

function sanitizeLobbyMediaItem(raw) {
  if (!raw || typeof raw !== 'object' || !(raw.imdbId || raw.id)) return null;
  const ids = resolveCanonicalIds(raw.id, raw.imdbId, raw.kpId, raw.title);
  return {
    id: ids.imdbId.slice(0, 64),
    imdbId: ids.imdbId.slice(0, 64),
    kpId: ids.kpId,
    title: String(raw.title || 'Без названия').slice(0, 160),
    originalTitle: String(raw.originalTitle || '').slice(0, 160),
    type: String(raw.type || 'movie').slice(0, 20),
    year: Number(raw.year) || 2024,
    yearRange: raw.yearRange ? String(raw.yearRange).slice(0, 32) : '',
    ratingKp: raw.ratingKp ?? null,
    ratingImdb: raw.ratingImdb ?? null,
    poster: String(raw.poster || '').slice(0, 500),
    backdrop: String(raw.backdrop || '').slice(0, 500),
    genres: Array.isArray(raw.genres) ? raw.genres.slice(0, 5).map(String) : ['Кино'],
    voices: Array.isArray(raw.voices) ? raw.voices.slice(0, 15).map(String) : ['Рус. Дублированный'],
    description: String(raw.description || '').slice(0, 800)
  };
}

function serializeLobbyForUser(lobby, viewerLower) {
  if (!lobby) return null;
  const members = Array.from(lobby.members.values()).map(m => ({
    username: m.username,
    isHost: m.usernameLower === lobby.hostLower,
    online: isUserOnline(m.usernameLower),
    joinedAt: m.joinedAt
  }));
  members.sort((a, b) => (Number(b.isHost) - Number(a.isHost)) || (Number(b.online) - Number(a.online)) || (a.joinedAt - b.joinedAt));

  return {
    id: lobby.id,
    name: lobby.name,
    hostUsername: lobby.hostUsername,
    isHost: lobby.hostLower === viewerLower,
    maxParticipants: MAX_LOBBY_PARTICIPANTS,
    memberCount: lobby.members.size,
    createdAt: lobby.createdAt,
    members,
    playback: lobby.playback,
    messages: lobby.messages.slice(-MAX_LOBBY_CHAT_MESSAGES),
    serverNow: Date.now()
  };
}

function getPendingInvitesForUser(usernameLower) {
  const map = pendingInvitesByUser.get(usernameLower);
  if (!map || map.size === 0) return [];
  const out = [];
  for (const [lobbyId, inv] of map.entries()) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) {
      map.delete(lobbyId);
      continue;
    }
    out.push({
      lobbyId,
      lobbyName: lobby.name,
      fromUsername: inv.fromUsername,
      memberCount: lobby.members.size,
      maxParticipants: MAX_LOBBY_PARTICIPANTS,
      createdAt: inv.createdAt
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function cleanupInvitesForLobby(lobbyId) {
  for (const [targetLower, map] of pendingInvitesByUser.entries()) {
    if (map.delete(lobbyId)) {
      if (map.size === 0) pendingInvitesByUser.delete(targetLower);
      sendSseToUser(targetLower, 'invites_update', { invites: getPendingInvitesForUser(targetLower) });
    }
  }
}

function appendLobbyMessage(lobby, msg) {
  lobby.messages.push(msg);
  if (lobby.messages.length > MAX_LOBBY_CHAT_MESSAGES) {
    lobby.messages = lobby.messages.slice(-MAX_LOBBY_CHAT_MESSAGES);
  }
  broadcastToLobby(lobby, 'chat_message', { lobbyId: lobby.id, message: msg });
}

function closeLobbyRoom(lobby, reason = 'Главный закрыл лобби') {
  if (!lobby || !lobbies.has(lobby.id)) return;
  const memberKeys = Array.from(lobby.members.keys());
  lobbies.delete(lobby.id);
  for (const mKey of memberKeys) {
    const entry = onlineUsers.get(mKey);
    if (entry && entry.lobbyId === lobby.id) entry.lobbyId = '';
    sendSseToUser(mKey, 'lobby_closed', { lobbyId: lobby.id, reason });
  }
  cleanupInvitesForLobby(lobby.id);
  schedulePresenceBroadcast();
}

function removeMemberFromLobby(lobby, memberLower, reasonText = '') {
  if (!lobby || !lobby.members.has(memberLower)) return;
  const removed = lobby.members.get(memberLower);
  lobby.members.delete(memberLower);
  const onlineEntry = onlineUsers.get(memberLower);
  if (onlineEntry && onlineEntry.lobbyId === lobby.id) onlineEntry.lobbyId = '';

  if (lobby.members.size === 0) {
    lobbies.delete(lobby.id);
    cleanupInvitesForLobby(lobby.id);
    schedulePresenceBroadcast();
    return;
  }

  let newHostNote = '';
  if (lobby.hostLower === memberLower) {
    const remaining = Array.from(lobby.members.values());
    remaining.sort((a, b) => (Number(isUserOnline(b.usernameLower)) - Number(isUserOnline(a.usernameLower))) || (a.joinedAt - b.joinedAt));
    const nextHost = remaining[0];
    lobby.hostLower = nextHost.usernameLower;
    lobby.hostUsername = nextHost.username;
    newHostNote = ` • Новый главный: ${nextHost.username}`;
  }

  appendLobbyMessage(lobby, {
    id: crypto.randomBytes(6).toString('hex'),
    type: 'system',
    username: 'Система',
    text: `${removed.username} ${reasonText || 'вышел из лобби'}${newHostNote}`,
    ts: Date.now()
  });

  broadcastToLobby(lobby, 'lobby_update', viewerLower => ({
    lobby: serializeLobbyForUser(lobby, viewerLower)
  }));
  schedulePresenceBroadcast();
}

async function listKnownUsers(query = '', limit = 30, viewerLower = '') {
  const qLower = String(query || '').trim().toLowerCase();
  const byKey = new Map();

  for (const [k, entry] of onlineUsers.entries()) {
    if (!isUserOnline(k)) continue;
    if (qLower && !k.includes(qLower) && !entry.username.toLowerCase().includes(qLower)) continue;
    byKey.set(k, {
      username: entry.username,
      usernameLower: k,
      online: true,
      lobbyId: entry.lobbyId || ''
    });
  }

  try {
    if (pgPool) {
      const r = qLower
        ? await pgPool.query(
            'SELECT username, username_lower FROM spbguka_users WHERE username_lower LIKE $1 ORDER BY updated_at DESC LIMIT $2',
            [`%${qLower}%`, limit]
          )
        : await pgPool.query(
            'SELECT username, username_lower FROM spbguka_users ORDER BY updated_at DESC LIMIT $1',
            [limit]
          );
      for (const row of r.rows) {
        if (!byKey.has(row.username_lower)) {
          const onlineEntry = onlineUsers.get(row.username_lower);
          byKey.set(row.username_lower, {
            username: row.username,
            usernameLower: row.username_lower,
            online: isUserOnline(row.username_lower),
            lobbyId: onlineEntry?.lobbyId || ''
          });
        }
      }
    } else {
      const entries = Object.values(accountsDb.users || {});
      for (const u of entries) {
        if (qLower && !u.usernameLower.includes(qLower) && !u.username.toLowerCase().includes(qLower)) continue;
        if (!byKey.has(u.usernameLower)) {
          const onlineEntry = onlineUsers.get(u.usernameLower);
          byKey.set(u.usernameLower, {
            username: u.username,
            usernameLower: u.usernameLower,
            online: isUserOnline(u.usernameLower),
            lobbyId: onlineEntry?.lobbyId || ''
          });
        }
      }
    }
  } catch (e) {}

  return Array.from(byKey.values())
    .filter(u => u.usernameLower !== viewerLower)
    .sort((a, b) => (Number(b.online) - Number(a.online)) || a.username.localeCompare(b.username, 'ru'))
    .slice(0, limit);
}

// Periodically prune stale offline presence entries
setInterval(() => {
  const now = Date.now();
  for (const [k, entry] of onlineUsers.entries()) {
    if (entry.sseClients.size === 0 && (now - entry.lastSeenAt) > PRESENCE_TTL_MS * 2) {
      onlineUsers.delete(k);
    }
  }
}, 30000);

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'spbguka',
      db: pgPool ? 'postgres' : 'local-file',
      catalogCount: liveCatalog.length,
      lastCatalogRefreshAt
    });
  }

  // --- Auth & Account Sync Routes ---
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const rawUsername = String(body.username || '').trim();
      const password = String(body.password || '');
      if (rawUsername.length < 2 || rawUsername.length > 32) {
        return sendJson(res, 400, { error: 'Никнейм должен быть от 2 до 32 символов' }, req);
      }
      if (password.length < 4 || password.length > 100) {
        return sendJson(res, 400, { error: 'Пароль должен быть не короче 4 символов' }, req);
      }
      const key = rawUsername.toLowerCase();
      const existing = await findUserByKey(key);
      if (existing) {
        return sendJson(res, 409, { error: 'Этот никнейм уже занят. Выберите другой или войдите.' }, req);
      }
      const now = Date.now();
      const user = {
        username: rawUsername,
        usernameLower: key,
        passwordHash: hashPassword(password),
        createdAt: now,
        updatedAt: now,
        history: sanitizeHistoryList(body.history || []),
        favorites: sanitizeFavoritesList(body.favorites || [])
      };
      const created = await createUserRecord(user);
      if (!created) {
        return sendJson(res, 409, { error: 'Этот никнейм уже занят. Выберите другой или войдите.' }, req);
      }
      const token = signAuthToken(key, user.username);
      setAuthCookie(req, res, token);
      return sendJson(res, 201, { token, user: publicUserPayload(user), db: pgPool ? 'postgres' : 'local-file' }, req);
    } catch (e) {
      return sendJson(res, 500, { error: 'Ошибка базы данных при регистрации', code: 'DB_UNAVAILABLE' }, req);
    }
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const rawUsername = String(body.username || '').trim();
      const password = String(body.password || '');
      const key = rawUsername.toLowerCase();
      const user = await findUserByKey(key);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return sendJson(res, 401, { error: 'Неверный никнейм или пароль' }, req);
      }
      if (Array.isArray(body.history) && body.history.length > 0) {
        user.history = mergeHistoryLists(user.history, body.history, user);
      }
      if (Array.isArray(body.favorites) && body.favorites.length > 0) {
        user.favorites = mergeFavoritesLists(user.favorites, body.favorites);
      }
      user.ephemeralRecovered = false;
      user.updatedAt = Date.now();
      await saveUserProgress(user, true);
      const token = signAuthToken(key, user.username);
      setAuthCookie(req, res, token);
      return sendJson(res, 200, { token, user: publicUserPayload(user), db: pgPool ? 'postgres' : 'local-file' }, req);
    } catch (e) {
      return sendJson(res, 500, { error: 'Ошибка входа или базы данных', code: 'DB_UNAVAILABLE' }, req);
    }
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const isHttps = req?.headers?.['x-forwarded-proto'] === 'https' || Boolean(req?.socket?.encrypted);
    res.setHeader('Set-Cookie', `spbguka_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`);
    return sendJson(res, 200, { ok: true }, req);
  }

  if ((pathname === '/api/auth/me' || pathname === '/api/account/sync') && req.method === 'GET') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    const refreshedToken = signAuthToken(user.usernameLower, user.username);
    setAuthCookie(req, res, refreshedToken);
    return sendJson(res, 200, { user: publicUserPayload(user), refreshedToken }, req);
  }

  if (pathname === '/api/account/sync' && req.method === 'POST') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    try {
      const body = await readJsonBody(req);
      const mode = body.mode === 'replace' ? 'replace' : 'merge';
      const now = Date.now();
      if (mode === 'replace') {
        if (Array.isArray(body.history)) {
          const prevHistory = Array.isArray(user.history) ? user.history : [];
          const nextHistory = sanitizeHistoryList(body.history);
          const nextIds = new Set(nextHistory.map(x => x.imdbId));
          user.deletedHistory = (user.deletedHistory && typeof user.deletedHistory === 'object')
            ? { ...user.deletedHistory }
            : {};
          for (const prevItem of prevHistory) {
            if (prevItem && prevItem.imdbId && !nextIds.has(prevItem.imdbId)) {
              user.deletedHistory[prevItem.imdbId] = Math.max(now, Number(prevItem.updatedAt) || 0);
            }
          }
          const delEntries = Object.entries(user.deletedHistory);
          if (delEntries.length > 200) {
            user.deletedHistory = Object.fromEntries(
              delEntries.sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 200)
            );
          }
          if (nextHistory.length === 0 && (body.clearHistory === true || prevHistory.length > 0)) {
            const maxPrevTs = prevHistory.reduce((m, x) => Math.max(m, Number(x?.updatedAt) || 0), 0);
            user.historyClearedAt = Math.max(now, maxPrevTs);
          }
          user.history = nextHistory;
        }
        if (Array.isArray(body.favorites)) {
          const nextFavorites = sanitizeFavoritesList(body.favorites);
          if (nextFavorites.length === 0 && body.clearFavorites === true) {
            user.favoritesClearedAt = now;
          }
          user.favorites = nextFavorites;
        }
        user.ephemeralRecovered = false;
      } else {
        if (Array.isArray(body.history)) {
          user.history = mergeHistoryLists(user.history, body.history, user);
        }
        if (Array.isArray(body.favorites)) {
          user.favorites = mergeFavoritesLists(user.favorites, body.favorites);
        }
        if ((user.history && user.history.length > 0) || (user.favorites && user.favorites.length > 0)) {
          user.ephemeralRecovered = false;
        }
      }
      user.updatedAt = now;
      await saveUserProgress(user, false);
      const refreshedToken = signAuthToken(user.usernameLower, user.username);
      setAuthCookie(req, res, refreshedToken);
      return sendJson(res, 200, { ok: true, user: publicUserPayload(user), refreshedToken }, req);
    } catch (e) {
      return sendJson(res, 500, { error: 'Ошибка синхронизации с базой данных', code: 'DB_UNAVAILABLE' }, req);
    }
  }

  // --- Watch Party / Lobby Routes ---
  if (pathname === '/api/lobby/events' && req.method === 'GET') {
    const user = await requireAuth(req, res, 'Войдите в аккаунт для подключения к лобби');
    if (!user) return;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });

    const entry = getOrCreateOnlineEntry(user);
    entry.sseClients.add(res);
    const activeLobby = getUserLobby(user.usernameLower);

    sendSseEvent(res, 'init', {
      username: user.username,
      serverNow: Date.now(),
      lobby: activeLobby ? serializeLobbyForUser(activeLobby, user.usernameLower) : null,
      invites: getPendingInvitesForUser(user.usernameLower),
      onlineCount: Array.from(onlineUsers.keys()).filter(isUserOnline).length
    });
    schedulePresenceBroadcast();

    const pingInterval = setInterval(() => {
      entry.lastSeenAt = Date.now();
      try {
        if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
      } catch (e) {}
    }, 15000);

    req.on('close', () => {
      clearInterval(pingInterval);
      entry.sseClients.delete(res);
      entry.lastSeenAt = Date.now();
      schedulePresenceBroadcast();
    });
    return;
  }

  if (pathname === '/api/lobby/users' && req.method === 'GET') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    touchUserPresence(user);
    const q = parsedUrl.searchParams.get('q') || '';
    const lobby = getUserLobby(user.usernameLower);
    const known = await listKnownUsers(q, 30, user.usernameLower);
    const users = known.map(u => {
      const targetInvites = pendingInvitesByUser.get(u.usernameLower);
      return {
        username: u.username,
        online: u.online,
        inThisLobby: Boolean(lobby && lobby.members.has(u.usernameLower)),
        inAnotherLobby: Boolean(u.lobbyId && (!lobby || u.lobbyId !== lobby.id)),
        invited: Boolean(lobby && targetInvites && targetInvites.has(lobby.id))
      };
    });
    const onlineTotal = Array.from(onlineUsers.keys()).filter(isUserOnline).length;
    return sendJson(res, 200, { users, onlineTotal, serverNow: Date.now() }, req);
  }

  if (pathname === '/api/lobby/state' && req.method === 'GET') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    touchUserPresence(user);
    const lobby = getUserLobby(user.usernameLower);
    return sendJson(res, 200, {
      lobby: lobby ? serializeLobbyForUser(lobby, user.usernameLower) : null,
      invites: getPendingInvitesForUser(user.usernameLower),
      onlineTotal: Array.from(onlineUsers.keys()).filter(isUserOnline).length,
      serverNow: Date.now()
    }, req);
  }

  if (pathname === '/api/lobby/create' && req.method === 'POST') {
    const user = await requireAuth(req, res, 'Войдите в аккаунт, чтобы создать лобби');
    if (!user) return;
    try {
      const body = await readJsonBody(req);
      touchUserPresence(user);
      const oldLobby = getUserLobby(user.usernameLower);
      if (oldLobby) {
        if (oldLobby.hostLower === user.usernameLower) {
          closeLobbyRoom(oldLobby, 'Главный создал новое лобби');
        } else {
          removeMemberFromLobby(oldLobby, user.usernameLower, 'вышел из лобби');
        }
      }

      const rawName = String(body.name || '').trim().slice(0, 40);
      const lobbyName = rawName.length >= 2 ? rawName : `Лобби ${user.username}`;
      const lobbyId = generateLobbyCode();
      const now = Date.now();
      const lobby = {
        id: lobbyId,
        name: lobbyName,
        hostLower: user.usernameLower,
        hostUsername: user.username,
        createdAt: now,
        members: new Map([[user.usernameLower, {
          username: user.username,
          usernameLower: user.usernameLower,
          joinedAt: now
        }]]),
        playback: {
          seq: 1,
          imdbId: '',
          mediaItem: null,
          season: 1,
          episode: 1,
          voice: '',
          balancer: 'direct',
          paused: true,
          currentTime: 0,
          updatedAt: now,
          actionLabel: 'Ожидание выбора фильма'
        },
        messages: [{
          id: crypto.randomBytes(6).toString('hex'),
          type: 'system',
          username: 'Система',
          text: `${user.username} создал лобби «${lobbyName}» (код: ${lobbyId})`,
          ts: now
        }]
      };
      lobbies.set(lobbyId, lobby);
      const entry = getOrCreateOnlineEntry(user);
      entry.lobbyId = lobbyId;
      schedulePresenceBroadcast();
      return sendJson(res, 201, { lobby: serializeLobbyForUser(lobby, user.usernameLower) }, req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Не удалось создать лобби' }, req);
    }
  }

  if (pathname === '/api/lobby/join' && req.method === 'POST') {
    const user = await requireAuth(req, res, 'Войдите в аккаунт, чтобы зайти в лобби');
    if (!user) return;
    try {
      const body = await readJsonBody(req);
      touchUserPresence(user);
      const code = String(body.lobbyId || '').trim().toUpperCase();
      const targetLobby = lobbies.get(code);
      if (!targetLobby) {
        return sendJson(res, 404, { error: 'Лобби не найдено или уже закрыто' }, req);
      }
      if (!targetLobby.members.has(user.usernameLower) && targetLobby.members.size >= MAX_LOBBY_PARTICIPANTS) {
        return sendJson(res, 400, { error: `В лобби уже максимум ${MAX_LOBBY_PARTICIPANTS} человек` }, req);
      }

      const oldLobby = getUserLobby(user.usernameLower);
      if (oldLobby && oldLobby.id !== targetLobby.id) {
        if (oldLobby.hostLower === user.usernameLower) {
          closeLobbyRoom(oldLobby, 'Главный перешёл в другое лобби');
        } else {
          removeMemberFromLobby(oldLobby, user.usernameLower, 'вышел из лобби');
        }
      }

      const invMap = pendingInvitesByUser.get(user.usernameLower);
      if (invMap && invMap.delete(targetLobby.id)) {
        if (invMap.size === 0) pendingInvitesByUser.delete(user.usernameLower);
        sendSseToUser(user.usernameLower, 'invites_update', { invites: getPendingInvitesForUser(user.usernameLower) });
      }

      const isNewJoin = !targetLobby.members.has(user.usernameLower);
      if (isNewJoin) {
        targetLobby.members.set(user.usernameLower, {
          username: user.username,
          usernameLower: user.usernameLower,
          joinedAt: Date.now()
        });
      }
      const entry = getOrCreateOnlineEntry(user);
      entry.lobbyId = targetLobby.id;

      if (isNewJoin) {
        appendLobbyMessage(targetLobby, {
          id: crypto.randomBytes(6).toString('hex'),
          type: 'system',
          username: 'Система',
          text: `${user.username} зашёл в лобби`,
          ts: Date.now()
        });
      }

      broadcastToLobby(targetLobby, 'lobby_update', viewerLower => ({
        lobby: serializeLobbyForUser(targetLobby, viewerLower)
      }));
      schedulePresenceBroadcast();

      return sendJson(res, 200, {
        lobby: serializeLobbyForUser(targetLobby, user.usernameLower),
        invites: getPendingInvitesForUser(user.usernameLower)
      }, req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Не удалось войти в лобби' }, req);
    }
  }

  if (pathname === '/api/lobby/leave' && req.method === 'POST') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    const lobby = getUserLobby(user.usernameLower);
    if (lobby) {
      removeMemberFromLobby(lobby, user.usernameLower, 'вышел из лобби');
    }
    return sendJson(res, 200, { ok: true }, req);
  }

  if (pathname === '/api/lobby/close' && req.method === 'POST') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    const lobby = getUserLobby(user.usernameLower);
    if (!lobby) return sendJson(res, 404, { error: 'Вы не в лобби' }, req);
    if (lobby.hostLower !== user.usernameLower) {
      return sendJson(res, 403, { error: 'Только главный может закрыть лобби' }, req);
    }
    closeLobbyRoom(lobby, `Главный (${user.username}) закрыл лобби`);
    return sendJson(res, 200, { ok: true }, req);
  }

  if (pathname === '/api/lobby/invite' && req.method === 'POST') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    try {
      const body = await readJsonBody(req);
      touchUserPresence(user);
      const lobby = getUserLobby(user.usernameLower);
      if (!lobby) return sendJson(res, 400, { error: 'Сначала создайте или войдите в лобби' }, req);
      if (lobby.members.size >= MAX_LOBBY_PARTICIPANTS) {
        return sendJson(res, 400, { error: `Лобби заполнено (максимум ${MAX_LOBBY_PARTICIPANTS} человек)` }, req);
      }

      const targetRaw = String(body.targetUsername || '').trim();
      const targetLower = targetRaw.toLowerCase();
      if (!targetLower || targetLower === user.usernameLower) {
        return sendJson(res, 400, { error: 'Нельзя пригласить самого себя' }, req);
      }
      if (lobby.members.has(targetLower)) {
        return sendJson(res, 400, { error: 'Этот пользователь уже в лобби' }, req);
      }

      const targetRecord = await findUserByKey(targetLower);
      const targetOnline = onlineUsers.get(targetLower);
      if (!targetRecord && !targetOnline) {
        return sendJson(res, 404, { error: 'Пользователь с таким ником не найден на сервере' }, req);
      }

      let invMap = pendingInvitesByUser.get(targetLower);
      if (!invMap) {
        invMap = new Map();
        pendingInvitesByUser.set(targetLower, invMap);
      }
      const invObj = {
        lobbyId: lobby.id,
        lobbyName: lobby.name,
        fromUsername: user.username,
        createdAt: Date.now()
      };
      invMap.set(lobby.id, invObj);

      sendSseToUser(targetLower, 'invite', {
        invite: {
          ...invObj,
          memberCount: lobby.members.size,
          maxParticipants: MAX_LOBBY_PARTICIPANTS
        },
        invites: getPendingInvitesForUser(targetLower)
      });

      const targetDisplay = targetOnline?.username || targetRecord?.username || targetRaw;
      return sendJson(res, 200, { ok: true, invitedUsername: targetDisplay }, req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Ошибка отправки приглашения' }, req);
    }
  }

  if (pathname === '/api/lobby/decline' && req.method === 'POST') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    try {
      const body = await readJsonBody(req);
      const code = String(body.lobbyId || '').trim().toUpperCase();
      const invMap = pendingInvitesByUser.get(user.usernameLower);
      if (invMap) {
        invMap.delete(code);
        if (invMap.size === 0) pendingInvitesByUser.delete(user.usernameLower);
      }
      return sendJson(res, 200, { ok: true, invites: getPendingInvitesForUser(user.usernameLower) }, req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Ошибка отклонения' }, req);
    }
  }

  if (pathname === '/api/lobby/kick' && req.method === 'POST') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    try {
      const body = await readJsonBody(req);
      const lobby = getUserLobby(user.usernameLower);
      if (!lobby) return sendJson(res, 404, { error: 'Лобби не найдено' }, req);
      if (lobby.hostLower !== user.usernameLower) {
        return sendJson(res, 403, { error: 'Управлять участниками может только главный' }, req);
      }
      const targetLower = String(body.targetUsername || '').trim().toLowerCase();
      if (!targetLower || targetLower === user.usernameLower || !lobby.members.has(targetLower)) {
        return sendJson(res, 400, { error: 'Участник не найден в лобби' }, req);
      }
      sendSseToUser(targetLower, 'lobby_kicked', {
        lobbyId: lobby.id,
        reason: `Главный (${user.username}) исключил вас из лобби`
      });
      removeMemberFromLobby(lobby, targetLower, 'исключён главным');
      return sendJson(res, 200, { lobby: serializeLobbyForUser(lobby, user.usernameLower) }, req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Ошибка управления лобби' }, req);
    }
  }

  if (pathname === '/api/lobby/transfer-host' && req.method === 'POST') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    try {
      const body = await readJsonBody(req);
      const lobby = getUserLobby(user.usernameLower);
      if (!lobby) return sendJson(res, 404, { error: 'Лобби не найдено' }, req);
      if (lobby.hostLower !== user.usernameLower) {
        return sendJson(res, 403, { error: 'Передать права может только главный' }, req);
      }
      const targetLower = String(body.targetUsername || '').trim().toLowerCase();
      const targetMember = lobby.members.get(targetLower);
      if (!targetMember || targetLower === user.usernameLower) {
        return sendJson(res, 400, { error: 'Выберите другого участника лобби' }, req);
      }
      lobby.hostLower = targetMember.usernameLower;
      lobby.hostUsername = targetMember.username;
      appendLobbyMessage(lobby, {
        id: crypto.randomBytes(6).toString('hex'),
        type: 'system',
        username: 'Система',
        text: `${user.username} передал права главного участнику ${targetMember.username}`,
        ts: Date.now()
      });
      broadcastToLobby(lobby, 'lobby_update', viewerLower => ({
        lobby: serializeLobbyForUser(lobby, viewerLower)
      }));
      return sendJson(res, 200, { lobby: serializeLobbyForUser(lobby, user.usernameLower) }, req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Ошибка передачи прав' }, req);
    }
  }

  if (pathname === '/api/lobby/sync' && req.method === 'POST') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    try {
      const body = await readJsonBody(req);
      touchUserPresence(user);
      const lobby = getUserLobby(user.usernameLower);
      if (!lobby) return sendJson(res, 404, { error: 'Лобби не найдено' }, req);
      if (lobby.hostLower !== user.usernameLower) {
        return sendJson(res, 403, { error: 'Управлять фильмом может только главный лобби' }, req);
      }

      const prev = lobby.playback || {};
      const nextMedia = body.mediaItem ? sanitizeLobbyMediaItem(body.mediaItem) : prev.mediaItem;
      const now = Date.now();
      lobby.playback = {
        seq: (prev.seq || 0) + 1,
        imdbId: nextMedia?.imdbId || prev.imdbId || '',
        mediaItem: nextMedia || null,
        season: Math.max(1, Number(body.season ?? prev.season) || 1),
        episode: Math.max(1, Number(body.episode ?? prev.episode) || 1),
        voice: String(body.voice ?? prev.voice ?? '').slice(0, 80),
        balancer: String(body.balancer ?? prev.balancer ?? 'direct').slice(0, 32),
        paused: typeof body.paused === 'boolean' ? body.paused : Boolean(prev.paused),
        currentTime: Math.max(0, Number(body.currentTime ?? prev.currentTime) || 0),
        updatedAt: now,
        actionLabel: String(body.actionLabel || '').slice(0, 80)
      };

      broadcastToLobby(
        lobby,
        'playback_sync',
        { playback: lobby.playback, hostUsername: lobby.hostUsername, serverNow: now },
        user.usernameLower
      );
      return sendJson(res, 200, { ok: true, playback: lobby.playback, serverNow: now }, req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Ошибка синхронизации лобби' }, req);
    }
  }

  if (pathname === '/api/lobby/chat' && req.method === 'POST') {
    const user = await requireAuth(req, res, 'Требуется вход в аккаунт');
    if (!user) return;
    try {
      const body = await readJsonBody(req);
      touchUserPresence(user);
      const lobby = getUserLobby(user.usernameLower);
      if (!lobby) return sendJson(res, 404, { error: 'Вы не состоите в лобби' }, req);
      const text = String(body.text || '').trim().slice(0, 400);
      if (!text) return sendJson(res, 400, { error: 'Введите сообщение' }, req);

      const msg = {
        id: crypto.randomBytes(6).toString('hex'),
        type: 'user',
        username: user.username,
        text,
        ts: Date.now()
      };
      appendLobbyMessage(lobby, msg);
      return sendJson(res, 200, { ok: true, message: msg }, req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Ошибка отправки сообщения' }, req);
    }
  }

  if (pathname === '/api/hls-proxy') {
    const targetUrl = parsedUrl.searchParams.get('url');
    const audioParam = parsedUrl.searchParams.get('audio');
    const singleAudioParam = parsedUrl.searchParams.get('singleAudio');
    return handleHlsProxy(req, res, targetUrl, audioParam, singleAudioParam);
  }

  if (pathname === '/api/embed-clean') {
    return handleEmbedClean(req, res, parsedUrl);
  }

  if (pathname === '/api/catalog') {
    const category = parsedUrl.searchParams.get('category') || 'all';
    const genre = parsedUrl.searchParams.get('genre') || 'all';
    const year = parsedUrl.searchParams.get('year') || 'all';
    const sort = parsedUrl.searchParams.get('sort') || 'popular';
    const newThreshold = new Date().getFullYear() - 2;

    let list = [...liveCatalog];

    if (category === 'new') list = list.filter(x => x.isNew || x.year >= newThreshold);
    else if (category === 'popular') list = list.filter(x => x.isPopular);
    else if (category === 'movie') list = list.filter(x => x.type === 'movie');
    else if (category === 'series') list = list.filter(x => x.type === 'series');
    else if (category === 'cartoon') list = list.filter(x => x.type === 'cartoon');
    else if (category === 'anime') list = list.filter(x => x.type === 'anime');

    if (genre !== 'all') {
      list = list.filter(x => x.genres.some(g => g.toLowerCase() === genre.toLowerCase()));
    }

    if (year === '2024-2026') list = list.filter(x => x.year >= 2024);
    else if (year === '2020-2023') list = list.filter(x => x.year >= 2020 && x.year <= 2023);
    else if (year === '2010-2019') list = list.filter(x => x.year >= 2010 && x.year <= 2019);
    else if (year === 'old') list = list.filter(x => x.year < 2010);

    if (sort === 'rating') {
      list.sort((a, b) => (b.ratingKp + b.ratingImdb) - (a.ratingKp + a.ratingImdb));
    } else if (sort === 'year' || (category === 'new' && sort === 'popular')) {
      list.sort((a, b) => (b.year - a.year) || ((b.ratingImdb || 0) - (a.ratingImdb || 0)));
    } else if (sort === 'title') {
      list.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    }

    return sendJson(res, 200, { items: list, total: list.length, updatedAt: lastCatalogRefreshAt }, req);
  }

  if (pathname === '/api/catalog/more') {
    const result = await handleCatalogMore({
      category: parsedUrl.searchParams.get('category') || 'all',
      animeSub: parsedUrl.searchParams.get('animeSub') || 'all',
      genre: parsedUrl.searchParams.get('genre') || 'all',
      year: parsedUrl.searchParams.get('year') || 'all',
      sort: parsedUrl.searchParams.get('sort') || 'popular',
      page: parsedUrl.searchParams.get('page') || '1'
    });
    return sendJson(res, 200, result, req);
  }

  if (pathname === '/api/search') {
    const q = parsedUrl.searchParams.get('q') || '';
    const items = await handleSearch(q);
    return sendJson(res, 200, { items, query: q });
  }

  if (pathname === '/api/details') {
    const imdb = parsedUrl.searchParams.get('imdb') || 'tt0903747';
    const title = parsedUrl.searchParams.get('title') || '';
    const mirror = parsedUrl.searchParams.get('mirror') || 'direct';
    const fast = parsedUrl.searchParams.get('fast') === '1';
    const details = await handleDetails(imdb, title, mirror, fast);
    return sendJson(res, 200, details, req);
  }

  if (pathname === '/api/source/animevost') {
    const title = parsedUrl.searchParams.get('title') || '';
    const originalTitle = parsedUrl.searchParams.get('originalTitle') || '';
    const year = parseInt(parsedUrl.searchParams.get('year') || '0', 10) || 0;
    const type = parsedUrl.searchParams.get('type') || 'anime';
    const data = await resolveAnimeVostSource({ title, originalTitle, year, type });
    return sendJson(res, 200, data, req);
  }

  if (pathname === '/api/source/anilibria') {
    const title = parsedUrl.searchParams.get('title') || '';
    const originalTitle = parsedUrl.searchParams.get('originalTitle') || '';
    const year = parseInt(parsedUrl.searchParams.get('year') || '0', 10) || 0;
    const type = parsedUrl.searchParams.get('type') || 'anime';
    const data = await resolveAniLibriaSource({ title, originalTitle, year, type });
    return sendJson(res, 200, data, req);
  }

  if (pathname === '/api/source/anilibria/master.m3u8') {
    return handleAniLibriaMasterM3u8(req, res, parsedUrl);
  }

  if (pathname === '/api/source/kinogo') {
    const imdbId = parsedUrl.searchParams.get('imdb') || '';
    const kpId = parsedUrl.searchParams.get('kp') || '';
    const title = parsedUrl.searchParams.get('title') || '';
    const year = parseInt(parsedUrl.searchParams.get('year') || '0', 10) || 0;
    const season = parsedUrl.searchParams.get('season') || '';
    const episode = parsedUrl.searchParams.get('episode') || '';
    const type = parsedUrl.searchParams.get('type') || 'movie';
    const data = await resolveKinogoSource({ imdbId, kpId, title, year, season, episode, type });
    return sendJson(res, 200, data, req);
  }

  if (pathname === '/api/actor') {
    const actorName = (parsedUrl.searchParams.get('name') || '').trim();
    if (!actorName) {
      return sendJson(res, 400, { error: 'Missing name' }, req);
    }
    const qLower = actorName.toLowerCase();
    const items = liveCatalog.filter(x => (x.cast || '').toLowerCase().includes(qLower));
    return sendJson(res, 200, { actor: actorName, items, total: items.length }, req);
  }

  if (pathname === '/api/download-stream') {
    const streamUrl = parsedUrl.searchParams.get('url') || '';
    const title = parsedUrl.searchParams.get('title') || 'video';
    if (!streamUrl) {
      res.writeHead(400);
      return res.end('Missing stream url');
    }
    const ext = /\.mp4(\?|$|#)/i.test(streamUrl) ? '.mp4' : '.m3u8';
    const safeFilename = encodeURIComponent(title.replace(/[^\w\dа-яА-ЯёЁ\s._-]/g, '_')) + ext;
    res.writeHead(302, {
      'Location': streamUrl,
      'Content-Disposition': `attachment; filename="${safeFilename}"`
    });
    return res.end();
  }

  // Static files from ./public (with Gzip compression for text assets)
  let safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, 'public', safePath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const baseHeaders = {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    };
    if (pathname.startsWith('/downloads/')) {
      baseHeaders['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
    }
    const compressible = ['.html', '.css', '.js', '.json', '.svg'].includes(ext);
    const acceptEnc = (req.headers['accept-encoding'] || '').toLowerCase();

    if (compressible && acceptEnc.includes('gzip') && content.length > 256) {
      zlib.gzip(content, (gzErr, gzBuf) => {
        if (gzErr) {
          res.writeHead(200, baseHeaders);
          return res.end(content);
        }
        res.writeHead(200, {
          ...baseHeaders,
          'Content-Encoding': 'gzip',
          'Vary': 'Accept-Encoding'
        });
        res.end(gzBuf);
      });
      return;
    }

    res.writeHead(200, baseHeaders);
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`SPBGUKA (HD VideoBox Web) server running at http://0.0.0.0:${PORT}`);
  await ensureDbReady();
  setTimeout(() => refreshLiveCatalog(), 1000);
  scheduleDaily10AmRefresh();
});
