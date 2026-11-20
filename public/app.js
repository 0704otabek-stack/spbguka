// СПБГУКА — Cross-Platform Cinema App (PC, Linux, Android, iOS Safari, LG webOS Smart TV)

const isSmartTv = /web0s|webos|tizen|smart-tv|smarttv|netcast|lg browser|viera|hisense|philips/i.test(navigator.userAgent) ||
  new URLSearchParams(window.location.search).get('tv') === '1';
if (isSmartTv) {
  document.documentElement.classList.add('tv-mode');
}

const state = {
  category: 'all',
  animeSubFilter: 'all',
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
  preferredVoice: '',
  selectedQuality: 'Авто (Макс. 1080p)',
  selectedSubtitleTrack: -1,
  availableSubtitles: [],
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

let authToken = localStorage.getItem('spbguka_auth_token') || '';
let authUser = localStorage.getItem('spbguka_auth_user') || '';
let authMode = 'login';
let accountSyncTimer = null;
let lastAccountPullTs = 0;

let lastAnyTouchTs = 0;
let isPlayerScreenLocked = false;
let sleepTimerId = null;
let sleepTimerDeadline = 0;
let sleepTimerMode = 'off';
let sleepTimerTickInterval = null;
let sleepEndAfterEpisode = false;

function isCoarsePointerDevice() {
  return Boolean(
    window.matchMedia?.('(pointer: coarse)')?.matches ||
    ('ontouchstart' in window && window.innerWidth <= 1024)
  );
}

function recentlyTouched(windowMs = 1500) {
  return (Date.now() - lastAnyTouchTs) < windowMs;
}

function applyRefreshedToken(data) {
  if (data && data.refreshedToken && typeof setAuthSession === 'function') {
    const nextUser = data.user?.username || authUser || '';
    if (nextUser) setAuthSession(data.refreshedToken, nextUser);
  }
}

function isConfirmedAuthInvalid(status, data) {
  if (status !== 401) return false;
  if (!data || !data.code) return true;
  return data.code === 'INVALID_TOKEN' || data.code === 'TOKEN_EXPIRED' || data.code === 'UNAUTHORIZED';
}

async function restoreAuthSessionFromCookie() {
  try {
    const res = await fetch('/api/auth/me', {
      credentials: 'include',
      headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
    });
    if (res.status === 503) return false;
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.user) {
      if (data.refreshedToken) {
        setAuthSession(data.refreshedToken, data.user.username);
      } else if (!authToken && data.token) {
        setAuthSession(data.token, data.user.username);
      } else if (!authUser && data.user.username) {
        authUser = data.user.username;
        localStorage.setItem('spbguka_auth_user', authUser);
        updateAccountUI();
      }
      if (typeof applySyncedUser === 'function') applySyncedUser(data.user);
      return true;
    }
    if (authToken && isConfirmedAuthInvalid(res.status, data)) {
      setAuthSession('', '');
    }
  } catch {}
  return false;
}

const clientStreamCache = new Map();

function getClientMirrorList(preferredMirror = 'direct') {
  if (preferredMirror === 'kinokino') {
    return [
      'https://kinokino.vip',
      'https://api.namy.ws',
      'https://api.kinogram.best',
      'https://api.embess.ws',
      'https://api.delivembd.ws'
    ];
  }
  if (preferredMirror === 'namy') {
    return [
      'https://api.namy.ws',
      'https://api.kinogram.best',
      'https://api.embess.ws',
      'https://api.delivembd.ws'
    ];
  }
  if (preferredMirror === 'delivembd') {
    return [
      'https://api.delivembd.ws',
      'https://api.kinogram.best',
      'https://api.embess.ws',
      'https://api.namy.ws'
    ];
  }
  return [
    'https://api.kinogram.best',
    'https://api.namy.ws',
    'https://api.embess.ws',
    'https://api.delivembd.ws'
  ];
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

function getEpisodeVoiceTracks(item, ep) {
  if (ep?.voiceTracks && ep.voiceTracks.length > 0) return ep.voiceTracks;
  const rawNames = (ep?.voices && ep.voices.length)
    ? ep.voices
    : (item?.voices && item.voices.length ? item.voices : ['Рус. Дублированный']);
  return normalizeAudioTracks(rawNames, null);
}

function resolveVoiceSelection(item, ep, desiredName) {
  const tracks = getEpisodeVoiceTracks(item, ep);
  if (!desiredName) return tracks[0];
  const exact = tracks.find(t => t.name === desiredName);
  if (exact) return exact;
  const lower = desiredName.trim().toLowerCase();
  const ci = tracks.find(t => t.name.toLowerCase() === lower);
  if (ci) return ci;
  const stripSuffix = s => s.replace(/\s*\(\d+\)\s*$/, '').trim().toLowerCase();
  const baseWanted = stripSuffix(desiredName);
  const partial = tracks.find(t => stripSuffix(t.name) === baseWanted);
  if (partial) return partial;
  return tracks[0];
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
                hlsUrl: signedHls,
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
            embedUrl: mirror + p,
            seasons: seasonsMap,
            voices: Array.from(allVoicesSet)
          };
        }
      }

      // Single Movie with source.hls
      const hlsMatch = mkBlock.match(/hls\s*:\s*"([^"]+)"/);
      if (hlsMatch) {
        const rawMovieHls = hlsMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        const signedHls = token ? `${rawMovieHls}&${token}` : rawMovieHls;
        const voiceTracks = extractAudioFromBlock(mkBlock);
        const voices = voiceTracks.map(t => t.name);

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
                voiceTracks,
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
// Picks the mirror returning the most complete set of voiceover tracks without blocking on dead mirrors.
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
      const settledPromise = Promise.allSettled(mirrors.map(m => probeClientMirror(m, paths)))
        .then(outcomes => {
          const valid = outcomes
            .filter(o => o.status === 'fulfilled' && o.value && o.value.found)
            .map(o => o.value);
          if (valid.length === 0) return null;
          valid.sort((a, b) => (b.voices?.length || 0) - (a.voices?.length || 0));
          return valid[0];
        });
      result = await settledPromise;
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
        const flagVal = isSelected ? 'YES' : 'NO';
        line = /DEFAULT=(YES|NO)/.test(line)
          ? line.replace(/DEFAULT=(YES|NO)/g, `DEFAULT=${flagVal}`)
          : `${line},DEFAULT=${flagVal}`;
        line = /AUTOSELECT=(YES|NO)/.test(line)
          ? line.replace(/AUTOSELECT=(YES|NO)/g, `AUTOSELECT=${flagVal}`)
          : `${line},AUTOSELECT=${flagVal}`;
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
const mobileCategoryStrip = document.getElementById('mobileCategoryStrip');
const animeShelf = document.getElementById('animeShelf');
const animeShelfList = document.getElementById('animeShelfList');
const allAnimeBtn = document.getElementById('allAnimeBtn');
const animeSubBar = document.getElementById('animeSubBar');
const randomPickBtn = document.getElementById('randomPickBtn');
const mobAccountNavBtn = document.getElementById('mobAccountNavBtn');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const favCountBadge = document.getElementById('favCountBadge');
const historyCountBadge = document.getElementById('historyCountBadge');

const continueWatchingBar = document.getElementById('continueWatchingBar');
const continueCardsList = document.getElementById('continueCardsList');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const resetFiltersBtn = document.getElementById('resetFiltersBtn');
const loadMoreWrap = document.getElementById('loadMoreWrap');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const loadMoreBtnText = document.getElementById('loadMoreBtnText');
const loadMoreSpinner = document.getElementById('loadMoreSpinner');
const loadMoreHint = document.getElementById('loadMoreHint');

const catalogMoreState = new Map();
let isLoadingMoreCatalog = false;

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
const infoSimilarBlock = document.getElementById('infoSimilarBlock');
const infoSimilarGrid = document.getElementById('infoSimilarGrid');
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
const videoCenterControls = document.getElementById('videoCenterControls');
const videoCenterPrevEpBtn = document.getElementById('videoCenterPrevEpBtn');
const videoCenterPlayBtn = document.getElementById('videoCenterPlayBtn');
const videoCenterNextEpBtn = document.getElementById('videoCenterNextEpBtn');
const vcCenterPlayIcon = document.getElementById('vcCenterPlayIcon');
const vcCenterPauseIcon = document.getElementById('vcCenterPauseIcon');
const customVideoBar = document.getElementById('customVideoBar');
const videoProgressRange = document.getElementById('videoProgressRange');
const vcPlayPauseBtn = document.getElementById('vcPlayPauseBtn');
const vcPlayIcon = document.getElementById('vcPlayIcon');
const vcPauseIcon = document.getElementById('vcPauseIcon');
const vcBack5Btn = document.getElementById('vcBack5Btn');
const vcFwd5Btn = document.getElementById('vcFwd5Btn');
const vcVolDownBtn = document.getElementById('vcVolDownBtn');
const vcMuteBtn = document.getElementById('vcMuteBtn');
const vcVolIcon = document.getElementById('vcVolIcon');
const vcMuteIcon = document.getElementById('vcMuteIcon');
const vcVolumeRange = document.getElementById('vcVolumeRange');
const vcVolUpBtn = document.getElementById('vcVolUpBtn');
const videoTimeText = document.getElementById('videoTimeText');
const vcMoreBtn = document.getElementById('vcMoreBtn');
const vcMoreMenu = document.getElementById('vcMoreMenu');
const vcMoreCloseBtn = document.getElementById('vcMoreCloseBtn');
const vcSpeedChips = document.getElementById('vcSpeedChips');
const vcMenuCurrentSpeed = document.getElementById('vcMenuCurrentSpeed');
const vcQualityChips = document.getElementById('vcQualityChips');
const vcMenuCurrentQuality = document.getElementById('vcMenuCurrentQuality');
const vcAudioChips = document.getElementById('vcAudioChips');
const vcMenuCurrentAudio = document.getElementById('vcMenuCurrentAudio');
const vcSubChips = document.getElementById('vcSubChips');
const vcMenuCurrentSub = document.getElementById('vcMenuCurrentSub');
const vcDownloadBtn = document.getElementById('vcDownloadBtn');
const vcDownloadInfo = document.getElementById('vcDownloadInfo');
const vcLockBtn = document.getElementById('vcLockBtn');
const vcUnlockPill = document.getElementById('vcUnlockPill');
const vcSleepPill = document.getElementById('vcSleepPill');
const vcSleepChips = document.getElementById('vcSleepChips');
const vcMenuCurrentSleep = document.getElementById('vcMenuCurrentSleep');
const vcFullscreenBtn = document.getElementById('vcFullscreenBtn');
const vcFsEnterIcon = document.getElementById('vcFsEnterIcon');
const vcFsExitIcon = document.getElementById('vcFsExitIcon');
const vcFullscreenBtnText = document.getElementById('vcFullscreenBtnText');
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

// Actor Profile Modal Elements
const actorModal = document.getElementById('actorModal');
const actorModalBackdrop = document.getElementById('actorModalBackdrop');
const closeActorModalBtn = document.getElementById('closeActorModalBtn');
const actorAvatarInitials = document.getElementById('actorAvatarInitials');
const actorNameTitle = document.getElementById('actorNameTitle');
const actorFilmCount = document.getElementById('actorFilmCount');
const actorSearchInCatalogBtn = document.getElementById('actorSearchInCatalogBtn');
const actorFilmographyGrid = document.getElementById('actorFilmographyGrid');
const restartVideoBtn = document.getElementById('restartVideoBtn');
const rewind120Btn = document.getElementById('rewind120Btn');
const skip120Btn = document.getElementById('skip120Btn');
const playbackSpeedSelect = document.getElementById('playbackSpeedSelect');
const pipBtn = document.getElementById('pipBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
let isScrubbingVideo = false;
let videoClickTimer = null;

const iframePlayerWrap = document.getElementById('iframePlayerWrap');
const balancerIframe = document.getElementById('balancerIframe');
const kinoboxContainer = document.getElementById('kinoboxContainer');

const filesTreeContainer = document.getElementById('filesTreeContainer');
const refreshParsersBtn = document.getElementById('refreshParsersBtn');

// Sources Modal
const parsersModal = document.getElementById('parsersModal');
const parsersStatusBtn = document.getElementById('parsersStatusBtn');
const closeParsersModalBtn = document.getElementById('closeParsersModalBtn');

// Install / Apps Modal Elements
const installAppBtn = document.getElementById('installAppBtn');
const openInstallFromSidebarBtn = document.getElementById('openInstallFromSidebarBtn');
const openInstallFromAccountBtn = document.getElementById('openInstallFromAccountBtn');
const installModal = document.getElementById('installModal');
const closeInstallModalBtn = document.getElementById('closeInstallModalBtn');
const pwaInstallActionBtn = document.getElementById('pwaInstallActionBtn');
const pwaInstallHint = document.getElementById('pwaInstallHint');
const pwaRefreshAppBtn = document.getElementById('pwaRefreshAppBtn');

// Watch Party / Lobby Elements
const lobbyBtn = document.getElementById('lobbyBtn');
const lobbyOnlineDot = document.getElementById('lobbyOnlineDot');
const lobbyBtnBadge = document.getElementById('lobbyBtnBadge');
const lobbyModal = document.getElementById('lobbyModal');
const closeLobbyModalBtn = document.getElementById('closeLobbyModalBtn');
const lobbyServerStatusText = document.getElementById('lobbyServerStatusText');
const lobbyAuthRequiredView = document.getElementById('lobbyAuthRequiredView');
const lobbyLoginRedirectBtn = document.getElementById('lobbyLoginRedirectBtn');
const lobbyHubView = document.getElementById('lobbyHubView');
const lobbyInvitesBox = document.getElementById('lobbyInvitesBox');
const lobbyInvitesList = document.getElementById('lobbyInvitesList');
const lobbyCreateForm = document.getElementById('lobbyCreateForm');
const lobbyNameInput = document.getElementById('lobbyNameInput');
const lobbyJoinCodeForm = document.getElementById('lobbyJoinCodeForm');
const lobbyJoinCodeInput = document.getElementById('lobbyJoinCodeInput');
const lobbyHubOnlineCount = document.getElementById('lobbyHubOnlineCount');
const lobbyHubRefreshOnlineBtn = document.getElementById('lobbyHubRefreshOnlineBtn');
const lobbyHubOnlineList = document.getElementById('lobbyHubOnlineList');
const lobbyRoomView = document.getElementById('lobbyRoomView');
const lobbyRoomNameTitle = document.getElementById('lobbyRoomNameTitle');
const lobbyRoomCodeBadge = document.getElementById('lobbyRoomCodeBadge');
const lobbyRoomHostLabel = document.getElementById('lobbyRoomHostLabel');
const lobbyRoomCapacityLabel = document.getElementById('lobbyRoomCapacityLabel');
const lobbyBrowseFilmsBtn = document.getElementById('lobbyBrowseFilmsBtn');
const lobbyOpenPlaybackBtn = document.getElementById('lobbyOpenPlaybackBtn');
const lobbyLeaveBtn = document.getElementById('lobbyLeaveBtn');
const lobbyCloseRoomBtn = document.getElementById('lobbyCloseRoomBtn');
const lobbyNowWatchingCard = document.getElementById('lobbyNowWatchingCard');
const lobbyNowTitle = document.getElementById('lobbyNowTitle');
const lobbyNowState = document.getElementById('lobbyNowState');
const lobbySyncJumpBtn = document.getElementById('lobbySyncJumpBtn');
const lobbyTabMembersBtn = document.getElementById('lobbyTabMembersBtn');
const lobbyTabChatBtn = document.getElementById('lobbyTabChatBtn');
const lobbyModalChatBadge = document.getElementById('lobbyModalChatBadge');
const lobbyMembersPane = document.getElementById('lobbyMembersPane');
const lobbyChatPane = document.getElementById('lobbyChatPane');
const lobbyServerOnlineCount = document.getElementById('lobbyServerOnlineCount');
const lobbySearchRefreshBtn = document.getElementById('lobbySearchRefreshBtn');
const lobbyUserSearchInput = document.getElementById('lobbyUserSearchInput');
const lobbyUserSearchList = document.getElementById('lobbyUserSearchList');
const lobbyMembersCountText = document.getElementById('lobbyMembersCountText');
const lobbyMembersList = document.getElementById('lobbyMembersList');
const lobbyModalChatMessages = document.getElementById('lobbyModalChatMessages');
const lobbyModalChatForm = document.getElementById('lobbyModalChatForm');
const lobbyModalChatInput = document.getElementById('lobbyModalChatInput');

// In-Player Lobby HUD & Optional Chat Drawer
const vcLobbyChatBtn = document.getElementById('vcLobbyChatBtn');
const vcLobbyChatBadge = document.getElementById('vcLobbyChatBadge');
const lobbyPlayerPill = document.getElementById('lobbyPlayerPill');
const lobbyPlayerPillText = document.getElementById('lobbyPlayerPillText');
const lobbyAutoplayResumeBtn = document.getElementById('lobbyAutoplayResumeBtn');
const playerChatDrawer = document.getElementById('playerChatDrawer');
const playerChatTitle = document.getElementById('playerChatTitle');
const closePlayerChatBtn = document.getElementById('closePlayerChatBtn');
const playerChatMessages = document.getElementById('playerChatMessages');
const playerChatForm = document.getElementById('playerChatForm');
const playerChatInput = document.getElementById('playerChatInput');

// Floating Invite Toast
const lobbyInviteToast = document.getElementById('lobbyInviteToast');
const inviteToastTitle = document.getElementById('inviteToastTitle');
const inviteToastSub = document.getElementById('inviteToastSub');
const inviteToastAcceptBtn = document.getElementById('inviteToastAcceptBtn');
const inviteToastDeclineBtn = document.getElementById('inviteToastDeclineBtn');

// Account & Sync Elements
const accountBtn = document.getElementById('accountBtn');
const accountDot = document.getElementById('accountDot');
const accountBtnLabel = document.getElementById('accountBtnLabel');
const accountModal = document.getElementById('accountModal');
const closeAccountModalBtn = document.getElementById('closeAccountModalBtn');
const authGuestView = document.getElementById('authGuestView');
const authProfileView = document.getElementById('authProfileView');
const authTabLogin = document.getElementById('authTabLogin');
const authTabRegister = document.getElementById('authTabRegister');
const authForm = document.getElementById('authForm');
const authUsernameInput = document.getElementById('authUsernameInput');
const authPasswordInput = document.getElementById('authPasswordInput');
const authMessage = document.getElementById('authMessage');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const profileAvatar = document.getElementById('profileAvatar');
const profileUsername = document.getElementById('profileUsername');
const profileSyncStatus = document.getElementById('profileSyncStatus');
const profileHistoryCount = document.getElementById('profileHistoryCount');
const profileFavoritesCount = document.getElementById('profileFavoritesCount');
const syncNowBtn = document.getElementById('syncNowBtn');
const logoutBtn = document.getElementById('logoutBtn');

// Fresh Releases Shelf
const newReleasesShelf = document.getElementById('newReleasesShelf');
const newReleasesList = document.getElementById('newReleasesList');
const newReleasesTitle = document.getElementById('newReleasesTitle');
const newReleasesUpdated = document.getElementById('newReleasesUpdated');
const allNewReleasesBtn = document.getElementById('allNewReleasesBtn');
let catalogUpdatedAt = 0;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CATEGORY_TITLES = {
  all: 'Весь каталог',
  popular: 'Популярное сейчас',
  new: `Новинки ${new Date().getFullYear() - 1}–${new Date().getFullYear()}`,
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
  updateAccountUI();
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
  scheduleAccountPush('replace', false);
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
  updateAccountUI();
  scheduleAccountPush('merge', false);
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
    scheduleAccountPush('merge', false);
  }
}

function removeFromHistory(imdbId) {
  state.history = state.history.filter(x => x.imdbId !== imdbId);
  localStorage.setItem('spbguka_history', JSON.stringify(state.history));
  updateBadges();
  updateAccountUI();
  scheduleAccountPush('replace', false);
  if (state.category === 'history') loadCatalog();
}

function clearHistory() {
  state.history = [];
  localStorage.setItem('spbguka_history', '[]');
  updateBadges();
  updateAccountUI();
  scheduleAccountPush('replace', false);
  if (state.category === 'history') loadCatalog();
}

// --- Account & Cross-Device Progress Sync ---
function setAuthSession(token, username) {
  authToken = token || '';
  authUser = username || '';
  if (authToken) localStorage.setItem('spbguka_auth_token', authToken);
  else localStorage.removeItem('spbguka_auth_token');
  if (authUser) localStorage.setItem('spbguka_auth_user', authUser);
  else localStorage.removeItem('spbguka_auth_user');
  updateAccountUI();
  if (typeof syncLobbyAuthSession === 'function') syncLobbyAuthSession();
}

function updateAccountUI() {
  const loggedIn = Boolean(authToken && authUser);
  if (accountBtn) accountBtn.classList.toggle('is-logged-in', loggedIn);
  if (mobAccountNavBtn) mobAccountNavBtn.classList.toggle('is-logged-in', loggedIn);
  if (accountDot) accountDot.classList.toggle('hidden', !loggedIn);
  if (accountBtnLabel) accountBtnLabel.textContent = loggedIn ? authUser : 'Войти';
  if (authGuestView) authGuestView.classList.toggle('hidden', loggedIn);
  if (authProfileView) authProfileView.classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    if (profileAvatar) profileAvatar.textContent = authUser.slice(0, 1).toUpperCase();
    if (profileUsername) profileUsername.textContent = authUser;
    if (profileHistoryCount) profileHistoryCount.textContent = String(state.history.length);
    if (profileFavoritesCount) profileFavoritesCount.textContent = String(state.favorites.length);
  }
}

function applySyncedUser(userPayload) {
  if (!userPayload) return;
  if (userPayload.username) {
    authUser = userPayload.username;
    localStorage.setItem('spbguka_auth_user', authUser);
  }
  if (Array.isArray(userPayload.history)) {
    state.history = userPayload.history;
    localStorage.setItem('spbguka_history', JSON.stringify(state.history));
  }
  if (Array.isArray(userPayload.favorites)) {
    state.favorites = userPayload.favorites;
    localStorage.setItem('spbguka_favorites', JSON.stringify(state.favorites));
  }
  updateBadges();
  updateAccountUI();
  if (state.catalogItems && state.catalogItems.length > 0) {
    if (state.category === 'history' || state.category === 'favorites') {
      loadCatalog();
    } else {
      renderCatalogGrid(state.catalogItems);
    }
  }
  if (profileSyncStatus) {
    const timeStr = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    profileSyncStatus.textContent = `Синхронизировано в ${timeStr}`;
  }
}

async function pushAccountSync(mode = 'merge', keepalive = false) {
  if (!authToken) return false;
  try {
    const res = await fetch('/api/account/sync', {
      method: 'POST',
      credentials: 'include',
      keepalive,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        mode,
        history: state.history,
        favorites: state.favorites
      })
    });
    if (res.status === 503) return false;
    const data = await res.json().catch(() => null);
    if (isConfirmedAuthInvalid(res.status, data)) {
      setAuthSession('', '');
      return false;
    }
    if (!res.ok) return false;
    applyRefreshedToken(data);
    if (data && data.user && mode === 'merge') {
      applySyncedUser(data.user);
    } else if (profileSyncStatus) {
      const timeStr = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      profileSyncStatus.textContent = `Сохранено в ${timeStr}`;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function scheduleAccountPush(mode = 'merge', immediate = false) {
  if (!authToken) return;
  if (immediate) {
    if (accountSyncTimer) clearTimeout(accountSyncTimer);
    accountSyncTimer = null;
    pushAccountSync(mode, true);
    return;
  }
  if (accountSyncTimer) clearTimeout(accountSyncTimer);
  accountSyncTimer = setTimeout(() => {
    accountSyncTimer = null;
    pushAccountSync(mode, false);
  }, 1200);
}

async function pullAccountSync(force = false) {
  if (!authToken) return false;
  const now = Date.now();
  if (!force && (now - lastAccountPullTs) < 8000) return false;
  lastAccountPullTs = now;
  try {
    const res = await fetch('/api/account/sync', {
      credentials: 'include',
      headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
    });
    if (res.status === 503) return false;
    if (res.status === 401) {
      const errData = await res.json().catch(() => null);
      if (isConfirmedAuthInvalid(res.status, errData)) {
        setAuthSession('', '');
      }
      return false;
    }
    if (res.ok) {
      res.clone().json().then(d => applyRefreshedToken(d)).catch(() => {});
    }
    if (!res.ok) return false;
    const data = await res.json();
    if (data && data.user) {
      applySyncedUser(data.user);
      return true;
    }
  } catch (e) {}
  return false;
}

// --- Watch Party / Lobby System (Max 20 Participants, Host Playback Sync, Optional Chat) ---
const lobbyState = {
  lobby: null,
  invites: [],
  onlineTotal: 0,
  users: [],
  activeModalTab: 'members', // 'members' | 'chat'
  chatOpenInPlayer: false,
  unreadMessages: 0,
  lastSeqApplied: 0,
  serverClockOffsetMs: 0,
  sse: null,
  searchTimer: null,
  hostSyncTimer: null,
  hostHeartbeatTimer: null,
  pendingSyncPlayback: null,
  pendingAutoplayBlocked: false
};

let isApplyingLobbySync = false;

function isLobbyHost() {
  return Boolean(lobbyState.lobby && authUser && lobbyState.lobby.isHost);
}

function isLobbyGuest() {
  return Boolean(lobbyState.lobby && authUser && !lobbyState.lobby.isHost);
}

function guardLobbyGuestPlaybackControl() {
  if (!isLobbyGuest()) return false;
  showPlayerOsd(`Управляет главный: ${lobbyState.lobby?.hostUsername || 'хост'}`);
  return true;
}

function computeLobbyTargetTime(playback) {
  if (!playback) return 0;
  const base = Math.max(0, Number(playback.currentTime) || 0);
  if (playback.paused) return base;
  const estServerNow = Date.now() + lobbyState.serverClockOffsetMs;
  const elapsed = Math.max(0, (estServerNow - (Number(playback.updatedAt) || estServerNow)) / 1000);
  return base + elapsed;
}

async function lobbyApi(url, method = 'GET', body = null) {
  if (!authToken) throw new Error('Войдите в аккаунт');
  const opts = {
    method,
    credentials: 'include',
    headers: { 'Authorization': `Bearer ${authToken}` }
  };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (isConfirmedAuthInvalid(res.status, data)) {
    setAuthSession('', '');
  }
  if (!res.ok) {
    throw new Error(data.error || 'Ошибка запроса лобби');
  }
  return data;
}

function normalizeLobbyPayload(lobby) {
  if (!lobby) return null;
  const meLower = (authUser || '').toLowerCase();
  return {
    ...lobby,
    isHost: Boolean(meLower && lobby.hostUsername && lobby.hostUsername.toLowerCase() === meLower),
    messages: Array.isArray(lobby.messages) ? lobby.messages : [],
    members: Array.isArray(lobby.members) ? lobby.members : []
  };
}

function setCurrentLobby(rawLobby, skipPlaybackSync = false) {
  const prevLobbyId = lobbyState.lobby?.id || '';
  lobbyState.lobby = normalizeLobbyPayload(rawLobby);
  if (lobbyState.lobby && lobbyState.lobby.serverNow) {
    lobbyState.serverClockOffsetMs = lobbyState.lobby.serverNow - Date.now();
  }
  if (!lobbyState.lobby) {
    lobbyState.chatOpenInPlayer = false;
    lobbyState.unreadMessages = 0;
    lobbyState.lastSeqApplied = 0;
    lobbyState.pendingSyncPlayback = null;
    lobbyState.pendingAutoplayBlocked = false;
    stopHostSyncHeartbeat();
  } else if (prevLobbyId !== lobbyState.lobby.id) {
    lobbyState.unreadMessages = 0;
    lobbyState.lastSeqApplied = 0;
  }

  updateLobbyUi();

  if (lobbyState.lobby && lobbyState.lobby.isHost) {
    startHostSyncHeartbeat();
  } else {
    stopHostSyncHeartbeat();
  }

  if (!skipPlaybackSync && lobbyState.lobby && !lobbyState.lobby.isHost && lobbyState.lobby.playback?.mediaItem) {
    applyIncomingLobbyPlayback(lobbyState.lobby.playback, lobbyState.lobby.hostUsername, lobbyState.lobby.serverNow);
  }
}

function renderLobbyUserRow(u, mode) {
  const row = document.createElement('div');
  row.className = 'lobby-user-row';

  const meta = document.createElement('div');
  meta.className = 'lobby-user-meta';
  const dot = document.createElement('span');
  dot.className = `lobby-status-dot ${u.online ? 'is-online' : ''}`;
  const name = document.createElement('span');
  name.className = 'lobby-user-name';
  name.textContent = u.username;
  meta.append(dot, name);

  if (mode === 'member' && u.isHost) {
    const tag = document.createElement('span');
    tag.className = 'lobby-role-tag';
    tag.textContent = 'Главный';
    meta.appendChild(tag);
  } else {
    const st = document.createElement('span');
    st.className = `lobby-status-text ${u.online ? 'is-online' : ''}`;
    st.textContent = u.online ? 'Онлайн' : 'Офлайн';
    meta.appendChild(st);
  }

  const actions = document.createElement('div');
  actions.className = 'lobby-user-actions';

  if (mode === 'search') {
    if (u.inThisLobby) {
      const lbl = document.createElement('span');
      lbl.className = 'lobby-status-text is-online';
      lbl.textContent = 'В лобби';
      actions.appendChild(lbl);
    } else if (u.invited) {
      const lbl = document.createElement('span');
      lbl.className = 'lobby-status-text';
      lbl.textContent = 'Приглашён';
      actions.appendChild(lbl);
    } else {
      const invBtn = document.createElement('button');
      invBtn.className = 'btn-primary btn-xs focusable';
      invBtn.type = 'button';
      invBtn.textContent = 'Пригласить';
      invBtn.addEventListener('click', () => inviteUserToLobby(u.username, invBtn));
      actions.appendChild(invBtn);
    }
  } else if (mode === 'member' && isLobbyHost() && !u.isHost) {
    const passBtn = document.createElement('button');
    passBtn.className = 'btn-ghost btn-xs focusable';
    passBtn.type = 'button';
    passBtn.title = 'Передать права главного';
    passBtn.textContent = 'Сделать главным';
    passBtn.addEventListener('click', () => transferLobbyHost(u.username));

    const kickBtn = document.createElement('button');
    kickBtn.className = 'btn-danger-ghost btn-xs focusable';
    kickBtn.type = 'button';
    kickBtn.title = 'Исключить из лобби';
    kickBtn.textContent = 'Исключить';
    kickBtn.addEventListener('click', () => kickLobbyMember(u.username));
    actions.append(passBtn, kickBtn);
  }

  row.append(meta, actions);
  return row;
}

function renderChatListInto(container, messages) {
  if (!container) return;
  container.innerHTML = '';
  if (!messages || messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lobby-chat-msg is-system';
    empty.textContent = 'Пока нет сообщений. Напишите первым!';
    container.appendChild(empty);
    return;
  }
  const meLower = (authUser || '').toLowerCase();
  for (const m of messages) {
    const el = document.createElement('div');
    const isSelf = m.type !== 'system' && m.username && m.username.toLowerCase() === meLower;
    el.className = `lobby-chat-msg ${m.type === 'system' ? 'is-system' : ''} ${isSelf ? 'is-self' : ''}`;
    if (m.type === 'system') {
      el.textContent = m.text;
    } else {
      const authorSpan = document.createElement('span');
      authorSpan.className = 'chat-author';
      authorSpan.textContent = m.username || 'Гость';
      const textSpan = document.createElement('span');
      textSpan.textContent = m.text || '';
      const timeSpan = document.createElement('span');
      timeSpan.className = 'chat-time';
      timeSpan.textContent = new Date(m.ts || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      el.append(authorSpan, textSpan, timeSpan);
    }
    container.appendChild(el);
  }
  container.scrollTop = container.scrollHeight;
}

function renderLobbyInvites() {
  const invites = lobbyState.invites || [];
  if (lobbyInvitesBox) lobbyInvitesBox.classList.toggle('hidden', invites.length === 0);
  if (lobbyInvitesList) {
    lobbyInvitesList.innerHTML = '';
    for (const inv of invites) {
      const row = document.createElement('div');
      row.className = 'lobby-invite-row';
      const info = document.createElement('div');
      info.className = 'lobby-user-meta';
      const txt = document.createElement('span');
      txt.className = 'lobby-user-name';
      txt.textContent = `«${inv.lobbyName}» от ${inv.fromUsername} (${inv.memberCount}/${inv.maxParticipants})`;
      info.appendChild(txt);

      const acts = document.createElement('div');
      acts.className = 'lobby-user-actions';
      const acc = document.createElement('button');
      acc.className = 'btn-primary btn-xs focusable';
      acc.type = 'button';
      acc.textContent = 'Войти';
      acc.addEventListener('click', () => joinLobbyById(inv.lobbyId));
      const dec = document.createElement('button');
      dec.className = 'btn-ghost btn-xs focusable';
      dec.type = 'button';
      dec.textContent = 'Отклонить';
      dec.addEventListener('click', () => declineLobbyInvite(inv.lobbyId));
      acts.append(acc, dec);

      row.append(info, acts);
      lobbyInvitesList.appendChild(row);
    }
  }

  if (lobbyInviteToast) {
    const latest = invites[0];
    if (!latest || (lobbyState.lobby && lobbyState.lobby.id === latest.lobbyId)) {
      lobbyInviteToast.classList.add('hidden');
    } else {
      if (inviteToastTitle) inviteToastTitle.textContent = `Приглашение в лобби «${latest.lobbyName}»`;
      if (inviteToastSub) inviteToastSub.textContent = `От ${latest.fromUsername} • ${latest.memberCount}/${latest.maxParticipants} чел.`;
      lobbyInviteToast.dataset.lobbyId = latest.lobbyId;
      lobbyInviteToast.classList.remove('hidden');
    }
  }
}

function renderLobbyUsersSearchList() {
  const onlineCountText = String(lobbyState.onlineTotal || 0);
  if (lobbyHubOnlineCount) lobbyHubOnlineCount.textContent = onlineCountText;
  if (lobbyServerOnlineCount) lobbyServerOnlineCount.textContent = onlineCountText;

  if (lobbyHubOnlineList) {
    lobbyHubOnlineList.innerHTML = '';
    const onlineOnly = (lobbyState.users || []).filter(u => u.online);
    if (onlineOnly.length === 0) {
      const note = document.createElement('span');
      note.className = 'lobby-status-text';
      note.textContent = 'Сейчас других игроков онлайн не найдено';
      lobbyHubOnlineList.appendChild(note);
    } else {
      for (const u of onlineOnly) {
        const pill = document.createElement('span');
        pill.className = 'lobby-online-pill';
        const dot = document.createElement('span');
        dot.className = 'lobby-status-dot is-online';
        const nm = document.createElement('span');
        nm.textContent = u.username;
        pill.append(dot, nm);
        lobbyHubOnlineList.appendChild(pill);
      }
    }
  }

  if (lobbyUserSearchList) {
    lobbyUserSearchList.innerHTML = '';
    if (!lobbyState.users || lobbyState.users.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lobby-status-text';
      empty.style.padding = '6px 2px';
      empty.textContent = 'Никто не найден по запросу';
      lobbyUserSearchList.appendChild(empty);
    } else {
      for (const u of lobbyState.users) {
        lobbyUserSearchList.appendChild(renderLobbyUserRow(u, 'search'));
      }
    }
  }
}

function updateLobbyUi() {
  const loggedIn = Boolean(authToken && authUser);
  const lobby = lobbyState.lobby;
  const inviteCount = (lobbyState.invites || []).length;

  if (lobbyBtn) lobbyBtn.classList.toggle('in-lobby', Boolean(lobby));
  if (lobbyOnlineDot) lobbyOnlineDot.classList.toggle('hidden', !lobby);
  if (lobbyBtnBadge) {
    const badgeVal = lobby ? lobby.memberCount : inviteCount;
    lobbyBtnBadge.textContent = String(badgeVal);
    lobbyBtnBadge.classList.toggle('hidden', badgeVal <= 0);
  }

  if (lobbyServerStatusText) {
    lobbyServerStatusText.textContent = loggedIn
      ? `На сервере онлайн: ${lobbyState.onlineTotal} • До 20 человек в лобби`
      : 'До 20 человек • Главный управляет фильмом';
  }

  if (lobbyAuthRequiredView) lobbyAuthRequiredView.classList.toggle('hidden', loggedIn);
  if (lobbyHubView) lobbyHubView.classList.toggle('hidden', !loggedIn || Boolean(lobby));
  if (lobbyRoomView) lobbyRoomView.classList.toggle('hidden', !loggedIn || !lobby);

  // Player bar Chat button & badge (strictly optional, hidden when not in a lobby)
  if (vcLobbyChatBtn) vcLobbyChatBtn.classList.toggle('hidden', !lobby);
  if (vcLobbyChatBadge) {
    vcLobbyChatBadge.textContent = String(lobbyState.unreadMessages);
    vcLobbyChatBadge.classList.toggle('hidden', !lobby || lobbyState.unreadMessages <= 0);
  }
  if (lobbyModalChatBadge) {
    lobbyModalChatBadge.textContent = String(lobbyState.unreadMessages);
    lobbyModalChatBadge.classList.toggle('hidden', !lobby || lobbyState.unreadMessages <= 0);
  }
  if (playerChatDrawer) {
    playerChatDrawer.classList.toggle('hidden', !lobby || !lobbyState.chatOpenInPlayer);
  }
  if (lobbyPlayerPill && lobbyPlayerPillText) {
    lobbyPlayerPill.classList.toggle('hidden', !lobby);
    if (lobby) {
      lobbyPlayerPillText.textContent = lobby.isHost
        ? `Лобби «${lobby.name}» (${lobby.memberCount}/20) • Вы главный`
        : `Лобби «${lobby.name}» • Главный: ${lobby.hostUsername}`;
    }
  }
  if (lobbyAutoplayResumeBtn) {
    lobbyAutoplayResumeBtn.classList.toggle('hidden', !lobby || lobby.isHost || !lobbyState.pendingAutoplayBlocked);
  }

  renderLobbyInvites();

  if (!lobby) return;

  if (lobbyRoomNameTitle) lobbyRoomNameTitle.textContent = lobby.name;
  if (lobbyRoomCodeBadge) lobbyRoomCodeBadge.textContent = `Код: ${lobby.id}`;
  if (lobbyRoomHostLabel) {
    lobbyRoomHostLabel.textContent = lobby.isHost
      ? `Главный: ${lobby.hostUsername} (Вы)`
      : `Главный: ${lobby.hostUsername}`;
  }
  if (lobbyRoomCapacityLabel) {
    lobbyRoomCapacityLabel.textContent = `${lobby.memberCount} / ${lobby.maxParticipants} участников`;
  }
  if (lobbyMembersCountText) {
    lobbyMembersCountText.textContent = `${lobby.memberCount} / ${lobby.maxParticipants}`;
  }
  if (lobbyBrowseFilmsBtn) lobbyBrowseFilmsBtn.classList.toggle('hidden', !lobby.isHost);
  if (lobbyCloseRoomBtn) lobbyCloseRoomBtn.classList.toggle('hidden', !lobby.isHost);
  if (lobbyOpenPlaybackBtn) lobbyOpenPlaybackBtn.classList.toggle('hidden', !lobby.playback?.mediaItem);

  if (lobbyNowWatchingCard) {
    const hasMedia = Boolean(lobby.playback?.mediaItem);
    lobbyNowWatchingCard.classList.toggle('hidden', !hasMedia);
    if (hasMedia) {
      if (lobbyNowTitle) lobbyNowTitle.textContent = lobby.playback.mediaItem.title || 'Фильм';
      if (lobbyNowState) {
        const curSec = Math.floor(computeLobbyTargetTime(lobby.playback));
        const statusStr = lobby.playback.paused ? 'На паузе' : 'Смотрят сейчас';
        lobbyNowState.textContent = `${statusStr} • ${formatPlayerTime(curSec)}`;
      }
    }
  }

  if (playerChatTitle) playerChatTitle.textContent = `Чат: ${lobby.name}`;

  if (lobbyMembersList) {
    lobbyMembersList.innerHTML = '';
    for (const m of lobby.members) {
      lobbyMembersList.appendChild(renderLobbyUserRow(m, 'member'));
    }
  }

  renderChatListInto(playerChatMessages, lobby.messages);
  renderChatListInto(lobbyModalChatMessages, lobby.messages);
}

function setLobbyModalTab(tabName) {
  lobbyState.activeModalTab = tabName === 'chat' ? 'chat' : 'members';
  if (lobbyTabMembersBtn) lobbyTabMembersBtn.classList.toggle('active', lobbyState.activeModalTab === 'members');
  if (lobbyTabChatBtn) lobbyTabChatBtn.classList.toggle('active', lobbyState.activeModalTab === 'chat');
  if (lobbyMembersPane) lobbyMembersPane.classList.toggle('hidden', lobbyState.activeModalTab !== 'members');
  if (lobbyChatPane) lobbyChatPane.classList.toggle('hidden', lobbyState.activeModalTab !== 'chat');
  if (lobbyState.activeModalTab === 'chat') {
    lobbyState.unreadMessages = 0;
    updateLobbyUi();
  }
}

async function fetchLobbyUsers(query = '') {
  if (!authToken) return;
  try {
    const data = await lobbyApi(`/api/lobby/users?q=${encodeURIComponent(query)}`);
    lobbyState.users = Array.isArray(data.users) ? data.users : [];
    lobbyState.onlineTotal = Number(data.onlineTotal) || 0;
    renderLobbyUsersSearchList();
    updateLobbyUi();
  } catch (e) {}
}

async function refreshLobbyState() {
  if (!authToken) return;
  try {
    const data = await lobbyApi('/api/lobby/state');
    lobbyState.invites = Array.isArray(data.invites) ? data.invites : [];
    lobbyState.onlineTotal = Number(data.onlineTotal) || 0;
    if (data.serverNow) lobbyState.serverClockOffsetMs = data.serverNow - Date.now();
    setCurrentLobby(data.lobby || null);
  } catch (e) {}
}

function disconnectLobbyEvents() {
  if (lobbyState.sse) {
    try { lobbyState.sse.close(); } catch (e) {}
    lobbyState.sse = null;
  }
  stopHostSyncHeartbeat();
}

function connectLobbyEvents() {
  disconnectLobbyEvents();
  if (!authToken || typeof EventSource === 'undefined') return;
  const es = new EventSource(`/api/lobby/events?token=${encodeURIComponent(authToken)}`);
  lobbyState.sse = es;

  es.addEventListener('init', ev => {
    try {
      const data = JSON.parse(ev.data);
      if (data.serverNow) lobbyState.serverClockOffsetMs = data.serverNow - Date.now();
      lobbyState.invites = Array.isArray(data.invites) ? data.invites : [];
      lobbyState.onlineTotal = Number(data.onlineCount) || 0;
      setCurrentLobby(data.lobby || null);
      if (lobbyModal && !lobbyModal.classList.contains('hidden')) {
        fetchLobbyUsers(lobbyUserSearchInput?.value.trim() || '');
      }
    } catch (e) {}
  });

  es.addEventListener('presence_pulse', ev => {
    try {
      const data = JSON.parse(ev.data);
      lobbyState.onlineTotal = Number(data.onlineCount) || lobbyState.onlineTotal;
      updateLobbyUi();
      if (lobbyModal && !lobbyModal.classList.contains('hidden')) {
        fetchLobbyUsers(lobbyUserSearchInput?.value.trim() || '');
      }
    } catch (e) {}
  });

  es.addEventListener('invite', ev => {
    try {
      const data = JSON.parse(ev.data);
      lobbyState.invites = Array.isArray(data.invites) ? data.invites : lobbyState.invites;
      updateLobbyUi();
      if (data.invite) {
        showPlayerOsd(`Приглашение в лобби «${data.invite.lobbyName}» от ${data.invite.fromUsername}`);
      }
    } catch (e) {}
  });

  es.addEventListener('invites_update', ev => {
    try {
      const data = JSON.parse(ev.data);
      lobbyState.invites = Array.isArray(data.invites) ? data.invites : [];
      updateLobbyUi();
    } catch (e) {}
  });

  es.addEventListener('lobby_update', ev => {
    try {
      const data = JSON.parse(ev.data);
      setCurrentLobby(data.lobby || null, true);
      if (lobbyModal && !lobbyModal.classList.contains('hidden')) {
        fetchLobbyUsers(lobbyUserSearchInput?.value.trim() || '');
      }
    } catch (e) {}
  });

  es.addEventListener('playback_sync', ev => {
    try {
      const data = JSON.parse(ev.data);
      if (data.serverNow) lobbyState.serverClockOffsetMs = data.serverNow - Date.now();
      if (lobbyState.lobby && data.playback) {
        lobbyState.lobby.playback = data.playback;
        if (data.hostUsername) {
          lobbyState.lobby.hostUsername = data.hostUsername;
          lobbyState.lobby.isHost = Boolean(authUser && data.hostUsername.toLowerCase() === authUser.toLowerCase());
        }
        updateLobbyUi();
        if (!lobbyState.lobby.isHost) {
          applyIncomingLobbyPlayback(data.playback, data.hostUsername || lobbyState.lobby.hostUsername, data.serverNow);
        }
      }
    } catch (e) {}
  });

  es.addEventListener('chat_message', ev => {
    try {
      const data = JSON.parse(ev.data);
      if (!lobbyState.lobby || !data.message || data.lobbyId !== lobbyState.lobby.id) return;
      lobbyState.lobby.messages.push(data.message);
      if (lobbyState.lobby.messages.length > 80) {
        lobbyState.lobby.messages = lobbyState.lobby.messages.slice(-80);
      }
      const chatVisibleInModal = lobbyModal && !lobbyModal.classList.contains('hidden') && lobbyState.activeModalTab === 'chat';
      const chatVisibleInPlayer = !itemModal.classList.contains('hidden') && lobbyState.chatOpenInPlayer;
      if (!chatVisibleInModal && !chatVisibleInPlayer && data.message.type === 'user' && data.message.username?.toLowerCase() !== (authUser || '').toLowerCase()) {
        lobbyState.unreadMessages += 1;
      }
      updateLobbyUi();
    } catch (e) {}
  });

  es.addEventListener('lobby_closed', ev => {
    try {
      const data = JSON.parse(ev.data);
      setCurrentLobby(null, true);
      showPlayerOsd(data.reason || 'Лобби закрыто');
    } catch (e) {}
  });

  es.addEventListener('lobby_kicked', ev => {
    try {
      const data = JSON.parse(ev.data);
      setCurrentLobby(null, true);
      showPlayerOsd(data.reason || 'Вас исключили из лобби');
    } catch (e) {}
  });
}

function syncLobbyAuthSession() {
  if (authToken && authUser) {
    connectLobbyEvents();
    refreshLobbyState();
  } else {
    disconnectLobbyEvents();
    lobbyState.invites = [];
    lobbyState.users = [];
    lobbyState.onlineTotal = 0;
    setCurrentLobby(null, true);
  }
}

async function emitHostPlaybackSync(actionLabel = '', overrides = {}) {
  if (!isLobbyHost() || isApplyingLobbySync) return;
  const mediaItem = overrides.mediaItem !== undefined ? overrides.mediaItem : state.currentItem;
  if (!mediaItem) return;
  const pausedVal = typeof overrides.paused === 'boolean'
    ? overrides.paused
    : (!html5Video || html5Video.paused || html5Video.ended);
  const timeVal = typeof overrides.currentTime === 'number'
    ? overrides.currentTime
    : (Number.isFinite(html5Video?.currentTime) ? html5Video.currentTime : 0);

  try {
    const res = await lobbyApi('/api/lobby/sync', 'POST', {
      mediaItem,
      season: Number(overrides.season ?? state.selectedSeason) || 1,
      episode: Number(overrides.episode ?? state.selectedEpisode) || 1,
      voice: overrides.voice ?? state.selectedVoice ?? '',
      balancer: overrides.balancer ?? state.selectedBalancer ?? 'direct',
      paused: pausedVal,
      currentTime: Math.max(0, timeVal),
      actionLabel
    });
    if (res.serverNow) lobbyState.serverClockOffsetMs = res.serverNow - Date.now();
    if (res.playback && lobbyState.lobby) {
      lobbyState.lobby.playback = res.playback;
      lobbyState.lastSeqApplied = res.playback.seq || lobbyState.lastSeqApplied;
      updateLobbyUi();
    }
  } catch (e) {}
}

function scheduleHostPlaybackSync(actionLabel = '', delayMs = 80, overrides = {}) {
  if (!isLobbyHost() || isApplyingLobbySync) return;
  if (lobbyState.hostSyncTimer) clearTimeout(lobbyState.hostSyncTimer);
  lobbyState.hostSyncTimer = setTimeout(() => {
    lobbyState.hostSyncTimer = null;
    emitHostPlaybackSync(actionLabel, overrides);
  }, delayMs);
}

function startHostSyncHeartbeat() {
  stopHostSyncHeartbeat();
  lobbyState.hostHeartbeatTimer = setInterval(() => {
    if (!isLobbyHost()) return;
    if (!itemModal.classList.contains('hidden') && state.currentItem && html5Video && !html5Video.paused && !html5Video.ended) {
      emitHostPlaybackSync('', { paused: false, currentTime: html5Video.currentTime });
    }
  }, 6000);
}

function stopHostSyncHeartbeat() {
  if (lobbyState.hostHeartbeatTimer) {
    clearInterval(lobbyState.hostHeartbeatTimer);
    lobbyState.hostHeartbeatTimer = null;
  }
}

function applyIncomingLobbyPlayback(playback, hostUsername = 'хост', serverNow = null) {
  if (!playback || !playback.mediaItem || !isLobbyGuest()) return;
  if (serverNow) lobbyState.serverClockOffsetMs = serverNow - Date.now();
  const seq = Number(playback.seq) || 0;
  if (seq > 0 && seq < lobbyState.lastSeqApplied) return;
  lobbyState.lastSeqApplied = seq;

  const targetTime = computeLobbyTargetTime(playback);
  const sameMovieOpen = !itemModal.classList.contains('hidden') && state.currentItem?.imdbId === playback.imdbId;
  const sameEpisode = Number(state.selectedSeason) === Number(playback.season || 1) &&
    Number(state.selectedEpisode) === Number(playback.episode || 1) &&
    state.selectedBalancer === (playback.balancer || 'direct');

  if (!sameMovieOpen) {
    lobbyState.pendingSyncPlayback = playback;
    if (lobbyModal && !lobbyModal.classList.contains('hidden')) {
      lobbyModal.classList.add('hidden');
      replaceOverlayHistory('lobby', 'item');
    } else {
      pushOverlayHistory('item');
    }
    openItemModal(playback.mediaItem, 'player', {
      season: playback.season || 1,
      episode: playback.episode || 1,
      voice: playback.voice || '',
      balancer: playback.balancer || 'direct',
      resumeSeconds: targetTime,
      paused: Boolean(playback.paused)
    });
    showPlayerOsd(`${hostUsername}: ${playback.actionLabel || playback.mediaItem.title}`);
    return;
  }

  if (!sameEpisode) {
    lobbyState.pendingSyncPlayback = playback;
    isApplyingLobbySync = true;
    state.selectedSeason = Number(playback.season) || 1;
    state.selectedEpisode = Number(playback.episode) || 1;
    state.selectedBalancer = playback.balancer || 'direct';
    if (playback.voice) state.preferredVoice = playback.voice;
    updateBalancerButtons();
    populatePlayerControls(state.currentItem);
    markFilesTabDirtyOrRefresh(state.currentItem);
    startPlayback(targetTime, true, { startPaused: Boolean(playback.paused) });
    setTimeout(() => { isApplyingLobbySync = false; }, 120);
    showPlayerOsd(`${hostUsername}: Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}`);
    return;
  }

  // Same movie and episode currently loaded in player
  isApplyingLobbySync = true;
  try {
    if (Math.abs((html5Video.currentTime || 0) - targetTime) > 1.8 && html5Video.readyState >= 1) {
      html5Video.currentTime = targetTime;
    }
    if (playback.paused) {
      lobbyState.pendingAutoplayBlocked = false;
      if (!html5Video.paused) html5Video.pause();
      if (playback.actionLabel) showPlayerOsd(`${hostUsername}: ${playback.actionLabel}`);
    } else if (html5Video.paused) {
      const p = html5Video.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          lobbyState.pendingAutoplayBlocked = false;
          updateLobbyUi();
        }).catch(() => {
          lobbyState.pendingAutoplayBlocked = true;
          updateLobbyUi();
          showPlayerOsd(`Нажмите ▶ чтобы продолжить с ${hostUsername}`);
        });
      }
      if (playback.actionLabel) showPlayerOsd(`${hostUsername}: ${playback.actionLabel}`);
    }
    updateCustomVideoBar();
    updateLobbyUi();
  } finally {
    setTimeout(() => { isApplyingLobbySync = false; }, 120);
  }
}

async function inviteUserToLobby(targetUsername, btnEl = null) {
  if (!lobbyState.lobby) return;
  if (btnEl) btnEl.disabled = true;
  try {
    const res = await lobbyApi('/api/lobby/invite', 'POST', { targetUsername });
    showPlayerOsd(`Приглашение отправлено: ${res.invitedUsername}`);
    await fetchLobbyUsers(lobbyUserSearchInput?.value.trim() || '');
  } catch (err) {
    showPlayerOsd(err.message);
    if (btnEl) btnEl.disabled = false;
  }
}

async function joinLobbyById(lobbyId) {
  if (!lobbyId) return;
  try {
    const data = await lobbyApi('/api/lobby/join', 'POST', { lobbyId });
    lobbyState.invites = Array.isArray(data.invites) ? data.invites : [];
    setCurrentLobby(data.lobby);
    showPlayerOsd(`Вы в лобби «${data.lobby.name}»`);
    fetchLobbyUsers(lobbyUserSearchInput?.value.trim() || '');
  } catch (err) {
    showPlayerOsd(err.message);
  }
}

async function declineLobbyInvite(lobbyId) {
  try {
    const data = await lobbyApi('/api/lobby/decline', 'POST', { lobbyId });
    lobbyState.invites = Array.isArray(data.invites) ? data.invites : [];
    updateLobbyUi();
  } catch (e) {}
}

async function kickLobbyMember(targetUsername) {
  try {
    const data = await lobbyApi('/api/lobby/kick', 'POST', { targetUsername });
    setCurrentLobby(data.lobby, true);
    showPlayerOsd(`${targetUsername} исключён`);
    fetchLobbyUsers(lobbyUserSearchInput?.value.trim() || '');
  } catch (err) {
    showPlayerOsd(err.message);
  }
}

async function transferLobbyHost(targetUsername) {
  try {
    const data = await lobbyApi('/api/lobby/transfer-host', 'POST', { targetUsername });
    setCurrentLobby(data.lobby, true);
    showPlayerOsd(`Новый главный: ${targetUsername}`);
  } catch (err) {
    showPlayerOsd(err.message);
  }
}

async function sendLobbyChatText(rawText) {
  const text = String(rawText || '').trim();
  if (!text || !lobbyState.lobby) return false;
  try {
    await lobbyApi('/api/lobby/chat', 'POST', { text });
    return true;
  } catch (err) {
    showPlayerOsd(err.message);
    return false;
  }
}

function togglePlayerChatDrawer(forceState = null, { fromPopstate = false } = {}) {
  if (!lobbyState.lobby) return;
  lobbyState.chatOpenInPlayer = forceState === null ? !lobbyState.chatOpenInPlayer : Boolean(forceState);
  if (lobbyState.chatOpenInPlayer) {
    lobbyState.unreadMessages = 0;
  }
  updateLobbyUi();
  if (lobbyState.chatOpenInPlayer) pushOverlayHistory('chat');
  else if (!fromPopstate) popOverlayHistory('chat');
}

function openLobbyModal() {
  if (!lobbyModal) return;
  updateLobbyUi();
  lobbyModal.classList.remove('hidden');
  pushOverlayHistory('lobby');
  if (authToken) {
    refreshLobbyState().then(() => fetchLobbyUsers(lobbyUserSearchInput?.value.trim() || ''));
  }
}

function updateResetFiltersButton() {
  const dirty = state.genre !== 'all' || state.year !== 'all' || state.sort !== 'popular' || state.searchQuery.trim() !== '';
  if (resetFiltersBtn) resetFiltersBtn.classList.toggle('hidden', !dirty);
}

function syncCategoryButtons(category) {
  document.querySelectorAll('.nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.category === category);
  });
  document.querySelectorAll('.mob-nav-item[data-category]').forEach(b => {
    b.classList.toggle('active', b.dataset.category === category);
  });
  document.querySelectorAll('.mob-cat-pill').forEach(b => {
    b.classList.toggle('active', b.dataset.category === category);
  });
  if (mobAccountNavBtn) mobAccountNavBtn.classList.remove('active');
  if (animeSubBar) {
    animeSubBar.classList.toggle('hidden', category !== 'anime');
    animeSubBar.querySelectorAll('.anime-sub-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.animeSub === state.animeSubFilter);
    });
  }
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
  heroBadge.textContent = `${featured.isNew ? 'Новинка · ' : ''}${TYPE_LABELS[featured.type] || 'В фокусе'}`;
  heroKp.textContent = `КП ${featured.ratingKp || '8.5'}`;
  heroImdb.textContent = `IMDb ${featured.ratingImdb || '8.6'}`;
  heroYear.textContent = featured.yearRange || featured.year || '2024';
  heroGenres.textContent = (featured.genres || []).slice(0, 3).join(', ');
  heroTitle.textContent = featured.title;
  heroSynopsis.textContent = featured.description || '';
}

function isAnimeSeriesItem(item) {
  if (!item) return false;
  if (Number(item.seasons) > 0 || Number(item.totalSeasons) > 0) return true;
  if (/сери|сезон|episode|series/i.test(String(item.duration || ''))) return true;
  if (/[–-]/.test(String(item.yearRange || ''))) return true;
  return false;
}

function getFilteredLocalCatalog() {
  let list = [...(state.masterCatalog || [])];
  const newThreshold = new Date().getFullYear() - 2;

  if (state.category === 'new') list = list.filter(x => x.isNew || x.year >= newThreshold);
  else if (state.category === 'popular') list = list.filter(x => x.isPopular);
  else if (state.category === 'movie') list = list.filter(x => x.type === 'movie');
  else if (state.category === 'series') list = list.filter(x => x.type === 'series');
  else if (state.category === 'cartoon') list = list.filter(x => x.type === 'cartoon');
  else if (state.category === 'anime') {
    list = list.filter(x => x.type === 'anime');
    if (state.animeSubFilter === 'new') {
      list = list.filter(x => x.isNew || (Number(x.year) || 0) >= newThreshold);
    } else if (state.animeSubFilter === 'series') {
      list = list.filter(x => isAnimeSeriesItem(x));
    } else if (state.animeSubFilter === 'movie') {
      list = list.filter(x => !isAnimeSeriesItem(x));
    }
    if (state.animeSubFilter === 'top') {
      list.sort((a, b) => Math.max(Number(b.ratingKp) || 0, Number(b.ratingImdb) || 0) - Math.max(Number(a.ratingKp) || 0, Number(a.ratingImdb) || 0));
    }
  }

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
  } else if (state.sort === 'year' || (state.category === 'new' && state.sort === 'popular')) {
    list.sort((a, b) => ((b.year || 0) - (a.year || 0)) || ((b.ratingImdb || 0) - (a.ratingImdb || 0)));
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
        catalogUpdatedAt = Number(data.updatedAt) || 0;
      } catch (e) {
        state.masterCatalog = [];
      }
    }
    state.catalogItems = getFilteredLocalCatalog();
  }

  loadingState.classList.add('hidden');
  renderHeroBanner(state.catalogItems);
  renderNewReleasesShelf();
  renderAnimeShelf();
  renderCatalogGrid(state.catalogItems);
}

function renderAnimeShelf() {
  if (!animeShelf || !animeShelfList) return;
  const showOnHome = !state.searchQuery && (state.category === 'all' || state.category === 'new');
  const pool = (state.masterCatalog && state.masterCatalog.length ? state.masterCatalog : state.catalogItems) || [];
  const animeItems = pool
    .filter(x => x && x.type === 'anime')
    .sort((a, b) => {
      const ra = Math.max(Number(a.ratingKp) || 0, Number(a.ratingImdb) || 0);
      const rb = Math.max(Number(b.ratingKp) || 0, Number(b.ratingImdb) || 0);
      if (rb !== ra) return rb - ra;
      return (Number(b.year) || 0) - (Number(a.year) || 0);
    })
    .slice(0, 16);

  if (!showOnHome || animeItems.length === 0) {
    animeShelf.classList.add('hidden');
    return;
  }

  animeShelfList.innerHTML = '';
  for (const item of animeItems) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'release-card focusable';
    const rating = item.ratingKp || item.ratingImdb || '';
    const subKind = isAnimeSeriesItem(item) ? 'Аниме-сериал' : 'Аниме-фильм';
    const genre = (item.genres || []).find(g => g !== 'Аниме') || 'Аниме';
    card.innerHTML = `
      <div class="release-poster-wrap">
        <img class="release-poster" src="${escapeHtml(item.poster)}" alt="${escapeHtml(item.title)}" loading="lazy" decoding="async" />
        <span class="release-year">${escapeHtml(item.year || '')}</span>
        ${rating ? `<span class="r-badge imdb release-rating">${escapeHtml(rating)}</span>` : ''}
      </div>
      <div class="release-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
      <div class="release-sub">${escapeHtml(subKind)} • ${escapeHtml(genre)}</div>
    `;
    card.addEventListener('click', () => openItemModal(item, 'player'));
    animeShelfList.appendChild(card);
  }
  animeShelf.classList.remove('hidden');
}

function renderNewReleasesShelf() {
  if (!newReleasesShelf || !newReleasesList) return;
  const show = state.category === 'all' &&
    !state.searchQuery.trim() &&
    state.genre === 'all' &&
    state.year === 'all' &&
    Array.isArray(state.masterCatalog);

  const fresh = show
    ? state.masterCatalog
        .filter(x => x.isNew)
        .sort((a, b) => ((b.year || 0) - (a.year || 0)) || ((b.ratingImdb || 0) - (a.ratingImdb || 0)))
        .slice(0, 14)
    : [];

  if (fresh.length < 3) {
    newReleasesShelf.classList.add('hidden');
    return;
  }

  const thisYear = new Date().getFullYear();
  if (newReleasesTitle) newReleasesTitle.textContent = `Новинки ${thisYear - 1}–${thisYear}`;
  if (newReleasesUpdated) {
    newReleasesUpdated.textContent = catalogUpdatedAt
      ? `обновлено ${new Date(catalogUpdatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      : '';
  }

  newReleasesList.innerHTML = '';
  for (const item of fresh) {
    const card = document.createElement('article');
    card.className = 'release-card focusable';
    card.tabIndex = 0;
    const typeLabel = TYPE_LABELS[item.type] || 'Кино';
    const genre = (item.genres || [])[0] || '';
    card.innerHTML = `
      <div class="release-poster-wrap">
        <img
          src="${escapeHtml(item.poster)}"
          alt="${escapeHtml(item.title)}"
          class="release-poster"
          loading="lazy"
          decoding="async"
          onerror="this.src='https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=400&q=70'"
        />
        <span class="release-year">${escapeHtml(item.year || '')}</span>
        ${item.ratingImdb ? `<span class="r-badge imdb release-rating">${escapeHtml(item.ratingImdb)}</span>` : ''}
      </div>
      <div class="release-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
      <div class="release-sub">${escapeHtml(typeLabel)}${genre ? ` • ${escapeHtml(genre)}` : ''}</div>
    `;
    card.addEventListener('click', () => openItemModal(item, 'player'));
    newReleasesList.appendChild(card);
  }
  newReleasesShelf.classList.remove('hidden');
}

function getCurrentCatalogViewKey() {
  return `${state.category}|${state.animeSubFilter}|${state.genre}|${state.year}|${state.sort}`;
}

function updateLoadMoreUi() {
  if (!loadMoreWrap || !loadMoreBtn) return;
  const hiddenView = Boolean(
    state.searchQuery.trim() ||
    state.category === 'favorites' ||
    state.category === 'history' ||
    !state.catalogItems ||
    state.catalogItems.length === 0
  );
  if (hiddenView) {
    loadMoreWrap.classList.add('hidden');
    return;
  }

  loadMoreWrap.classList.remove('hidden');
  const viewState = catalogMoreState.get(getCurrentCatalogViewKey()) || { page: 0, exhausted: false };

  if (viewState.exhausted) {
    loadMoreBtn.disabled = true;
    if (loadMoreBtnText) loadMoreBtnText.textContent = 'Все тайтлы загружены';
    if (loadMoreSpinner) loadMoreSpinner.classList.add('hidden');
    if (loadMoreHint) loadMoreHint.textContent = `Показано ${state.catalogItems.length} тайтлов`;
  } else if (isLoadingMoreCatalog) {
    loadMoreBtn.disabled = true;
    if (loadMoreBtnText) loadMoreBtnText.textContent = 'Загружаем ещё...';
    if (loadMoreSpinner) loadMoreSpinner.classList.remove('hidden');
    if (loadMoreHint) loadMoreHint.textContent = `Показано ${state.catalogItems.length} тайтлов`;
  } else {
    loadMoreBtn.disabled = false;
    if (loadMoreBtnText) loadMoreBtnText.textContent = 'Показать ещё';
    if (loadMoreSpinner) loadMoreSpinner.classList.add('hidden');
    if (loadMoreHint) loadMoreHint.textContent = `Показано ${state.catalogItems.length} тайтлов • нажмите, чтобы загрузить ещё`;
  }
}

function createMovieCardElement(item, favIds, historyMap) {
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
      ${item.isNew ? '<span class="card-new-pill">Новинка</span>' : ''}
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
  return card;
}

function appendCatalogCards(newItems) {
  if (!Array.isArray(newItems) || newItems.length === 0) return;
  resultsCount.textContent = state.catalogItems.length;
  emptyState.classList.add('hidden');
  const favIds = new Set(state.favorites.map(f => f.imdbId));
  const historyMap = new Map(state.history.map(h => [h.imdbId, h]));
  for (const item of newItems) {
    catalogGrid.appendChild(createMovieCardElement(item, favIds, historyMap));
  }
  updateLoadMoreUi();
}

async function loadMoreCatalogItems() {
  if (isLoadingMoreCatalog) return;
  if (state.searchQuery.trim() || state.category === 'favorites' || state.category === 'history') return;

  const viewKey = getCurrentCatalogViewKey();
  const viewState = catalogMoreState.get(viewKey) || { page: 0, exhausted: false };
  if (viewState.exhausted) return;

  isLoadingMoreCatalog = true;
  updateLoadMoreUi();

  try {
    let appendedAny = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      viewState.page += 1;
      const params = new URLSearchParams({
        category: state.category || 'all',
        animeSub: state.animeSubFilter || 'all',
        genre: state.genre || 'all',
        year: state.year || 'all',
        sort: state.sort || 'popular',
        page: String(viewState.page)
      });
      const res = await fetch(`/api/catalog/more?${params.toString()}`);
      if (!res.ok) break;
      const data = await res.json();

      if (getCurrentCatalogViewKey() !== viewKey) return;

      const curIds = new Set(state.catalogItems.map(x => x.imdbId));
      const masterIds = new Set((state.masterCatalog || []).map(x => x.imdbId));
      const rawItems = Array.isArray(data.items) ? data.items : [];
      const unseen = [];

      for (const it of rawItems) {
        if (!it || !it.imdbId) continue;
        if (!masterIds.has(it.imdbId)) {
          masterIds.add(it.imdbId);
          if (Array.isArray(state.masterCatalog)) state.masterCatalog.push(it);
        }
        if (!curIds.has(it.imdbId)) {
          curIds.add(it.imdbId);
          unseen.push(it);
        }
      }

      if (unseen.length > 0) {
        state.catalogItems.push(...unseen);
        appendCatalogCards(unseen);
        appendedAny = true;
        if (data.hasMore === false) viewState.exhausted = true;
        break;
      }

      if (!data.hasMore) {
        viewState.exhausted = true;
        break;
      }
    }
    if (!appendedAny && viewState.page >= 20) {
      viewState.exhausted = true;
    }
    catalogMoreState.set(viewKey, viewState);
  } catch (e) {
    showPlayerOsd('Не удалось загрузить ещё тайтлы');
  } finally {
    isLoadingMoreCatalog = false;
    updateLoadMoreUi();
  }
}

function renderCatalogGrid(items) {
  resultsCount.textContent = items.length;
  catalogGrid.innerHTML = '';

  if (items.length === 0) {
    emptyState.classList.remove('hidden');
    updateLoadMoreUi();
    return;
  }
  emptyState.classList.add('hidden');

  const favIds = new Set(state.favorites.map(f => f.imdbId));
  const historyMap = new Map(state.history.map(h => [h.imdbId, h]));

  for (const item of items) {
    catalogGrid.appendChild(createMovieCardElement(item, favIds, historyMap));
  }
  updateLoadMoreUi();
}

function getActiveEpisodeObj(item) {
  if (!item || !item.seasons) return null;
  const seasonList = item.seasons[state.selectedSeason] || Object.values(item.seasons)[0] || [];
  return seasonList.find(ep => Number(ep.episode) === Number(state.selectedEpisode)) || seasonList[0] || null;
}

async function openItemModal(itemSummary, initialTab = 'player', lobbyOverride = null) {
  if (!lobbyOverride && isLobbyGuest()) {
    showPlayerOsd(`Фильм выбирает главный: ${lobbyState.lobby?.hostUsername || 'хост'}`);
    return;
  }
  const myOpenToken = ++modalOpenToken;
  filesTabDirty = true;
  if (lobbyOverride && lobbyOverride.balancer) {
    state.selectedBalancer = lobbyOverride.balancer;
  }
  state.currentItem = {
    ...itemSummary,
    qualities: itemSummary.qualities || ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD', '360p'],
    providers: itemSummary.providers || [
      { id: 'direct', name: 'СПБГУКА Direct HLS (Чистый поток • 0% рекламы)', badge: '1080p FHD / Multi-Audio', speed: '120 Мбит/с' }
    ]
  };

  itemModal.classList.remove('hidden');
  pushOverlayHistory('item');
  document.body.style.overflow = 'hidden';
  clearTvFocus();

  const savedHistory = lobbyOverride ? null : state.history.find(h => h.imdbId === itemSummary.imdbId);
  state.selectedSeason = lobbyOverride?.season || savedHistory?.season || 1;
  state.selectedEpisode = lobbyOverride?.episode || savedHistory?.episode || 1;
  state.preferredVoice = lobbyOverride?.voice || savedHistory?.voice || '';
  state.selectedVoice = lobbyOverride?.voice || savedHistory?.voice || (itemSummary.voices && itemSummary.voices[0]) || 'Рус. Дублированный';
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
  const desiredSeason = lobbyOverride?.season || savedHistory?.season;
  state.selectedSeason = (desiredSeason && item.seasons?.[desiredSeason]) ? desiredSeason : (seasonKeys[0] || 1);

  const epsInSeason = item.seasons?.[state.selectedSeason] || [];
  const desiredEpisode = lobbyOverride?.episode || savedHistory?.episode;
  state.selectedEpisode = (desiredEpisode && epsInSeason.some(e => Number(e.episode) === Number(desiredEpisode)))
    ? desiredEpisode
    : (epsInSeason[0]?.episode || 1);

  const activeEp = getActiveEpisodeObj(item);
  const initialSelection = resolveVoiceSelection(item, activeEp, state.preferredVoice || state.selectedVoice);
  state.selectedVoice = initialSelection.name;
  if (!state.preferredVoice) state.preferredVoice = initialSelection.name;

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
  const resumeAt = lobbyOverride ? (Number(lobbyOverride.resumeSeconds) || 0) : (savedHistory?.currentTime || 0);
  startPlayback(resumeAt, true, lobbyOverride ? { startPaused: Boolean(lobbyOverride.paused) } : null);
  revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  if (!lobbyOverride && isLobbyHost()) {
    emitHostPlaybackSync(`Запустил: ${item.title}`, {
      mediaItem: item,
      season: state.selectedSeason,
      episode: state.selectedEpisode,
      voice: state.selectedVoice,
      balancer: state.selectedBalancer,
      paused: false,
      currentTime: resumeAt
    });
  }
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
  if (item.cast) {
    infoCast.innerHTML = '';
    const actors = item.cast.split(',').map(a => a.trim()).filter(Boolean);
    actors.forEach(actor => {
      const btn = document.createElement('button');
      btn.className = 'actor-tag-btn focusable';
      btn.type = 'button';
      btn.textContent = actor;
      btn.title = `Профиль и фильмы с актёром ${actor}`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openActorProfile(actor);
      });
      infoCast.appendChild(btn);
    });
  } else {
    infoCast.textContent = 'Не указан';
  }
  infoIds.textContent = `IMDb: ${item.imdbId || '—'} • KP: ${item.kpId || '—'}`;
  infoDescription.textContent = item.description || 'Описание отсутствует.';

  infoVoicesList.innerHTML = '';
  for (const v of (item.voices || [])) {
    const btn = document.createElement('button');
    btn.className = 'chip-btn focusable';
    btn.type = 'button';
    btn.textContent = v;
    btn.addEventListener('click', () => {
      state.preferredVoice = v;
      state.selectedVoice = v;
      populatePlayerControls(item);
      switchModalTab('player');
      switchAudioTrackOrRestart(v);
      showPlayerOsd(`Озвучка: ${v}`);
    });
    infoVoicesList.appendChild(btn);
  }
  renderSimilarTitles(item);
}

function renderSimilarTitles(item) {
  if (!infoSimilarBlock || !infoSimilarGrid) return;
  const pool = (state.masterCatalog && state.masterCatalog.length ? state.masterCatalog : state.catalogItems) || [];
  if (!item || pool.length < 2) {
    infoSimilarBlock.classList.add('hidden');
    infoSimilarGrid.innerHTML = '';
    return;
  }
  const itemGenres = new Set((item.genres || []).filter(g => g && g !== 'Аниме'));
  const itemYear = Number(item.year) || 0;
  const scored = [];
  for (const cand of pool) {
    if (!cand || cand.imdbId === item.imdbId) continue;
    let score = 0;
    if (cand.type === item.type) score += 2;
    const candGenres = cand.genres || [];
    for (const g of candGenres) {
      if (itemGenres.has(g)) score += 3;
    }
    if (itemYear && Number(cand.year) && Math.abs(Number(cand.year) - itemYear) <= 4) {
      score += 1;
    }
    if (score > 0) {
      const rating = Math.max(Number(cand.ratingKp) || 0, Number(cand.ratingImdb) || 0);
      scored.push({ cand, score: score + rating * 0.05 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const picks = scored.slice(0, 6).map(x => x.cand);
  if (!picks.length) {
    infoSimilarBlock.classList.add('hidden');
    infoSimilarGrid.innerHTML = '';
    return;
  }
  infoSimilarGrid.innerHTML = '';
  for (const sim of picks) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'info-similar-card focusable';
    const rating = sim.ratingKp || sim.ratingImdb || '';
    btn.innerHTML = `
      <div class="info-similar-poster-wrap">
        <img src="${escapeHtml(sim.poster)}" alt="${escapeHtml(sim.title)}" loading="lazy" decoding="async" />
        ${rating ? `<span class="info-similar-rating">${escapeHtml(rating)}</span>` : ''}
      </div>
      <div class="info-similar-title" title="${escapeHtml(sim.title)}">${escapeHtml(sim.title)}</div>
      <div class="info-similar-year">${escapeHtml(sim.year || '')}</div>
    `;
    btn.addEventListener('click', () => openItemModal(sim, 'info'));
    infoSimilarGrid.appendChild(btn);
  }
  infoSimilarBlock.classList.remove('hidden');
}

function isDirectHlsBalancer(b) {
  return ['direct', 'namy', 'kinogram', 'delivembd'].includes(b);
}

function isUsingHlsJs() {
  return Boolean(hlsInstance && window.Hls && window.Hls.isSupported());
}

function applyDesiredAudioTrack(hls) {
  if (!hls || !hls.audioTracks || hls.audioTracks.length === 0) return;
  const desired = typeof hls._desiredAudioTrackIdx === 'number' ? hls._desiredAudioTrackIdx : 0;
  if (desired >= 0 && desired < hls.audioTracks.length && hls.audioTrack !== desired) {
    hls.audioTrack = desired;
  }
}

// Switch audio track seamlessly via hls.js or native HLS reload with ?audio=idx&singleAudio=1 (iPhone Safari / Smart TVs)
function switchAudioTrackOrRestart(voiceName) {
  const item = state.currentItem;
  if (!item) return;
  const activeEp = getActiveEpisodeObj(item);
  const resolved = resolveVoiceSelection(item, activeEp, voiceName);
  state.selectedVoice = resolved.name;
  const voiceIdx = resolved.trackIndex;

  if (isDirectHlsBalancer(state.selectedBalancer) && isUsingHlsJs() && hlsInstance.audioTracks && voiceIdx < hlsInstance.audioTracks.length) {
    hlsInstance._desiredAudioTrackIdx = voiceIdx;
    hlsInstance.audioTrack = voiceIdx;
    const isEpisodic = item.type === 'series' || item.type === 'anime' || item.type === 'cartoon';
    const epPart = isEpisodic ? ` • Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}` : '';
    nowPlayingText.textContent = `${item.title}${epPart} • ${state.selectedVoice} • ${state.selectedQuality}`;
    addToHistory(item, state.selectedSeason, state.selectedEpisode, state.selectedVoice, state.selectedQuality, html5Video.currentTime || 0, html5Video.duration || 0);
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
  const tracks = getEpisodeVoiceTracks(item, activeEp);
  const voices = tracks.map(t => t.name);

  const desiredTarget = state.preferredVoice || state.selectedVoice;
  const resolved = resolveVoiceSelection(item, activeEp, desiredTarget);
  state.selectedVoice = resolved.name;

  // Voices
  voiceSelector.innerHTML = '';
  if (vcAudioChips) vcAudioChips.innerHTML = '';
  for (const voice of voices) {
    const btn = document.createElement('button');
    btn.className = `chip-btn focusable ${state.selectedVoice === voice ? 'active' : ''}`;
    btn.type = 'button';
    btn.textContent = voice;
    btn.addEventListener('click', () => {
      state.preferredVoice = voice;
      state.selectedVoice = voice;
      populatePlayerControls(item);
      switchAudioTrackOrRestart(voice);
      showPlayerOsd(`Озвучка: ${voice}`);
    });
    voiceSelector.appendChild(btn);

    if (vcAudioChips) {
      const chip = document.createElement('button');
      chip.className = `vc-menu-chip focusable ${state.selectedVoice === voice ? 'active' : ''}`;
      chip.type = 'button';
      chip.textContent = voice;
      chip.addEventListener('click', () => {
        state.preferredVoice = voice;
        state.selectedVoice = voice;
        populatePlayerControls(item);
        switchAudioTrackOrRestart(voice);
        showPlayerOsd(`Озвучка / Аудио: ${voice}`);
      });
      vcAudioChips.appendChild(chip);
    }
  }
  if (vcMenuCurrentAudio) {
    vcMenuCurrentAudio.textContent = state.selectedVoice || 'По умолчанию';
  }

  // Qualities
  qualitySelector.innerHTML = '';
  if (vcQualityChips) vcQualityChips.innerHTML = '';
  const qualities = item.qualities || ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD', '360p'];
  for (const q of qualities) {
    const btn = document.createElement('button');
    btn.className = `chip-btn focusable ${state.selectedQuality === q ? 'active' : ''}`;
    btn.type = 'button';
    const shortQ = q.replace('Авто (Макс. 1080p)', 'Авто').replace(' FHD', '').replace(' HD', '').replace(' SD', '');
    btn.textContent = shortQ;
    btn.addEventListener('click', () => {
      state.selectedQuality = q;
      populatePlayerControls(item);
      switchQualityLevel(q);
      showPlayerOsd(`Качество: ${q}`);
    });
    qualitySelector.appendChild(btn);

    if (vcQualityChips) {
      const chip = document.createElement('button');
      chip.className = `vc-menu-chip focusable ${state.selectedQuality === q ? 'active' : ''}`;
      chip.type = 'button';
      chip.textContent = shortQ;
      chip.addEventListener('click', () => {
        state.selectedQuality = q;
        populatePlayerControls(item);
        switchQualityLevel(q);
        showPlayerOsd(`Качество: ${q}`);
      });
      vcQualityChips.appendChild(chip);
    }
  }
  if (vcMenuCurrentQuality) {
    vcMenuCurrentQuality.textContent = (state.selectedQuality || 'Авто').replace('Авто (Макс. 1080p)', 'Авто').replace(' FHD', '');
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
        if (guardLobbyGuestPlaybackControl()) return;
        state.selectedSeason = sNum;
        const firstEp = seasonsObj[sNum]?.[0]?.episode || 1;
        state.selectedEpisode = firstEp;
        populatePlayerControls(item);
        markFilesTabDirtyOrRefresh(item);
        startPlayback(0, true);
        showPlayerOsd(`Сезон ${sNum}, Серия ${firstEp}`);
        if (isLobbyHost()) {
          emitHostPlaybackSync(`Сезон ${sNum}, Серия ${firstEp}`, { season: sNum, episode: firstEp, currentTime: 0, paused: false });
        }
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
        if (guardLobbyGuestPlaybackControl()) return;
        state.selectedEpisode = ep.episode;
        populatePlayerControls(item);
        markFilesTabDirtyOrRefresh(item);
        startPlayback(0, true);
        showPlayerOsd(`Сезон ${state.selectedSeason}, Серия ${ep.episode}`);
        if (isLobbyHost()) {
          emitHostPlaybackSync(`Серия ${ep.episode}`, { episode: ep.episode, currentTime: 0, paused: false });
        }
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
  updateVideoCenterControls();
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

function formatPlayerTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const DEFAULT_CONTROLS_HIDE_MS = 2000;
let isMouseOverPlayerControls = false;
let touchStartedWithControls = false;
let singleTapToggleTimer = null;

function isAppleTouchVolumeLocked(requestedVol) {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && Math.abs(html5Video.volume - requestedVol) > 0.05;
}

function saveAudioPreferences() {
  try {
    localStorage.setItem('spbguka_volume', String(html5Video.volume));
    localStorage.setItem('spbguka_muted', html5Video.muted ? '1' : '0');
  } catch (e) {}
}

function applySavedAudioPreferences() {
  if (!html5Video) return;
  try {
    const rawVol = localStorage.getItem('spbguka_volume');
    if (rawVol !== null) {
      const parsedVol = parseFloat(rawVol);
      if (Number.isFinite(parsedVol) && parsedVol >= 0 && parsedVol <= 1) {
        html5Video.volume = parsedVol;
      }
    }
    if (localStorage.getItem('spbguka_muted') === '1') {
      html5Video.muted = true;
    }
  } catch (e) {}
}

function setVideoVolume(vol, showFeedback = true) {
  if (!html5Video) return;
  const clamped = Math.max(0, Math.min(1, Math.round(vol * 20) / 20));
  html5Video.volume = clamped;
  if (isAppleTouchVolumeLocked(clamped)) {
    if (clamped === 0) {
      html5Video.muted = true;
    } else if (html5Video.muted && clamped > 0) {
      html5Video.muted = false;
    }
    updateCustomVideoBar();
    if (showFeedback) {
      showPlayerOsd(html5Video.muted ? 'Звук выключен' : 'На iPhone громкость регулируется кнопками устройства');
    }
    revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    return;
  }
  html5Video.muted = clamped === 0;
  saveAudioPreferences();
  updateCustomVideoBar();
  if (showFeedback) {
    showPlayerOsd(html5Video.muted ? 'Звук выключен' : `Громкость: ${Math.round(clamped * 100)}%`);
  }
  revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
}

function adjustVideoVolume(delta) {
  if (!html5Video) return;
  const baseVol = html5Video.muted ? 0 : html5Video.volume;
  setVideoVolume(baseVol + delta, true);
}

function updateCustomVideoBar() {
  if (!html5Video) return;
  const paused = html5Video.paused || html5Video.ended;
  if (videoStageArea) videoStageArea.classList.toggle('is-paused', paused);
  if (vcPlayIcon) vcPlayIcon.classList.toggle('hidden', !paused);
  if (vcPauseIcon) vcPauseIcon.classList.toggle('hidden', paused);
  if (vcCenterPlayIcon) vcCenterPlayIcon.classList.toggle('hidden', !paused);
  if (vcCenterPauseIcon) vcCenterPauseIcon.classList.toggle('hidden', paused);
  if (videoCenterPlayBtn) {
    videoCenterPlayBtn.setAttribute('aria-label', paused ? 'Воспроизвести' : 'Пауза');
  }

  const effVol = html5Video.muted ? 0 : Math.round((Number.isFinite(html5Video.volume) ? html5Video.volume : 1) * 100);
  const muted = html5Video.muted || effVol === 0;
  if (vcVolIcon) vcVolIcon.classList.toggle('hidden', muted);
  if (vcMuteIcon) vcMuteIcon.classList.toggle('hidden', !muted);
  if (vcVolumeRange) {
    vcVolumeRange.value = String(effVol);
    vcVolumeRange.style.setProperty('--vol-pct', `${effVol}%`);
  }

  const cur = Number.isFinite(html5Video.currentTime) ? html5Video.currentTime : 0;
  const dur = (Number.isFinite(html5Video.duration) && html5Video.duration > 0) ? html5Video.duration : 0;
  if (videoTimeText) {
    videoTimeText.textContent = `${formatPlayerTime(cur)} / ${formatPlayerTime(dur)}`;
  }
  if (videoProgressRange && !isScrubbingVideo) {
    const ratio = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
    videoProgressRange.value = String(Math.round(ratio * 1000));
    videoProgressRange.style.setProperty('--pct', `${(ratio * 100).toFixed(2)}%`);
  }
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
  if (!overlay120Group) return;
  const cur = Number.isFinite(html5Video.currentTime) ? html5Video.currentTime : 0;
  const dur = (Number.isFinite(html5Video.duration) && html5Video.duration > 0) ? html5Video.duration : 0;
  const isFirstHalf = (dur === 0) || (cur <= dur * 0.5);

  const key = `${isFirstHalf ? 1 : 0}`;
  if (key === lastSmartOverlayKey) return;
  lastSmartOverlayKey = key;

  overlay120Group.classList.toggle('hidden', !isFirstHalf);
  if (overlayNextEpBtn) {
    overlayNextEpBtn.classList.add('hidden');
  }
}

function updateVideoCenterControls() {
  if (!videoCenterControls) return;
  const item = state.currentItem;
  const seasonsObj = item?.seasons || {};
  const seasonNums = Object.keys(seasonsObj).map(Number).sort((a, b) => a - b);
  const isMultiEpisode = Boolean(item && (item.type === 'series' || item.type === 'anime' || item.type === 'cartoon' || seasonNums.length > 1 || (seasonsObj[1] && seasonsObj[1].length > 1)));

  const prevTarget = getAdjacentEpisodeTarget(-1);
  const nextTarget = getAdjacentEpisodeTarget(1);

  if (videoCenterPrevEpBtn) {
    videoCenterPrevEpBtn.classList.toggle('hidden', !isMultiEpisode);
    videoCenterPrevEpBtn.disabled = !prevTarget;
    videoCenterPrevEpBtn.classList.toggle('disabled', !prevTarget);
  }
  if (videoCenterNextEpBtn) {
    videoCenterNextEpBtn.classList.toggle('hidden', !isMultiEpisode);
    videoCenterNextEpBtn.disabled = !nextTarget;
    videoCenterNextEpBtn.classList.toggle('disabled', !nextTarget);
  }
}

function setupSubtitles(activeEp) {
  if (!html5Video) return;
  const oldTracks = html5Video.querySelectorAll('track');
  oldTracks.forEach(t => t.remove());

  const subTracks = [];

  if (activeEp?.subtitles && Array.isArray(activeEp.subtitles)) {
    activeEp.subtitles.forEach((s, idx) => {
      if (!s.url) return;
      const trackEl = document.createElement('track');
      trackEl.kind = 'subtitles';
      trackEl.label = s.name || `Субтитры ${idx + 1}`;
      trackEl.srclang = s.lang || 'ru';
      const proxiedUrl = s.url.startsWith('/') ? s.url : `/api/hls-proxy?url=${encodeURIComponent(s.url)}`;
      trackEl.src = proxiedUrl;
      html5Video.appendChild(trackEl);
      subTracks.push({ id: idx, name: s.name || `Субтитры ${idx + 1}`, source: 'track' });
    });
  }

  if (hlsInstance && hlsInstance.subtitleTracks && hlsInstance.subtitleTracks.length > 0) {
    hlsInstance.subtitleTracks.forEach((st, idx) => {
      const name = st.name || st.lang || `Субтитры ${idx + 1}`;
      subTracks.push({ id: idx, name, source: 'hls' });
    });
  }

  state.availableSubtitles = subTracks;
  renderSubtitleMenu(subTracks);
}

function renderSubtitleMenu(subTracks) {
  if (!vcSubChips) return;
  vcSubChips.innerHTML = '';

  const offChip = document.createElement('button');
  offChip.className = `vc-menu-chip focusable ${state.selectedSubtitleTrack === -1 ? 'active' : ''}`;
  offChip.type = 'button';
  offChip.dataset.sub = '-1';
  offChip.textContent = 'Выкл';
  offChip.addEventListener('click', () => switchSubtitleTrack({ id: -1, name: 'Выкл' }));
  vcSubChips.appendChild(offChip);

  subTracks.forEach(st => {
    const chip = document.createElement('button');
    chip.className = `vc-menu-chip focusable ${state.selectedSubtitleTrack === st.id ? 'active' : ''}`;
    chip.type = 'button';
    chip.dataset.sub = String(st.id);
    chip.textContent = st.name;
    chip.addEventListener('click', () => switchSubtitleTrack(st));
    vcSubChips.appendChild(chip);
  });

  if (vcMenuCurrentSub) {
    const activeTrack = subTracks.find(t => t.id === state.selectedSubtitleTrack);
    vcMenuCurrentSub.textContent = activeTrack ? activeTrack.name : 'Выкл';
  }
}

function switchSubtitleTrack(subObj) {
  if (!subObj || subObj.id === -1) {
    state.selectedSubtitleTrack = -1;
    if (hlsInstance) hlsInstance.subtitleTrack = -1;
    if (html5Video && html5Video.textTracks) {
      Array.from(html5Video.textTracks).forEach(t => { t.mode = 'disabled'; });
    }
    if (vcMenuCurrentSub) vcMenuCurrentSub.textContent = 'Выкл';
    showPlayerOsd('Субтитры: Выкл');
  } else {
    state.selectedSubtitleTrack = subObj.id;
    if (subObj.source === 'hls' && hlsInstance) {
      hlsInstance.subtitleTrack = subObj.id;
    } else if (html5Video && html5Video.textTracks) {
      Array.from(html5Video.textTracks).forEach((t, i) => {
        t.mode = (i === subObj.id) ? 'showing' : 'disabled';
      });
    }
    if (vcMenuCurrentSub) vcMenuCurrentSub.textContent = subObj.name;
    showPlayerOsd(`Субтитры: ${subObj.name}`);
  }

  if (vcSubChips) {
    vcSubChips.querySelectorAll('.vc-menu-chip').forEach(c => {
      c.classList.toggle('active', Number(c.dataset.sub) === (subObj ? subObj.id : -1));
    });
  }
}

function toggleVcMoreMenu() {
  if (!vcMoreMenu) return;
  const isHidden = vcMoreMenu.classList.contains('hidden');
  vcMoreMenu.classList.toggle('hidden', !isHidden);
  revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  if (isHidden) {
    pushOverlayHistory('vcMore');
    const firstFocusable = vcMoreMenu.querySelector('.focusable');
    if (firstFocusable && isSmartTv) firstFocusable.focus();
  } else {
    popOverlayHistory('vcMore');
  }
}

async function openActorProfile(actorName) {
  if (!actorModal) return;
  const trimmedName = (actorName || '').trim();
  if (!trimmedName) return;

  if (actorNameTitle) actorNameTitle.textContent = trimmedName;
  if (actorAvatarInitials) {
    const parts = trimmedName.split(/\s+/).filter(Boolean);
    const inits = parts.map(p => p[0]).join('').slice(0, 2).toUpperCase();
    actorAvatarInitials.textContent = inits || 'АК';
  }

  const qLower = trimmedName.toLowerCase();
  let matches = (state.catalogItems || []).filter(it => (it.cast || '').toLowerCase().includes(qLower));

  if (matches.length < 2) {
    try {
      const res = await fetch(`/api/actor?name=${encodeURIComponent(trimmedName)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.items && Array.isArray(data.items)) {
          const map = new Map(matches.map(m => [m.imdbId || m.id, m]));
          data.items.forEach(it => map.set(it.imdbId || it.id, it));
          matches = Array.from(map.values());
        }
      }
    } catch (e) {}
  }

  if (actorFilmCount) {
    const count = matches.length;
    const mod10 = count % 10;
    const mod100 = count % 100;
    const word = (mod10 === 1 && mod100 !== 11) ? 'фильм/сериал' : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'фильма' : 'фильмов');
    actorFilmCount.textContent = count > 0 ? `${count} ${word}` : 'Пока нет в каталоге';
  }

  if (actorFilmographyGrid) {
    actorFilmographyGrid.innerHTML = '';
    if (matches.length === 0) {
      actorFilmographyGrid.innerHTML = '<div style="grid-column: 1 / -1; padding: 20px; text-align: center; color: var(--text-muted);">Фильмы с этим актёром загружаются. Нажмите «Найти в поиске» для глобального поиска.</div>';
    } else {
      matches.forEach(m => {
        const card = document.createElement('div');
        card.className = 'actor-film-card focusable';
        card.innerHTML = `
          <img class="actor-film-poster" src="${m.poster || ''}" alt="${m.title}" loading="lazy" />
          <div class="actor-film-info">
            <span class="actor-film-title" title="${m.title}">${m.title}</span>
            <div class="actor-film-meta">
              <span>${m.year || ''} • ${m.type === 'series' ? 'Сериал' : 'Фильм'}</span>
              <span class="actor-film-rating">★ ${m.ratingKp || m.ratingImdb || ''}</span>
            </div>
          </div>
        `;
        card.addEventListener('click', () => {
          closeActorProfile();
          openItemModal(m);
        });
        actorFilmographyGrid.appendChild(card);
      });
    }
  }

  actorModal.classList.remove('hidden');
  pushOverlayHistory('actor');
  const firstFocus = actorModal.querySelector('.focusable');
  if (firstFocus && isSmartTv) firstFocus.focus();
}

function closeActorProfile({ fromPopstate = false } = {}) {
  if (actorModal) actorModal.classList.add('hidden');
  if (!fromPopstate) popOverlayHistory('actor');
}

function setPlayerScreenLocked(locked) {
  const wasLocked = isPlayerScreenLocked;
  isPlayerScreenLocked = Boolean(locked);
  if (videoStageArea) {
    videoStageArea.classList.toggle('video-locked', isPlayerScreenLocked);
    if (isPlayerScreenLocked) videoStageArea.classList.remove('controls-active');
  }
  if (vcMoreMenu && isPlayerScreenLocked) vcMoreMenu.classList.add('hidden');
  if (vcUnlockPill) {
    vcUnlockPill.classList.toggle('hidden', !isPlayerScreenLocked);
    vcUnlockPill.classList.toggle('is-flash', isPlayerScreenLocked);
  }
  if (vcLockBtn) vcLockBtn.classList.toggle('active', isPlayerScreenLocked);
  if (!isPlayerScreenLocked) {
    if (wasLocked && itemModal && !itemModal.classList.contains('hidden')) {
      revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    }
  } else if (overlayControlsTimer) {
    clearTimeout(overlayControlsTimer);
    overlayControlsTimer = null;
  }
}

function updateSleepTimerUi() {
  if (vcSleepChips) {
    vcSleepChips.querySelectorAll('.vc-menu-chip[data-sleep]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sleep === sleepTimerMode);
    });
  }
  let badgeLabel = 'Выкл';
  let pillLabel = '';
  if (sleepTimerMode === 'episode' && sleepEndAfterEpisode) {
    badgeLabel = 'До конца серии';
    pillLabel = 'Сон: конец серии';
  } else if (sleepTimerDeadline > Date.now()) {
    const remSec = Math.max(1, Math.ceil((sleepTimerDeadline - Date.now()) / 1000));
    const mins = Math.floor(remSec / 60);
    const secs = remSec % 60;
    const formatted = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}с`;
    badgeLabel = formatted;
    pillLabel = `Сон: ${formatted}`;
  }
  if (vcMenuCurrentSleep) vcMenuCurrentSleep.textContent = badgeLabel;
  if (vcSleepPill) {
    vcSleepPill.textContent = pillLabel;
    vcSleepPill.classList.toggle('hidden', !pillLabel);
  }
}

function setSleepTimer(mode) {
  if (sleepTimerId) {
    clearTimeout(sleepTimerId);
    sleepTimerId = null;
  }
  if (sleepTimerTickInterval) {
    clearInterval(sleepTimerTickInterval);
    sleepTimerTickInterval = null;
  }
  sleepTimerDeadline = 0;
  sleepEndAfterEpisode = false;
  sleepTimerMode = String(mode || 'off');

  if (sleepTimerMode === 'episode') {
    sleepEndAfterEpisode = true;
    showPlayerOsd('Таймер сна: пауза в конце серии');
  } else {
    const mins = parseInt(sleepTimerMode, 10);
    if (Number.isFinite(mins) && mins > 0) {
      sleepTimerDeadline = Date.now() + mins * 60000;
      sleepTimerId = setTimeout(() => {
        sleepTimerId = null;
        if (sleepTimerTickInterval) {
          clearInterval(sleepTimerTickInterval);
          sleepTimerTickInterval = null;
        }
        sleepTimerDeadline = 0;
        sleepTimerMode = 'off';
        if (html5Video && !html5Video.paused) html5Video.pause();
        if (typeof updateCustomVideoBar === 'function') updateCustomVideoBar();
        if (isPlayerScreenLocked) setPlayerScreenLocked(false);
        revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
        updateSleepTimerUi();
        showPlayerOsd('Таймер сна завершил воспроизведение');
      }, mins * 60000);
      sleepTimerTickInterval = setInterval(updateSleepTimerUi, 1000);
      showPlayerOsd(`Таймер сна: ${mins} мин`);
    } else {
      sleepTimerMode = 'off';
    }
  }
  updateSleepTimerUi();
}

function hideVideoOverlayControls() {
  if (overlayControlsTimer) {
    clearTimeout(overlayControlsTimer);
    overlayControlsTimer = null;
  }
  if (!videoStageArea) return;
  if (!isPlayerScreenLocked && (!html5Video || html5Video.paused || html5Video.ended)) return;
  videoStageArea.classList.remove('controls-active');
}

function revealVideoOverlayControls(timeoutMs = DEFAULT_CONTROLS_HIDE_MS) {
  if (!videoStageArea) return;
  if (isPlayerScreenLocked) {
    if (overlayControlsTimer) {
      clearTimeout(overlayControlsTimer);
      overlayControlsTimer = null;
    }
    videoStageArea.classList.remove('controls-active');
    if (vcUnlockPill) {
      vcUnlockPill.classList.remove('hidden');
      vcUnlockPill.classList.remove('is-flash');
      void vcUnlockPill.offsetWidth;
      vcUnlockPill.classList.add('is-flash');
    }
    return;
  }
  const paused = !html5Video || html5Video.paused || html5Video.ended;
  videoStageArea.classList.add('controls-active');
  videoStageArea.classList.toggle('is-paused', paused);
  updateSmartVideoOverlay();
  if (overlayControlsTimer) clearTimeout(overlayControlsTimer);
  if (paused) {
    overlayControlsTimer = null;
    return;
  }
  const moreOpen = vcMoreMenu && !vcMoreMenu.classList.contains('hidden');
  if (moreOpen) {
    overlayControlsTimer = null;
    return;
  }
  const effectiveMs = (isCoarsePointerDevice() || recentlyTouched(2500))
    ? Math.min(Number(timeoutMs) || DEFAULT_CONTROLS_HIDE_MS, DEFAULT_CONTROLS_HIDE_MS)
    : (Number(timeoutMs) || DEFAULT_CONTROLS_HIDE_MS);
  overlayControlsTimer = setTimeout(() => {
    overlayControlsTimer = null;
    const hoverBlocked = isMouseOverPlayerControls && !isCoarsePointerDevice() && !recentlyTouched(1500);
    if (html5Video && !html5Video.paused && !html5Video.ended && !hoverBlocked && !isScrubbingVideo) {
      videoStageArea.classList.remove('controls-active');
    } else if (html5Video && !html5Video.paused && !html5Video.ended) {
      revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    }
  }, effectiveMs);
}

function seekRelative(deltaSeconds) {
  if (!html5Video) return;
  if (guardLobbyGuestPlaybackControl()) return;
  const cur = Number.isFinite(html5Video.currentTime) ? html5Video.currentTime : 0;
  const dur = (Number.isFinite(html5Video.duration) && html5Video.duration > 0) ? html5Video.duration : Infinity;
  const target = Math.max(0, Math.min(dur, cur + deltaSeconds));
  html5Video.currentTime = target;
  if (isLobbyHost()) {
    scheduleHostPlaybackSync(`Перемотка ${deltaSeconds > 0 ? '+' : ''}${deltaSeconds}с`, 140, { currentTime: target });
  }

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
  updateCustomVideoBar();
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

function finishLobbyOrNormalPlay(targetEl, resumeSec, lobbyStartOpts) {
  const pending = lobbyState.pendingSyncPlayback;
  const shouldPause = Boolean(lobbyStartOpts?.startPaused || (isLobbyGuest() && pending?.paused));
  const desiredTime = (isLobbyGuest() && pending)
    ? computeLobbyTargetTime(pending)
    : resumeSec;

  if (desiredTime > 2) {
    try { targetEl.currentTime = desiredTime; } catch (e) {}
  }

  if (shouldPause) {
    isApplyingLobbySync = true;
    targetEl.pause();
    updateCustomVideoBar();
    setTimeout(() => { isApplyingLobbySync = false; }, 100);
    return;
  }

  const p = targetEl.play();
  if (p && typeof p.then === 'function') {
    p.then(() => {
      lobbyState.pendingAutoplayBlocked = false;
      updateLobbyUi();
    }).catch(() => {
      if (isLobbyGuest()) {
        lobbyState.pendingAutoplayBlocked = true;
        updateLobbyUi();
        showPlayerOsd(`Нажмите ▶ чтобы смотреть с ${lobbyState.lobby?.hostUsername || 'главным'}`);
      }
    });
  }
}

async function startPlayback(resumeSeconds = 0, forceReload = false, lobbyStartOpts = null) {
  const item = state.currentItem;
  if (!item) return;

  const myPlayToken = ++playbackRequestToken;
  const activeEp = getActiveEpisodeObj(item);
  const resolvedVoice = resolveVoiceSelection(item, activeEp, state.preferredVoice || state.selectedVoice);
  state.selectedVoice = resolvedVoice.name;
  const voiceIdx = resolvedVoice.trackIndex;

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
    setupSubtitles(activeEp);

    // Prefer hls.js on PC, Linux, Android, webOS Chromium
    if (window.Hls && window.Hls.isSupported()) {
      if (!forceReload && currentLoadedHlsUrl === streamUrl && hlsInstance) {
        hlsInstance._desiredAudioTrackIdx = voiceIdx;
        applyDesiredAudioTrack(hlsInstance);
        switchQualityLevel(state.selectedQuality);
        finishLobbyOrNormalPlay(html5Video, resumeSeconds, lobbyStartOpts);
        return;
      }

      destroyHls();
      const manifestUrl = await buildClientHlsManifestUrl(streamUrl, voiceIdx, false);
      if (myPlayToken !== playbackRequestToken || itemModal.classList.contains('hidden')) return;

      currentLoadedHlsUrl = streamUrl;
      html5Video.poster = '';

      const activeHls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        capLevelToPlayerSize: true
      });
      activeHls._desiredAudioTrackIdx = voiceIdx;
      hlsInstance = activeHls;

      activeHls.loadSource(manifestUrl);
      activeHls.attachMedia(html5Video);

      activeHls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        applyDesiredAudioTrack(activeHls);
        switchQualityLevel(state.selectedQuality);
        setupSubtitles(activeEp);
        finishLobbyOrNormalPlay(html5Video, resumeSeconds, lobbyStartOpts);
      });

      activeHls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => applyDesiredAudioTrack(activeHls));
      activeHls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, () => setupSubtitles(activeEp));
      activeHls.on(window.Hls.Events.LEVEL_SWITCHED, () => applyDesiredAudioTrack(activeHls));
      return;
    }

    // Native HLS fallback (iPhone / iPad Safari & older Smart TV browsers): singleAudio=1 forces chosen voiceover!
    if (html5Video.canPlayType('application/vnd.apple.mpegurl')) {
      destroyHls();
      const nativeUrl = await buildClientHlsManifestUrl(streamUrl, voiceIdx, true);
      if (myPlayToken !== playbackRequestToken || itemModal.classList.contains('hidden')) return;

      currentLoadedHlsUrl = nativeUrl;
      html5Video.src = nativeUrl;
      setupSubtitles(activeEp);
      html5Video.addEventListener('loadedmetadata', () => {
        finishLobbyOrNormalPlay(html5Video, resumeSeconds, lobbyStartOpts);
      }, { once: true });
      return;
    }
  }

  // Kinokino.vip embed source (Kinopoisk mirror)
  if (state.selectedBalancer === 'kinokino') {
    destroyHls();
    html5Video.pause();
    html5Video.removeAttribute('src');
    directPlayerWrap.classList.add('hidden');
    iframePlayerWrap.classList.remove('hidden');
    kinoboxContainer.classList.add('hidden');
    balancerIframe.classList.remove('hidden');
    applyIframeSandbox();

    const kpId = item.kpId || (item.id && /^\d+$/.test(item.id) ? item.id : '');
    const isSeries = item.type === 'series' || item.type === 'anime' || item.type === 'cartoon';
    const query = isSeries ? `?season=${state.selectedSeason}&episode=${state.selectedEpisode}` : '';
    const embedUrl = kpId
      ? `https://kinokino.vip/embed/kp/${kpId}${query}`
      : `https://kinokino.vip/embed/imdb/${item.imdbId}${query}`;
    balancerIframe.removeAttribute('srcdoc');
    balancerIframe.src = embedUrl;
    showPlayerOsd('Источник kinokino.vip загружен');
    return;
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

    // Check if user entered a kinopoisk or kinokino link, or KP id
    const kpMatch = customUrl.match(/(?:kinopoisk\.ru\/(?:film|series)\/|kinokino\.vip\/embed\/kp\/)(\d+)/i) || customUrl.match(/^(\d{3,9})$/);
    if (kpMatch) {
      const kpId = kpMatch[1];
      const isSeries = item.type === 'series' || item.type === 'anime' || item.type === 'cartoon';
      const query = isSeries ? `?season=${state.selectedSeason}&episode=${state.selectedEpisode}` : '';
      balancerIframe.removeAttribute('srcdoc');
      balancerIframe.src = `https://kinokino.vip/embed/kp/${kpId}${query}`;
      showPlayerOsd(`Загружен источник kinokino.vip (KP #${kpId})`);
      return;
    }

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

function closeItemModal({ fromPopstate = false } = {}) {
  const closedCurTime = Number.isFinite(html5Video?.currentTime) ? html5Video.currentTime : 0;
  const closedItem = state.currentItem;
  if (isLobbyHost() && closedItem) {
    emitHostPlaybackSync('Главный приостановил просмотр', {
      mediaItem: closedItem,
      paused: true,
      currentTime: closedCurTime
    });
  }
  lobbyState.chatOpenInPlayer = false;
  lobbyState.pendingAutoplayBlocked = false;
  updateLobbyUi();
  if (vcMoreMenu) vcMoreMenu.classList.add('hidden');
  exitVideoFullscreen({ fromPopstate: true });
  saveLivePlaybackProgress();
  scheduleAccountPush('merge', true);
  modalOpenToken++;
  playbackRequestToken++;
  if (overlayControlsTimer) clearTimeout(overlayControlsTimer);
  if (seekFeedbackTimer) clearTimeout(seekFeedbackTimer);
  if (seekStreakTimer) clearTimeout(seekStreakTimer);
  setSleepTimer('off');
  setPlayerScreenLocked(false);
  isMouseOverPlayerControls = false;
  isScrubbingVideo = false;
  seekStreakDir = 0;
  seekStreakTotal = 0;
  lastSmartOverlayKey = '';
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
  if (!fromPopstate) popOverlayHistory('item');
}

function updateFavButtonState() {
  if (!state.currentItem) return;
  const isFav = state.favorites.some(f => f.imdbId === state.currentItem.imdbId);
  modalFavBtn.textContent = isFav ? 'В избранном' : 'В избранное';
  modalFavBtn.style.background = isFav ? 'var(--accent)' : '';
  modalFavBtn.style.color = isFav ? 'var(--accent-ink)' : '';
}

function getFullscreenElement() {
  return document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement ||
    null;
}

function isVideoFullscreen() {
  return Boolean(
    getFullscreenElement() ||
    (videoStageArea && videoStageArea.classList.contains('pseudo-fullscreen')) ||
    (iframePlayerWrap && iframePlayerWrap.classList.contains('pseudo-fullscreen'))
  );
}

function syncFullscreenUi() {
  const fsEl = getFullscreenElement();
  const isVideoFs = Boolean(
    videoStageArea && (
      fsEl === videoStageArea ||
      fsEl === html5Video ||
      fsEl === directPlayerWrap ||
      videoStageArea.classList.contains('pseudo-fullscreen')
    )
  );
  const isIframeFs = Boolean(
    iframePlayerWrap && (
      fsEl === iframePlayerWrap ||
      iframePlayerWrap.classList.contains('pseudo-fullscreen')
    )
  );
  const fs = isVideoFs || isIframeFs;
  if (videoStageArea) videoStageArea.classList.toggle('is-fullscreen', isVideoFs);
  if (iframePlayerWrap) iframePlayerWrap.classList.toggle('is-fullscreen', isIframeFs);
  if (vcFsEnterIcon) vcFsEnterIcon.classList.toggle('hidden', fs);
  if (vcFsExitIcon) vcFsExitIcon.classList.toggle('hidden', !fs);
  if (vcFullscreenBtnText) vcFullscreenBtnText.textContent = fs ? '✕ Выйти' : 'На весь экран';
  if (fullscreenBtn) fullscreenBtn.textContent = fs ? '✕ Выйти' : 'На весь экран';
}

function enterPseudoFullscreen(target) {
  if (!target) return;
  target.classList.add('pseudo-fullscreen');
  document.body.classList.add('pseudo-fullscreen-open');
  syncFullscreenUi();
  revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
}

let pendingFsFallbackTimer = null;
let wasNativeFullscreen = false;
let lastRequestedFsTarget = null;

function handleFullscreenChange() {
  const fsEl = getFullscreenElement();
  if (fsEl) {
    wasNativeFullscreen = true;
    if (pendingFsFallbackTimer) {
      clearTimeout(pendingFsFallbackTimer);
      pendingFsFallbackTimer = null;
    }
    if (videoStageArea) videoStageArea.classList.remove('pseudo-fullscreen');
    if (iframePlayerWrap) iframePlayerWrap.classList.remove('pseudo-fullscreen');
    document.body.classList.remove('pseudo-fullscreen-open');
    syncFullscreenUi();
    revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  } else {
    if (wasNativeFullscreen) {
      wasNativeFullscreen = false;
      if (videoStageArea) videoStageArea.classList.remove('pseudo-fullscreen');
      if (iframePlayerWrap) iframePlayerWrap.classList.remove('pseudo-fullscreen');
      document.body.classList.remove('pseudo-fullscreen-open');
      syncFullscreenUi();
      popOverlayHistory('fullscreen');
    } else {
      syncFullscreenUi();
    }
  }
}

function exitVideoFullscreen({ fromPopstate = false } = {}) {
  if (pendingFsFallbackTimer) {
    clearTimeout(pendingFsFallbackTimer);
    pendingFsFallbackTimer = null;
  }
  wasNativeFullscreen = false;
  if (videoStageArea) videoStageArea.classList.remove('pseudo-fullscreen');
  if (iframePlayerWrap) iframePlayerWrap.classList.remove('pseudo-fullscreen');
  document.body.classList.remove('pseudo-fullscreen-open');

  if (getFullscreenElement()) {
    const exitFn = document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.mozCancelFullScreen ||
      document.msExitFullscreen;
    if (exitFn) {
      try {
        const p = exitFn.call(document);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) {}
    }
  }
  syncFullscreenUi();
  if (!fromPopstate) popOverlayHistory('fullscreen');
}

function enterVideoFullscreen() {
  const target = directPlayerWrap.classList.contains('hidden')
    ? iframePlayerWrap
    : (videoStageArea || html5Video);
  if (!target) return;

  pushOverlayHistory('fullscreen');

  lastRequestedFsTarget = target;
  if (pendingFsFallbackTimer) {
    clearTimeout(pendingFsFallbackTimer);
    pendingFsFallbackTimer = null;
  }

  const triggerPseudoFallback = () => {
    if (pendingFsFallbackTimer) {
      clearTimeout(pendingFsFallbackTimer);
      pendingFsFallbackTimer = null;
    }
    if (!getFullscreenElement()) {
      enterPseudoFullscreen(target);
    }
  };

  if (target.requestFullscreen) {
    pendingFsFallbackTimer = setTimeout(() => {
      pendingFsFallbackTimer = null;
      if (!isVideoFullscreen()) enterPseudoFullscreen(target);
    }, 650);

    const onNativeSuccess = () => {
      if (pendingFsFallbackTimer) {
        clearTimeout(pendingFsFallbackTimer);
        pendingFsFallbackTimer = null;
      }
      if (!getFullscreenElement()) {
        enterPseudoFullscreen(target);
      } else {
        handleFullscreenChange();
      }
    };

    try {
      const p = target.requestFullscreen({ navigationUI: 'hide' });
      if (p && typeof p.then === 'function') {
        p.then(onNativeSuccess).catch(() => {
          try {
            const p2 = target.requestFullscreen();
            if (p2 && typeof p2.then === 'function') {
              p2.then(onNativeSuccess).catch(triggerPseudoFallback);
            }
          } catch (e2) {
            triggerPseudoFallback();
          }
        });
      }
      return;
    } catch (e) {
      try {
        const p2 = target.requestFullscreen();
        if (p2 && typeof p2.then === 'function') {
          p2.then(onNativeSuccess).catch(triggerPseudoFallback);
        }
        return;
      } catch (e2) {
        triggerPseudoFallback();
        return;
      }
    }
  }

  const reqFn = target.webkitRequestFullscreen ||
    target.mozRequestFullScreen ||
    target.msRequestFullscreen;

  if (reqFn) {
    pendingFsFallbackTimer = setTimeout(() => {
      pendingFsFallbackTimer = null;
      if (!isVideoFullscreen()) enterPseudoFullscreen(target);
    }, 650);
    try {
      const p = reqFn.call(target);
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (pendingFsFallbackTimer) {
            clearTimeout(pendingFsFallbackTimer);
            pendingFsFallbackTimer = null;
          }
          if (!getFullscreenElement()) {
            enterPseudoFullscreen(target);
          } else {
            handleFullscreenChange();
          }
        }).catch(triggerPseudoFallback);
      }
      return;
    } catch (e) {
      triggerPseudoFallback();
      return;
    }
  }

  enterPseudoFullscreen(target);
}

function toggleVideoFullscreen() {
  if (isVideoFullscreen()) {
    exitVideoFullscreen();
  } else {
    enterVideoFullscreen();
  }
}

// Per-Layer User-Gesture History Stack (never calls pushState inside popstate, immune to Chromium Back-skipping)
const overlayHistoryStack = [];
let ignoringGuardPops = 0;
let committedHistoryDepth = 0;

try {
  if (!window.history.state || typeof window.history.state.spbgukaDepth !== 'number') {
    window.history.replaceState({ ...(window.history.state || {}), spbgukaRoot: true, spbgukaDepth: 0 }, '');
  } else {
    committedHistoryDepth = Number(window.history.state.spbgukaDepth) || 0;
  }
} catch (e) {}

function hasAnyOpenOverlay() {
  return Boolean(
    (vcMoreMenu && !vcMoreMenu.classList.contains('hidden')) ||
    (playerChatDrawer && !playerChatDrawer.classList.contains('hidden')) ||
    isVideoFullscreen() ||
    (actorModal && !actorModal.classList.contains('hidden')) ||
    (lobbyModal && !lobbyModal.classList.contains('hidden')) ||
    (installModal && !installModal.classList.contains('hidden')) ||
    (accountModal && !accountModal.classList.contains('hidden')) ||
    (parsersModal && !parsersModal.classList.contains('hidden')) ||
    (itemModal && !itemModal.classList.contains('hidden'))
  );
}

function pushOverlayHistory(layer) {
  if (!layer) return;
  if (overlayHistoryStack.includes(layer)) return;
  overlayHistoryStack.push(layer);
  try {
    window.history.pushState({ spbgukaDepth: overlayHistoryStack.length, spbgukaLayer: layer }, '');
    committedHistoryDepth = overlayHistoryStack.length;
  } catch (e) {
    overlayHistoryStack.pop();
  }
}

function popOverlayHistory(layer) {
  const idx = overlayHistoryStack.lastIndexOf(layer);
  if (idx === -1) return;
  const popCount = overlayHistoryStack.length - idx;
  overlayHistoryStack.splice(idx, popCount);
  if (popCount > 0 && committedHistoryDepth > 0) {
    const stepsToPop = Math.min(popCount, committedHistoryDepth);
    if (stepsToPop > 0) {
      committedHistoryDepth = Math.max(0, committedHistoryDepth - stepsToPop);
      ignoringGuardPops++;
      try {
        window.history.go(-stepsToPop);
      } catch (e) {
        ignoringGuardPops = Math.max(0, ignoringGuardPops - 1);
      }
    }
  }
}

function replaceOverlayHistory(oldLayer, newLayer) {
  if (!newLayer) return;
  if (overlayHistoryStack.includes(newLayer)) {
    popOverlayHistory(oldLayer);
    return;
  }
  const idx = overlayHistoryStack.lastIndexOf(oldLayer);
  if (idx === -1) {
    pushOverlayHistory(newLayer);
    return;
  }
  overlayHistoryStack[idx] = newLayer;
  try {
    window.history.replaceState({ spbgukaDepth: idx + 1, spbgukaLayer: newLayer }, '');
  } catch (e) {}
}

function closeOverlayLayer(layer, { fromPopstate = false } = {}) {
  switch (layer) {
    case 'vcMore':
      if (vcMoreMenu && !vcMoreMenu.classList.contains('hidden')) {
        vcMoreMenu.classList.add('hidden');
        revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
      }
      if (!fromPopstate) popOverlayHistory('vcMore');
      return true;
    case 'chat':
      if (playerChatDrawer && !playerChatDrawer.classList.contains('hidden')) {
        togglePlayerChatDrawer(false, { fromPopstate });
      } else if (!fromPopstate) {
        popOverlayHistory('chat');
      }
      return true;
    case 'fullscreen':
      if (isVideoFullscreen()) {
        exitVideoFullscreen({ fromPopstate });
      } else if (!fromPopstate) {
        popOverlayHistory('fullscreen');
      }
      return true;
    case 'actor':
      if (actorModal && !actorModal.classList.contains('hidden')) {
        closeActorProfile({ fromPopstate });
      } else if (!fromPopstate) {
        popOverlayHistory('actor');
      }
      return true;
    case 'lobby':
      if (lobbyModal) lobbyModal.classList.add('hidden');
      if (!fromPopstate) popOverlayHistory('lobby');
      return true;
    case 'install':
      if (installModal) installModal.classList.add('hidden');
      if (!fromPopstate) popOverlayHistory('install');
      return true;
    case 'account':
      if (accountModal) accountModal.classList.add('hidden');
      if (!fromPopstate) popOverlayHistory('account');
      return true;
    case 'parsers':
      if (parsersModal) parsersModal.classList.add('hidden');
      if (!fromPopstate) popOverlayHistory('parsers');
      return true;
    case 'item':
      if (itemModal && !itemModal.classList.contains('hidden')) {
        closeItemModal({ fromPopstate });
      } else if (!fromPopstate) {
        popOverlayHistory('item');
      }
      return true;
    default:
      return false;
  }
}

function closeTopmostOverlay({ fromPopstate = false } = {}) {
  if (vcMoreMenu && !vcMoreMenu.classList.contains('hidden')) {
    return closeOverlayLayer('vcMore', { fromPopstate });
  }
  if (playerChatDrawer && !playerChatDrawer.classList.contains('hidden')) {
    return closeOverlayLayer('chat', { fromPopstate });
  }
  if (isVideoFullscreen()) {
    return closeOverlayLayer('fullscreen', { fromPopstate });
  }
  if (actorModal && !actorModal.classList.contains('hidden')) {
    return closeOverlayLayer('actor', { fromPopstate });
  }
  if (lobbyModal && !lobbyModal.classList.contains('hidden')) {
    return closeOverlayLayer('lobby', { fromPopstate });
  }
  if (installModal && !installModal.classList.contains('hidden')) {
    return closeOverlayLayer('install', { fromPopstate });
  }
  if (accountModal && !accountModal.classList.contains('hidden')) {
    return closeOverlayLayer('account', { fromPopstate });
  }
  if (parsersModal && !parsersModal.classList.contains('hidden')) {
    return closeOverlayLayer('parsers', { fromPopstate });
  }
  if (itemModal && !itemModal.classList.contains('hidden')) {
    return closeOverlayLayer('item', { fromPopstate });
  }
  return false;
}

window.addEventListener('popstate', e => {
  if (ignoringGuardPops > 0) {
    ignoringGuardPops--;
    return;
  }
  committedHistoryDepth = Number(e.state?.spbgukaDepth) || 0;
  const targetDepth = committedHistoryDepth;
  if (overlayHistoryStack.length > targetDepth) {
    while (overlayHistoryStack.length > targetDepth) {
      const layer = overlayHistoryStack.pop();
      closeOverlayLayer(layer, { fromPopstate: true });
    }
  } else if (hasAnyOpenOverlay()) {
    closeTopmostOverlay({ fromPopstate: true });
  }
});

// Spatial TV D-Pad Navigation (LG webOS / Samsung Tizen / HTPC Linux)
function getArrowDirection(e) {
  if (e.key === 'ArrowUp' || e.key === 'Up' || e.keyCode === 38) return 'ArrowUp';
  if (e.key === 'ArrowDown' || e.key === 'Down' || e.keyCode === 40) return 'ArrowDown';
  if (e.key === 'ArrowLeft' || e.key === 'Left' || e.keyCode === 37) return 'ArrowLeft';
  if (e.key === 'ArrowRight' || e.key === 'Right' || e.keyCode === 39) return 'ArrowRight';
  return null;
}

function isConfirmKey(e) {
  return e.key === 'Enter' || e.key === 'Select' || e.key === 'Accept' || e.keyCode === 13 || e.keyCode === 23;
}

function isBackKey(e, isTyping = false) {
  return (
    e.key === 'Escape' ||
    e.key === 'BrowserBack' ||
    e.key === 'GoBack' ||
    e.key === 'XF86Back' ||
    e.key === 'Back' ||
    e.keyCode === 461 ||
    e.keyCode === 10009 ||
    (!isTyping && (e.key === 'Backspace' || e.keyCode === 8))
  );
}

function isTextEditingActive() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    return t !== 'range' && t !== 'checkbox' && t !== 'radio' && t !== 'button' && t !== 'submit';
  }
  return false;
}

function clearTvFocus() {
  if (currentTvFocusedEl) {
    currentTvFocusedEl.classList.remove('tv-focus');
    currentTvFocusedEl = null;
  }
}

function getVisibleFocusableWithRects() {
  let scope = document.body;
  if (isVideoFullscreen()) {
    scope = directPlayerWrap.classList.contains('hidden') ? iframePlayerWrap : videoStageArea;
  } else if (lobbyModal && !lobbyModal.classList.contains('hidden')) {
    scope = lobbyModal;
  } else if (installModal && !installModal.classList.contains('hidden')) {
    scope = installModal;
  } else if (accountModal && !accountModal.classList.contains('hidden')) {
    scope = accountModal;
  } else if (!parsersModal.classList.contains('hidden')) {
    scope = parsersModal;
  } else if (!itemModal.classList.contains('hidden')) {
    scope = itemModal;
  }

  const result = [];
  for (const el of scope.querySelectorAll('.focusable')) {
    if (el.disabled || el.closest('.hidden')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    result.push({ el, rect });
  }
  return result;
}

function pickInitialTvFocus(candidates, direction) {
  if (isVideoFullscreen() || (!itemModal.classList.contains('hidden') && state.activeTab === 'player')) {
    const preferred = [
      vcPlayPauseBtn,
      videoCenterPlayBtn,
      videoCenterNextEpBtn,
      videoCenterPrevEpBtn,
      overlayForward120Btn,
      vcMoreBtn,
      vcFullscreenBtn
    ];
    for (const target of preferred) {
      const match = candidates.find(c => c.el === target);
      if (match) return match.el;
    }
  }
  if (direction === 'ArrowDown' && itemModal.classList.contains('hidden')) {
    const heroMatch = candidates.find(c => c.el === heroWatchBtn);
    if (heroMatch) return heroMatch.el;
    const cardMatch = candidates.find(c => c.el.classList.contains('release-card') || c.el.classList.contains('movie-card'));
    if (cardMatch) return cardMatch.el;
  }
  const activeEntry = candidates.find(c => c.el === document.activeElement);
  return (activeEntry || candidates[0]).el;
}

function moveSpatialFocus(direction) {
  if (isVideoFullscreen() || (!itemModal.classList.contains('hidden') && state.activeTab === 'player')) {
    revealVideoOverlayControls(4500);
  }
  const candidates = getVisibleFocusableWithRects();
  if (candidates.length === 0) return;

  const currentEntry = currentTvFocusedEl ? candidates.find(c => c.el === currentTvFocusedEl) : null;
  if (!currentEntry) {
    currentTvFocusedEl = pickInitialTvFocus(candidates, direction);
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
    let primaryEdgeDist = 0;
    let perpPenalty = 0;

    if (direction === 'ArrowRight' && dx > 6) {
      valid = true;
      primaryEdgeDist = Math.max(0, r.left - curRect.right) + dx * 0.25;
      const vertOverlap = Math.max(0, Math.min(curRect.bottom, r.bottom) - Math.max(curRect.top, r.top));
      const edgeGapY = Math.max(0, r.top - curRect.bottom, curRect.top - r.bottom);
      perpPenalty = vertOverlap > 0 ? Math.abs(dy) * 0.35 : (edgeGapY * 2.8 + Math.abs(dy) * 0.6);
    } else if (direction === 'ArrowLeft' && dx < -6) {
      valid = true;
      primaryEdgeDist = Math.max(0, curRect.left - r.right) + (-dx) * 0.25;
      const vertOverlap = Math.max(0, Math.min(curRect.bottom, r.bottom) - Math.max(curRect.top, r.top));
      const edgeGapY = Math.max(0, r.top - curRect.bottom, curRect.top - r.bottom);
      perpPenalty = vertOverlap > 0 ? Math.abs(dy) * 0.35 : (edgeGapY * 2.8 + Math.abs(dy) * 0.6);
    } else if (direction === 'ArrowDown' && dy > 6) {
      valid = true;
      primaryEdgeDist = Math.max(0, r.top - curRect.bottom) + dy * 0.25;
      const horizOverlap = Math.max(0, Math.min(curRect.right, r.right) - Math.max(curRect.left, r.left));
      const edgeGapX = Math.max(0, r.left - curRect.right, curRect.left - r.right);
      perpPenalty = horizOverlap > 0 ? Math.abs(dx) * 0.35 : (edgeGapX * 2.6 + Math.abs(dx) * 0.5);
    } else if (direction === 'ArrowUp' && dy < -6) {
      valid = true;
      primaryEdgeDist = Math.max(0, curRect.top - r.bottom) + (-dy) * 0.25;
      const horizOverlap = Math.max(0, Math.min(curRect.right, r.right) - Math.max(curRect.left, r.left));
      const edgeGapX = Math.max(0, r.left - curRect.right, curRect.left - r.right);
      perpPenalty = horizOverlap > 0 ? Math.abs(dx) * 0.35 : (edgeGapX * 2.6 + Math.abs(dx) * 0.5);
    }

    if (!valid) continue;
    const score = primaryEdgeDist + perpPenalty;
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
document.querySelectorAll('.nav-item[data-category], .mob-nav-item[data-category]').forEach(btn => {
  btn.addEventListener('click', () => {
    const cat = btn.dataset.category;
    if (!cat) return;
    state.category = cat;
    if (cat === 'anime') state.animeSubFilter = 'all';
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
  state.animeSubFilter = 'all';
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
    if (guardLobbyGuestPlaybackControl()) return;
    html5Video.currentTime = 0;
    html5Video.play().catch(() => {});
    saveLivePlaybackProgress();
    showPlayerOsd('С начала (0:00)');
    if (isLobbyHost()) emitHostPlaybackSync('С начала (0:00)', { currentTime: 0, paused: false });
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

applyCustomStreamBtn.addEventListener('click', () => {
  const customUrl = customStreamInput.value.trim();
  if (!customUrl) return;

  const kpMatch = customUrl.match(/(?:kinopoisk\.ru\/(?:film|series)\/|kinokino\.vip\/embed\/kp\/)(\d+)/i) || customUrl.match(/^(\d{3,9})$/);
  if (kpMatch) {
    const kpId = kpMatch[1];
    state.selectedBalancer = 'kinokino';
    updateBalancerButtons();
    destroyHls();
    html5Video.pause();
    html5Video.removeAttribute('src');
    directPlayerWrap.classList.add('hidden');
    iframePlayerWrap.classList.remove('hidden');
    kinoboxContainer.classList.add('hidden');
    balancerIframe.classList.remove('hidden');
    applyIframeSandbox();
    const isSeries = state.currentItem && (state.currentItem.type === 'series' || state.currentItem.type === 'anime' || state.currentItem.type === 'cartoon');
    const query = isSeries ? `?season=${state.selectedSeason}&episode=${state.selectedEpisode}` : '';
    balancerIframe.removeAttribute('srcdoc');
    balancerIframe.src = `https://kinokino.vip/embed/kp/${kpId}${query}`;
    showPlayerOsd(`Загружен источник kinokino.vip (KP #${kpId})`);
    return;
  }

  startPlayback(0, true);
});

sandboxToggle.addEventListener('change', () => {
  applyIframeSandbox();
  if (!isDirectHlsBalancer(state.selectedBalancer)) startPlayback(0, true);
});

function switchEpisodeStep(delta, osdPrefix = '') {
  if (!state.currentItem) return;
  if (guardLobbyGuestPlaybackControl()) return;
  const target = getAdjacentEpisodeTarget(delta);
  if (!target) return;
  state.selectedSeason = target.season;
  state.selectedEpisode = target.episode;
  populatePlayerControls(state.currentItem);
  markFilesTabDirtyOrRefresh(state.currentItem);
  startPlayback(0, true);
  revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  const label = `Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}`;
  showPlayerOsd(osdPrefix ? `${osdPrefix}: ${label}` : label);
  if (isLobbyHost()) {
    emitHostPlaybackSync(label, { season: state.selectedSeason, episode: state.selectedEpisode, currentTime: 0, paused: false });
  }
}

prevEpBtn.addEventListener('click', () => switchEpisodeStep(-1));
nextEpBtn.addEventListener('click', () => switchEpisodeStep(1));

function bindResponsivePlayerButton(btn, handler) {
  if (!btn || typeof handler !== 'function') return;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchMoved = false;
  let lastTouchActTs = 0;

  btn.addEventListener('pointerdown', e => {
    e.stopPropagation();
    if (e.pointerType && e.pointerType !== 'mouse') {
      lastAnyTouchTs = Date.now();
      isMouseOverPlayerControls = false;
    }
    if (!isPlayerScreenLocked) revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  });

  btn.addEventListener('touchstart', e => {
    e.stopPropagation();
    lastAnyTouchTs = Date.now();
    isMouseOverPlayerControls = false;
    touchMoved = false;
    const t = e.touches && e.touches[0];
    if (t) {
      touchStartX = t.clientX;
      touchStartY = t.clientY;
    }
    if (!isPlayerScreenLocked) revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  }, { passive: true });

  btn.addEventListener('touchmove', e => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - touchStartX) > 14 || Math.abs(t.clientY - touchStartY) > 14) {
      touchMoved = true;
    }
  }, { passive: true });

  btn.addEventListener('touchend', e => {
    e.stopPropagation();
    lastAnyTouchTs = Date.now();
    isMouseOverPlayerControls = false;
    if (touchMoved || isPlayerScreenLocked) return;
    if (btn.disabled || btn.classList.contains('disabled')) return;
    if (videoStageArea && !videoStageArea.classList.contains('controls-active') && !videoStageArea.classList.contains('is-paused')) return;
    e.preventDefault();
    lastTouchActTs = Date.now();
    handler(e);
    revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  }, { passive: false });

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (isPlayerScreenLocked) return;
    if (btn.disabled || btn.classList.contains('disabled')) return;
    if (videoStageArea && !videoStageArea.classList.contains('controls-active') && !videoStageArea.classList.contains('is-paused')) return;
    if (Date.now() - lastTouchActTs < 450) return;
    handler(e);
    revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  });
}

bindResponsivePlayerButton(videoCenterPrevEpBtn, () => switchEpisodeStep(-1, 'Предыдущая серия'));
bindResponsivePlayerButton(videoCenterNextEpBtn, () => switchEpisodeStep(1, 'Следующая серия'));

if (vcLockBtn) {
  vcLockBtn.addEventListener('click', e => {
    e.stopPropagation();
    setPlayerScreenLocked(!isPlayerScreenLocked);
  });
}
if (vcUnlockPill) {
  let unlockTouchTs = 0;
  vcUnlockPill.addEventListener('touchstart', e => {
    e.stopPropagation();
    lastAnyTouchTs = Date.now();
  }, { passive: true });
  vcUnlockPill.addEventListener('touchend', e => {
    e.stopPropagation();
    e.preventDefault();
    lastAnyTouchTs = Date.now();
    unlockTouchTs = Date.now();
    setPlayerScreenLocked(false);
    showPlayerOsd('Экран разблокирован');
  }, { passive: false });
  vcUnlockPill.addEventListener('click', e => {
    e.stopPropagation();
    if (Date.now() - unlockTouchTs < 450) return;
    setPlayerScreenLocked(false);
    showPlayerOsd('Экран разблокирован');
  });
}
if (vcSleepChips) {
  vcSleepChips.querySelectorAll('.vc-menu-chip[data-sleep]').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      setSleepTimer(chip.dataset.sleep || 'off');
      if (vcMoreMenu) vcMoreMenu.classList.add('hidden');
      popOverlayHistory('vcMore');
      revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    });
  });
}

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

// Three-Dots ("...") Player Settings Menu Event Handlers
if (vcMoreBtn) {
  vcMoreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleVcMoreMenu();
  });
}
if (vcMoreCloseBtn) {
  vcMoreCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (vcMoreMenu) vcMoreMenu.classList.add('hidden');
    popOverlayHistory('vcMore');
    revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  });
}
document.addEventListener('click', (e) => {
  if (vcMoreMenu && !vcMoreMenu.classList.contains('hidden')) {
    if (!vcMoreMenu.contains(e.target) && !vcMoreBtn?.contains(e.target)) {
      vcMoreMenu.classList.add('hidden');
      popOverlayHistory('vcMore');
      revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    }
  }
});
if (vcSpeedChips) {
  vcSpeedChips.querySelectorAll('.vc-menu-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const spd = parseFloat(chip.dataset.speed);
      if (html5Video && Number.isFinite(spd)) {
        html5Video.playbackRate = spd;
        vcSpeedChips.querySelectorAll('.vc-menu-chip').forEach(c => c.classList.toggle('active', c === chip));
        if (vcMenuCurrentSpeed) vcMenuCurrentSpeed.textContent = `${spd}x`;
        if (playbackSpeedSelect) playbackSpeedSelect.value = String(spd);
        showPlayerOsd(`Скорость: ${spd}x`);
      }
    });
  });
}
if (vcDownloadBtn) {
  vcDownloadBtn.addEventListener('click', () => {
    const item = state.currentItem;
    if (!item) return;
    const activeEp = getActiveEpisodeObj(item);
    const streamUrl = activeEp?.rawHls || activeEp?.hlsUrl || (html5Video && html5Video.src ? html5Video.src : '');
    const title = `${item.title}${item.type === 'series' ? `_S${state.selectedSeason}E${state.selectedEpisode}` : ''}`;
    if (!streamUrl) {
      showPlayerOsd('Ссылка на поток не найдена');
      return;
    }
    const downloadUrl = `/api/download-stream?url=${encodeURIComponent(streamUrl)}&title=${encodeURIComponent(title)}`;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `${title}.m3u8`;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(streamUrl).catch(() => {});
    }
    if (vcDownloadInfo) {
      vcDownloadInfo.textContent = 'Файл загружается. Ссылка на поток скопирована в буфер.';
      vcDownloadInfo.classList.remove('hidden');
    }
    showPlayerOsd('📥 Загрузка видео запущена');
  });
}

// Actor Profile Modal Listeners
if (closeActorModalBtn) {
  closeActorModalBtn.addEventListener('click', closeActorProfile);
}
if (actorModalBackdrop) {
  actorModalBackdrop.addEventListener('click', closeActorProfile);
}
if (actorSearchInCatalogBtn) {
  actorSearchInCatalogBtn.addEventListener('click', () => {
    const actor = actorNameTitle?.textContent || '';
    closeActorProfile();
    closeItemModal();
    if (searchInput) {
      searchInput.value = actor;
      state.searchQuery = actor;
      state.category = 'all';
      syncCategoryButtons('all');
      loadCatalog();
      searchInput.focus();
    }
  });
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

function togglePlayPauseVideo() {
  if (!html5Video) return;
  if (lobbyState.pendingAutoplayBlocked && isLobbyGuest()) {
    lobbyState.pendingAutoplayBlocked = false;
    const latest = lobbyState.lobby?.playback;
    if (latest) {
      const targetSec = computeLobbyTargetTime(latest);
      if (targetSec > 0 && html5Video.readyState >= 1) html5Video.currentTime = targetSec;
    }
    html5Video.play().catch(() => {});
    updateCustomVideoBar();
    updateLobbyUi();
    revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    return;
  }
  if (guardLobbyGuestPlaybackControl()) return;
  if (html5Video.paused || html5Video.ended) {
    html5Video.play().catch(() => {});
  } else {
    html5Video.pause();
  }
  updateCustomVideoBar();
  revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
}

if (vcPlayPauseBtn) vcPlayPauseBtn.addEventListener('click', togglePlayPauseVideo);
bindResponsivePlayerButton(videoCenterPlayBtn, togglePlayPauseVideo);
if (vcBack5Btn) vcBack5Btn.addEventListener('click', () => seekRelative(-5));
if (vcFwd5Btn) vcFwd5Btn.addEventListener('click', () => seekRelative(5));
if (vcFullscreenBtn) vcFullscreenBtn.addEventListener('click', toggleVideoFullscreen);

if (vcVolDownBtn) {
  vcVolDownBtn.addEventListener('click', () => adjustVideoVolume(-0.1));
}
if (vcVolUpBtn) {
  vcVolUpBtn.addEventListener('click', () => adjustVideoVolume(0.1));
}
if (vcVolumeRange) {
  vcVolumeRange.addEventListener('input', () => {
    setVideoVolume(Number(vcVolumeRange.value) / 100, true);
  });
}
if (vcMuteBtn) {
  vcMuteBtn.addEventListener('click', () => {
    html5Video.muted = !html5Video.muted;
    if (!html5Video.muted && html5Video.volume === 0) {
      html5Video.volume = 0.5;
    }
    saveAudioPreferences();
    updateCustomVideoBar();
    showPlayerOsd(html5Video.muted ? 'Звук выключен' : `Громкость: ${Math.round(html5Video.volume * 100)}%`);
    revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  });
}

if (videoProgressRange) {
  videoProgressRange.addEventListener('input', () => {
    if (isLobbyGuest()) {
      isScrubbingVideo = false;
      updateCustomVideoBar();
      guardLobbyGuestPlaybackControl();
      return;
    }
    isScrubbingVideo = true;
    const dur = (Number.isFinite(html5Video.duration) && html5Video.duration > 0) ? html5Video.duration : 0;
    const ratio = Number(videoProgressRange.value) / 1000;
    videoProgressRange.style.setProperty('--pct', `${(ratio * 100).toFixed(2)}%`);
    if (videoTimeText && dur > 0) {
      videoTimeText.textContent = `${formatPlayerTime(ratio * dur)} / ${formatPlayerTime(dur)}`;
    }
    revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  });
  videoProgressRange.addEventListener('change', () => {
    if (guardLobbyGuestPlaybackControl()) {
      isScrubbingVideo = false;
      updateCustomVideoBar();
      return;
    }
    const dur = (Number.isFinite(html5Video.duration) && html5Video.duration > 0) ? html5Video.duration : 0;
    if (dur > 0) {
      const target = (Number(videoProgressRange.value) / 1000) * dur;
      html5Video.currentTime = target;
      if (isLobbyHost()) {
        scheduleHostPlaybackSync(`Перемотка на ${formatPlayerTime(target)}`, 80, { currentTime: target });
      }
    }
    isScrubbingVideo = false;
    updateSmartVideoOverlay();
    updateCustomVideoBar();
    saveLivePlaybackProgress();
    revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  });
}

document.addEventListener('touchstart', () => {
  lastAnyTouchTs = Date.now();
  isMouseOverPlayerControls = false;
}, { passive: true, capture: true });

['pointerup', 'pointercancel', 'touchend', 'touchcancel'].forEach(evt => {
  window.addEventListener(evt, () => {
    if (isScrubbingVideo) {
      isScrubbingVideo = false;
      revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    }
  }, { passive: true });
});

[customVideoBar, videoSmartOverlay].forEach(el => {
  if (!el) return;
  el.addEventListener('pointerenter', e => {
    if (e.pointerType === 'mouse' && !isCoarsePointerDevice() && !recentlyTouched(1500)) {
      isMouseOverPlayerControls = true;
      revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    }
  });
  el.addEventListener('pointerleave', e => {
    if (e.pointerType === 'mouse') {
      isMouseOverPlayerControls = false;
      revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    }
  });
});

document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
document.addEventListener('mozfullscreenchange', handleFullscreenChange);
document.addEventListener('MSFullscreenChange', handleFullscreenChange);

['fullscreenerror', 'webkitfullscreenerror'].forEach(evt => {
  document.addEventListener(evt, () => {
    if (pendingFsFallbackTimer) {
      clearTimeout(pendingFsFallbackTimer);
      pendingFsFallbackTimer = null;
    }
    const target = lastRequestedFsTarget || (directPlayerWrap.classList.contains('hidden') ? iframePlayerWrap : (videoStageArea || html5Video));
    if (target && !isVideoFullscreen()) {
      enterPseudoFullscreen(target);
    }
  });
});

html5Video.addEventListener('timeupdate', () => {
  updateSmartVideoOverlay();
  updateCustomVideoBar();
  const now = Date.now();
  if (now - lastHistorySaveTs >= 5000) {
    lastHistorySaveTs = now;
    saveLivePlaybackProgress();
  }
});

['seeking', 'loadedmetadata', 'durationchange', 'seeked', 'volumechange'].forEach(evt => {
  html5Video.addEventListener(evt, () => {
    updateSmartVideoOverlay();
    updateCustomVideoBar();
  });
});

html5Video.addEventListener('seeked', () => {
  updateSmartVideoOverlay();
  updateCustomVideoBar();
  if (!isApplyingLobbySync && isLobbyHost() && !itemModal.classList.contains('hidden')) {
    scheduleHostPlaybackSync('Перемотка', 120);
  }
});

html5Video.addEventListener('play', () => {
  updateSmartVideoOverlay();
  updateCustomVideoBar();
  revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  if (!isApplyingLobbySync && isLobbyHost() && !itemModal.classList.contains('hidden')) {
    scheduleHostPlaybackSync('Продолжил просмотр', 40, { paused: false });
  }
});

html5Video.addEventListener('playing', () => {
  updateCustomVideoBar();
  revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
});

html5Video.addEventListener('pause', () => {
  isMouseOverPlayerControls = false;
  updateSmartVideoOverlay();
  updateCustomVideoBar();
  if (overlayControlsTimer) {
    clearTimeout(overlayControlsTimer);
    overlayControlsTimer = null;
  }
  if (videoStageArea) {
    videoStageArea.classList.add('controls-active', 'is-paused');
  }
  saveLivePlaybackProgress();
  scheduleAccountPush('merge', true);
  if (!isApplyingLobbySync && isLobbyHost() && !itemModal.classList.contains('hidden')) {
    scheduleHostPlaybackSync('Поставил на паузу', 40, { paused: true });
  }
});

html5Video.addEventListener('ended', () => {
  updateCustomVideoBar();
  saveLivePlaybackProgress();
  if (sleepEndAfterEpisode) {
    setSleepTimer('off');
    showPlayerOsd('Таймер сна: воспроизведение остановлено');
    if (isPlayerScreenLocked) setPlayerScreenLocked(false);
    revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    return;
  }
  if (!isLobbyGuest()) {
    switchEpisodeStep(1, 'Автопереход');
  }
});

function isVideoOverlayControlTarget(el) {
  return Boolean(el && el.closest && el.closest('.video-smart-overlay, .custom-video-bar, .video-center-controls, .video-center-btn, .video-center-step-btn, .video-center-play, .vc-more-menu, .vc-unlock-pill, .vc-sleep-pill, .player-chat-drawer, .lobby-player-pill, .lobby-autoplay-btn'));
}

if (videoStageArea) {
  videoStageArea.addEventListener('pointermove', e => {
    if (isPlayerScreenLocked) return;
    if (e.pointerType !== 'mouse' || isCoarsePointerDevice() || recentlyTouched(1500)) return;
    const now = Date.now();
    if (now - lastOverlayRevealTs >= 250) {
      lastOverlayRevealTs = now;
      revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    }
  });
  videoStageArea.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'mouse' || isCoarsePointerDevice() || recentlyTouched(1500)) return;
    isMouseOverPlayerControls = false;
    hideVideoOverlayControls();
  });

  videoStageArea.addEventListener('touchstart', e => {
    lastAnyTouchTs = Date.now();
    isMouseOverPlayerControls = false;
    if (isPlayerScreenLocked) return;
    touchStartedWithControls = videoStageArea.classList.contains('controls-active');
    if (singleTapToggleTimer) {
      clearTimeout(singleTapToggleTimer);
      singleTapToggleTimer = null;
    }
    if (isVideoOverlayControlTarget(e.target) && !html5Video.paused) {
      revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
    }
  }, { passive: true });

  videoStageArea.addEventListener('click', e => {
    if (isPlayerScreenLocked) {
      if (!vcUnlockPill?.contains(e.target)) {
        revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
      }
      return;
    }
    if (isVideoOverlayControlTarget(e.target)) {
      return;
    }
    if (e.pointerType !== 'mouse' && (e.pointerType === 'touch' || isCoarsePointerDevice())) return;
    if ((Date.now() - lastTouchTapTime) < 650 || recentlyTouched(900)) return;
    if (videoClickTimer) clearTimeout(videoClickTimer);
    videoClickTimer = setTimeout(() => {
      videoClickTimer = null;
      togglePlayPauseVideo();
    }, 220);
  });

  videoStageArea.addEventListener('touchend', e => {
    lastAnyTouchTs = Date.now();
    isMouseOverPlayerControls = false;
    if (isPlayerScreenLocked) {
      if (!vcUnlockPill?.contains(e.target)) {
        revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
      }
      return;
    }
    if (isVideoOverlayControlTarget(e.target)) {
      if (videoStageArea.classList.contains('controls-active') && !html5Video.paused) {
        revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
      }
      return;
    }
    const rect = videoStageArea.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    if (y > rect.height - 80) return;
    const xRatio = x / rect.width;
    const side = xRatio < 0.4 ? -1 : (xRatio > 0.6 ? 1 : 0);

    const now = Date.now();
    const windowMs = seekStreakDir === side ? 650 : 320;
    if (side !== 0 && lastTouchTapSide === side && (now - lastTouchTapTime) <= windowMs) {
      if (e.cancelable) e.preventDefault();
      if (singleTapToggleTimer) {
        clearTimeout(singleTapToggleTimer);
        singleTapToggleTimer = null;
      }
      seekRelative(side * 5);
      lastTouchTapTime = now;
      lastTouchTapSide = side;
    } else {
      lastTouchTapTime = now;
      lastTouchTapSide = side;
      if (!touchStartedWithControls || html5Video.paused || html5Video.ended) {
        revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
      } else if (side === 0) {
        hideVideoOverlayControls();
      } else {
        singleTapToggleTimer = setTimeout(() => {
          singleTapToggleTimer = null;
          if (!html5Video.paused && !html5Video.ended) {
            hideVideoOverlayControls();
          }
        }, 250);
      }
    }
  }, { passive: false });

  videoStageArea.addEventListener('dblclick', e => {
    if (isVideoOverlayControlTarget(e.target)) {
      return;
    }
    if (videoClickTimer) {
      clearTimeout(videoClickTimer);
      videoClickTimer = null;
    }
    const rect = videoStageArea.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = e.clientX - rect.left;
    const xRatio = x / rect.width;
    e.preventDefault();
    if (xRatio < 0.35 || xRatio > 0.65) {
      seekRelative(xRatio < 0.5 ? -5 : 5);
    } else {
      toggleVideoFullscreen();
    }
  });
}

refreshParsersBtn.addEventListener('click', () => {
  if (state.currentItem) {
    populateFilesTab(state.currentItem);
    filesTabDirty = false;
  }
});

parsersStatusBtn.addEventListener('click', () => {
  parsersModal.classList.remove('hidden');
  pushOverlayHistory('parsers');
});
closeParsersModalBtn.addEventListener('click', () => {
  parsersModal.classList.add('hidden');
  popOverlayHistory('parsers');
});
parsersModal.addEventListener('click', e => {
  if (e.target === parsersModal) {
    parsersModal.classList.add('hidden');
    popOverlayHistory('parsers');
  }
});

// Unified Capture-Phase Keyboard & Smart TV Remote Navigation (D-Pad Ring, Back=461/10009, Media Keys)
document.addEventListener('keydown', e => {
  const isTyping = isTextEditingActive();

  // Quick search focus
  if (e.key === '/' && !isTyping && itemModal.classList.contains('hidden')) {
    e.preventDefault();
    searchInput.focus();
    return;
  }

  // Back / Escape handling: first exit fullscreen / close chat, then close top-most modal
  if (isBackKey(e, isTyping) && hasAnyOpenOverlay()) {
    e.preventDefault();
    e.stopPropagation();
    closeTopmostOverlay({ fromPopstate: false });
    return;
  }

  // Media Player Hotkeys (Play/Pause, Seek, Fullscreen)
  if (!itemModal.classList.contains('hidden') && state.activeTab === 'player' && !isTyping) {
    if (e.key === ' ' || e.key === 'k' || e.key === 'MediaPlayPause' || e.keyCode === 179) {
      if (document.activeElement?.tagName !== 'BUTTON') {
        e.preventDefault();
        togglePlayPauseVideo();
        return;
      }
    }
    if (e.keyCode === 415) { // TV Play
      e.preventDefault();
      html5Video.play().catch(() => {});
      updateCustomVideoBar();
      return;
    }
    if (e.keyCode === 19) { // TV Pause
      e.preventDefault();
      html5Video.pause();
      updateCustomVideoBar();
      return;
    }
    if (e.keyCode === 417) { // TV FastForward
      e.preventDefault();
      seekRelative(15);
      return;
    }
    if (e.keyCode === 412) { // TV Rewind
      e.preventDefault();
      seekRelative(-15);
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleVideoFullscreen();
      return;
    }
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      if (vcMuteBtn) vcMuteBtn.click();
      return;
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      adjustVideoVolume(0.1);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      adjustVideoVolume(-0.1);
      return;
    }
  }

  // D-Pad Arrow Keys (5s quick seek when watching without TV focus, otherwise spatial D-Pad ring navigation)
  const dir = getArrowDirection(e);
  if (dir && !isTyping) {
    const inPlayerDirect =
      !itemModal.classList.contains('hidden') &&
      state.activeTab === 'player' &&
      !directPlayerWrap.classList.contains('hidden');

    if (inPlayerDirect && !currentTvFocusedEl && (dir === 'ArrowLeft' || dir === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      seekRelative(dir === 'ArrowRight' ? 5 : -5);
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    moveSpatialFocus(dir);
    return;
  }

  // OK / Enter on focused TV element (cards, chips, overlay buttons, select dropdowns)
  if (!isTyping && isConfirmKey(e) && currentTvFocusedEl) {
    if (currentTvFocusedEl.tagName === 'SELECT') {
      e.preventDefault();
      e.stopPropagation();
      const sel = currentTvFocusedEl;
      if (sel.options.length > 0) {
        sel.selectedIndex = (sel.selectedIndex + 1) % sel.options.length;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    currentTvFocusedEl.click();
  }
}, true);

// Account & Cross-Device Sync Listeners
function setAuthTabMode(mode) {
  authMode = mode === 'register' ? 'register' : 'login';
  if (authTabLogin) authTabLogin.classList.toggle('active', authMode === 'login');
  if (authTabRegister) authTabRegister.classList.toggle('active', authMode === 'register');
  if (authPasswordInput) {
    authPasswordInput.autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
  }
  if (authSubmitBtn) {
    authSubmitBtn.textContent = authMode === 'register' ? 'Создать аккаунт' : 'Войти в аккаунт';
  }
  if (authMessage) {
    authMessage.classList.add('hidden');
    authMessage.textContent = '';
  }
}

function showAuthMessage(text, isOk = false) {
  if (!authMessage) return;
  authMessage.textContent = text;
  authMessage.classList.toggle('is-ok', isOk);
  authMessage.classList.remove('hidden');
}

if (accountBtn) {
  accountBtn.addEventListener('click', () => {
    updateAccountUI();
    if (authToken) pullAccountSync(true);
    accountModal.classList.remove('hidden');
    pushOverlayHistory('account');
  });
}

if (mobAccountNavBtn) {
  mobAccountNavBtn.addEventListener('click', () => {
    updateAccountUI();
    if (authToken) pullAccountSync(true);
    accountModal.classList.remove('hidden');
    pushOverlayHistory('account');
  });
}

if (closeAccountModalBtn) {
  closeAccountModalBtn.addEventListener('click', () => {
    accountModal.classList.add('hidden');
    popOverlayHistory('account');
  });
}

if (allNewReleasesBtn) {
  allNewReleasesBtn.addEventListener('click', () => {
    state.category = 'new';
    state.searchQuery = '';
    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
    syncCategoryButtons('new');
    loadCatalog();
    document.querySelector('.section-header')?.scrollIntoView({
      behavior: isSmartTv ? 'auto' : 'smooth',
      block: 'start'
    });
  });
}

if (allAnimeBtn) {
  allAnimeBtn.addEventListener('click', () => {
    state.category = 'anime';
    state.animeSubFilter = 'all';
    state.searchQuery = '';
    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
    syncCategoryButtons('anime');
    loadCatalog();
    document.querySelector('.section-header')?.scrollIntoView({
      behavior: isSmartTv ? 'auto' : 'smooth',
      block: 'start'
    });
  });
}

if (animeSubBar) {
  animeSubBar.querySelectorAll('.anime-sub-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sub = btn.dataset.animeSub || 'all';
      state.animeSubFilter = sub;
      const sortEl = document.getElementById('sortFilter') || document.getElementById('sortSelect');
      if (sub === 'top') {
        state.sort = 'rating';
      } else if (sub === 'new') {
        state.sort = 'year';
      } else {
        state.sort = 'popular';
      }
      if (sortEl) sortEl.value = state.sort;
      syncCategoryButtons(state.category);
      loadCatalog();
    });
  });
}

if (mobileCategoryStrip) {
  mobileCategoryStrip.querySelectorAll('.mob-cat-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const cat = pill.dataset.category || 'all';
      state.category = cat;
      if (cat === 'anime') state.animeSubFilter = 'all';
      state.searchQuery = '';
      searchInput.value = '';
      clearSearchBtn.classList.add('hidden');
      syncCategoryButtons(cat);
      loadCatalog();
    });
  });
}

if (randomPickBtn) {
  randomPickBtn.addEventListener('click', () => {
    const activePool = (state.catalogItems && state.catalogItems.length)
      ? state.catalogItems
      : (state.masterCatalog || []);
    if (!activePool.length) return;
    const pick = activePool[Math.floor(Math.random() * activePool.length)];
    if (pick) openItemModal(pick, 'info');
  });
}

if (accountModal) {
  accountModal.addEventListener('click', e => {
    if (e.target === accountModal) {
      accountModal.classList.add('hidden');
      popOverlayHistory('account');
    }
  });
}

if (authTabLogin) authTabLogin.addEventListener('click', () => setAuthTabMode('login'));
if (authTabRegister) authTabRegister.addEventListener('click', () => setAuthTabMode('register'));

if (authForm) {
  authForm.addEventListener('submit', async e => {
    e.preventDefault();
    const username = authUsernameInput.value.trim();
    const password = authPasswordInput.value;
    if (username.length < 2) {
      showAuthMessage('Никнейм должен быть не короче 2 символов');
      return;
    }
    if (password.length < 4) {
      showAuthMessage('Пароль должен быть не короче 4 символов');
      return;
    }

    authSubmitBtn.disabled = true;
    try {
      const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          history: state.history,
          favorites: state.favorites
        })
      });
      const data = await res.json();
      if (!res.ok) {
        showAuthMessage(data.error || 'Ошибка авторизации');
        return;
      }
      setAuthSession(data.token, data.user?.username || username);
      applySyncedUser(data.user);
      authPasswordInput.value = '';
      accountModal.classList.add('hidden');
      popOverlayHistory('account');
      showPlayerOsd(`Вход выполнен: ${authUser}`);
    } catch (err) {
      showAuthMessage('Нет связи с сервером');
    } finally {
      authSubmitBtn.disabled = false;
    }
  });
}

if (syncNowBtn) {
  syncNowBtn.addEventListener('click', async () => {
    syncNowBtn.disabled = true;
    if (profileSyncStatus) profileSyncStatus.textContent = 'Синхронизация...';
    const ok = await pushAccountSync('merge', false);
    if (!ok && profileSyncStatus) profileSyncStatus.textContent = 'Ошибка соединения';
    syncNowBtn.disabled = false;
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
    setAuthSession('', '');
    setAuthTabMode('login');
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveLivePlaybackProgress();
    scheduleAccountPush('merge', true);
  } else if (document.visibilityState === 'visible') {
    if (authToken) {
      pullAccountSync(false);
    } else {
      restoreAuthSessionFromCookie();
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration('/').then(reg => {
        if (reg) reg.update().catch(() => {});
      }).catch(() => {});
    }
  }
});

window.addEventListener('focus', () => {
  if (authToken) {
    pullAccountSync(false);
  } else {
    restoreAuthSessionFromCookie();
  }
});

window.addEventListener('pagehide', () => {
  saveLivePlaybackProgress();
  scheduleAccountPush('merge', true);
});

// PWA Service Worker v2 & App Install / Refresh Prompts (Android / Desktop / iOS / LG webOS / Linux)
let deferredInstallPrompt = null;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js?v=2', { updateViaCache: 'none' })
      .then(reg => {
        reg.update().catch(() => {});
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              worker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(() => {});
  });
}

if (pwaRefreshAppBtn) {
  pwaRefreshAppBtn.addEventListener('click', async () => {
    pwaRefreshAppBtn.disabled = true;
    pwaRefreshAppBtn.textContent = 'Обновление...';
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.update().catch(() => {})));
      }
    } catch (e) {}
    const sep = window.location.search ? '&' : '?';
    window.location.replace(`${window.location.pathname}${window.location.search}${sep}upd=${Date.now()}`);
  });
}

function updateInstallPromptUI() {
  if (!pwaInstallActionBtn) return;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone) {
    pwaInstallActionBtn.textContent = 'Приложение уже установлено';
    pwaInstallActionBtn.disabled = true;
    return;
  }
  if (deferredInstallPrompt) {
    pwaInstallActionBtn.textContent = 'Установить на устройство';
    pwaInstallActionBtn.disabled = false;
    if (pwaInstallHint) {
      pwaInstallHint.textContent = 'Нажмите кнопку ниже — система установит отдельное приложение СПБГУКА с иконкой на главный экран.';
    }
  } else {
    pwaInstallActionBtn.textContent = 'Как установить в браузере';
    pwaInstallActionBtn.disabled = false;
  }
}

function openInstallModal() {
  if (!installModal) return;
  const fromAccount = accountModal && !accountModal.classList.contains('hidden');
  if (fromAccount) {
    accountModal.classList.add('hidden');
  }
  updateInstallPromptUI();
  installModal.classList.remove('hidden');
  if (fromAccount) replaceOverlayHistory('account', 'install');
  else pushOverlayHistory('install');
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updateInstallPromptUI();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallPromptUI();
  showPlayerOsd('Приложение СПБГУКА установлено');
});

if (installAppBtn) installAppBtn.addEventListener('click', openInstallModal);
if (openInstallFromSidebarBtn) openInstallFromSidebarBtn.addEventListener('click', openInstallModal);
if (openInstallFromAccountBtn) openInstallFromAccountBtn.addEventListener('click', openInstallModal);
if (closeInstallModalBtn) {
  closeInstallModalBtn.addEventListener('click', () => {
    installModal.classList.add('hidden');
    popOverlayHistory('install');
  });
}
if (installModal) {
  installModal.addEventListener('click', e => {
    if (e.target === installModal) {
      installModal.classList.add('hidden');
      popOverlayHistory('install');
    }
  });
}
if (pwaInstallActionBtn) {
  pwaInstallActionBtn.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      try {
        await deferredInstallPrompt.userChoice;
      } catch (e) {}
      deferredInstallPrompt = null;
      updateInstallPromptUI();
      return;
    }
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (pwaInstallHint) {
      pwaInstallHint.textContent = isIos
        ? 'На iPhone / iPad откройте этот сайт в Safari → кнопка «Поделиться» → «На экран «Домой»».'
        : 'Откройте меню браузера (⋮ или ⋯ справа вверху) → «Установить приложение» / «Добавить на главный экран».';
    }
    showPlayerOsd(isIos ? 'Safari → Поделиться → На экран «Домой»' : 'Меню браузера (⋮) → Установить приложение');
  });
}

// Watch Party / Lobby Event Listeners
if (lobbyBtn) lobbyBtn.addEventListener('click', openLobbyModal);
if (lobbyPlayerPill) lobbyPlayerPill.addEventListener('click', openLobbyModal);
if (closeLobbyModalBtn) {
  closeLobbyModalBtn.addEventListener('click', () => {
    lobbyModal.classList.add('hidden');
    popOverlayHistory('lobby');
  });
}
if (lobbyModal) {
  lobbyModal.addEventListener('click', e => {
    if (e.target === lobbyModal) {
      lobbyModal.classList.add('hidden');
      popOverlayHistory('lobby');
    }
  });
}

if (lobbyLoginRedirectBtn) {
  lobbyLoginRedirectBtn.addEventListener('click', () => {
    lobbyModal.classList.add('hidden');
    if (accountModal) {
      updateAccountUI();
      accountModal.classList.remove('hidden');
      replaceOverlayHistory('lobby', 'account');
    } else {
      popOverlayHistory('lobby');
    }
  });
}

if (lobbyCreateForm) {
  lobbyCreateForm.addEventListener('submit', async e => {
    e.preventDefault();
    const name = lobbyNameInput ? lobbyNameInput.value.trim() : '';
    try {
      const data = await lobbyApi('/api/lobby/create', 'POST', { name });
      if (lobbyNameInput) lobbyNameInput.value = '';
      setCurrentLobby(data.lobby, true);
      showPlayerOsd(`Создано лобби «${data.lobby.name}»`);
      fetchLobbyUsers(lobbyUserSearchInput?.value.trim() || '');
    } catch (err) {
      showPlayerOsd(err.message);
    }
  });
}

if (lobbyJoinCodeForm) {
  lobbyJoinCodeForm.addEventListener('submit', async e => {
    e.preventDefault();
    const code = lobbyJoinCodeInput ? lobbyJoinCodeInput.value.trim().toUpperCase() : '';
    if (!code) return;
    await joinLobbyById(code);
    if (lobbyJoinCodeInput) lobbyJoinCodeInput.value = '';
  });
}

if (lobbyHubRefreshOnlineBtn) {
  lobbyHubRefreshOnlineBtn.addEventListener('click', () => fetchLobbyUsers(''));
}

if (lobbySearchRefreshBtn) {
  lobbySearchRefreshBtn.addEventListener('click', () => fetchLobbyUsers(lobbyUserSearchInput?.value.trim() || ''));
}

if (lobbyUserSearchInput) {
  lobbyUserSearchInput.addEventListener('input', () => {
    if (lobbyState.searchTimer) clearTimeout(lobbyState.searchTimer);
    lobbyState.searchTimer = setTimeout(() => {
      fetchLobbyUsers(lobbyUserSearchInput.value.trim());
    }, 220);
  });
}

if (lobbyRoomCodeBadge) {
  lobbyRoomCodeBadge.addEventListener('click', async () => {
    const code = lobbyState.lobby?.id || '';
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showPlayerOsd(`Код лобби скопирован: ${code}`);
    } catch (e) {
      showPlayerOsd(`Код лобби: ${code}`);
    }
  });
}

if (lobbyBrowseFilmsBtn) {
  lobbyBrowseFilmsBtn.addEventListener('click', () => {
    lobbyModal.classList.add('hidden');
    popOverlayHistory('lobby');
  });
}

function jumpToCurrentLobbyMedia() {
  const pb = lobbyState.lobby?.playback;
  if (!pb || !pb.mediaItem) return;
  lobbyModal.classList.add('hidden');
  replaceOverlayHistory('lobby', 'item');
  const targetSec = computeLobbyTargetTime(pb);
  openItemModal(pb.mediaItem, 'player', {
    season: pb.season || 1,
    episode: pb.episode || 1,
    voice: pb.voice || '',
    balancer: pb.balancer || 'direct',
    resumeSeconds: targetSec,
    paused: Boolean(pb.paused)
  });
}

if (lobbyOpenPlaybackBtn) lobbyOpenPlaybackBtn.addEventListener('click', jumpToCurrentLobbyMedia);
if (lobbySyncJumpBtn) lobbySyncJumpBtn.addEventListener('click', jumpToCurrentLobbyMedia);

if (lobbyLeaveBtn) {
  lobbyLeaveBtn.addEventListener('click', async () => {
    try { await lobbyApi('/api/lobby/leave', 'POST', {}); } catch (e) {}
    setCurrentLobby(null, true);
    showPlayerOsd('Вы вышли из лобби');
  });
}

if (lobbyCloseRoomBtn) {
  lobbyCloseRoomBtn.addEventListener('click', async () => {
    try { await lobbyApi('/api/lobby/close', 'POST', {}); } catch (e) {}
    setCurrentLobby(null, true);
    showPlayerOsd('Лобби закрыто');
  });
}

if (lobbyTabMembersBtn) lobbyTabMembersBtn.addEventListener('click', () => setLobbyModalTab('members'));
if (lobbyTabChatBtn) lobbyTabChatBtn.addEventListener('click', () => setLobbyModalTab('chat'));

if (vcLobbyChatBtn) {
  vcLobbyChatBtn.addEventListener('click', () => {
    togglePlayerChatDrawer();
    revealVideoOverlayControls(DEFAULT_CONTROLS_HIDE_MS);
  });
}

if (closePlayerChatBtn) {
  closePlayerChatBtn.addEventListener('click', () => togglePlayerChatDrawer(false));
}

if (playerChatForm) {
  playerChatForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (!playerChatInput) return;
    const text = playerChatInput.value;
    playerChatInput.value = '';
    await sendLobbyChatText(text);
  });
}

if (lobbyModalChatForm) {
  lobbyModalChatForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (!lobbyModalChatInput) return;
    const text = lobbyModalChatInput.value;
    lobbyModalChatInput.value = '';
    await sendLobbyChatText(text);
  });
}

if (lobbyAutoplayResumeBtn) {
  lobbyAutoplayResumeBtn.addEventListener('click', () => {
    lobbyState.pendingAutoplayBlocked = false;
    const pb = lobbyState.lobby?.playback;
    if (pb && html5Video.readyState >= 1) {
      html5Video.currentTime = computeLobbyTargetTime(pb);
    }
    html5Video.play().catch(() => {});
    updateLobbyUi();
  });
}

if (inviteToastAcceptBtn) {
  inviteToastAcceptBtn.addEventListener('click', async () => {
    const code = lobbyInviteToast?.dataset.lobbyId || '';
    if (!code) return;
    await joinLobbyById(code);
    openLobbyModal();
  });
}

if (inviteToastDeclineBtn) {
  inviteToastDeclineBtn.addEventListener('click', async () => {
    const code = lobbyInviteToast?.dataset.lobbyId || '';
    if (code) await declineLobbyInvite(code);
  });
}

// Clear TV focus highlight when user switches to mouse/touch
document.addEventListener('pointerdown', clearTvFocus);

if (loadMoreBtn) {
  loadMoreBtn.addEventListener('click', loadMoreCatalogItems);
}

// Initialize
applySavedAudioPreferences();
updateCustomVideoBar();
updateBadges();
updateAccountUI();
syncLobbyAuthSession();
if (authToken) {
  pullAccountSync(true);
} else {
  restoreAuthSessionFromCookie();
}
loadCatalog();
