// СПБГУКА — HD VideoBox Web Edition Client Application (with Real HLS Multi-Audio Streaming)

const state = {
  category: 'all',
  genre: 'all',
  year: 'all',
  sort: 'popular',
  searchQuery: '',
  catalogItems: [],
  favorites: JSON.parse(localStorage.getItem('spbguka_favorites') || '[]'),
  history: JSON.parse(localStorage.getItem('spbguka_history') || '[]'),
  currentItem: null,
  activeTab: 'player',
  selectedBalancer: 'direct',
  selectedVoice: 'Рус. Дублированный',
  selectedQuality: 'Авто (Макс. 1080p)',
  selectedSeason: 1,
  selectedEpisode: 1,
  blockedAds: 142
};

let hlsInstance = null;
let currentLoadedHlsUrl = '';
let osdTimeout = null;

// DOM Elements
const catalogGrid = document.getElementById('catalogGrid');
const loadingState = document.getElementById('loadingState');
const emptyState = document.getElementById('emptyState');
const resultsCount = document.getElementById('resultsCount');
const sectionTitle = document.getElementById('sectionTitle');
const sectionSubtitle = document.getElementById('sectionSubtitle');

const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');

const favCountBadge = document.getElementById('favCountBadge');
const historyCountBadge = document.getElementById('historyCountBadge');
const blockedAdsCounter = document.getElementById('blockedAdsCounter');

const continueWatchingBar = document.getElementById('continueWatchingBar');
const continueTitle = document.getElementById('continueTitle');
const continueMeta = document.getElementById('continueMeta');
const continuePlayBtn = document.getElementById('continuePlayBtn');

// Modal Elements
const itemModal = document.getElementById('itemModal');
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
const balancerSelector = document.getElementById('balancerSelector');
const customStreamRow = document.getElementById('customStreamRow');
const customStreamInput = document.getElementById('customStreamInput');
const applyCustomStreamBtn = document.getElementById('applyCustomStreamBtn');
const voiceSelector = document.getElementById('voiceSelector');
const qualitySelector = document.getElementById('qualitySelector');
const sandboxToggle = document.getElementById('sandboxToggle');

const seriesPickerBox = document.getElementById('seriesPickerBox');
const seasonButtons = document.getElementById('seasonButtons');
const episodeButtons = document.getElementById('episodeButtons');
const prevEpBtn = document.getElementById('prevEpBtn');
const nextEpBtn = document.getElementById('nextEpBtn');

const playerOsd = document.getElementById('playerOsd');
const directPlayerWrap = document.getElementById('directPlayerWrap');
const html5Video = document.getElementById('html5Video');
const nowPlayingText = document.getElementById('nowPlayingText');
const playbackSpeedSelect = document.getElementById('playbackSpeedSelect');
const pipBtn = document.getElementById('pipBtn');

const iframePlayerWrap = document.getElementById('iframePlayerWrap');
const balancerIframe = document.getElementById('balancerIframe');
const kinoboxContainer = document.getElementById('kinoboxContainer');

const filesTreeContainer = document.getElementById('filesTreeContainer');
const refreshParsersBtn = document.getElementById('refreshParsersBtn');

// Parsers Modal
const parsersModal = document.getElementById('parsersModal');
const parsersStatusBtn = document.getElementById('parsersStatusBtn');
const adShieldBtn = document.getElementById('adShieldBtn');
const closeParsersModalBtn = document.getElementById('closeParsersModalBtn');

const CATEGORY_TITLES = {
  all: 'Весь каталог СПБГУКА (HD VideoBox)',
  popular: 'Популярные фильмы и сериалы сейчас',
  new: 'Новинки кино и сериалов (2023–2026)',
  movie: 'Фильмы в HD 1080p / 4K без рекламы',
  series: 'Сериалы во всех озвучках',
  cartoon: 'Мультфильмы и анимация',
  anime: 'Аниме (Studio Band / AniLibria / Субтитры)',
  favorites: '⭐ Избранные фильмы и сериалы',
  history: '🕒 История вашего просмотра'
};

const TYPE_LABELS = {
  movie: 'ФИЛЬМ',
  series: 'СЕРИАЛ',
  cartoon: 'МУЛЬТФИЛЬМ',
  anime: 'АНИМЕ'
};

function updateBadges() {
  favCountBadge.textContent = state.favorites.length;
  historyCountBadge.textContent = state.history.length;

  if (state.history.length > 0) {
    const last = state.history[0];
    continueWatchingBar.classList.remove('hidden');
    continueTitle.textContent = last.title;
    const epPart = (last.type === 'series' || last.type === 'anime' || last.type === 'cartoon')
      ? `Сезон ${last.season || 1}, Серия ${last.episode || 1} • `
      : '';
    continueMeta.textContent = `${epPart}Озвучка: ${last.voice || 'Дубляж'} • ${last.quality || '1080p'}`;
  } else {
    continueWatchingBar.classList.add('hidden');
  }
}

function saveFavorites() {
  localStorage.setItem('spbguka_favorites', JSON.stringify(state.favorites));
  updateBadges();
}

function addToHistory(item, season, episode, voice, quality, currentTime = 0) {
  const entry = {
    id: item.id,
    imdbId: item.imdbId,
    kpId: item.kpId,
    title: item.title,
    originalTitle: item.originalTitle,
    type: item.type,
    year: item.year,
    ratingKp: item.ratingKp,
    ratingImdb: item.ratingImdb,
    poster: item.poster,
    genres: item.genres || ['Кино'],
    voices: item.voices || ['Рус. Дублированный'],
    season,
    episode,
    voice,
    quality,
    currentTime: Math.floor(currentTime || 0),
    updatedAt: Date.now()
  };

  state.history = [entry, ...state.history.filter(x => x.imdbId !== item.imdbId)].slice(0, 40);
  localStorage.setItem('spbguka_history', JSON.stringify(state.history));
  updateBadges();
}

function incrementAdBlockCounter(amount = 3) {
  state.blockedAds += amount;
  blockedAdsCounter.textContent = state.blockedAds;
}

async function loadCatalog() {
  loadingState.classList.remove('hidden');
  emptyState.classList.add('hidden');
  catalogGrid.innerHTML = '';

  if (state.searchQuery.trim()) {
    sectionTitle.textContent = `Результаты поиска: «${state.searchQuery}»`;
    sectionSubtitle.textContent = 'Глобальный поиск по базам Кинопоиск, IMDb, Wikidata RU и балансерам СПБГУКА';
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(state.searchQuery)}`);
      const data = await res.json();
      state.catalogItems = data.items || [];
    } catch (e) {
      state.catalogItems = [];
    }
  } else if (state.category === 'favorites') {
    sectionTitle.textContent = CATEGORY_TITLES.favorites;
    sectionSubtitle.textContent = 'Сохранённые вами фильмы и сериалы для быстрого доступа';
    state.catalogItems = [...state.favorites];
  } else if (state.category === 'history') {
    sectionTitle.textContent = CATEGORY_TITLES.history;
    sectionSubtitle.textContent = 'Продолжайте просмотр с выбранной серии, студии озвучки и секунды';
    state.catalogItems = [...state.history];
  } else {
    sectionTitle.textContent = CATEGORY_TITLES[state.category] || CATEGORY_TITLES.all;
    sectionSubtitle.textContent = 'Автоматический парсинг прямых HLS-потоков со всех балансеров • Любая студия озвучки • 0% рекламы';
    try {
      const params = new URLSearchParams({
        category: state.category,
        genre: state.genre,
        year: state.year,
        sort: state.sort
      });
      const res = await fetch(`/api/catalog?${params.toString()}`);
      const data = await res.json();
      state.catalogItems = data.items || [];
    } catch (e) {
      state.catalogItems = [];
    }
  }

  loadingState.classList.add('hidden');
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

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'movie-card';
    const typeLabel = TYPE_LABELS[item.type] || 'КИНО';
    const voicesList = item.voices || ['Рус. Дублированный', 'HDrezka Studio', 'Red Head Sound'];
    const historyMatch = state.history.find(h => h.imdbId === item.imdbId);

    card.innerHTML = `
      <div class="card-poster-wrap">
        <img
          src="${item.poster}"
          alt="${item.title}"
          class="card-poster"
          loading="lazy"
          onerror="this.src='https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=600&q=80'"
        />
        <div class="card-badges-top">
          <span class="card-type-pill">${typeLabel}</span>
          <div class="card-ratings-pill">
            ${item.ratingKp ? `<span class="r-badge kp">КП ${item.ratingKp}</span>` : ''}
            ${item.ratingImdb ? `<span class="r-badge imdb">IMDb ${item.ratingImdb}</span>` : ''}
          </div>
        </div>
        <div class="card-quality-ribbon">
          <span class="q-pill">1080p HLS</span>
          <span class="voices-count-pill">🎙️ ${voicesList.length} озвучек</span>
        </div>
        <div class="card-play-hover">
          <div class="play-circle">▶</div>
          <span style="font-size:0.78rem;font-weight:700;color:#fff;">Смотреть без рекламы</span>
        </div>
      </div>
      <div class="card-body">
        <h3 class="card-title" title="${item.title}">${item.title}</h3>
        <div class="card-sub">${item.yearRange || item.year} • ${(item.genres || ['Кино']).slice(0, 2).join(', ')}</div>
        <div class="card-voices-preview">
          ${historyMatch
            ? `🕒 Продолжить: С${historyMatch.season}Э${historyMatch.episode} (${historyMatch.voice})`
            : `🎙️ ${voicesList.slice(0, 2).join(', ')}`}
        </div>
      </div>
    `;

    card.addEventListener('click', () => openItemModal(item));
    catalogGrid.appendChild(card);
  }
}

function getActiveEpisodeObj(item) {
  if (!item || !item.seasons) return null;
  const seasonList = item.seasons[state.selectedSeason] || Object.values(item.seasons)[0] || [];
  return seasonList.find(ep => Number(ep.episode) === Number(state.selectedEpisode)) || seasonList[0] || null;
}

async function openItemModal(itemSummary, initialTab = 'player') {
  itemModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  incrementAdBlockCounter(4);

  const savedHistory = state.history.find(h => h.imdbId === itemSummary.imdbId);

  modalTitle.textContent = itemSummary.title;
  modalOrigTitle.textContent = `${itemSummary.originalTitle || ''} (${itemSummary.yearRange || itemSummary.year || ''})`;
  modalTypeBadge.textContent = TYPE_LABELS[itemSummary.type] || 'КИНО';
  nowPlayingText.textContent = `⏳ Подключение прямого HLS-потока без рекламы для «${itemSummary.title}»...`;

  try {
    const res = await fetch(`/api/details?imdb=${encodeURIComponent(itemSummary.imdbId)}&title=${encodeURIComponent(itemSummary.title)}`);
    const detailed = await res.json();
    state.currentItem = detailed;
  } catch (e) {
    state.currentItem = {
      ...itemSummary,
      seasons: { 1: [{ season: 1, episode: 1, title: 'Основной поток', hlsUrl: '', voices: itemSummary.voices || ['Рус. Дублированный'] }] },
      qualities: ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD', '360p'],
      providers: [{ id: 'direct', name: 'СПБГУКА Direct HLS', badge: '1080p', speed: '110 Мбит/с' }]
    };
  }

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
  populateFilesTab(item);
  updateFavButtonState();
  switchModalTab(initialTab);
  startPlayback(savedHistory?.currentTime || 0, true);
}

function populateInfoTab(item) {
  modalTitle.textContent = item.title;
  modalOrigTitle.textContent = `${item.originalTitle || item.title} (${item.yearRange || item.year})`;
  modalTypeBadge.textContent = TYPE_LABELS[item.type] || 'КИНО';

  infoPoster.src = item.poster;
  infoRatingKp.textContent = item.ratingKp || '8.1';
  infoRatingImdb.textContent = item.ratingImdb || '8.2';
  infoYear.textContent = item.yearRange || item.year || '2024';
  infoCountry.textContent = item.country || 'США / Мир';
  infoGenres.textContent = (item.genres || ['Кино']).join(', ');
  infoDuration.textContent = item.duration || '120 мин';
  infoDirector.textContent = item.director || 'Не указан';
  infoCast.textContent = item.cast || 'Не указан';
  infoIds.textContent = `IMDb: ${item.imdbId || '—'} | Кинопоиск ID: ${item.kpId || 'Авто-поиск'}`;
  infoDescription.textContent = item.description || 'Описание загружается...';

  infoVoicesList.innerHTML = '';
  for (const v of (item.voices || [])) {
    const btn = document.createElement('button');
    btn.className = 'chip-btn';
    btn.textContent = `🎙️ ${v}`;
    btn.addEventListener('click', () => {
      state.selectedVoice = v;
      populatePlayerControls(item);
      switchModalTab('player');
      switchAudioTrackOrRestart(v);
      showPlayerOsd(`🎙️ Выбрана озвучка: ${v}`);
    });
    infoVoicesList.appendChild(btn);
  }
}

// Switch audio track live in hls.js without reloading stream if already playing
function switchAudioTrackOrRestart(voiceName) {
  const item = state.currentItem;
  if (!item) return;
  const activeEp = getActiveEpisodeObj(item);
  const epVoices = activeEp?.voices || item.voices || [];
  const voiceIdx = epVoices.indexOf(voiceName);

  if (state.selectedBalancer === 'direct' && hlsInstance && hlsInstance.audioTracks && hlsInstance.audioTracks.length > 0 && voiceIdx >= 0 && voiceIdx < hlsInstance.audioTracks.length) {
    hlsInstance.audioTrack = voiceIdx;
    const epPart = (item.type === 'series' || item.type === 'anime' || item.type === 'cartoon')
      ? ` • Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}`
      : '';
    nowPlayingText.textContent = `${item.title}${epPart} • Озвучка: ${state.selectedVoice} • [${state.selectedQuality}]`;
    addToHistory(item, state.selectedSeason, state.selectedEpisode, state.selectedVoice, state.selectedQuality, html5Video.currentTime || 0);
  } else {
    startPlayback(html5Video.currentTime || 0, true);
  }
}

// Switch quality level live in hls.js
function switchQualityLevel(qualityLabel) {
  if (state.selectedBalancer === 'direct' && hlsInstance && hlsInstance.levels && hlsInstance.levels.length > 0) {
    if (qualityLabel.startsWith('Авто')) {
      hlsInstance.currentLevel = -1;
    } else {
      const targetHeight = parseInt(qualityLabel, 10); // 1080, 720, 480, 360
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
    btn.className = `chip-btn ${state.selectedVoice === voice ? 'active' : ''}`;
    btn.textContent = voice;
    btn.addEventListener('click', () => {
      state.selectedVoice = voice;
      populatePlayerControls(item);
      switchAudioTrackOrRestart(voice);
      showPlayerOsd(`🎙️ Озвучка переключена: ${voice}`);
    });
    voiceSelector.appendChild(btn);
  }

  // Qualities
  qualitySelector.innerHTML = '';
  const qualities = item.qualities || ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD', '360p'];
  for (const q of qualities) {
    const btn = document.createElement('button');
    btn.className = `chip-btn ${state.selectedQuality === q ? 'active' : ''}`;
    btn.textContent = q;
    btn.addEventListener('click', () => {
      state.selectedQuality = q;
      populatePlayerControls(item);
      switchQualityLevel(q);
      showPlayerOsd(`💎 Качество видео: ${q}`);
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
      sBtn.className = `chip-btn ${Number(state.selectedSeason) === sNum ? 'active' : ''}`;
      sBtn.textContent = `Сезон ${sNum}`;
      sBtn.addEventListener('click', () => {
        state.selectedSeason = sNum;
        const firstEp = seasonsObj[sNum]?.[0]?.episode || 1;
        state.selectedEpisode = firstEp;
        populatePlayerControls(item);
        populateFilesTab(item);
        startPlayback(0, true);
        showPlayerOsd(`📁 Сезон ${sNum}, Серия ${firstEp} • ${state.selectedVoice}`);
      });
      seasonButtons.appendChild(sBtn);
    }

    episodeButtons.innerHTML = '';
    const eps = seasonsObj[state.selectedSeason] || [];
    for (const ep of eps) {
      const epBtn = document.createElement('button');
      epBtn.className = `ep-btn ${Number(state.selectedEpisode) === Number(ep.episode) ? 'active' : ''}`;
      epBtn.innerHTML = `
        <span class="ep-num">${ep.episode} серия</span>
        <span class="ep-name" title="${ep.title}">${ep.title}</span>
      `;
      epBtn.addEventListener('click', () => {
        state.selectedEpisode = ep.episode;
        populatePlayerControls(item);
        populateFilesTab(item);
        startPlayback(0, true);
        showPlayerOsd(`▶ Сезон ${state.selectedSeason}, Серия ${ep.episode} • ${state.selectedVoice}`);
      });
      episodeButtons.appendChild(epBtn);
    }
  } else {
    seriesPickerBox.classList.add('hidden');
  }
}

function populateFilesTab(item) {
  filesTreeContainer.innerHTML = '';
  const providers = item.providers || [
    { id: 'direct', name: 'СПБГУКА Direct HLS (Без рекламы)', badge: '1080p FHD', speed: '120 Мбит/с' }
  ];
  const activeEp = getActiveEpisodeObj(item);
  const voices = activeEp?.voices || item.voices || ['Рус. Дублированный'];
  const qualities = item.qualities || ['Авто (Макс. 1080p)', '1080p FHD', '720p HD', '480p SD'];

  for (const prov of providers) {
    const group = document.createElement('div');
    group.className = 'provider-group';

    let rowsHtml = '';
    for (const voice of voices) {
      const epLabel = (item.type === 'series' || item.type === 'anime' || item.type === 'cartoon')
        ? `Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}`
        : 'Полный фильм';

      const qButtonsHtml = qualities.map(q => `
        <button class="chip-btn file-launch-btn" data-voice="${voice}" data-quality="${q}" data-prov="${prov.id}">
          ▶ ${q}
        </button>
      `).join('');

      rowsHtml += `
        <div class="file-stream-row">
          <div class="file-meta">
            <span>🎬 <strong>${item.title}</strong> (${epLabel})</span>
            <span class="file-voice-tag">🎙️ ${voice}</span>
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
          <strong>📡 ${prov.name}</strong>
          <span style="margin-left:10px;font-size:0.78rem;color:var(--accent-green);">● ${prov.badge} (${prov.speed})</span>
        </div>
        <span class="mono" style="color:var(--text-muted);">HLS Stream: Ready</span>
      </div>
      <div class="provider-files-list">
        ${rowsHtml}
      </div>
    `;
    filesTreeContainer.appendChild(group);
  }

  filesTreeContainer.querySelectorAll('.file-launch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.selectedVoice = btn.dataset.voice;
      state.selectedQuality = btn.dataset.quality;
      state.selectedBalancer = btn.dataset.prov === 'vidsrc' ? 'vidsrc' : 'direct';
      updateBalancerButtons();
      populatePlayerControls(item);
      switchModalTab('player');
      startPlayback(0, true);
      showPlayerOsd(`🚀 Запущен поток: ${state.selectedVoice} (${state.selectedQuality})`);
    });
  });
}

function showPlayerOsd(message) {
  playerOsd.textContent = message;
  playerOsd.classList.remove('hidden');
  if (osdTimeout) clearTimeout(osdTimeout);
  osdTimeout = setTimeout(() => {
    playerOsd.classList.add('hidden');
  }, 3200);
}

function updateBalancerButtons() {
  balancerSelector.querySelectorAll('.chip-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.balancer === state.selectedBalancer);
  });
  customStreamRow.classList.toggle('hidden', state.selectedBalancer !== 'custom');
}

function destroyHls() {
  if (hlsInstance) {
    try { hlsInstance.destroy(); } catch (e) {}
    hlsInstance = null;
  }
  currentLoadedHlsUrl = '';
}

function startPlayback(resumeSeconds = 0, forceReload = false) {
  const item = state.currentItem;
  if (!item) return;

  const activeEp = getActiveEpisodeObj(item);
  const epVoices = activeEp?.voices || item.voices || ['Рус. Дублированный'];
  const voiceIdx = Math.max(0, epVoices.indexOf(state.selectedVoice));

  addToHistory(item, state.selectedSeason, state.selectedEpisode, state.selectedVoice, state.selectedQuality, resumeSeconds);

  const epPart = (item.type === 'series' || item.type === 'anime' || item.type === 'cartoon')
    ? ` • Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}`
    : '';
  nowPlayingText.textContent = `${item.title}${epPart} • Озвучка: ${state.selectedVoice} • [${state.selectedQuality}]`;

  // If Direct HLS mode is selected and we have a real parsed HLS URL for this episode/movie
  if (state.selectedBalancer === 'direct' && activeEp && activeEp.hlsUrl) {
    iframePlayerWrap.classList.add('hidden');
    balancerIframe.src = 'about:blank';
    directPlayerWrap.classList.remove('hidden');

    const targetHlsUrl = activeEp.hlsUrl;

    if (!forceReload && currentLoadedHlsUrl === targetHlsUrl && hlsInstance) {
      if (hlsInstance.audioTracks && voiceIdx < hlsInstance.audioTracks.length) {
        hlsInstance.audioTrack = voiceIdx;
      }
      switchQualityLevel(state.selectedQuality);
      html5Video.play().catch(() => {});
      return;
    }

    destroyHls();
    currentLoadedHlsUrl = targetHlsUrl;
    html5Video.poster = '';

    if (window.Hls && window.Hls.isSupported()) {
      hlsInstance = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60
      });

      hlsInstance.loadSource(targetHlsUrl);
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
    } else if (html5Video.canPlayType('application/vnd.apple.mpegurl')) {
      html5Video.src = targetHlsUrl;
      html5Video.addEventListener('loadedmetadata', () => {
        if (resumeSeconds > 2) html5Video.currentTime = resumeSeconds;
        html5Video.play().catch(() => {});
      }, { once: true });
    }
    return;
  }

  // Fallback or explicit External Web Balancers (Namy / Kinogram / VidSrc)
  destroyHls();
  html5Video.pause();
  html5Video.removeAttribute('src');
  directPlayerWrap.classList.add('hidden');
  iframePlayerWrap.classList.remove('hidden');
  kinoboxContainer.classList.add('hidden');
  balancerIframe.classList.remove('hidden');

  applyIframeSandbox();

  const idPath = item.kpId ? `/embed/kp/${encodeURIComponent(item.kpId)}` : `/embed/imdb/${encodeURIComponent(item.imdbId)}`;

  if (state.selectedBalancer === 'namy' || (state.selectedBalancer === 'direct' && !activeEp?.hlsUrl)) {
    const seasonParams = (item.type === 'series' || item.type === 'anime' || item.type === 'cartoon')
      ? `?season=${state.selectedSeason}&episode=${state.selectedEpisode}`
      : '';
    balancerIframe.src = `https://api.namy.ws${idPath}${seasonParams}`;
    showPlayerOsd(`🌐 Подключён балансер Collaps / Namy`);
  } else if (state.selectedBalancer === 'kinogram') {
    const seasonParams = (item.type === 'series' || item.type === 'anime' || item.type === 'cartoon')
      ? `?season=${state.selectedSeason}&episode=${state.selectedEpisode}`
      : '';
    balancerIframe.src = `https://api.kinogram.best${idPath}${seasonParams}`;
    showPlayerOsd(`🎬 Подключён балансер Kinogram Mirror`);
  } else if (state.selectedBalancer === 'vidsrc') {
    const isTv = item.type === 'series' || item.type === 'anime' || item.type === 'cartoon';
    const embedUrl = isTv
      ? `https://vidsrc.su/embed/tv/${encodeURIComponent(item.imdbId)}/${state.selectedSeason}/${state.selectedEpisode}`
      : `https://vidsrc.su/embed/movie/${encodeURIComponent(item.imdbId)}`;
    balancerIframe.src = embedUrl;
    showPlayerOsd(`🌍 Подключён балансер VidSrc.su (С${state.selectedSeason}Э${state.selectedEpisode})`);
  } else if (state.selectedBalancer === 'custom') {
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
      balancerIframe.src = customUrl;
    }
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
}

function closeItemModal() {
  destroyHls();
  html5Video.pause();
  balancerIframe.src = 'about:blank';
  itemModal.classList.add('hidden');
  document.body.style.overflow = '';
}

function updateFavButtonState() {
  if (!state.currentItem) return;
  const isFav = state.favorites.some(f => f.imdbId === state.currentItem.imdbId);
  modalFavBtn.textContent = isFav ? '★ В избранном' : '☆ В избранное';
  modalFavBtn.style.borderColor = isFav ? 'var(--accent-gold)' : '';
  modalFavBtn.style.color = isFav ? 'var(--accent-gold)' : '';
}

// Event Listeners
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.category = btn.dataset.category;
    state.searchQuery = '';
    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
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

searchForm.addEventListener('submit', e => {
  e.preventDefault();
  state.searchQuery = searchInput.value.trim();
  clearSearchBtn.classList.toggle('hidden', !state.searchQuery);
  loadCatalog();
});

searchInput.addEventListener('input', () => {
  clearSearchBtn.classList.toggle('hidden', !searchInput.value);
});

clearSearchBtn.addEventListener('click', () => {
  searchInput.value = '';
  state.searchQuery = '';
  clearSearchBtn.classList.add('hidden');
  loadCatalog();
});

document.querySelectorAll('.quick-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    const q = tag.dataset.query;
    searchInput.value = q;
    state.searchQuery = q;
    clearSearchBtn.classList.remove('hidden');
    loadCatalog();
  });
});

document.getElementById('sidebarToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
});

document.getElementById('brandLogo').addEventListener('click', e => {
  e.preventDefault();
  state.category = 'all';
  state.genre = 'all';
  state.searchQuery = '';
  searchInput.value = '';
  clearSearchBtn.classList.add('hidden');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.category === 'all'));
  loadCatalog();
});

continuePlayBtn.addEventListener('click', () => {
  if (state.history.length > 0) {
    openItemModal(state.history[0], 'player');
  }
});

// Modal Tabs & Controls
document.querySelectorAll('.hdvb-tab').forEach(tab => {
  tab.addEventListener('click', () => switchModalTab(tab.dataset.tab));
});

switchToPlayerBtn.addEventListener('click', () => switchModalTab('player'));
closeModalBtn.addEventListener('click', closeItemModal);

itemModal.addEventListener('click', e => {
  if (e.target === itemModal) closeItemModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !itemModal.classList.contains('hidden')) {
    closeItemModal();
  }
});

modalFavBtn.addEventListener('click', () => {
  if (!state.currentItem) return;
  const idx = state.favorites.findIndex(f => f.imdbId === state.currentItem.imdbId);
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
  } else {
    state.favorites.unshift(state.currentItem);
  }
  saveFavorites();
  updateFavButtonState();
  if (state.category === 'favorites') loadCatalog();
});

balancerSelector.querySelectorAll('.chip-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.selectedBalancer = btn.dataset.balancer;
    updateBalancerButtons();
    startPlayback(html5Video.currentTime || 0, true);
  });
});

applyCustomStreamBtn.addEventListener('click', () => startPlayback(0, true));
sandboxToggle.addEventListener('change', () => {
  applyIframeSandbox();
  if (state.selectedBalancer !== 'direct') startPlayback(0, true);
});

prevEpBtn.addEventListener('click', () => {
  if (!state.currentItem) return;
  const eps = (state.currentItem.seasons && state.currentItem.seasons[state.selectedSeason]) || [];
  const curIdx = eps.findIndex(e => Number(e.episode) === Number(state.selectedEpisode));
  if (curIdx > 0) {
    state.selectedEpisode = eps[curIdx - 1].episode;
    populatePlayerControls(state.currentItem);
    populateFilesTab(state.currentItem);
    startPlayback(0, true);
    showPlayerOsd(`⏮ Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}`);
  }
});

nextEpBtn.addEventListener('click', () => {
  if (!state.currentItem) return;
  const eps = (state.currentItem.seasons && state.currentItem.seasons[state.selectedSeason]) || [];
  const curIdx = eps.findIndex(e => Number(e.episode) === Number(state.selectedEpisode));
  if (curIdx >= 0 && curIdx < eps.length - 1) {
    state.selectedEpisode = eps[curIdx + 1].episode;
    populatePlayerControls(state.currentItem);
    populateFilesTab(state.currentItem);
    startPlayback(0, true);
    showPlayerOsd(`⏭ Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}`);
  }
});

playbackSpeedSelect.addEventListener('change', e => {
  html5Video.playbackRate = parseFloat(e.target.value);
  showPlayerOsd(`⏩ Скорость воспроизведения: ${e.target.value}x`);
});

pipBtn.addEventListener('click', async () => {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await html5Video.requestPictureInPicture();
    }
  } catch (e) {}
});

html5Video.addEventListener('ended', () => {
  if (!state.currentItem) return;
  const eps = (state.currentItem.seasons && state.currentItem.seasons[state.selectedSeason]) || [];
  const curIdx = eps.findIndex(e => Number(e.episode) === Number(state.selectedEpisode));
  if (curIdx >= 0 && curIdx < eps.length - 1) {
    state.selectedEpisode = eps[curIdx + 1].episode;
    populatePlayerControls(state.currentItem);
    populateFilesTab(state.currentItem);
    startPlayback(0, true);
    showPlayerOsd(`▶ Автопереход: Сезон ${state.selectedSeason}, Серия ${state.selectedEpisode}`);
  }
});

refreshParsersBtn.addEventListener('click', () => {
  if (!state.currentItem) return;
  incrementAdBlockCounter(5);
  populateFilesTab(state.currentItem);
});

parsersStatusBtn.addEventListener('click', () => parsersModal.classList.remove('hidden'));
adShieldBtn.addEventListener('click', () => parsersModal.classList.remove('hidden'));
closeParsersModalBtn.addEventListener('click', () => parsersModal.classList.add('hidden'));
parsersModal.addEventListener('click', e => {
  if (e.target === parsersModal) parsersModal.classList.add('hidden');
});

// Initialize App
updateBadges();
loadCatalog();
