import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

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

// Curated seed catalog of popular & iconic Movies, Series, Cartoons, and Anime (Russian metadata + real KP & IMDb IDs)
const SEED_CATALOG = [
  {
    id: 'tt0903747',
    imdbId: 'tt0903747',
    kpId: '404900',
    title: 'Во все тяжкие',
    originalTitle: 'Breaking Bad',
    type: 'series',
    year: 2008,
    yearRange: '2008–2013',
    ratingKp: 8.9,
    ratingImdb: 9.5,
    country: 'США',
    genres: ['Криминал', 'Драма', 'Триллер'],
    duration: '47 мин / серия',
    director: 'Винс Гиллиган',
    cast: 'Брайан Крэнстон, Аарон Пол, Анна Ганн, Дин Норрис, Боб Оденкёрк',
    poster: 'https://m.media-amazon.com/images/M/MV5BMzU5ZGYzNmQtMTdhYy00OGRiLTg0NmQtYjVjNzliZTg1ZGE4XkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    seasonsCount: 5,
    episodesPerSeason: [7, 13, 13, 13, 16],
    voices: ['Кубик в кубе', 'Рус. Дублированный', 'LostFilm', 'Fox', 'Ю. Сербин', 'Дмитрий "Goblin" Пучков', 'Eng.Original'],
    description: 'Школьный учитель химии Уолтер Уайт узнаёт, что болен раком лёгких. Учитывая сложное финансовое состояние дел семьи, а также перспективы, Уолтер решает заняться изготовлением метамфетамина. Для этого он привлекает своего бывшего ученика Джесси Пинкмана.'
  },
  {
    id: 'tt28429213',
    imdbId: 'tt28429213',
    kpId: '5304403',
    title: 'Слово пацана. Кровь на асфальте',
    originalTitle: 'Slovo patsana. Krov na asfalte',
    type: 'series',
    year: 2023,
    yearRange: '2023',
    ratingKp: 8.3,
    ratingImdb: 8.4,
    country: 'Россия',
    genres: ['Драма', 'Криминал'],
    duration: '50 мин / серия',
    director: 'Жора Крыжовников',
    cast: 'Иван Янковский, Рузиль Минекаев, Леон Кемстач, Елизавета Базыкина, Никита Кологривый',
    poster: 'https://m.media-amazon.com/images/M/MV5BNjkxMDY3MTEtNDhlNy00NmY5LThiNjQtMzEzYzllM2I4ZWMwXkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1400&q=80',
    isNew: true,
    isPopular: true,
    seasonsCount: 1,
    episodesPerSeason: [8],
    voices: ['Рус. Оригинальный'],
    description: 'Конец 1980-х. Пока родители борются за выживание, брошенные всеми дети сбиваются в уличные стаи и делят асфальт. Четырнадцатилетний Андрей из интеллигентной семьи заводит дружбу с пацанами из группировки «Универсам».'
  },
  {
    id: 'tt15239678',
    imdbId: 'tt15239678',
    kpId: '4540126',
    title: 'Дюна: Часть вторая',
    originalTitle: 'Dune: Part Two',
    type: 'movie',
    year: 2024,
    yearRange: '2024',
    ratingKp: 8.2,
    ratingImdb: 8.5,
    country: 'США, Канада',
    genres: ['Фантастика', 'Боевик', 'Драма', 'Приключения'],
    duration: '166 мин',
    director: 'Дени Вильнёв',
    cast: 'Тимоти Шаламе, Зендея, Ребекка Фергюсон, Хавьер Бардем, Остин Батлер',
    poster: 'https://m.media-amazon.com/images/M/MV5BNTc0YmQxMjEtODI5MC00NjFiLTlkMWUtOGQ5NjFmYWUyZGJhXkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?auto=format&fit=crop&w=1400&q=80',
    isNew: true,
    isPopular: true,
    voices: ['Рус. Дублированный', 'Red Head Sound', 'HDrezka Studio (Дубл.)', 'LostFilm', 'TVShows', 'JASKIER', 'Eng.Original'],
    description: 'Герцог Пол Атрейдес присоединяется к фременам, чтобы стать Муад’Дибом, одновременно пытаясь остановить наступление войны и отомстить заговорщикам, уничтожившим его семью.'
  },
  {
    id: 'tt0816692',
    imdbId: 'tt0816692',
    kpId: '258687',
    title: 'Интерстеллар',
    originalTitle: 'Interstellar',
    type: 'movie',
    year: 2014,
    yearRange: '2014',
    ratingKp: 8.6,
    ratingImdb: 8.7,
    country: 'США, Великобритания',
    genres: ['Фантастика', 'Драма', 'Приключения'],
    duration: '169 мин',
    director: 'Кристофер Нолан',
    cast: 'Мэттью Макконахи, Энн Хэтэуэй, Джессика Честейн, Майкл Кейн, Мэтт Дэймон',
    poster: 'https://m.media-amazon.com/images/M/MV5BYzdjMDAxZGItMjI2My00ODA1LTlkNzItOWFjMDU5ZDJlYWY3XkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    voices: ['Рус. Дублированный', 'HDrezka Studio', 'Гаврилов', 'Eng.Original'],
    description: 'Когда засуха, пыльные бури и вымирание растений приводят человечество к продовольственному кризису, коллектив исследователей и учёных отправляется сквозь червоточину в путешествие, чтобы превзойти прежние ограничения для космических путешествий человека.'
  },
  {
    id: 'tt15398776',
    imdbId: 'tt15398776',
    kpId: '4664634',
    title: 'Оппенгеймер',
    originalTitle: 'Oppenheimer',
    type: 'movie',
    year: 2023,
    yearRange: '2023',
    ratingKp: 8.1,
    ratingImdb: 8.3,
    country: 'США, Великобритания',
    genres: ['Биография', 'Драма', 'История'],
    duration: '180 мин',
    director: 'Кристофер Нолан',
    cast: 'Киллиан Мёрфи, Эмили Блант, Мэтт Дэймон, Роберт Дауни мл., Флоренс Пью',
    poster: 'https://m.media-amazon.com/images/M/MV5BN2JkMDc5MGQtZjg3YS00NmFiLWIyZmQtZTJmNTM5MjVmYTQ4XkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1400&q=80',
    isNew: true,
    isPopular: true,
    voices: ['Red Head Sound', 'Рус. Дублированный', 'HDrezka Studio', 'TVShows', 'JASKIER', 'Eng.Original'],
    description: 'История жизни американского физика-теоретика Роберта Оппенгеймера, который во времена Второй мировой войны руководил Манхэттенским проектом — секретными разработками ядерного оружия.'
  },
  {
    id: 'tt0944947',
    imdbId: 'tt0944947',
    kpId: '464963',
    title: 'Игра престолов',
    originalTitle: 'Game of Thrones',
    type: 'series',
    year: 2011,
    yearRange: '2011–2019',
    ratingKp: 9.0,
    ratingImdb: 9.2,
    country: 'США, Великобритания',
    genres: ['Фэнтези', 'Драма', 'Боевик', 'Приключения'],
    duration: '55 мин / серия',
    director: 'Дэвид Бениофф, Д.Б. Уайсс',
    cast: 'Эмилия Кларк, Кит Харингтон, Питер Динклэйдж, Лина Хиди, Николай Костер-Вальдау',
    poster: 'https://m.media-amazon.com/images/M/MV5BMTNhMDJmNmYtNDQ5OS00ODdlLWE0ZDAtZTgyYTIwNDY3OTU3XkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    seasonsCount: 8,
    episodesPerSeason: [10, 10, 10, 10, 10, 10, 7, 6],
    voices: ['LostFilm', 'Рус. Дублированный', 'HDrezka Studio', 'AlexFilm', 'Кубик в кубе', 'Eng.Original'],
    description: 'К концу подходит время благоденствия, и лето, длившееся почти десятилетие, угасает. Вокруг средоточия власти Семи королевств, Железного трона, зреет заговор, и в это непростое время король решает искать поддержки у друга юности Эддарда Старка.'
  },
  {
    id: 'tt8367814',
    imdbId: 'tt8367814',
    kpId: '1143242',
    title: 'Джентльмены',
    originalTitle: 'The Gentlemen',
    type: 'movie',
    year: 2019,
    yearRange: '2019',
    ratingKp: 8.6,
    ratingImdb: 7.8,
    country: 'Великобритания, США',
    genres: ['Криминал', 'Комедия', 'Боевик'],
    duration: '113 мин',
    director: 'Гай Ричи',
    cast: 'Мэттью Макконахи, Чарли Ханнэм, Генри Голдинг, Хью Грант, Колин Фаррелл',
    poster: 'https://m.media-amazon.com/images/M/MV5BMTlkMmVmYjktYTc2NC00ZGZjLWEyOWUtMjc2MDMwMjQwOTA5XkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    voices: ['Рус. Дублированный', 'Кубик в кубе', 'Дмитрий "Goblin" Пучков', 'HDrezka Studio', 'JASKIER', 'Eng.Original'],
    description: 'Талантливый выпускник Оксфорда, применив уникальный ум и невиданную дерзость, придумал нелегальную схему обогащения с использованием поместья обедневшей английской аристократии.'
  },
  {
    id: 'tt1321510',
    imdbId: 'tt1321510',
    kpId: '502838',
    title: 'Джентльмены (Сериал)',
    originalTitle: 'The Gentlemen (TV Series)',
    type: 'series',
    year: 2024,
    yearRange: '2024',
    ratingKp: 7.8,
    ratingImdb: 8.0,
    country: 'Великобритания, США',
    genres: ['Криминал', 'Комедия', 'Боевик'],
    duration: '50 мин / серия',
    director: 'Гай Ричи',
    cast: 'Тео Джеймс, Кая Скоделарио, Джанкарло Эспозито, Винни Джонс',
    poster: 'https://m.media-amazon.com/images/M/MV5BMjE2ZjI3NTItYmFjOS00YWM3LWI0NDMtN2I4NGI2YjE0M2U5XkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1514539079130-25950c84af65?auto=format&fit=crop&w=1400&q=80',
    isNew: true,
    isPopular: true,
    seasonsCount: 1,
    episodesPerSeason: [8],
    voices: ['Red Head Sound', 'HDrezka Studio', 'Кубик в кубе', 'LostFilm', 'TVShows', 'Eng.Original'],
    description: 'Эдди Холстед наследует огромное поместье своего отца и обнаруживает, что земля стала частью гигантской империи по выращиванию марихуаны под управлением легендарного Бобби Гласса.'
  },
  {
    id: 'tt1190634',
    imdbId: 'tt1190634',
    kpId: '460586',
    title: 'Пацаны',
    originalTitle: 'The Boys',
    type: 'series',
    year: 2019,
    yearRange: '2019–2026',
    ratingKp: 8.3,
    ratingImdb: 8.7,
    country: 'США',
    genres: ['Фантастика', 'Боевик', 'Комедия', 'Криминал'],
    duration: '60 мин / серия',
    director: 'Эрик Крипке',
    cast: 'Карл Урбан, Джек Куэйд, Энтони Старр, Эрин Мориарти, Дженсен Эклс',
    poster: 'https://m.media-amazon.com/images/M/MV5BMWJlN2U5MzItNjU4My00NTM2LWFjOWUtOWFiNjg3ZTMxZDY1XkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=1400&q=80',
    isNew: true,
    isPopular: true,
    seasonsCount: 4,
    episodesPerSeason: [8, 8, 8, 8],
    voices: ['Кубик в кубе', 'HDrezka Studio', 'Red Head Sound', 'LostFilm', 'AlexFilm', 'TVShows'],
    description: 'Действие разворачивается в мире, где существуют супергерои, но за их глянцевым фасадом скрывается мир наркотиков, коррупции и безнаказанности. Против них выступает отряд «Пацанов» во главе с Билли Бутчером.'
  },
  {
    id: 'tt12637874',
    imdbId: 'tt12637874',
    kpId: '1392550',
    title: 'Фоллаут',
    originalTitle: 'Fallout',
    type: 'series',
    year: 2024,
    yearRange: '2024',
    ratingKp: 8.0,
    ratingImdb: 8.4,
    country: 'США',
    genres: ['Фантастика', 'Боевик', 'Драма', 'Приключения'],
    duration: '60 мин / серия',
    director: 'Джонатан Нолан',
    cast: 'Элла Пернелл, Уолтон Гоггинс, Аарон Мотен, Кайл Маклахлен',
    poster: 'https://m.media-amazon.com/images/M/MV5BNjI5M2I0N2ItYjI0MC00NjU1LTk2MzUtNDY1NWI4M2M2YThmXkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=1400&q=80',
    isNew: true,
    isPopular: true,
    seasonsCount: 1,
    episodesPerSeason: [8],
    voices: ['Red Head Sound', 'HDrezka Studio', 'Кубик в кубе', 'LostFilm', 'TVShows', 'JASKIER'],
    description: 'Спустя 200 лет после ядерного апокалипсиса обитательница комфортабельного подземного Убежища 33 вынуждена выйти на выжженную поверхность Лос-Анджелеса, чтобы спасти своего отца.'
  },
  {
    id: 'tt6263850',
    imdbId: 'tt6263850',
    kpId: '1229684',
    title: 'Дэдпул и Росомаха',
    originalTitle: 'Deadpool & Wolverine',
    type: 'movie',
    year: 2024,
    yearRange: '2024',
    ratingKp: 7.5,
    ratingImdb: 7.7,
    country: 'США',
    genres: ['Фантастика', 'Боевик', 'Комедия'],
    duration: '128 мин',
    director: 'Шон Леви',
    cast: 'Райан Рейнольдс, Хью Джекман, Эмма Коррин, Мэттью Макфэдьен',
    poster: 'https://m.media-amazon.com/images/M/MV5BZTk5ODY0MmQtMzA3Ni00NGY1LThiYzItZThiNjFiNDM4MTM3XkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=1400&q=80',
    isNew: true,
    isPopular: true,
    voices: ['Red Head Sound', 'Рус. Дублированный', 'HDrezka Studio', 'JASKIER', 'Eng.Original'],
    description: 'Уэйд Уилсон попадает в организацию «Управление временными изменениями», что выдергивает его из спокойной жизни и заставляет объединиться с Росомахой ради спасения своей вселенной.'
  },
  {
    id: 'tt2861424',
    imdbId: 'tt2861424',
    kpId: '685246',
    title: 'Рик и Морти',
    originalTitle: 'Rick and Morty',
    type: 'cartoon',
    year: 2013,
    yearRange: '2013–2025',
    ratingKp: 8.9,
    ratingImdb: 9.1,
    country: 'США',
    genres: ['Мультфильмы', 'Фантастика', 'Комедия', 'Приключения'],
    duration: '23 мин / серия',
    director: 'Джастин Ройланд, Дэн Хармон',
    cast: 'Сыендук (озвучка РФ), Иэн Кардони, Гарри Белден',
    poster: 'https://m.media-amazon.com/images/M/MV5BZjRjOTFkOTktZWUzMi00YzMyLThkMmYtMjEwNmQyNzliYTNmXkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    seasonsCount: 7,
    episodesPerSeason: [11, 10, 10, 10, 10, 10, 10],
    voices: ['Сыендук', 'HDrezka Studio', 'TVShows', 'Eng.Original'],
    description: 'Безумный учёный Рик Санчез переезжает в дом своей дочери Бет и втягивает своего 14-летнего внука Морти в безумные межпространственные приключения по всей мультивселенной.'
  },
  {
    id: 'tt2560140',
    imdbId: 'tt2560140',
    kpId: '749374',
    title: 'Атака титанов',
    originalTitle: 'Shingeki no Kyojin',
    type: 'anime',
    year: 2013,
    yearRange: '2013–2023',
    ratingKp: 8.7,
    ratingImdb: 9.1,
    country: 'Япония',
    genres: ['Аниме', 'Боевик', 'Драма', 'Фэнтези'],
    duration: '24 мин / серия',
    director: 'Тэцуро Араки',
    cast: 'Юки Кадзи, Юи Исикава, Марина Иноуэ',
    poster: 'https://m.media-amazon.com/images/M/MV5BNjY4MDQxZTItM2JjMi00NjM5LTk0MWQtOTBlNTY2YjBiNmFjXkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    seasonsCount: 4,
    episodesPerSeason: [25, 12, 22, 30],
    voices: ['Studio Band', 'AniLibria', 'AniDUB', 'SHIZA Project', 'HDrezka Studio', 'Японский + Субтитры'],
    description: 'Сотни лет назад человечество было почти полностью истреблено гигантскими титанами. Выжившие укрылись за тремя высокими стенами, пока однажды Колоссальный титан не пробил брешь в внешней стене.'
  },
  {
    id: 'tt7366338',
    imdbId: 'tt7366338',
    kpId: '1227803',
    title: 'Чернобыль',
    originalTitle: 'Chernobyl',
    type: 'series',
    year: 2019,
    yearRange: '2019',
    ratingKp: 8.8,
    ratingImdb: 9.3,
    country: 'США, Великобритания',
    genres: ['Драма', 'История', 'Триллер'],
    duration: '65 мин / серия',
    director: 'Йохан Ренк',
    cast: 'Джаред Харрис, Стеллан Скарсгард, Эмили Уотсон, Пол Риттер',
    poster: 'https://m.media-amazon.com/images/M/MV5BNzU0OTI4YTQtNGQ1ZS00ZjA4LTg3MTMtZjkyZWNjN2RiZDJmXkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    seasonsCount: 1,
    episodesPerSeason: [5],
    voices: ['Рус. Дублированный', 'HDrezka Studio', 'LostFilm', 'Кубик в кубе', 'AlexFilm', 'Eng.Original'],
    description: '26 апреля 1986 года на Чернобыльской АЭС происходит взрыв реактора. Академик Валерий Легасов и зампред Совета Министров Борис Щербина пытаются выяснить причины катастрофы и предотвратить ещё большую трагедию.'
  },
  {
    id: 'tt9362722',
    imdbId: 'tt9362722',
    kpId: '1219177',
    title: 'Человек-паук: Паутина вселенных',
    originalTitle: 'Spider-Man: Across the Spider-Verse',
    type: 'cartoon',
    year: 2023,
    yearRange: '2023',
    ratingKp: 8.4,
    ratingImdb: 8.6,
    country: 'США',
    genres: ['Мультфильмы', 'Фантастика', 'Боевик', 'Приключения'],
    duration: '140 мин',
    director: 'Жуакин Душ Сантуш',
    cast: 'Шамеик Мур, Хейли Стайнфелд, Оскар Айзек',
    poster: 'https://m.media-amazon.com/images/M/MV5BMzI0NmVkMjEtYmY4MS00ZDMxLTlkZmEtMzU4MDQxYTMzMjU2XkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1635805737707-575885ab0820?auto=format&fit=crop&w=1400&q=80',
    isNew: true,
    isPopular: true,
    voices: ['Red Head Sound', 'Рус. Дублированный', 'HDrezka Studio', 'TVShows', 'JASKIER'],
    description: 'Майлз Моралес отправляется в приключение по мультивселенной вместе с Гвен Стейси и новой командой Людей-пауков, которым предстоит столкнуться с могущественным злодеем.'
  },
  {
    id: 'tt12343534',
    imdbId: 'tt12343534',
    kpId: '1382226',
    title: 'Магическая битва',
    originalTitle: 'Jujutsu Kaisen',
    type: 'anime',
    year: 2020,
    yearRange: '2020–2024',
    ratingKp: 8.3,
    ratingImdb: 8.5,
    country: 'Япония',
    genres: ['Аниме', 'Боевик', 'Фэнтези'],
    duration: '24 мин / серия',
    director: 'Пак Сон-ху',
    cast: 'Дзюнъя Эноки, Юума Утида, Юити Накамура',
    poster: 'https://m.media-amazon.com/images/M/MV5BNmI1MmYxNWQtY2E5NC00ZTlmLWIzZGEtNzM1YmE3NDA5NzhjXkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=1400&q=80',
    isNew: true,
    isPopular: true,
    seasonsCount: 2,
    episodesPerSeason: [24, 23],
    voices: ['Studio Band', 'AniLibria', 'AniStar', 'Crunchyroll', 'Японский + Субтитры'],
    description: 'Старшеклассник Юдзи Итадори проглатывает проклятый палец Двуликого Сукуны, чтобы спасти друзей, и становится сосудом для древнего демона. Его принимают в Токийский магический колледж под крыло Сатору Годзё.'
  },
  {
    id: 'tt2442560',
    imdbId: 'tt2442560',
    kpId: '716587',
    title: 'Острые козырьки',
    originalTitle: 'Peaky Blinders',
    type: 'series',
    year: 2013,
    yearRange: '2013–2022',
    ratingKp: 8.4,
    ratingImdb: 8.8,
    country: 'Великобритания',
    genres: ['Криминал', 'Драма'],
    duration: '58 мин / серия',
    director: 'Стивен Найт',
    cast: 'Киллиан Мёрфи, Пол Андерсон, Хелен Маккрори, Том Харди, Аннабелль Уоллис',
    poster: 'https://m.media-amazon.com/images/M/MV5BMThlOWE3MWEtZjM4Ny00M2FiLTkyMmYtZGY3ZTcyMzM5YmNlXkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1514539079130-25950c84af65?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    seasonsCount: 6,
    episodesPerSeason: [6, 6, 6, 6, 6, 6],
    voices: ['LostFilm', 'Кубик в кубе', 'HDrezka Studio', 'AlexFilm', 'Рус. Дублированный', 'Eng.Original'],
    description: 'Бирмингем, 1919 год. Вернувшиеся с полей Первой мировой войны братья Шелби во главе с амбициозным Томасом создают самую влиятельную и жестокую криминальную группировку города, в чьи кепки вшиты бритвенные лезвия.'
  },
  {
    id: 'tt11126994',
    imdbId: 'tt11126994',
    kpId: '4445150',
    title: 'Аркейн',
    originalTitle: 'Arcane',
    type: 'cartoon',
    year: 2021,
    yearRange: '2021–2024',
    ratingKp: 8.8,
    ratingImdb: 9.0,
    country: 'США, Франция',
    genres: ['Мультфильмы', 'Фантастика', 'Боевик', 'Драма'],
    duration: '42 мин / серия',
    director: 'Паскаль Шаррю, Арно Делорд',
    cast: 'Хейли Стайнфелд, Элла Пернелл, Кевин Алехандро',
    poster: 'https://m.media-amazon.com/images/M/MV5BYjA2NzhlMDItNWRmZC00MzRjLWE3ZjAtZjBlZDAwOWY2ODdjXkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=1400&q=80',
    isNew: true,
    isPopular: true,
    seasonsCount: 2,
    episodesPerSeason: [9, 9],
    voices: ['Рус. Дублированный', 'Red Head Sound', 'HDrezka Studio', 'LostFilm', 'TVShows', 'Eng.Original'],
    description: 'История двух сестёр — Вай и Паудер (Джинкс), оказавшихся по разные стороны баррикад в противостоянии утопического города Пилтовер и мрачного подземного Зауна.'
  },
  {
    id: 'tt0993846',
    imdbId: 'tt0993846',
    kpId: '462682',
    title: 'Волк с Уолл-стрит',
    originalTitle: 'The Wolf of Wall Street',
    type: 'movie',
    year: 2013,
    yearRange: '2013',
    ratingKp: 8.0,
    ratingImdb: 8.2,
    country: 'США',
    genres: ['Биография', 'Криминал', 'Комедия', 'Драма'],
    duration: '180 мин',
    director: 'Мартин Скорсезе',
    cast: 'Леонардо ДиКаприо, Джона Хилл, Марго Робби, Мэттью Макконахи',
    poster: 'https://m.media-amazon.com/images/M/MV5BMjIxMjgxNTk0MF5BMl5BanBnXkFtZTgwNjIyOTg2MDE@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    voices: ['Рус. Дублированный', 'Кубик в кубе', 'HDrezka Studio', 'JASKIER', 'Дмитрий "Goblin" Пучков', 'Eng.Original'],
    description: '1987 год. Джордан Белфорт становится брокером в успешном инвестиционном банке, а вскоре открывает собственную фирму Stratton Oakmont, превращая свою жизнь в бесконечный праздник больших денег.'
  },
  {
    id: 'tt10919420',
    imdbId: 'tt10919420',
    kpId: '1309325',
    title: 'Игра в кальмара',
    originalTitle: 'Squid Game',
    type: 'series',
    year: 2021,
    yearRange: '2021–2025',
    ratingKp: 7.6,
    ratingImdb: 8.0,
    country: 'Южная Корея',
    genres: ['Триллер', 'Драма', 'Боевик'],
    duration: '55 мин / серия',
    director: 'Хван Дон-хёк',
    cast: 'Ли Джон-джэ, Пак Хэ-су, Ви Ха-джун, Чон Хо-ён',
    poster: 'https://m.media-amazon.com/images/M/MV5BYTU3ZDVhNmMtMDVlNC00MDc0LTgwNDMtYWE5MTI2ZGI4YWIwXkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=1400&q=80',
    isNew: true,
    isPopular: true,
    seasonsCount: 2,
    episodesPerSeason: [9, 7],
    voices: ['Рус. Дублированный', 'Red Head Sound', 'HDrezka Studio', 'TVShows', 'LostFilm', 'Корейский + Субтитры'],
    description: 'Из-за нужды в деньгах сотни людей, разорившихся и погрязших в долгах, принимают странное приглашение поучаствовать в детских играх на выживание с призовым фондом 45,6 млрд вон.'
  },
  {
    id: 'tt1375666',
    imdbId: 'tt1375666',
    kpId: '447301',
    title: 'Начало',
    originalTitle: 'Inception',
    type: 'movie',
    year: 2010,
    yearRange: '2010',
    ratingKp: 8.7,
    ratingImdb: 8.8,
    country: 'США, Великобритания',
    genres: ['Фантастика', 'Боевик', 'Триллер'],
    duration: '148 мин',
    director: 'Кристофер Нолан',
    cast: 'Леонардо ДиКаприо, Джозеф Гордон-Левитт, Том Харди, Киллиан Мёрфи, Марион Котийяр',
    poster: 'https://m.media-amazon.com/images/M/MV5BMjAxMzY3NjcxNF5BMl5BanBnXkFtZTcwNTI5OTM0Mw@@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    voices: ['Рус. Дублированный', 'HDrezka Studio', 'Гаврилов', 'Ю. Сербин', 'Eng.Original'],
    description: 'Кобб — талантливый вор, лучший из лучших в опасном искусстве извлечения: он крадёт ценные секреты из глубин подсознания во время сна, когда человеческий разум наиболее уязвим.'
  },
  {
    id: 'tt1865718',
    imdbId: 'tt1865718',
    kpId: '591929',
    title: 'Гравити Фолз',
    originalTitle: 'Gravity Falls',
    type: 'cartoon',
    year: 2012,
    yearRange: '2012–2016',
    ratingKp: 9.0,
    ratingImdb: 8.9,
    country: 'США',
    genres: ['Мультфильмы', 'Детектив', 'Комедия', 'Приключения', 'Фэнтези'],
    duration: '22 мин / серия',
    director: 'Алекс Хирш',
    cast: 'Джейсон Риттер, Кристен Шаал, Алекс Хирш',
    poster: 'https://m.media-amazon.com/images/M/MV5BMTEzNDc3MDQ2NzNeQTJeQWpwZ15BbWU4MDYzMzUwMDIx._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    seasonsCount: 2,
    episodesPerSeason: [20, 20],
    voices: ['Рус. Дублированный', 'Сыендук', 'HDrezka Studio', 'Eng.Original'],
    description: 'Близнецы Диппер и Мэйбл Пайнс отправляются на летние каникулы в тихий городок Гравити Фолз к своему двоюродному дедушке Стэну, где находят таинственный Дневник №3.'
  },
  {
    id: 'tt0877057',
    imdbId: 'tt0877057',
    kpId: '406148',
    title: 'Тетрадь смерти',
    originalTitle: 'Death Note',
    type: 'anime',
    year: 2006,
    yearRange: '2006–2007',
    ratingKp: 8.6,
    ratingImdb: 8.9,
    country: 'Япония',
    genres: ['Аниме', 'Триллер', 'Детектив', 'Фэнтези'],
    duration: '23 мин / серия',
    director: 'Тэцуро Араки',
    cast: 'Мамору Мияно, Каппэй Ямагути',
    poster: 'https://m.media-amazon.com/images/M/MV5BYTgyZDhmMTEtZDFhNi00MTc4LTg3NjUtYWJlNGE5Mzk2NzMxXkEyXkFqcGc@._V1_FMjpg_UX600_.jpg',
    backdrop: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=1400&q=80',
    isNew: false,
    isPopular: true,
    seasonsCount: 1,
    episodesPerSeason: [37],
    voices: ['Рус. Дублированный (2x2)', 'AniDUB', 'AniLibria', 'Studio Band', 'Японский + Субтитры'],
    description: 'Лучшему ученику Японии Ягами Лайту в руки попадает Тетрадь смерти бога синигами Рюка. Каждый человек, чьё имя будет записано в эту тетрадь, умирает.'
  }
];

const searchCache = new Map();
const streamCache = new Map();
const wikiCache = new Map();
const detailsCache = new Map();

function getMirrorList(preferredMirror = 'direct') {
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

// Parse real HLS streams, seasons, episodes, and Russian studio voiceover tracks from Namy / Kinogram / Embess / Delivembd balancers
async function parseLiveStreamBalancer(imdbId, kpId, preferredMirror = 'direct') {
  const cacheKey = `${imdbId || ''}:${kpId || ''}:${preferredMirror}`;
  const cached = streamCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 10 * 60 * 1000) {
    return cached.data;
  }

  const mirrors = getMirrorList(preferredMirror);

  const paths = [];
  if (kpId) paths.push(`/embed/kp/${kpId}`);
  if (imdbId) paths.push(`/embed/imdb/${imdbId}`);

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

        const html = await r.text();
        const mkIdx = html.lastIndexOf('makePlayer({');
        if (mkIdx === -1) continue;

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

            const result = {
              found: true,
              isSeries: true,
              embedUrl: mirror + p,
              seasons: seasonsMap,
              voices: Array.from(allVoicesSet)
            };
            streamCache.set(cacheKey, { ts: Date.now(), data: result });
            return result;
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
          const result = {
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
                  hlsUrl: hlsProxyUrl,
                  rawHls: signedHls,
                  voices,
                  voiceTracks,
                  subtitles: []
                }
              ]
            }
          };
          streamCache.set(cacheKey, { ts: Date.now(), data: result });
          return result;
        }
      } catch (e) {
        // try next mirror/path
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
    { id: 'direct', name: 'СПБГУКА Direct HLS (Чистый поток • 0% рекламы)', badge: '1080p FHD / Multi-Audio', speed: '120 Мбит/с' },
    { id: 'namy', name: 'Collaps HLS Mirror (Прямой поток без рекламы)', badge: '1080p FHD', speed: '110 Мбит/с' },
    { id: 'kinogram', name: 'Kinogram HLS Mirror (Прямой поток без рекламы)', badge: '1080p FHD', speed: '105 Мбит/с' },
    { id: 'delivembd', name: 'Delivembed HLS Mirror (Прямой поток без рекламы)', badge: '1080p FHD', speed: '98 Мбит/с' }
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

// HLS Stream Proxy: Fetches master.m3u8, audio/video sub-playlists, and .ts/.vtt segments with matching UA & Origin
async function handleHlsProxy(req, res, targetUrl, audioIdxParam, singleAudioParam) {
  if (!targetUrl) {
    res.writeHead(400);
    return res.end('Missing url param');
  }

  try {
    const upstreamHeaders = {
      'User-Agent': UPSTREAM_UA,
      'Origin': UPSTREAM_ORIGIN,
      'Referer': `${UPSTREAM_ORIGIN}/`
    };
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
      const lines = rawText.split(/\r?\n/);
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
        'Cache-Control': 'no-cache'
      });
      return res.end(rewritten);
    }

    // Binary segment (.ts / .m4s / .mp4 / .vtt)
    const resHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': contentType || (targetUrl.includes('.vtt') ? 'text/vtt; charset=utf-8' : 'video/mp2t'),
      'Cache-Control': 'public, max-age=3600'
    };
    const contentLength = r.headers.get('content-length');
    if (contentLength) resHeaders['Content-Length'] = contentLength;
    const contentRange = r.headers.get('content-range');
    if (contentRange) resHeaders['Content-Range'] = contentRange;

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

// Ad-Stripped Fallback Embed Proxy: strips VAST/pop/banner ad configs and routes HLS through /api/hls-proxy
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
  if (kp) paths.push(`/embed/kp/${encodeURIComponent(kp)}${query}`);
  if (imdb) paths.push(`/embed/imdb/${encodeURIComponent(imdb)}${query}`);

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
          .replace(/<script\s+data-name="ad">[\s\S]*?<\/script>/gi, '<script data-name="ad">var middleCount = 0, adTimeouts = {}, adsConfig = {};</script>')
          .replace(/ads:\s*adsConfig/g, 'ads: undefined')
          .replace(/distribrey\.com/gi, '')
          .replace(/getsdk\.online/gi, '')
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

function loadOrCreateAuthSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  ensureDataDir();
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const saved = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (saved.length >= 32) return saved;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, generated, 'utf8');
    return generated;
  } catch (e) {
    return crypto.createHash('sha256').update(__dirname + '_spbguka_secret').digest('hex');
  }
}

const AUTH_SECRET = loadOrCreateAuthSecret();

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

function signAuthToken(usernameLower) {
  const payload = {
    u: usernameLower,
    exp: Date.now() + 90 * 24 * 60 * 60 * 1000
  };
  const body = toBase64Url(JSON.stringify(payload));
  const sig = toBase64Url(crypto.createHmac('sha256', AUTH_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expectedSig = toBase64Url(crypto.createHmac('sha256', AUTH_SECRET).update(body).digest());
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(fromBase64Url(body).toString('utf8'));
    if (!payload.u || !payload.exp || payload.exp < Date.now()) return null;
    return payload.u;
  } catch (e) {
    return null;
  }
}

function getAuthTokenFromReq(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = req.headers['cookie'] || '';
  const match = cookieHeader.match(/(?:^|;\s*)spbguka_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

const DATABASE_URL = process.env.DATABASE_URL || '';
const pgPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

async function initDatabase() {
  if (!pgPool) return;
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
    console.log('PostgreSQL database ready (spbguka_users)');
  } catch (e) {
    console.error('PostgreSQL init error:', e.message);
  }
}

async function findUserByKey(key) {
  if (pgPool) {
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
  }
  return accountsDb.users[key] || null;
}

async function createUserRecord(user) {
  if (pgPool) {
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
  }
  if (accountsDb.users[user.usernameLower]) return false;
  accountsDb.users[user.usernameLower] = user;
  scheduleSaveAccounts(true);
  return true;
}

async function saveUserProgress(user, immediate = false) {
  if (pgPool) {
    await pgPool.query(
      'UPDATE spbguka_users SET history_json = $2::jsonb, favorites_json = $3::jsonb, updated_at = $4 WHERE username_lower = $1',
      [
        user.usernameLower,
        JSON.stringify(user.history || []),
        JSON.stringify(user.favorites || []),
        user.updatedAt
      ]
    );
    return;
  }
  accountsDb.users[user.usernameLower] = user;
  scheduleSaveAccounts(immediate);
}

async function getAuthenticatedUser(req) {
  const token = getAuthTokenFromReq(req);
  const usernameLower = verifyAuthToken(token);
  if (!usernameLower) return null;
  try {
    return await findUserByKey(usernameLower);
  } catch (e) {
    return null;
  }
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

let liveCatalog = SEED_CATALOG.map(x => ({
  ...x,
  isNew: x.year >= new Date().getFullYear() - 1
}));
let lastCatalogRefreshAt = 0;

function parseReleaseYear(releaseInfo) {
  const match = String(releaseInfo || '').match(/(\d{4})/);
  return match ? Number(match[1]) : new Date().getFullYear();
}

async function fetchCinemetaTop(mediaType) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(`https://v3-cinemeta.strem.io/catalog/${mediaType}/top.json`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.metas) ? json.metas : [];
  } catch (e) {
    return [];
  }
}

async function refreshLiveCatalog() {
  const currentYear = new Date().getFullYear();
  const newThreshold = currentYear - 1; // e.g., 2025-2026 in 2026

  try {
    const [movieMetas, seriesMetas] = await Promise.all([
      fetchCinemetaTop('movie'),
      fetchCinemetaTop('series')
    ]);
    const allMetas = [
      ...seriesMetas.map(m => ({ ...m, _kind: 'series' })),
      ...movieMetas.map(m => ({ ...m, _kind: 'movie' }))
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
        isNew: item.year >= newThreshold || /2025|2026/.test(String(refreshedYearRange || ''))
      };
    });

    const seedIds = new Set(updatedSeed.map(x => x.imdbId));
    const candidateNew = [];
    const seenNew = new Set();

    for (const m of allMetas) {
      const imdbId = m.imdb_id || m.id;
      if (!imdbId || !String(imdbId).startsWith('tt') || seedIds.has(imdbId) || seenNew.has(imdbId)) continue;
      seenNew.add(imdbId);

      const year = parseReleaseYear(m.releaseInfo);
      const parsedRating = parseFloat(m.imdbRating);
      const ratingImdb = (Number.isFinite(parsedRating) && parsedRating > 0) ? Number(parsedRating.toFixed(1)) : 7.4;
      const ratingKp = Number(Math.max(5.5, Math.min(9.5, ratingImdb - 0.1)).toFixed(1));
      const ruGenres = (Array.isArray(m.genres) ? m.genres : [])
        .map(g => GENRE_RU_MAP[g] || g)
        .filter(Boolean)
        .slice(0, 3);
      if (ruGenres.length === 0) ruGenres.push(m._kind === 'series' ? 'Драма' : 'Кино');

      const isAnim = (m.genres || []).includes('Animation');
      const resolvedType = isAnim ? 'cartoon' : m._kind;
      const isRecent = year >= newThreshold;

      // Prioritize current new releases (2025-2026) and high-rated current hits
      if (!isRecent && candidateNew.length >= 16) continue;

      candidateNew.push({
        id: imdbId,
        imdbId,
        kpId: '',
        title: m.name || imdbId,
        originalTitle: m.name || '',
        type: resolvedType,
        year,
        yearRange: m.releaseInfo ? String(m.releaseInfo) : String(year),
        ratingKp,
        ratingImdb,
        country: 'США / Мир',
        genres: ruGenres,
        duration: resolvedType === 'series' ? '45 мин / серия' : '115 мин',
        director: Array.isArray(m.director) && m.director.length ? m.director.join(', ') : 'По данным IMDb',
        cast: Array.isArray(m.cast) && m.cast.length ? m.cast.slice(0, 5).join(', ') : 'В ролях',
        poster: m.poster || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=600&q=80',
        backdrop: m.background || m.poster || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1400&q=80',
        isNew: isRecent,
        isPopular: true,
        seasonsCount: resolvedType === 'series' ? 1 : 1,
        episodesPerSeason: resolvedType === 'series' ? [10] : [1],
        voices: resolvedType === 'series'
          ? ['HDrezka Studio', 'LostFilm', 'Red Head Sound', 'Кубик в кубе', 'Рус. Дублированный', 'Eng.Original']
          : ['Рус. Дублированный', 'Red Head Sound', 'HDrezka Studio', 'JASKIER', 'Eng.Original'],
        description: m.description || `Новинка ${year} года (${m.name}). Смотреть онлайн в HD 1080p без рекламы.`
      });

      if (candidateNew.length >= 24) break;
    }

    // Sort fresh releases first, then enrich Russian titles/KP IDs via Wikidata
    candidateNew.sort((a, b) => (b.year - a.year) || (b.ratingImdb - a.ratingImdb));
    const enrichedBatches = [];
    for (let i = 0; i < candidateNew.length; i += 12) {
      const batch = await enrichWithRussianMetadata(candidateNew.slice(i, i + 12));
      enrichedBatches.push(...batch);
    }

    liveCatalog = [...enrichedBatches, ...updatedSeed];
    detailsCache.clear();
    searchCache.clear();
    lastCatalogRefreshAt = Date.now();
    console.log(`Catalog refreshed: ${liveCatalog.length} items (${enrichedBatches.filter(x => x.isNew).length} new ${newThreshold}-${currentYear} releases)`);
  } catch (e) {
    console.error('Catalog refresh failed:', e.message);
  }
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

function sanitizeHistoryList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(x => x && typeof x === 'object' && (x.imdbId || x.id))
    .slice(0, 60)
    .map(x => ({
      id: x.id || x.imdbId,
      imdbId: String(x.imdbId || x.id),
      kpId: x.kpId ? String(x.kpId) : '',
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
    }));
}

function mergeHistoryLists(serverList = [], clientList = []) {
  const byId = new Map();
  for (const item of [...sanitizeHistoryList(serverList), ...sanitizeHistoryList(clientList)]) {
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
    if (seen.has(imdbId)) continue;
    seen.add(imdbId);
    out.push({
      id: x.id || imdbId,
      imdbId,
      kpId: x.kpId ? String(x.kpId) : '',
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
    updatedAt: user.updatedAt || Date.now()
  };
}

function setAuthCookie(res, token) {
  const maxAge = 90 * 24 * 60 * 60;
  res.setHeader('Set-Cookie', `spbguka_token=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
}

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
      const token = signAuthToken(key);
      setAuthCookie(res, token);
      return sendJson(res, 201, { token, user: publicUserPayload(user), db: pgPool ? 'postgres' : 'local-file' }, req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Некорректные данные регистрации' }, req);
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
        user.history = mergeHistoryLists(user.history, body.history);
      }
      if (Array.isArray(body.favorites) && body.favorites.length > 0) {
        user.favorites = mergeFavoritesLists(user.favorites, body.favorites);
      }
      user.updatedAt = Date.now();
      await saveUserProgress(user, true);
      const token = signAuthToken(key);
      setAuthCookie(res, token);
      return sendJson(res, 200, { token, user: publicUserPayload(user), db: pgPool ? 'postgres' : 'local-file' }, req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Ошибка входа' }, req);
    }
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', 'spbguka_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    return sendJson(res, 200, { ok: true }, req);
  }

  if ((pathname === '/api/auth/me' || pathname === '/api/account/sync') && req.method === 'GET') {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return sendJson(res, 401, { error: 'Требуется вход в аккаунт' }, req);
    }
    return sendJson(res, 200, { user: publicUserPayload(user) }, req);
  }

  if (pathname === '/api/account/sync' && req.method === 'POST') {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return sendJson(res, 401, { error: 'Требуется вход в аккаунт' }, req);
    }
    try {
      const body = await readJsonBody(req);
      const mode = body.mode === 'replace' ? 'replace' : 'merge';
      if (Array.isArray(body.history)) {
        user.history = mode === 'replace'
          ? sanitizeHistoryList(body.history)
          : mergeHistoryLists(user.history, body.history);
      }
      if (Array.isArray(body.favorites)) {
        user.favorites = mode === 'replace'
          ? sanitizeFavoritesList(body.favorites)
          : mergeFavoritesLists(user.favorites, body.favorites);
      }
      user.updatedAt = Date.now();
      await saveUserProgress(user, false);
      return sendJson(res, 200, { ok: true, user: publicUserPayload(user) }, req);
    } catch (e) {
      return sendJson(res, 400, { error: 'Ошибка синхронизации' }, req);
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
    const newThreshold = new Date().getFullYear() - 1;

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
  await initDatabase();
  setTimeout(() => refreshLiveCatalog(), 1000);
  scheduleDaily10AmRefresh();
});
