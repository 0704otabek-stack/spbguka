// СПБГУКА — Cross-Platform Cinema App (PC, Linux, Android, iOS Safari, LG webOS Smart TV)

const isSmartTv = /web0s|webos|tizen|smart-tv|smarttv|netcast|lg browser|viera|hisense|philips/i.test(navigator.userAgent) ||
  new URLSearchParams(window.location.search).get('tv') === '1';
if (isSmartTv) {
  document.documentElement.classList.add('tv-mode');
}

const state = {
  category: 'all',
  genre: 'all',
  year: 'all',
  sort: 'popular',
  searchQuery: '',
  masterCatalog: null,
  catalogItems: [],
  featuredItem: null,
  favorites: JSON.parse(localStorage.getItem('spbguka_favorites') || '[]'),
  history: JSON.parse(localStorage.getItem('spbguka_history') || '[]'),
  currentItem: null,
  activeTab: 'player',
  selectedBalancer: 'direct',
  selectedVoice: 'Рус. Дублированный',
  selectedQuality: 'Авто (Макс. 1080p)',
  selectedSeason: 1,
  selectedEpisode: 1
};

let hlsInstance = null;
let currentLoadedHlsUrl = '';
let currentManifestBlobUrl = '';
let playbackRequestToken = 0;
let modalOpenToken = 0;
let searchReqToken = 0;
let searchDebounceTimer = null;
let lastHistorySaveTs = 0;
let filesTabDirty = true;
let osdTimeout = null;
let overlayControlsTimer = null;
let seekFeedbackTimer = null;
let seekStreakDir = 0;
let seekStreakTotal = 0;
let seekStreakTimer = null;
let lastTouchTapTime = 0;
let lastTouchTapSide = 0;
let lastSmartOverlayKey = '';
let lastOverlayRevealTs = 0;
let currentTvFocusedEl = null;

const clientStreamCache = new Map();

function getClientMirrorList(preferredMirror = 'direct') {
  if (preferredMirror === 'kinogram') {
    return [
      'https://api.kinogram.best',
      'https://api.namy.ws',
      'https://api.delivembd.ws',
      'https://api.embess.ws'
    ];
  }
  if (preferredMirror === 'delivembd') {
    return [
      'https://api.delivembd.ws',
      'https://api.embess.ws',
      'https://api.namy.ws',
      'https://api.kinogram.best'
    ];
  }
  return [
    'https://api.namy.ws',
    'https://api.kinogram.best',
    'https://api.embess.ws',
    'https://api.delivembd.ws'
  ];
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

async function probeClientMirror(mirror, paths) {
  for (const p of paths) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(mirror + p, {
        credentials: 'omit',
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!r.ok) continue;

      const html = await r.text();
      const mkIdx = html.lastIndexOf('makePlayer({');
      if (mkIdx === -1) continue;

      const tokenMatch = html.match(/var\s+lok\s*=\s*\d+\s*,\s*\w+\s*=\s*"([^"]+)"/);
      const token = tokenMatch?.[1] || '';
      const mkBlock = html.slice(mkIdx);

      // Series / Cartoon / Anime with playlist seasons
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
              const epVoices = ep.audio?.names || ['Русский перевод'];
              epVoices.forEach(v => allVoicesSet.add(v));

              const signedHls = ep.hls ? (token ? `${ep.hls}&${token}` : ep.hls) : '';
              seasonsMap[sNum].push({
                season: sNum,
                episode: epNum,
                title: ep.title || `Серия ${epNum}`,
                duration: Math.round((ep.duration || 2700) / 60),
                hlsUrl: signedHls,
                rawHls: signedHls,
                voices: epVoices,
                subtitles: (ep.cc || []).map(c => ({ name: c.name, url: c.url }))
              });
            }
          }

          return {
            found: true,
            isSeries: true,
            embedUrl: mirror + p,
            seasons: seasonsMap,
            voices: Array.from(allVoicesSet)
          };
        }
      }

      // Single Movie with source.hls
      const hlsMatch = mkBlock.match(/hls\s*:\s*"([^"]+)"/);
      if (hlsMatch) {
        const signedHls = token ? `${hlsMatch[1]}&${token}` : hlsMatch[1];
        let voices = ['Рус. Дублированный'];
        const audioNamesMatch = mkBlock.match(/"names"\s*:\s*(\[[^\]]+\])/);
        if (audioNamesMatch) {
          try { voices = JSON.parse(audioNamesMatch[1]); } catch (e) {}
        }

        return {
          found: true,
          isSeries: false,
          embedUrl: mirror + p,
          voices,
          seasons: {
            1: [
              {
                season: 1,
                episode: 1,
                title: 'Полный фильм',
                duration: 130,
                hlsUrl: signedHls,
                rawHls: signedHls,
                voices,
                subtitles: []
              }
            ]
          }
        };
      }
    } catch (e) {
      // try next path
    }
  }
  throw new Error('Mirror miss');
}

// Client-Side Mirror Extractor: runs directly from the user's browser (residential IP + real UA)
// Racing mirrors concurrently with Promise.any so streams resolve in ~300ms.
async function parseClientStreamBalancer(imdbId, kpId, preferredMirror = 'direct') {
  const cacheKey = `${imdbId || ''}:${kpId || ''}:${preferredMirror}`;
  const cached = clientStreamCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 10 * 60 * 1000) {
    return cached.data;
  }

  const mirrors = getClientMirrorList(preferredMirror);
  const paths = [];
  if (kpId) paths.push(`/embed/kp/${encodeURIComponent(kpId)}`);
  if (imdbId) paths.push(`/embed/imdb/${encodeURIComponent(imdbId)}`);
  if (paths.length === 0) return { found: false };

  try {
    let result = null;
    if (preferredMirror !== 'direct') {
      try {
        result = await probeClientMirror(mirrors[0], paths);
      } catch (e) {
        result = await Promise.any(mirrors.slice(1).map(m => probeClientMirror(m, paths)));
      }
    } else {
      result = await Promise.any(mirrors.map(m => probeClientMirror(m, paths)));
    }
    if (result && result.found) {
      clientStreamCache.set(cacheKey, { ts: Date.now(), data: result });
      return result;
    }
  } catch (e) {
    // all mirrors failed
  }

  return { found: false };
}

function revokeCurrentManifestBlob() {
  if (currentManifestBlobUrl) {
    try { URL.revokeObjectURL(currentManifestBlobUrl); } catch (e) {}
    currentManifestBlobUrl = '';
  }
}

// Fetch master.m3u8 directly in browser (or via backend proxy fallback), clean failover audio duplicates,
// apply chosen voiceover track, and return Blob URL (hls.js) or data URI (iOS Safari native HLS).
async function buildClientHlsManifestUrl(rawHlsUrl, voiceIdx, singleAudio = false) {
  const isProxyUrl = rawHlsUrl.startsWith('/api/hls-proxy');
  const fetchTarget = isProxyUrl
    ? `${rawHlsUrl}&audio=${voiceIdx}${singleAudio ? '&singleAudio=1' : ''}`
    : rawHlsUrl;
  const resolvedBase = new URL(fetchTarget, window.location.origin).href;

  try {
    const r = await fetch(fetchTarget, { credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rawText = await r.text();
    const lines = rawText.split(/\r?\n/);
    const outLines = [];

    const audioLinesCount = lines.filter(l =>
      l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO') && !l.includes('GROUP-ID="failover-audio-0"')
    ).length;
    const effectiveAudioIdx = (voiceIdx >= 0 && audioLinesCount > 0)
      ? Math.min(voiceIdx, audioLinesCount - 1)
      : -1;
    let audioCounter = 0;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      if (line.includes('GROUP-ID="failover-audio-0"')) continue;
      if (line.includes('AUDIO="failover-audio-0"')) {
        i++; // skip redundant failover stream URI line right after
        continue;
      }

      if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO') && effectiveAudioIdx >= 0) {
        const currentIdx = audioCounter++;
        if (singleAudio && currentIdx !== effectiveAudioIdx) continue;
        const isSelected = currentIdx === effectiveAudioIdx;
        line = line
          .replace(/DEFAULT=(YES|NO)/g, `DEFAULT=${isSelected ? 'YES' : 'NO'}`)
          .replace(/AUTOSELECT=(YES|NO)/g, `AUTOSELECT=${isSelected ? 'YES' : 'NO'}`);
      }

      if (line.startsWith('#') && line.includes('URI="')) {
        line = line.replace(/URI="([^"]+)"/g, (_, uriVal) => {
          return `URI="${new URL(uriVal, resolvedBase).href}"`;
        });
        outLines.push(line);
        continue;
      }

      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        outLines.push(new URL(trimmed, resolvedBase).href);
      } else {
        outLines.push(line);
      }
    }

    const rewritten = outLines.join('\n');
    if (singleAudio) {
      return 'data:application/vnd.apple.mpegurl;charset=utf-8,' + encodeURIComponent(rewritten);
    }

    revokeCurrentManifestBlob();
    const blob = new Blob([rewritten], { type: 'application/vnd.apple.mpegurl' });
    currentManifestBlobUrl = URL.createObjectURL(blob);
    return currentManifestBlobUrl;
  } catch (err) {
    // Fallback to backend proxy if browser manifest fetch fails
    if (isProxyUrl) {
      return `${rawHlsUrl}&audio=${voiceIdx}${singleAudio ? '&singleAudio=1' : ''}`;
    }
    return `/api/hls-proxy?url=${encodeURIComponent(rawHlsUrl)}&audio=${voiceIdx}${singleAudio ? '&singleAudio=1' : ''}`;
  }
}

// DOM Elements
const catalogGrid = document.getElementById('catalogGrid');
const loadingState = document.getElementById('loadingState');
const emptyState = document.getElementById('emptyState');
const resultsCount = document.getElementById('resultsCount');
const sectionTitle = document.getElementById('sectionTitle');
const sectionSubtitle = document.getElementById('sectionSubtitle');

// Hero Elements
const heroBanner = document.getElementById('heroBanner');
const heroBackdrop = document.getElementById('heroBackdrop');
const heroBadge = document.getElementById('heroBadge');
const heroKp = document.getElementById('heroKp');
const heroImdb = document.getElementById('heroImdb');
const heroYear = document.getElementById('heroYear');
const heroGenres = document.getElementById('heroGenres');
const heroTitle = document.getElementById('heroTitle');
const heroSynopsis = document.getElementById('heroSynopsis');
const heroWatchBtn = document.getElementById('heroWatchBtn');
const heroInfoBtn = document.getElementById('heroInfoBtn');

// Search & Nav
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const favCountBadge = document.getElementById('favCountBadge');
const historyCountBadge = document.getElementById('historyCountBadge');

const continueWatchingBar = document.getElementById('continueWatchingBar');
const continueCardsList = document.getElementById('continueCardsList');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const resetFiltersBtn = document.getElementById('resetFiltersBtn');

// Modal Elements
const itemModal = document.getElementById('itemModal');
const modalWindow = itemModal.querySelector('.modal-window');
const theaterModeBtn = document.getElementById('theaterModeBtn');
const closeModalBtn = document.getElementById('closeModalBtn');
const modalTypeBadge = document.getElementById('modalTypeBadge');
const modalTitle = document.getElementById('modalTitle');
const modalOrigTitle = document.getElementById('modalOrigTitle');
const modalFavBtn = document.getElementById('modalFavBtn');

// Info Tab Elements
const infoPoster = document.getElementById('infoPoster');
const infoRatingKp = document.getElementById('infoRatingKp');
const infoRatingImdb = document.getElementById('infoRatingImdb');
const infoYear = document.getElementById('infoYear');
const infoCountry = document.getElementById('infoCountry');
const infoGenres = document.getElementById('infoGenres');
const infoDuration = document.getElementById('infoDuration');
const infoDirector = document.getElementById('infoDirector');
const infoCast = document.getElementById('infoCast');
const infoIds = document.getElementById('infoIds');
const infoDescription = document.getElementById('infoDescription');
const infoVoicesList = document.getElementById('infoVoicesList');
const switchToPlayerBtn = document.getElementById('switchToPlayerBtn');

// Player Tab Elements
const videoStage = document.getElementById('videoStage');
const balancerSelector = document.getElementById('balancerSelector');
const customStreamRow = document.getElementById('customStreamRow');
const customStreamInput = document.getElementById('customStreamInput');
const applyCustomStreamBtn = document.getElementById('applyCustomStreamBtn');
const sandboxRow = document.getElementById('sandboxRow');
const sandboxToggle = document.getElementById('sandboxToggle');
const voiceSelector = document.getElementById('voiceSelector');
const qualitySelector = document.getElementById('qualitySelector');

const seriesPickerBox = document.getElementById('seriesPickerBox');
const episodesCountBadge = document.getElementById('episodesCountBadge');
const seasonButtons = document.getElementById('seasonButtons');
const episodeButtons = document.getElementById('episodeButtons');
const prevEpBtn = document.getElementById('prevEpBtn');
const nextEpBtn = document.getElementById('nextEpBtn');

const playerOsd = document.getElementById('playerOsd');
const directPlayerWrap = document.getElementById('directPlayerWrap');
const videoStageArea = document.getElementById('videoStageArea');
const html5Video = document.getElementById('html5Video');
const seekFeedbackLeft = document.getElementById('seekFeedbackLeft');
const seekFeedbackLeftText = document.getElementById('seekFeedbackLeftText');
const seekFeedbackRight = document.getElementById('seekFeedbackRight');
const seekFeedbackRightText = document.getElementById('seekFeedbackRightText');
const videoSmartOverlay = document.getElementById('videoSmartOverlay');
const overlay120Group = document.getElementById('overlay120Group');
const overlayRewind120Btn = document.getElementById('overlayRewind120Btn');
const overlayForward120Btn = document.getElementById('overlayForward120Btn');
const overlayNextEpBtn = document.getElementById('overlayNextEpBtn');
const overlayNextEpText = document.getElementById('overlayNextEpText');
const nowPlayingText = document.getElementById('nowPlayingText');
const restartVideoBtn = document.getElementById('restartVideoBtn');
const rewind120Btn = document.getElementById('rewind120Btn');
const skip120Btn = document.getElementById('skip120Btn');
const playbackSpeedSelect = document.getElementById('playbackSpeedSelect');
const pipBtn = document.getElementById('pipBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');

const iframePlayerWrap = document.getElementById('iframePlayerWrap');
const balancerIframe = document.getElementById('balancerIframe');
const kinoboxContainer = document.getElementById('kinoboxContainer');

const filesTreeContainer = document.getElementById('filesTreeContainer');
const refreshParsersBtn = document.getElementById('refreshParsersBtn');

// Sources Modal
const parsersModal = document.getElementById('parsersModal');
const parsersStatusBtn = document.getElementById('parsersStatusBtn');
const closeParsersModalBtn = document.getElementById('closeParsersModalBtn');

const CATEGORY_TITLES = {
  all: 'Весь каталог',
  popular: 'Популярное сейчас',
  new: 'Новинки 2023–2026',
  movie: 'Фильмы',
  series: 'Сериалы',
  cartoon: 'Мультфильмы',
  anime: 'Аниме',
  favorites: 'Избранное',
  history: 'История просмотра'
};

const TYPE_LABELS = {
  movie: 'Фильм',
  series: 'Сериал',
  cartoon: 'Мультфильм',
  anime: 'Аниме'
};

function getProgressPercent(h) {
  if (!h || !h.currentTime || h.currentTime <= 5) return 0;
  const total = h.durationSeconds > 60 ? h.durationSeconds : 5400;
  return Math.min(98, Math.max(4, Math.round((h.currentTime / total) * 100)));
}

function updateBadges() {
  favCountBadge.textContent = state.favorites.length;
  historyCountBadge.textContent = state.history.length;

  const recent = state.history.slice(0, 5);
  if (recent.length > 0 && continueCardsList) {
    continueWatchingBar.classList.remove('hidden');
    continueCardsList.innerHTML = '';

    for (const h of recent) {
      const isEpisodic = h.type === 'series' || h.type === 'anime' || h.type === 'cartoon';
      const epPart = isEpisodic ? `С${h.season || 1}·С${h.episode || 1} • ` : '';
      const pct = getProgressPercent(h) || 4;

      const card = document.createElement('div');
      card.className = 'continue-card focusable';
      card.tabIndex = 0;
      card.innerHTML = `
        <img
          src="${h.poster}"
          alt="${h.title}"
          class="continue-card-thumb"
          loading="lazy"
          decoding="async"
          onerror="this.src='https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=300&q=70'"
        />
        <div class="continue-card-body">
          <div class="continue-card-title" title="${h.title}">${h.title}</div>
          <div class="continue-card-meta">${epPart}${h.voice || 'Дубляж'}</div>
          <div class="continue-card-progress">
            <div class="continue-card-progress-fill" style="width:${pct}%"></div>
          </div>
        </div>
        <button type="button" class="continue-card-remove" title="Убрать из истории" aria-label="Убрать из истории">×</button>
      `;

      card.addEventListener('click', () => openItemModal(h, 'player'));
      card.querySelector('.continue-card-remove').addEventListener('click', e => {
        e.stopPropagation();
        removeFromHistory(h.imdbId);
      });
      continueCardsList.appendChild(card);
    }
  } else {
    continueWatchingBar.classList.add('hidden');
  }
}

function saveFavorites() {
  localStorage.setItem('spbguka_favorites', JSON.stringify(state.favorites));
  updateBadges();
}

function toggleFavorite(item) {
  if (!item) return false;
  const idx = state.favorites.findIndex(f => f.imdbId === item.imdbId);
  const added = idx < 0;
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
  } else {
    state.favorites.unshift(item);
  }
  saveFavorites();
  return added;
}

function addToHistory(item, season, episode, voice, quality, currentTime = 0, durationSeconds = 0) {
  const prev = state.history.find(x => x.imdbId === item.imdbId);
  const resolvedDuration = durationSeconds > 60
    ? Math.floor(durationSeconds)
    : (prev?.durationSeconds || (item.type === 'movie' ? 7200 : 3000));

  const entry = {
    id: item.id,
    imdbId: item.imdbId,
    kpId: item.kpId,
    title: item.title,
    originalTitle: item.originalTitle,
    type: item.type,
    year: item.year,
    yearRange: item.yearRange,
    ratingKp: item.ratingKp,
    ratingImdb: item.ratingImdb,
    poster: item.poster,
    backdrop: item.backdrop,
    genres: item.genres || ['Кино'],
    voices: item.voices || ['Рус. Дублированный'],
    description: item.description || '',
    season,
    episode,
    voice,
    quality,
    currentTime: Math.floor(currentTime || 0),
    durationSeconds: resolvedDuration,
    updatedAt: Date.now()
  };

  state.history = [entry, ...state.history.filter(x => x.imdbId !== item.imdbId)].slice(0, 40);
  localStorage.setItem('spbguka_history', JSON.stringify(state.history));
  updateBadges();
}

function saveLivePlaybackProgress() {
  if (!state.currentItem || !html5Video || itemModal.classList.contains('hidden')) return;
  const t = Math.floor(html5Video.currentTime || 0);
  const dur = Math.floor(html5Video.duration || 0);
  if (t <= 0) return;
  const idx = state.history.findIndex(x => x.imdbId === state.currentItem.imdbId);
  if (idx >= 0) {
    state.history[idx].currentTime = t;
    if (dur > 60) state.history[idx].durationSeconds = dur;
    state.history[idx].updatedAt = Date.now();
    localStorage.setItem('spbguka_history', JSON.stringify(state.history));
  }
}

function removeFromHistory(imdbId) {
  state.history = state.history.filter(x => x.imdbId !== imdbId);
  localStorage.setItem('spbguka_history', JSON.stringify(state.history));
  updateBadges();
  if (state.category === 'history') loadCatalog();
}

function clearHistory() {
  state.history = [];
  localStorage.setItem('spbguka_history', '[]');
  updateBadges();
  if (state.category === 'history') loadCatalog();
}

function updateResetFiltersButton() {
  const dirty = state.genre !== 'all' || state.year !== 'all' || state.sort !== 'popular' || state.searchQuery.trim() !== '';
  if (resetFiltersBtn) resetFiltersBtn.classList.toggle('hidden', !dirty);
}

function syncCategoryButtons(category) {
  document.querySelectorAll('.nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.category === category);
  });
  document.querySelectorAll('.mob-nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.category === category);
  });
}

function renderHeroBanner(items) {
  const showHero = !state.searchQuery.trim() && state.category !== 'favorites' && state.category !== 'history' && items.length > 0;
  if (!showHero) {
    heroBanner.classList.add('hidden');
    state.featuredItem = null;
    return;
  }

  const featured = items[0];
  state.featuredItem = featured;
  heroBanner.classList.remove('hidden');

  const bgUrl = featured.backdrop || featured.poster;
  heroBackdrop.style.backgroundImage = `url("${bgUrl}")`;
  heroBadge.textContent = TYPE_LABELS[featured.type] || 'В фокусе';
  heroKp.textContent = `КП ${featured.ratingKp || '8.5'}`;
  heroImdb.textContent = `IMDb ${featured.ratingImdb || '8.6'}`;
  heroYear.textContent = featured.yearRange || featured.year || '2024';
  heroGenres.textContent = (featured.genres || []).slice(0, 3).join(', ');
  heroTitle.textContent = featured.title;
  heroSynopsis.textContent = featured.description || '';
}

function getFilteredLocalCatalog() {
  let list = [...(state.masterCatalog || [])];

  if (state.category === 'new') list = list.filter(x => x.isNew || x.year >= 2023);
  else if (state.category === 'popular') list = list.filter(x => x.isPopular);
  else if (state.category === 'movie') list = list.filter(x => x.type === 'movie');
  else if (state.category === 'series') list = list.filter(x => x.type === 'series');
  else if (state.category === 'cartoon') list = list.filter(x => x.type === 'cartoon');
  else if (state.category === 'anime') list = list.filter(x => x.type === 'anime');

  if (state.genre !== 'all') {
    const gLower = state.genre.toLowerCase();
    list = list.filter(x => (x.genres || []).some(g => g.toLowerCase() === gLower));
  }

  if (state.year === '2024-2026') list = list.filter(x => x.year >= 2024);
  else if (state.year === '2020-2023') list = list.filter(x => x.year >= 2020 && x.year <= 2023);
  else if (state.year === '2010-2019') list = list.filter(x => x.year >= 2010 && x.year <= 2019);
  else if (state.year === 'old') list = list.filter(x => x.year < 2010);

  if (state.sort === 'rating') {
    list.sort((a, b) => ((b.ratingKp || 0) + (b.ratingImdb || 0)) - ((a.ratingKp || 0) + (a.ratingImdb || 0)));
  } else if (state.sort === 'year') {
    list.sort((a, b) => (b.year || 0) - (a.year || 0));
  } else if (state.sort === 'title') {
    list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ru'));
  }

  return list;
}

async function loadCatalog() {
  updateResetFiltersButton();
  emptyState.classList.add('hidden');

  if (state.searchQuery.trim()) {
    const mySearchToken = ++searchReqToken;
    loadingState.classList.remove('hidden');
    catalogGrid.innerHTML = '';
    sectionTitle.textContent = `Поиск: «${state.searchQuery}»`;
    sectionSubtitle.textContent = 'Результаты из IMDb, Wikidata RU и подключённых видео-балансеров';
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(state.searchQuery)}`);
      const data = await res.json();
      if (mySearchToken !== searchReqToken) return;
      state.catalogItems = data.items || [];
    } catch (e) {
      if (mySearchToken !== searchReqToken) return;
      state.catalogItems = [];
    }
  } else if (state.category === 'favorites') {
    searchReqToken++;
    sectionTitle.textContent = CATEGORY_TITLES.favorites;
    sectionSubtitle.textContent = 'Сохранённые фильмы и сериалы';
    state.catalogItems = [...state.favorites];
  } else if (state.category === 'history') {
    searchReqToken++;
    sectionTitle.textContent = CATEGORY_TITLES.history;
    sectionSubtitle.textContent = 'Недавно открытые фильмы и серии';
    state.catalogItems = [...state.history];
  } else {
    searchReqToken++;
    sectionTitle.textContent = CATEGORY_TITLES[state.category] || CATEGORY_TITLES.all;
    sectionSubtitle.textContent = 'Прямые HLS-потоки • Выбор озвучки без рекламы';
    if (!state.masterCatalog) {
      loadingState.classList.remove('hidden');
      catalogGrid.innerHTML = '';
      try {
        const res = await fetch('/api/catalog?category=all&sort=popular');
        const data = await res.json();
        state.masterCatalog = data.items || [];
      } catch (e) {
        state.masterCatalog = [];
      }
    }
    state.catalogItems = getFilteredLocalCatalog();
  }

  loadingState.classList.add('hidden');
  renderHeroBanner(state.catalogItems);
  renderCatalogGrid(state.catalogItems);
}

function renderCatalogGrid(items) {
  resultsCount.textContent = items.length;
  catalogGrid.innerHTML = '';

  if (items.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  const favIds = new Set(state.favorites.map(f => f.imdbId));
  const historyMap = new Map(state.history.map(h => [h.imdbId, h]));

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'movie-card focusable';
    card.tabIndex = 0;
    const typeLabel = TYPE_LABELS[item.type] || 'Кино';
    const voicesList = item.voices || ['Рус. Дублированный', 'HDrezka Studio', 'Red Head Sound'];
    const historyMatch = historyMap.get(item.imdbId);
    const isFav = favIds.has(item.imdbId);
    const progressPct = getProgressPercent(historyMatch);

    card.innerHTML = `
      <div class="card-poster-wrap">
        <img
          src="${item.poster}"
          alt="${item.title}"
          class="card-poster"
          loading="lazy"
          decoding="async"
          onerror="this.src='https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=600&q=80'"
        />
        <div class="card-badges-top">
          <span class="card-type-pill">${typeLabel}</span>
          <div class="card-ratings-pill">
            ${item.ratingKp ? `<span class="r-badge kp">${item.ratingKp}</span>` : ''}
            ${item.ratingImdb ? `<span class="r-badge imdb">${item.ratingImdb}</span>` : ''}
          </div>
        </div>
        <button type="button" class="card-fav-btn ${isFav ? 'is-fav' : ''}" title="${isFav ? 'Убрать из избранного' : 'В избранное'}" aria-label="В избранное">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
          </svg>
        </button>
        <div class="card-play-hover">
          <div class="play-circle">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 5v14l11-7z"/>
            </svg>
          </div>
        </div>
        ${progressPct > 0
          ? `<div class="card-progress-bar"><div class="card-progress-fill" style="width:${progressPct}%"></div></div>`
          : ''}
      </div>
      <div class="card-body">
        <h3 class="card-title" title="${item.title}">${item.title}</h3>
        <div class="card-sub">${item.yearRange || item.year} • ${(item.genres || ['Кино']).slice(0, 2).join(', ')}</div>
        <div class="card-voices-preview">
          ${historyMatch
            ? `Сезон ${historyMatch.season}, Серия ${historyMatch.episode} • ${historyMatch.voice}`
            : `${voicesList.length} ${voicesList.length === 1 ? 'озвучка' : voicesList.length < 5 ? 'озвучки' : 'озвучек'}`}
        </div>
      </div>
    `;

    const favBtn = card.querySelector('.card-fav-btn');
    favBtn.addEventListener('click', e => {
      e.stopPropagation();
      const added = toggleFavorite(item);
      favBtn.classList.toggle('is-fav', added);
      favBtn.title = added ? 'Убрать из избранного' : 'В избранное';
      if (state.category === 'favorites') loadCatalog();
    });

    card.addEventListener('click', () => openItemModal(item, 'player'));
    catalogGrid.appendChild(card);
  }
}

function getActiveEpisodeObj(item) {
  if (!item || !item.seasons) return null;
  const seasonList = item.seasons[state.selectedSeason] || Object.values(item.seasons)[0] || [];
  return seasonList.find(ep => Number(ep.episode) === Number(state.selectedEpisode)) || seasonList[0] || null;
}

async function openItemModal(itemSummary, initialTab = 'player') {
  const myOpenToken = ++modalOpenToken;
  filesTabDirty = true;
  state.currentItem = {
    ...itemSummary,
    qualities: itemSummary.qualities || ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD', '360p'],
    providers: itemSummary.providers || [
      { id: 'direct', name: 'СПБГУКА Direct HLS (Чистый поток • 0% рекламы)', badge: '1080p FHD / Multi-Audio', speed: '120 Мбит/с' }
    ]
  };

  itemModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  clearTvFocus();

  const savedHistory = state.history.find(h => h.imdbId === itemSummary.imdbId);
  state.selectedSeason = savedHistory?.season || 1;
  state.selectedEpisode = savedHistory?.episode || 1;
  state.selectedVoice = savedHistory?.voice || (itemSummary.voices && itemSummary.voices[0]) || 'Рус. Дублированный';
  state.selectedQuality = savedHistory?.quality || 'Авто (Макс. 1080p)';

  // Immediately render card metadata so modal opens in 0ms
  populateInfoTab(state.currentItem);
  updateFavButtonState();
  updateBalancerButtons();
  switchModalTab(initialTab);
  nowPlayingText.textContent = `Подключение потока: ${itemSummary.title}...`;

  const fallbackDetailed = {
    ...itemSummary,
    seasons: { 1: [{ season: 1, episode: 1, title: 'Основной поток', hlsUrl: '', voices: itemSummary.voices || ['Рус. Дублированный'] }] },
    qualities: ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD', '360p'],
    providers: [{ id: 'direct', name: 'Прямой HLS', badge: '1080p', speed: '110 Мбит/с' }]
  };

  // Run fast server metadata lookup (?fast=1) and parallel client mirror extraction simultaneously
  const [detailedRes, initialClientData] = await Promise.all([
    fetch(`/api/details?imdb=${encodeURIComponent(itemSummary.imdbId)}&title=${encodeURIComponent(itemSummary.title)}&mirror=${encodeURIComponent(state.selectedBalancer)}&fast=1`)
      .then(r => r.json())
      .catch(() => fallbackDetailed),
    parseClientStreamBalancer(itemSummary.imdbId, itemSummary.kpId, state.selectedBalancer)
  ]);

  if (myOpenToken !== modalOpenToken || itemModal.classList.contains('hidden')) return;

  const detailed = detailedRes || fallbackDetailed;
  let clientData = initialClientData;

  if ((!clientData || !clientData.found) && !itemSummary.kpId && detailed.kpId) {
    clientData = await parseClientStreamBalancer(detailed.imdbId, detailed.kpId, state.selectedBalancer);
    if (myOpenToken !== modalOpenToken || itemModal.classList.contains('hidden')) return;
  }

  if (clientData && clientData.found) {
    detailed.hasDirectHls = true;
    detailed.seasons = clientData.seasons;
    if (clientData.voices && clientData.voices.length > 0) {
      detailed.voices = clientData.voices;
    }
    if (clientData.isSeries && detailed.type === 'movie') {
      detailed.type = 'series';
    }
    detailed.embedUrl = clientData.embedUrl;
  }

  state.currentItem = detailed;

  const item = state.currentItem;
  const seasonKeys = Object.keys(item.seasons || {}).map(Number).sort((a, b) => a - b);
  state.selectedSeason = (savedHistory?.season && item.seasons?.[savedHistory.season]) ? savedHistory.season : (seasonKeys[0] || 1);

  const epsInSeason = item.seasons?.[state.selectedSeason] || [];
  state.selectedEpisode = (savedHistory?.episode && epsInSeason.some(e => Number(e.episode) === Number(savedHistory.episode)))
    ? savedHistory.episode
    : (epsInSeason[0]?.episode || 1);

  const activeEp = getActiveEpisodeObj(item);
  const availableVoices = (activeEp?.voices && activeEp.voices.length) ? activeEp.voices : (item.voices || ['Рус. Дублированный']);

  state.selectedVoice = (savedHistory?.voice && availableVoices.includes(savedHistory.voice))
    ? savedHistory.voice
    : availableVoices[0];

  state.selectedQuality = savedHistory?.quality || 'Авто (Макс. 1080p)';

  populateInfoTab(item);
  populatePlayerControls(item);
  filesTabDirty = true;
  if (state.activeTab === 'files') {
    populateFilesTab(item);
    filesTabDirty = false;
  }
  updateFavButtonState();
  updateBalancerButtons();
  startPlayback(savedHistory?.currentTime || 0, true);
  revealVideoOverlayControls(3200);
}

function populateInfoTab(item) {
  modalTitle.textContent = item.title;
  modalOrigTitle.textContent = `${item.originalTitle || item.title} (${item.yearRange || item.year})`;
  modalTypeBadge.textContent = TYPE_LABELS[item.type] || 'Кино';

  infoPoster.src = item.poster;
  infoRatingKp.textContent = item.ratingKp || '8.1';
  infoRatingImdb.textContent = item.ratingImdb || '8.2';
  infoYear.textContent = item.yearRange || item.year || '2024';
  infoCountry.textContent = item.country || 'США / Мир';
  infoGenres.textContent = (item.genres || ['Кино']).join(', ');
  infoDuration.textContent = item.duration || '120 мин';
  infoDirector.textContent = item.director || 'Не указан';
  infoCast.textContent = item.cast || 'Не указан';
  infoIds.textContent = `IMDb: ${item.imdbId || '—'} • KP: ${item.kpId || '—'}`;
  infoDescription.textContent = item.description || 'Описание отсутствует.';

  infoVoicesList.innerHTML = '';
  for (const v of (item.voices || [])) {
    const btn = document.createElement('button');
    btn.className = 'chip-btn focusable';
    btn.type = 'button';
    btn.textContent = v;
    btn.addEventListener('click', () => {
      state.selectedVoice = v;
      populatePlayerControls(item);
      switchModalTab('player');
      switchAudioTrackOrRestart(v);
      showPlayerOsd(`Озвучка: ${v}`);
    });
    infoVoicesList.appendChild(btn);
  }
}

function isDirectHlsBalancer(b) {
  return ['direct', 'namy', 'kinogram', 'delivembd'].includes(b);
}

function isUsingHlsJs() {
  return Boolean(hlsInstance && window.Hls && window.Hls.isSupported());
}

// Switch audio track seamlessly via hls.js or native HLS reload with ?audio=idx&singleAudio=1 (iPhone Safari / Smart TVs)
function switchAudioTrackOrRestart(voiceName) {
  const item = state.currentItem;
  if (!item) return;
  const activeEp = getActiveEpisodeObj(item);
  const epVoices = activeEp?.voices || item.voices || [];
  const voiceIdx = Math.max(0, epVoices.indexOf(voiceName));

  if (isDirectHlsBalancer(state.selectedBalancer) && isUsingHlsJs() && hlsInstance.audioTracks && voiceIdx < hlsInstance.audioTracks.length) {
    hlsInstance.audioTrack = voiceIdx;
    const isEpisodic = item.type === 'series' || item.type === 'anime' || item.type === 'cartoon';
    const epPart = isEpisodic ? ` • Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}` : '';
    nowPlayingText.textContent = `${item.title}${epPart} • ${state.selectedVoice} • ${state.selectedQuality}`;
    addToHistory(item, state.selectedSeason, state.selectedEpisode, state.selectedVoice, state.selectedQuality, html5Video.currentTime || 0);
  } else {
    startPlayback(html5Video.currentTime || 0, true);
  }
}

function switchQualityLevel(qualityLabel) {
  if (isDirectHlsBalancer(state.selectedBalancer) && hlsInstance && hlsInstance.levels && hlsInstance.levels.length > 0) {
    if (qualityLabel.startsWith('Авто')) {
      hlsInstance.currentLevel = -1;
    } else {
      const targetHeight = parseInt(qualityLabel, 10);
      let bestIdx = 0;
      let minDiff = Infinity;
      hlsInstance.levels.forEach((lvl, idx) => {
        const h = lvl.height || 720;
        const diff = Math.abs(h - targetHeight);
        if (diff < minDiff) {
          minDiff = diff;
          bestIdx = idx;
        }
      });
      hlsInstance.currentLevel = bestIdx;
    }
  }
}

function markFilesTabDirtyOrRefresh(item) {
  filesTabDirty = true;
  if (state.activeTab === 'files' && item) {
    populateFilesTab(item);
    filesTabDirty = false;
  }
}

function populatePlayerControls(item) {
  const activeEp = getActiveEpisodeObj(item);
  const voices = (activeEp?.voices && activeEp.voices.length)
    ? activeEp.voices
    : (item.voices || ['Рус. Дублированный', 'HDrezka Studio', 'Red Head Sound']);

  if (!voices.includes(state.selectedVoice)) {
    state.selectedVoice = voices[0];
  }

  // Voices
  voiceSelector.innerHTML = '';
  for (const voice of voices) {
    const btn = document.createElement('button');
    btn.className = `chip-btn focusable ${state.selectedVoice === voice ? 'active' : ''}`;
    btn.type = 'button';
    btn.textContent = voice;
    btn.addEventListener('click', () => {
      state.selectedVoice = voice;
      populatePlayerControls(item);
      switchAudioTrackOrRestart(voice);
      showPlayerOsd(`Озвучка: ${voice}`);
    });
    voiceSelector.appendChild(btn);
  }

  // Qualities
  qualitySelector.innerHTML = '';
  const qualities = item.qualities || ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD', '360p'];
  for (const q of qualities) {
    const btn = document.createElement('button');
    btn.className = `chip-btn focusable ${state.selectedQuality === q ? 'active' : ''}`;
    btn.type = 'button';
    btn.textContent = q.replace('Авто (Макс. 1080p)', 'Авто').replace(' FHD', '').replace(' HD', '').replace(' SD', '');
    btn.addEventListener('click', () => {
      state.selectedQuality = q;
      populatePlayerControls(item);
      switchQualityLevel(q);
      showPlayerOsd(`Качество: ${q}`);
    });
    qualitySelector.appendChild(btn);
  }

  // Seasons & Episodes
  const seasonsObj = item.seasons || {};
  const seasonNums = Object.keys(seasonsObj).map(Number).sort((a, b) => a - b);
  const isMultiEpisode = item.type === 'series' || item.type === 'anime' || item.type === 'cartoon' || seasonNums.length > 1 || (seasonsObj[1] && seasonsObj[1].length > 1);

  if (isMultiEpisode) {
    seriesPickerBox.classList.remove('hidden');
    seasonButtons.innerHTML = '';
    for (const sNum of seasonNums) {
      const sBtn = document.createElement('button');
      sBtn.className = `chip-btn focusable ${Number(state.selectedSeason) === sNum ? 'active' : ''}`;
      sBtn.type = 'button';
      sBtn.textContent = `Сезон ${sNum}`;
      sBtn.addEventListener('click', () => {
        state.selectedSeason = sNum;
        const firstEp = seasonsObj[sNum]?.[0]?.episode || 1;
        state.selectedEpisode = firstEp;
        populatePlayerControls(item);
        markFilesTabDirtyOrRefresh(item);
        startPlayback(0, true);
        showPlayerOsd(`Сезон ${sNum}, Серия ${firstEp}`);
      });
      seasonButtons.appendChild(sBtn);
    }

    episodeButtons.innerHTML = '';
    const eps = seasonsObj[state.selectedSeason] || [];
    if (episodesCountBadge) {
      const count = eps.length;
      const mod10 = count % 10;
      const mod100 = count % 100;
      const word = (mod10 === 1 && mod100 !== 11)
        ? 'серия'
        : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'серии' : 'серий');
      episodesCountBadge.textContent = count > 0 ? `${count} ${word}` : '';
    }

    for (const ep of eps) {
      const epBtn = document.createElement('button');
      epBtn.className = `ep-btn focusable ${Number(state.selectedEpisode) === Number(ep.episode) ? 'active' : ''}`;
      epBtn.type = 'button';
      epBtn.innerHTML = `
        <span class="ep-num">${ep.episode} серия</span>
        <span class="ep-name" title="${ep.title}">${ep.title}</span>
      `;
      epBtn.addEventListener('click', () => {
        state.selectedEpisode = ep.episode;
        populatePlayerControls(item);
        markFilesTabDirtyOrRefresh(item);
        startPlayback(0, true);
        showPlayerOsd(`Сезон ${state.selectedSeason}, Серия ${ep.episode}`);
      });
      episodeButtons.appendChild(epBtn);
    }

    requestAnimationFrame(() => {
      episodeButtons.querySelector('.ep-btn.active')?.scrollIntoView({
        behavior: isSmartTv ? 'auto' : 'smooth',
        block: 'nearest',
        inline: 'center'
      });
    });
  } else {
    if (episodesCountBadge) episodesCountBadge.textContent = '';
    seriesPickerBox.classList.add('hidden');
  }
}

function populateFilesTab(item) {
  filesTreeContainer.innerHTML = '';
  const providers = item.providers || [
    { id: 'direct', name: 'Прямой HLS', badge: '1080p', speed: '120 Мбит/с' }
  ];
  const activeEp = getActiveEpisodeObj(item);
  const voices = activeEp?.voices || item.voices || ['Рус. Дублированный'];
  const qualities = item.qualities || ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD'];

  for (const prov of providers) {
    const group = document.createElement('div');
    group.className = 'provider-group';

    let rowsHtml = '';
    for (const voice of voices) {
      const isEpisodic = item.type === 'series' || item.type === 'anime' || item.type === 'cartoon';
      const epLabel = isEpisodic ? `Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}` : 'Полный фильм';

      const qButtonsHtml = qualities.map(q => `
        <button class="chip-btn file-launch-btn focusable" type="button" data-voice="${voice}" data-quality="${q}" data-prov="${prov.id}">
          ${q.replace('Авто (Макс. 1080p)', 'Авто')}
        </button>
      `).join('');

      rowsHtml += `
        <div class="file-stream-row">
          <div class="file-meta">
            <span><strong>${item.title}</strong> • ${epLabel}</span>
            <span class="file-voice-tag">${voice}</span>
          </div>
          <div class="file-qualities">
            ${qButtonsHtml}
          </div>
        </div>
      `;
    }

    group.innerHTML = `
      <div class="provider-group-header">
        <div>
          <strong>${prov.name}</strong>
          <span style="margin-left:8px;font-size:0.76rem;color:var(--ok);">${prov.badge}</span>
        </div>
        <span class="mono" style="color:var(--text-muted);">${prov.speed}</span>
      </div>
      <div class="provider-files-list">${rowsHtml}</div>
    `;
    filesTreeContainer.appendChild(group);
  }

  filesTreeContainer.querySelectorAll('.file-launch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedVoice = btn.dataset.voice;
      state.selectedQuality = btn.dataset.quality;
      state.selectedBalancer = isDirectHlsBalancer(btn.dataset.prov) ? btn.dataset.prov : 'direct';
      updateBalancerButtons();
      populatePlayerControls(item);
      switchModalTab('player');
      startPlayback(0, true);
      showPlayerOsd(`${state.selectedVoice} • ${state.selectedQuality}`);
    });
  });
}

function showPlayerOsd(message) {
  playerOsd.textContent = message;
  playerOsd.classList.remove('hidden');
  if (osdTimeout) clearTimeout(osdTimeout);
  osdTimeout = setTimeout(() => {
    playerOsd.classList.add('hidden');
  }, 2800);
}

function getAdjacentEpisodeTarget(delta) {
  const item = state.currentItem;
  if (!item || !item.seasons) return null;
  const seasonNums = Object.keys(item.seasons).map(Number).sort((a, b) => a - b);
  const curSeason = Number(state.selectedSeason);
  const curSeasonIdx = seasonNums.indexOf(curSeason);
  if (curSeasonIdx === -1) return null;

  const eps = item.seasons[curSeason] || [];
  const curEpIdx = eps.findIndex(e => Number(e.episode) === Number(state.selectedEpisode));
  if (curEpIdx === -1) return null;

  const nextEpIdx = curEpIdx + delta;
  if (nextEpIdx >= 0 && nextEpIdx < eps.length) {
    return {
      season: curSeason,
      episode: eps[nextEpIdx].episode,
      title: eps[nextEpIdx].title || ''
    };
  }

  if (delta > 0 && curSeasonIdx + 1 < seasonNums.length) {
    const nextSeason = seasonNums[curSeasonIdx + 1];
    const nextSeasonEps = item.seasons[nextSeason] || [];
    if (nextSeasonEps.length > 0) {
      return {
        season: nextSeason,
        episode: nextSeasonEps[0].episode,
        title: nextSeasonEps[0].title || ''
      };
    }
  }

  if (delta < 0 && curSeasonIdx > 0) {
    const prevSeason = seasonNums[curSeasonIdx - 1];
    const prevSeasonEps = item.seasons[prevSeason] || [];
    if (prevSeasonEps.length > 0) {
      const lastEp = prevSeasonEps[prevSeasonEps.length - 1];
      return {
        season: prevSeason,
        episode: lastEp.episode,
        title: lastEp.title || ''
      };
    }
  }

  return null;
}

function updateSmartVideoOverlay() {
  if (!overlay120Group || !overlayNextEpBtn) return;
  const cur = Number.isFinite(html5Video.currentTime) ? html5Video.currentTime : 0;
  const dur = (Number.isFinite(html5Video.duration) && html5Video.duration > 0) ? html5Video.duration : 0;
  const isFirstHalf = (dur === 0) || (cur <= dur * 0.5);

  const remaining = dur > 0 ? (dur - cur) : Infinity;
  const nextTarget = getAdjacentEpisodeTarget(1);
  const showNextEp = !isFirstHalf && dur > 0 && remaining <= 180 && Boolean(nextTarget);
  const key = `${isFirstHalf ? 1 : 0}|${showNextEp ? 1 : 0}|${nextTarget ? `${nextTarget.season}:${nextTarget.episode}` : ''}`;
  if (key === lastSmartOverlayKey) return;
  lastSmartOverlayKey = key;

  overlay120Group.classList.toggle('hidden', !isFirstHalf);
  overlayNextEpBtn.classList.toggle('hidden', !showNextEp);
  if (showNextEp && overlayNextEpText && nextTarget) {
    overlayNextEpText.textContent = `Следующая серия (С${nextTarget.season} Е${nextTarget.episode}) ⏭`;
  }
}

function revealVideoOverlayControls(timeoutMs = 3200) {
  if (!videoStageArea) return;
  videoStageArea.classList.add('controls-active');
  updateSmartVideoOverlay();
  if (overlayControlsTimer) clearTimeout(overlayControlsTimer);
  overlayControlsTimer = setTimeout(() => {
    if (!html5Video.paused) {
      videoStageArea.classList.remove('controls-active');
    }
  }, timeoutMs);
}

function seekRelative(deltaSeconds) {
  if (!html5Video) return;
  const cur = Number.isFinite(html5Video.currentTime) ? html5Video.currentTime : 0;
  const dur = (Number.isFinite(html5Video.duration) && html5Video.duration > 0) ? html5Video.duration : Infinity;
  const target = Math.max(0, Math.min(dur, cur + deltaSeconds));
  html5Video.currentTime = target;

  const dir = deltaSeconds < 0 ? -1 : 1;
  if (Math.abs(deltaSeconds) < 60 && seekStreakDir === dir) {
    seekStreakTotal += deltaSeconds;
  } else {
    seekStreakDir = dir;
    seekStreakTotal = deltaSeconds;
  }

  if (seekStreakTimer) clearTimeout(seekStreakTimer);
  seekStreakTimer = setTimeout(() => {
    seekStreakDir = 0;
    seekStreakTotal = 0;
  }, 750);

  const sign = seekStreakTotal > 0 ? '+' : '';
  const text = `${sign}${seekStreakTotal} сек`;

  if (seekFeedbackLeft && seekFeedbackRight && seekFeedbackLeftText && seekFeedbackRightText) {
    seekFeedbackLeft.classList.toggle('hidden', dir !== -1);
    seekFeedbackRight.classList.toggle('hidden', dir !== 1);
    if (dir === -1) seekFeedbackLeftText.textContent = text;
    else seekFeedbackRightText.textContent = text;

    if (seekFeedbackTimer) clearTimeout(seekFeedbackTimer);
    seekFeedbackTimer = setTimeout(() => {
      seekFeedbackLeft.classList.add('hidden');
      seekFeedbackRight.classList.add('hidden');
    }, 850);
  }

  showPlayerOsd(text);
  revealVideoOverlayControls();
  saveLivePlaybackProgress();
}

function updateBalancerButtons() {
  balancerSelector.querySelectorAll('.chip-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.balancer === state.selectedBalancer);
  });
  customStreamRow.classList.toggle('hidden', state.selectedBalancer !== 'custom');
  sandboxRow.classList.toggle('hidden', isDirectHlsBalancer(state.selectedBalancer));
}

function destroyHls() {
  if (hlsInstance) {
    try { hlsInstance.destroy(); } catch (e) {}
    hlsInstance = null;
  }
  currentLoadedHlsUrl = '';
  revokeCurrentManifestBlob();
}

async function loadClientCleanEmbed(item, balancerName) {
  const mirrorKey = balancerName === 'custom' ? 'namy' : balancerName;
  const mirrors = getClientMirrorList(mirrorKey);
  const query = `?season=${encodeURIComponent(String(state.selectedSeason || 1))}&episode=${encodeURIComponent(String(state.selectedEpisode || 1))}`;
  const paths = [];
  if (item.kpId) paths.push(`/embed/kp/${encodeURIComponent(item.kpId)}${query}`);
  if (item.imdbId) paths.push(`/embed/imdb/${encodeURIComponent(item.imdbId)}${query}`);

  for (const mirror of mirrors) {
    for (const p of paths) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6500);
        const r = await fetch(mirror + p, { credentials: 'omit', signal: controller.signal });
        clearTimeout(timeout);
        if (!r.ok) continue;

        let html = await r.text();
        if (!html.includes('makePlayer({')) continue;

        html = html
          .replace(/<head([^>]*)>/i, `<head$1><base href="${mirror}/">`)
          .replace(/<script\s+data-name="ad">[\s\S]*?<\/script>/gi, '<script data-name="ad">var middleCount = 0, adTimeouts = {}, adsConfig = {};</script>')
          .replace(/ads:\s*adsConfig/g, 'ads: undefined')
          .replace(/distribrey\.com/gi, '')
          .replace(/getsdk\.online/gi, '');

        balancerIframe.removeAttribute('src');
        balancerIframe.srcdoc = html;
        return true;
      } catch (e) {
        // try next mirror/path
      }
    }
  }

  const cleanParams = new URLSearchParams({
    imdb: item.imdbId || '',
    kp: item.kpId || '',
    mirror: mirrorKey,
    season: String(state.selectedSeason || 1),
    episode: String(state.selectedEpisode || 1)
  });
  balancerIframe.removeAttribute('srcdoc');
  balancerIframe.src = `/api/embed-clean?${cleanParams.toString()}`;
  return false;
}

async function startPlayback(resumeSeconds = 0, forceReload = false) {
  const item = state.currentItem;
  if (!item) return;

  const myPlayToken = ++playbackRequestToken;
  const activeEp = getActiveEpisodeObj(item);
  const epVoices = activeEp?.voices || item.voices || ['Рус. Дублированный'];
  const voiceIdx = Math.max(0, epVoices.indexOf(state.selectedVoice));

  addToHistory(item, state.selectedSeason, state.selectedEpisode, state.selectedVoice, state.selectedQuality, resumeSeconds);

  const isEpisodic = item.type === 'series' || item.type === 'anime' || item.type === 'cartoon';
  const epPart = isEpisodic ? ` • Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}` : '';
  nowPlayingText.textContent = `${item.title}${epPart} • ${state.selectedVoice} • ${state.selectedQuality}`;

  // Direct HLS Stream (used for Прямой HLS, Collaps HLS, Kinogram HLS, Delivembed HLS — 0% ads)
  const streamUrl = activeEp?.rawHls || activeEp?.hlsUrl;
  if (isDirectHlsBalancer(state.selectedBalancer) && streamUrl) {
    iframePlayerWrap.classList.add('hidden');
    balancerIframe.removeAttribute('srcdoc');
    balancerIframe.src = 'about:blank';
    directPlayerWrap.classList.remove('hidden');

    // Prefer hls.js on PC, Linux, Android, webOS Chromium
    if (window.Hls && window.Hls.isSupported()) {
      if (!forceReload && currentLoadedHlsUrl === streamUrl && hlsInstance) {
        if (hlsInstance.audioTracks && voiceIdx < hlsInstance.audioTracks.length) {
          hlsInstance.audioTrack = voiceIdx;
        }
        switchQualityLevel(state.selectedQuality);
        html5Video.play().catch(() => {});
        return;
      }

      destroyHls();
      const manifestUrl = await buildClientHlsManifestUrl(streamUrl, voiceIdx, false);
      if (myPlayToken !== playbackRequestToken || itemModal.classList.contains('hidden')) return;

      currentLoadedHlsUrl = streamUrl;
      html5Video.poster = '';

      hlsInstance = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        capLevelToPlayerSize: true
      });

      hlsInstance.loadSource(manifestUrl);
      hlsInstance.attachMedia(html5Video);

      hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (hlsInstance.audioTracks && voiceIdx < hlsInstance.audioTracks.length) {
          hlsInstance.audioTrack = voiceIdx;
        }
        switchQualityLevel(state.selectedQuality);
        if (resumeSeconds > 2) {
          html5Video.currentTime = resumeSeconds;
        }
        html5Video.play().catch(() => {});
      });

      hlsInstance.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        if (hlsInstance.audioTracks && voiceIdx < hlsInstance.audioTracks.length) {
          hlsInstance.audioTrack = voiceIdx;
        }
      });
      return;
    }

    // Native HLS fallback (iPhone / iPad Safari & older Smart TV browsers): singleAudio=1 forces chosen voiceover!
    if (html5Video.canPlayType('application/vnd.apple.mpegurl')) {
      destroyHls();
      const nativeUrl = await buildClientHlsManifestUrl(streamUrl, voiceIdx, true);
      if (myPlayToken !== playbackRequestToken || itemModal.classList.contains('hidden')) return;

      currentLoadedHlsUrl = nativeUrl;
      html5Video.src = nativeUrl;
      html5Video.addEventListener('loadedmetadata', () => {
        if (resumeSeconds > 2) {
          try { html5Video.currentTime = resumeSeconds; } catch (e) {}
        }
        html5Video.play().catch(() => {});
      }, { once: true });
      return;
    }
  }

  // Fallback: Client-side ad-stripped embed or Custom Stream
  destroyHls();
  html5Video.pause();
  html5Video.removeAttribute('src');
  directPlayerWrap.classList.add('hidden');
  iframePlayerWrap.classList.remove('hidden');
  kinoboxContainer.classList.add('hidden');
  balancerIframe.classList.remove('hidden');

  applyIframeSandbox();

  if (state.selectedBalancer === 'custom') {
    const customUrl = customStreamInput.value.trim();
    if (!customUrl) return;
    if (customUrl.includes('.m3u8') && window.Hls && window.Hls.isSupported()) {
      iframePlayerWrap.classList.add('hidden');
      directPlayerWrap.classList.remove('hidden');
      hlsInstance = new window.Hls();
      hlsInstance.loadSource(customUrl);
      hlsInstance.attachMedia(html5Video);
      hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => html5Video.play().catch(() => {}));
    } else if (customUrl.endsWith('.mp4') || customUrl.endsWith('.webm')) {
      iframePlayerWrap.classList.add('hidden');
      directPlayerWrap.classList.remove('hidden');
      html5Video.src = customUrl;
      html5Video.play().catch(() => {});
    } else {
      balancerIframe.removeAttribute('srcdoc');
      balancerIframe.src = customUrl;
    }
  } else {
    await loadClientCleanEmbed(item, state.selectedBalancer);
  }
}

function applyIframeSandbox() {
  if (sandboxToggle.checked) {
    balancerIframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-presentation');
  } else {
    balancerIframe.removeAttribute('sandbox');
  }
}

function switchModalTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.hdvb-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.getElementById('tabInfo').classList.toggle('hidden', tabName !== 'info');
  document.getElementById('tabPlayer').classList.toggle('hidden', tabName !== 'player');
  document.getElementById('tabFiles').classList.toggle('hidden', tabName !== 'files');
  if (tabName === 'files' && state.currentItem && filesTabDirty) {
    populateFilesTab(state.currentItem);
    filesTabDirty = false;
  }
}

function closeItemModal() {
  saveLivePlaybackProgress();
  modalOpenToken++;
  playbackRequestToken++;
  if (overlayControlsTimer) clearTimeout(overlayControlsTimer);
  if (seekFeedbackTimer) clearTimeout(seekFeedbackTimer);
  if (seekStreakTimer) clearTimeout(seekStreakTimer);
  seekStreakDir = 0;
  seekStreakTotal = 0;
  if (seekFeedbackLeft) seekFeedbackLeft.classList.add('hidden');
  if (seekFeedbackRight) seekFeedbackRight.classList.add('hidden');
  destroyHls();
  html5Video.pause();
  balancerIframe.removeAttribute('srcdoc');
  balancerIframe.src = 'about:blank';
  itemModal.classList.add('hidden');
  if (modalWindow) modalWindow.classList.remove('theater-mode');
  if (theaterModeBtn) theaterModeBtn.textContent = 'Широкий экран';
  document.body.style.overflow = '';
  updateBadges();
  clearTvFocus();
}

function updateFavButtonState() {
  if (!state.currentItem) return;
  const isFav = state.favorites.some(f => f.imdbId === state.currentItem.imdbId);
  modalFavBtn.textContent = isFav ? 'В избранном' : 'В избранное';
  modalFavBtn.style.background = isFav ? 'var(--accent)' : '';
  modalFavBtn.style.color = isFav ? 'var(--accent-ink)' : '';
}

function toggleVideoFullscreen() {
  const target = directPlayerWrap.classList.contains('hidden')
    ? iframePlayerWrap
    : (videoStageArea || html5Video);
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (target.requestFullscreen) {
    target.requestFullscreen().catch(() => {
      if (html5Video.webkitEnterFullscreen) html5Video.webkitEnterFullscreen();
    });
  } else if (html5Video.webkitEnterFullscreen) {
    // iPhone Safari native video fullscreen
    html5Video.webkitEnterFullscreen();
  }
}

// Spatial TV D-Pad Navigation (LG webOS / Samsung Tizen / HTPC Linux)
function clearTvFocus() {
  if (currentTvFocusedEl) {
    currentTvFocusedEl.classList.remove('tv-focus');
    currentTvFocusedEl = null;
  }
}

function getVisibleFocusableWithRects() {
  const scope = !parsersModal.classList.contains('hidden')
    ? parsersModal
    : (!itemModal.classList.contains('hidden') ? itemModal : document.body);

  const result = [];
  for (const el of scope.querySelectorAll('.focusable')) {
    if (el.offsetParent === null) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      result.push({ el, rect });
    }
  }
  return result;
}

function moveSpatialFocus(direction) {
  const candidates = getVisibleFocusableWithRects();
  if (candidates.length === 0) return;

  const currentEntry = currentTvFocusedEl ? candidates.find(c => c.el === currentTvFocusedEl) : null;
  if (!currentEntry) {
    const activeEl = document.activeElement;
    const activeEntry = candidates.find(c => c.el === activeEl) || candidates[0];
    currentTvFocusedEl = activeEntry.el;
    currentTvFocusedEl.classList.add('tv-focus');
    currentTvFocusedEl.focus({ preventScroll: true });
    currentTvFocusedEl.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
    return;
  }

  const curRect = currentEntry.rect;
  const curCx = curRect.left + curRect.width / 2;
  const curCy = curRect.top + curRect.height / 2;

  let bestEl = null;
  let bestScore = Infinity;

  for (const { el, rect: r } of candidates) {
    if (el === currentTvFocusedEl) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cx - curCx;
    const dy = cy - curCy;

    let valid = false;
    let primaryDist = 0;
    let secondaryDist = 0;

    if (direction === 'ArrowRight' && dx > 12) {
      valid = true;
      primaryDist = dx;
      secondaryDist = Math.abs(dy);
    } else if (direction === 'ArrowLeft' && dx < -12) {
      valid = true;
      primaryDist = -dx;
      secondaryDist = Math.abs(dy);
    } else if (direction === 'ArrowDown' && dy > 12) {
      valid = true;
      primaryDist = dy;
      secondaryDist = Math.abs(dx);
    } else if (direction === 'ArrowUp' && dy < -12) {
      valid = true;
      primaryDist = -dy;
      secondaryDist = Math.abs(dx);
    }

    if (!valid) continue;
    const score = primaryDist + secondaryDist * 2.2;
    if (score < bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }

  if (bestEl) {
    currentTvFocusedEl.classList.remove('tv-focus');
    currentTvFocusedEl = bestEl;
    currentTvFocusedEl.classList.add('tv-focus');
    currentTvFocusedEl.focus({ preventScroll: true });
    currentTvFocusedEl.scrollIntoView({ behavior: isSmartTv ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' });
  }
}

// Event Listeners
document.querySelectorAll('.nav-item, .mob-nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    state.category = btn.dataset.category;
    state.searchQuery = '';
    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
    syncCategoryButtons(state.category);
    loadCatalog();
  });
});

document.querySelectorAll('.genre-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.genre-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.genre = btn.dataset.genre;
    state.searchQuery = '';
    loadCatalog();
  });
});

document.getElementById('yearFilter').addEventListener('change', e => {
  state.year = e.target.value;
  loadCatalog();
});

document.getElementById('sortFilter').addEventListener('change', e => {
  state.sort = e.target.value;
  loadCatalog();
});

function resetAllFilters() {
  clearTimeout(searchDebounceTimer);
  state.category = 'all';
  state.genre = 'all';
  if ('year' in state) state.year = 'all';
  if ('sort' in state) state.sort = 'popular';
  state.searchQuery = '';
  searchInput.value = '';
  clearSearchBtn.classList.add('hidden');
  ['genreFilter', 'yearFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = 'all';
  });
  const sortEl = document.getElementById('sortFilter') || document.getElementById('sortSelect');
  if (sortEl) sortEl.value = 'popular';
  if (typeof syncCategoryButtons === 'function') syncCategoryButtons('all');
  if (typeof updateResetFiltersButton === 'function') updateResetFiltersButton();
  loadCatalog();
}

searchForm.addEventListener('submit', e => {
  e.preventDefault();
  clearTimeout(searchDebounceTimer);
  state.searchQuery = searchInput.value.trim();
  clearSearchBtn.classList.toggle('hidden', !state.searchQuery);
  if (typeof updateResetFiltersButton === 'function') updateResetFiltersButton();
  loadCatalog();
  searchInput.blur();
});

searchInput.addEventListener('input', () => {
  const val = searchInput.value.trim();
  clearSearchBtn.classList.toggle('hidden', !searchInput.value);
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    if (state.searchQuery !== val) {
      state.searchQuery = val;
      if (typeof updateResetFiltersButton === 'function') updateResetFiltersButton();
      loadCatalog();
    }
  }, 350);
});

clearSearchBtn.addEventListener('click', () => {
  clearTimeout(searchDebounceTimer);
  searchInput.value = '';
  state.searchQuery = '';
  clearSearchBtn.classList.add('hidden');
  if (typeof updateResetFiltersButton === 'function') updateResetFiltersButton();
  loadCatalog();
});

if (resetFiltersBtn) {
  resetFiltersBtn.addEventListener('click', resetAllFilters);
}

if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', () => {
    clearHistory();
    renderCatalogGrid();
  });
}

document.getElementById('sidebarToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
});

document.getElementById('brandLogo').addEventListener('click', e => {
  e.preventDefault();
  resetAllFilters();
});

heroWatchBtn.addEventListener('click', () => {
  if (state.featuredItem) openItemModal(state.featuredItem, 'player');
});

heroInfoBtn.addEventListener('click', () => {
  if (state.featuredItem) openItemModal(state.featuredItem, 'info');
});

// Modal Tabs & Controls
document.querySelectorAll('.hdvb-tab').forEach(tab => {
  tab.addEventListener('click', () => switchModalTab(tab.dataset.tab));
});

switchToPlayerBtn.addEventListener('click', () => switchModalTab('player'));
closeModalBtn.addEventListener('click', closeItemModal);

if (theaterModeBtn && modalWindow) {
  theaterModeBtn.addEventListener('click', () => {
    const isWide = modalWindow.classList.toggle('theater-mode');
    theaterModeBtn.textContent = isWide ? 'Обычный вид' : 'Широкий экран';
  });
}

if (restartVideoBtn) {
  restartVideoBtn.addEventListener('click', () => {
    html5Video.currentTime = 0;
    html5Video.play().catch(() => {});
    saveLivePlaybackProgress();
    showPlayerOsd('С начала (0:00)');
  });
}

itemModal.addEventListener('click', e => {
  if (e.target === itemModal) closeItemModal();
});

modalFavBtn.addEventListener('click', () => {
  if (!state.currentItem) return;
  toggleFavorite(state.currentItem);
  updateFavButtonState();
});

balancerSelector.querySelectorAll('.chip-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const nextBalancer = btn.dataset.balancer;
    state.selectedBalancer = nextBalancer;
    updateBalancerButtons();
    const resumeAt = html5Video.currentTime || 0;

    if (isDirectHlsBalancer(nextBalancer) && state.currentItem) {
      nowPlayingText.textContent = `Переключение зеркала (${btn.textContent})...`;
      let updated = false;
      try {
        const clientData = await parseClientStreamBalancer(
          state.currentItem.imdbId,
          state.currentItem.kpId,
          nextBalancer
        );
        if (clientData.found) {
          state.currentItem.seasons = clientData.seasons;
          if (clientData.voices && clientData.voices.length) state.currentItem.voices = clientData.voices;
          if (clientData.embedUrl) state.currentItem.embedUrl = clientData.embedUrl;
          updated = true;
        }
      } catch (e) {}

      if (!updated) {
        try {
          const res = await fetch(
            `/api/details?imdb=${encodeURIComponent(state.currentItem.imdbId)}&title=${encodeURIComponent(state.currentItem.title)}&mirror=${encodeURIComponent(nextBalancer)}`
          );
          const refreshed = await res.json();
          if (refreshed && refreshed.seasons) {
            state.currentItem.seasons = refreshed.seasons;
            if (refreshed.voices && refreshed.voices.length) state.currentItem.voices = refreshed.voices;
            if (refreshed.providers) state.currentItem.providers = refreshed.providers;
          }
        } catch (e) {}
      }

      populatePlayerControls(state.currentItem);
      markFilesTabDirtyOrRefresh(state.currentItem);
      startPlayback(resumeAt, true);
      showPlayerOsd(`Источник: ${btn.textContent}`);
    } else {
      startPlayback(resumeAt, true);
    }
  });
});

applyCustomStreamBtn.addEventListener('click', () => startPlayback(0, true));
sandboxToggle.addEventListener('change', () => {
  applyIframeSandbox();
  if (!isDirectHlsBalancer(state.selectedBalancer)) startPlayback(0, true);
});

function switchEpisodeStep(delta, osdPrefix = '') {
  if (!state.currentItem) return;
  const target = getAdjacentEpisodeTarget(delta);
  if (!target) return;
  state.selectedSeason = target.season;
  state.selectedEpisode = target.episode;
  populatePlayerControls(state.currentItem);
  markFilesTabDirtyOrRefresh(state.currentItem);
  startPlayback(0, true);
  revealVideoOverlayControls(3200);
  const label = `Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}`;
  showPlayerOsd(osdPrefix ? `${osdPrefix}: ${label}` : label);
}

prevEpBtn.addEventListener('click', () => switchEpisodeStep(-1));
nextEpBtn.addEventListener('click', () => switchEpisodeStep(1));

if (overlayForward120Btn) {
  overlayForward120Btn.addEventListener('click', () => seekRelative(120));
}
if (overlayRewind120Btn) {
  overlayRewind120Btn.addEventListener('click', () => seekRelative(-120));
}
if (skip120Btn) {
  skip120Btn.addEventListener('click', () => seekRelative(120));
}
if (rewind120Btn) {
  rewind120Btn.addEventListener('click', () => seekRelative(-120));
}
if (overlayNextEpBtn) {
  overlayNextEpBtn.addEventListener('click', () => switchEpisodeStep(1, 'Следующая серия'));
}

playbackSpeedSelect.addEventListener('change', e => {
  html5Video.playbackRate = parseFloat(e.target.value);
  showPlayerOsd(`Скорость: ${e.target.value}x`);
});

pipBtn.addEventListener('click', async () => {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (html5Video.requestPictureInPicture) {
      await html5Video.requestPictureInPicture();
    }
  } catch (e) {}
});

fullscreenBtn.addEventListener('click', toggleVideoFullscreen);

html5Video.addEventListener('timeupdate', () => {
  updateSmartVideoOverlay();
  const now = Date.now();
  if (now - lastHistorySaveTs >= 5000) {
    lastHistorySaveTs = now;
    saveLivePlaybackProgress();
  }
});

['loadedmetadata', 'durationchange', 'seeked'].forEach(evt => {
  html5Video.addEventListener(evt, updateSmartVideoOverlay);
});

html5Video.addEventListener('play', () => {
  updateSmartVideoOverlay();
  revealVideoOverlayControls(2800);
});

html5Video.addEventListener('pause', () => {
  updateSmartVideoOverlay();
  if (overlayControlsTimer) clearTimeout(overlayControlsTimer);
  if (videoStageArea) videoStageArea.classList.add('controls-active');
  saveLivePlaybackProgress();
});

html5Video.addEventListener('ended', () => {
  saveLivePlaybackProgress();
  switchEpisodeStep(1, 'Автопереход');
});

if (videoStageArea) {
  videoStageArea.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    const now = Date.now();
    if (now - lastOverlayRevealTs >= 250) {
      lastOverlayRevealTs = now;
      revealVideoOverlayControls();
    }
  });
  videoStageArea.addEventListener('touchstart', () => revealVideoOverlayControls(), { passive: true });

  videoStageArea.addEventListener('touchend', e => {
    if (e.target.closest('.video-smart-overlay')) return;
    const rect = videoStageArea.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    // Ignore taps on bottom native controls strip
    if (y > rect.height - 54) return;
    const xRatio = x / rect.width;
    const side = xRatio < 0.4 ? -1 : (xRatio > 0.6 ? 1 : 0);
    if (side === 0) return;

    const now = Date.now();
    const windowMs = seekStreakDir === side ? 650 : 320;
    if (lastTouchTapSide === side && (now - lastTouchTapTime) <= windowMs) {
      if (e.cancelable) e.preventDefault();
      seekRelative(side * 5);
      lastTouchTapTime = now;
      lastTouchTapSide = side;
    } else {
      lastTouchTapTime = now;
      lastTouchTapSide = side;
    }
  }, { passive: false });

  videoStageArea.addEventListener('dblclick', e => {
    if (e.target.closest('.video-smart-overlay')) return;
    const rect = videoStageArea.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y > rect.height - 54) return;
    const xRatio = x / rect.width;
    if (xRatio < 0.35 || xRatio > 0.65) {
      e.preventDefault();
      seekRelative(xRatio < 0.5 ? -5 : 5);
    }
  });
}

refreshParsersBtn.addEventListener('click', () => {
  if (state.currentItem) {
    populateFilesTab(state.currentItem);
    filesTabDirty = false;
  }
});

parsersStatusBtn.addEventListener('click', () => parsersModal.classList.remove('hidden'));
closeParsersModalBtn.addEventListener('click', () => parsersModal.classList.add('hidden'));
parsersModal.addEventListener('click', e => {
  if (e.target === parsersModal) parsersModal.classList.add('hidden');
});

// Capture-phase ArrowLeft/ArrowRight 5s seek when direct player is active on PC
document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tag = document.activeElement?.tagName;
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (isTyping) return;
  if (
    !itemModal.classList.contains('hidden') &&
    state.activeTab === 'player' &&
    !directPlayerWrap.classList.contains('hidden') &&
    !currentTvFocusedEl
  ) {
    e.preventDefault();
    e.stopPropagation();
    seekRelative(e.key === 'ArrowRight' ? 5 : -5);
  }
}, true);

// Global Keyboard & Smart TV Remote Control (webOS Back=461, Tizen Back=10009, Media Keys)
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  // Quick search focus
  if (e.key === '/' && !isTyping && itemModal.classList.contains('hidden')) {
    e.preventDefault();
    searchInput.focus();
    return;
  }

  // Back / Escape handling (PC Escape, LG webOS 461, Samsung Tizen 10009)
  if (e.key === 'Escape' || e.keyCode === 461 || e.keyCode === 10009) {
    if (!parsersModal.classList.contains('hidden')) {
      e.preventDefault();
      parsersModal.classList.add('hidden');
      return;
    }
    if (!itemModal.classList.contains('hidden')) {
      e.preventDefault();
      closeItemModal();
      return;
    }
  }

  // Media Player Controls (Play/Pause, Seek, Fullscreen)
  if (!itemModal.classList.contains('hidden') && state.activeTab === 'player' && !isTyping) {
    if (e.key === ' ' || e.key === 'k' || e.key === 'MediaPlayPause' || e.keyCode === 179) {
      if (document.activeElement?.tagName !== 'BUTTON') {
        e.preventDefault();
        if (html5Video.paused) html5Video.play().catch(() => {});
        else html5Video.pause();
        return;
      }
    }
    if (e.keyCode === 415) { // TV Play
      e.preventDefault();
      html5Video.play().catch(() => {});
      return;
    }
    if (e.keyCode === 19) { // TV Pause
      e.preventDefault();
      html5Video.pause();
      return;
    }
    if (e.keyCode === 417) { // TV FastForward
      e.preventDefault();
      html5Video.currentTime = Math.min(html5Video.duration || 0, (html5Video.currentTime || 0) + 15);
      showPlayerOsd('+15 сек');
      return;
    }
    if (e.keyCode === 412) { // TV Rewind
      e.preventDefault();
      html5Video.currentTime = Math.max(0, (html5Video.currentTime || 0) - 15);
      showPlayerOsd('-15 сек');
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleVideoFullscreen();
      return;
    }
  }

  // D-Pad Arrow Key Spatial Navigation
  if (!isTyping && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    // If video itself is focused and user presses left/right, seek 10s
    if (document.activeElement === html5Video && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      return;
    }
    e.preventDefault();
    moveSpatialFocus(e.key);
    return;
  }

  if (!isTyping && e.key === 'Enter' && currentTvFocusedEl) {
    if (document.activeElement !== currentTvFocusedEl) {
      e.preventDefault();
      currentTvFocusedEl.click();
    }
  }
});

// Clear TV focus highlight when user switches to mouse/touch
document.addEventListener('pointerdown', clearTvFocus);

// Initialize
updateBadges();
loadCatalog();
