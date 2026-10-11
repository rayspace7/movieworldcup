/**
 * 나만의 명작영화 월드컵 백엔드 예제 (Express, TMDB API + Upstash Redis)
 *
 * 전체 흐름
 * 1. 장르 / 국가(한국·미국·유럽·일본·중화권·그외 모든 국가) / 시대(1970년대 이전·
 *    1980~1990년대·2000년대 이후) 세 가지를 "각각 선택 또는 생략"할 수 있고, 고른
 *    조건을 모두 합쳐서(AND) TMDB에서 영화를 긁어와요. 예: 국가=한국영화 + 장르=드라마 +
 *    시대=2000년대 이후 → "2000년대 이후에 나온 한국 드라마 영화" 풀을 만들어요.
 *    조합마다 Upstash에 "따로" 캐싱해요 (조합별 캐시 키가 달라요. getPoolKey 참고).
 *    - /discover/movie를 vote_average.desc로 정렬해서 모아요.
 *    - 국가 필터는 TMDB가 콤마로 OR 검색을 지원하지 않아서, 국가 하나당 여러 번 나눠서
 *      요청한 뒤 합쳐요 (예: 유럽영화 = 영국+프랑스+독일+이탈리아+스페인+스웨덴 영화를 합침,
 *      중화권영화 = 중국+대만+홍콩 영화를 합침). 장르/시대 조건은 그 각각의 요청에
 *      파라미터로 같이 끼워 넣어서 "국가 AND 장르 AND 시대"가 되게 해요.
 *      ⚠️ 파라미터 이름 주의: 국가 필터는 with_origin_country예요. 예전엔 원어 필터인
 *      original_language를 잘못 써서(TMDB가 조용히 무시하는 파라미터예요) "아시아영화"를
 *      선택해도 서양 영화가 섞여 나오는 버그가 있었는데, with_origin_country로 고쳤어요.
 *    - "그외 모든 국가"는 TMDB가 "이 국가들을 제외"하는 필터를 지원하지 않아서, 국가 필터
 *      없이 가져온 다음 TMDB 응답의 origin_country 필드를 보고 이미 카테고리가 있는 주요
 *      국가(한국/미국/영국/프랑스/독일/이탈리아/스페인/스웨덴/일본/중국/대만/홍콩) 작품을
 *      코드에서 걸러내요 (excludeOriginCountries).
 *    - 시대별 필터는 primary_release_date.gte/lte를 써요 (예: 2000년대 이후 = gte 2000-01-01).
 *    - 장르 필터는 with_genres를 써요 (TMDB 장르 ID, 예: 18은 드라마).
 *    - 조건을 여러 개 합칠수록 풀이 좁아지니까, 합쳐진 조건 개수에 맞춰 기준 투표수
 *      (minVoteCount)를 자동으로 낮춰서 16편 이상 모이게 해요 (getComboMinVoteCount 참고).
 *    - TMDB Rate limit은 넉넉한 편이지만, 매 요청마다 새로 긁으면 느리고 낭비라 캐싱이 필수예요.
 * 2. GET /api/movies/random16?genre=xx&country=yy&era=zz → 세 파라미터 모두 선택 사항이에요
 *    (아무것도 안 주면 "모든 영화"). genre는 TMDB 장르 ID(예: 18=드라마), country는
 *    korean/american/european/japanese/chinese/other 중 하나, era는 era_pre1970/
 *    era_80_90/era_2000 중 하나예요. 해당 조합 풀 중 16편을 무작위로 뽑아 클라이언트에
 *    내려줘요.
 * 3. POST /api/movies/result → 최종 우승작 id를 받아 Upstash에 우승 카운터를 1 올리고,
 *    전체 플레이 수 대비 이 영화가 우승한 비율(%), TOP 10 리더보드를 계산해서 돌려줘요.
 *
 * 사용 방법
 *   npm install express @upstash/redis
 *   TMDB_API_KEY=... UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node movies.js
 *
 * TMDB API 키 발급
 *   1. https://www.themoviedb.org 가입
 *   2. 설정 → API → "API 읽기 액세스 토큰(v4 auth)" 또는 "API 키(v3 auth)" 발급
 *   3. 이 코드는 v3 API 키를 사용해요 (쿼리 파라미터 ?api_key=... 방식)
 *   4. ⚠️ 상업적 사용(광고가 붙는 이 앱 포함)은 TMDB와 별도 서면 계약이 필요해요.
 *      개발·테스트 단계에서는 무료 키로 충분하지만, 정식 출시 전에는 TMDB 측에 문의해서
 *      상업적 이용 약관을 꼭 확인해주세요. (https://www.themoviedb.org/about/logos-attribution)
 *
 * Upstash DB는 밸런스게임 앱과 "별도"로 새로 만드는 걸 추천해요 (앱별 리소스 분리).
 */

import express from 'express';
import { Redis } from '@upstash/redis';

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => {
  res.send('moviecup server is running');
});

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';
const POOL_SIZE = 1000; // 카테고리당 목표 최대치 (실제로는 TMDB에 그만큼 없으면 더 적게 모여요)

/**
 * "그외 모든 국가"에서 걸러낼 주요 국가 코드 (이미 자기 국가 옵션이 있는 국가들).
 */
const MAJOR_ORIGIN_COUNTRIES = ['KR', 'US', 'GB', 'FR', 'DE', 'IT', 'ES', 'SE', 'JP', 'CN', 'TW', 'HK'];

/**
 * 국가별 설정.
 * - variants: TMDB /discover/movie에 붙일 국가 파라미터들. 여러 개면 각각 따로 긁어서 합쳐요
 *   (TMDB가 origin_country를 콤마로 OR 검색하게 해주지 않아서 이렇게 우회해요).
 * - baseMinVoteCount: 이 국가만 단독으로 고를 때 쓰는 기준 투표수. 장르/시대와 조합되면
 *   getComboMinVoteCount()가 이 값을 더 낮춰서 써요.
 * - pagesPerVariant: variant 하나당 최대로 긁을 페이지 수(20개/페이지).
 * - excludeOriginCountries: 있으면, 응답에 담긴 origin_country가 이 목록과 하나라도 겹치는
 *   작품은 풀에서 제외해요 ("그외 모든 국가" 전용).
 */
const COUNTRY_CONFIG = {
  korean: {
    baseMinVoteCount: 200,
    pagesPerVariant: 50,
    variants: [{ with_origin_country: 'KR' }],
  },
  american: {
    baseMinVoteCount: 600,
    pagesPerVariant: 50,
    variants: [{ with_origin_country: 'US' }],
  },
  european: {
    baseMinVoteCount: 150,
    pagesPerVariant: 25,
    variants: [
      { with_origin_country: 'GB' },
      { with_origin_country: 'FR' },
      { with_origin_country: 'DE' },
      { with_origin_country: 'IT' },
      { with_origin_country: 'ES' },
      { with_origin_country: 'SE' },
    ],
  },
  japanese: {
    baseMinVoteCount: 100,
    pagesPerVariant: 50,
    variants: [{ with_origin_country: 'JP' }],
  },
  chinese: {
    baseMinVoteCount: 100,
    pagesPerVariant: 35,
    variants: [
      { with_origin_country: 'CN' },
      { with_origin_country: 'TW' },
      { with_origin_country: 'HK' },
    ],
  },
  other: {
    baseMinVoteCount: 300,
    pagesPerVariant: 50,
    variants: [{}],
    excludeOriginCountries: MAJOR_ORIGIN_COUNTRIES,
  },
};

/** 시대별 TMDB 날짜 파라미터 + 이 시대만 단독으로 고를 때 쓰는 기준 투표수. */
const ERA_CONFIG = {
  era_pre1970: { baseMinVoteCount: 80, params: { 'primary_release_date.lte': '1969-12-31' } },
  era_80_90: { baseMinVoteCount: 300, params: { 'primary_release_date.gte': '1980-01-01', 'primary_release_date.lte': '1999-12-31' } },
  era_2000: { baseMinVoteCount: 1000, params: { 'primary_release_date.gte': '2000-01-01' } },
};

/** 장르만 단독으로 고를 때 쓰는 기준 투표수. */
const GENRE_BASE_MIN_VOTE_COUNT = 400;

/** 아무 조건도 없는 "모든 영화"의 기준 투표수. */
const ALL_MIN_VOTE_COUNT = 1000;

/**
 * 장르/국가/시대 중 고른 조건을 모두 합친(AND) TMDB 요청 설정을 만들어요.
 * 셋 다 선택사항이라, 어떤 조합으로 와도 동작해요.
 */
function buildComboConfig({ genreId, country, era }) {
  const countryCfg = country ? COUNTRY_CONFIG[country] : null;
  const eraCfg = era ? ERA_CONFIG[era] : null;
  const activeCount = (genreId ? 1 : 0) + (countryCfg ? 1 : 0) + (eraCfg ? 1 : 0);

  // 국가 variant가 있으면 그 variant들을 기준으로 여러 번 나눠 요청하고,
  // 없으면(장르/시대만 고르거나 아무것도 안 골랐으면) 한 번만 요청해요.
  const baseVariants = countryCfg ? countryCfg.variants : [{}];
  const extraParams = {
    ...(genreId ? { with_genres: String(genreId) } : {}),
    ...(eraCfg ? eraCfg.params : {}),
  };
  const variants = baseVariants.map((v) => ({ ...v, ...extraParams }));

  const minVoteCount = getComboMinVoteCount({ genreId, countryCfg, eraCfg, activeCount });
  const pagesPerVariant = countryCfg ? countryCfg.pagesPerVariant : 50;

  return {
    variants,
    minVoteCount,
    pagesPerVariant,
    excludeOriginCountries: countryCfg?.excludeOriginCountries || null,
  };
}

/**
 * 조건을 하나만 고르면 그 조건의 기준 투표수를 그대로 쓰고, 여러 개를 조합하면
 * (풀이 급격히 좁아지니까) 더 낮춰서 16편 이상은 모이게 해요.
 */
function getComboMinVoteCount({ genreId, countryCfg, eraCfg, activeCount }) {
  if (activeCount === 0) return ALL_MIN_VOTE_COUNT;
  const bases = [];
  if (countryCfg) bases.push(countryCfg.baseMinVoteCount);
  if (genreId) bases.push(GENRE_BASE_MIN_VOTE_COUNT);
  if (eraCfg) bases.push(eraCfg.baseMinVoteCount);
  if (activeCount === 1) return bases[0];
  const minBase = Math.min(...bases);
  return Math.max(15, Math.round(minBase / activeCount));
}

function getPoolKey({ genreId, country, era }) {
  // v5: 장르·국가·시대를 조합해서 고를 수 있게 바뀌면서(캐시 키도 조합별로 나뉘어요),
  //     기존 카테고리 캐시는 더 이상 쓰지 않으니 새로 만들게 키를 올렸어요.
  if (!genreId && !country && !era) return 'moviecup:pool:v5:all';
  const parts = [
    country || '-',
    genreId ? `genre${genreId}` : '-',
    era || '-',
  ];
  return `moviecup:pool:v5:combo:${parts.join(':')}`;
}

if (!TMDB_API_KEY) {
  console.warn('⚠️  TMDB_API_KEY 환경변수가 없어요. 서버를 시작하기 전에 설정해주세요.');
}
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.warn('⚠️  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 환경변수가 없어요.');
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function fetchTmdbPage(page, extraParams, minVoteCount) {
  // vote_average만으로 정렬하면 동점작이 많아서 페이지 경계에서 같은 영화가
  // 여러 페이지에 걸쳐 중복으로 나올 수 있어요. 완전히 막아주진 않지만,
  // 중복은 아래 ensureMoviePool에서 id 기준으로 한 번 더 걸러내요.
  const params = new URLSearchParams({
    api_key: TMDB_API_KEY,
    language: 'ko-KR',
    sort_by: 'vote_average.desc',
    'vote_count.gte': String(minVoteCount),
    page: String(page),
    ...extraParams,
  });
  const res = await fetch(`${TMDB_BASE}/discover/movie?${params.toString()}`);
  if (!res.ok) throw new Error(`TMDB API error: ${res.status}`);
  return res.json();
}

/**
 * 장르/국가/시대 조합별로 TMDB에서 영화를 긁어와 Upstash에 캐싱해요.
 * 이미 캐싱돼 있으면 그대로 반환해요.
 */
async function ensureMoviePool({ genreId, country, era }) {
  const poolKey = getPoolKey({ genreId, country, era });
  const cached = await redis.get(poolKey);
  if (cached) return cached;

  const config = buildComboConfig({ genreId, country, era });
  console.log(`[${poolKey}] 영화 풀이 없어서 TMDB에서 새로 가져와요. 1~2분 정도 걸릴 수 있어요...`);
  const seenIds = new Set();
  const movies = [];

  for (const variant of config.variants) {
    for (let page = 1; page <= config.pagesPerVariant; page++) {
      const data = await fetchTmdbPage(page, variant, config.minVoteCount);
      const results = data.results || [];
      if (page === 1) {
        // TMDB가 이 조건(투표수 기준)에 맞다고 보는 "전체" 개수예요.
        // 실제로 모이는 풀은 이 숫자와 POOL_SIZE(1000) 중 작은 쪽이에요.
        console.log(`[${poolKey}] variant=${JSON.stringify(variant)} TMDB 기준 전체 후보 ${data.total_results ?? '?'}편 (vote_count≥${config.minVoteCount})`);
      }
      if (results.length === 0) break; // 더 이상 결과 없음

      for (const m of results) {
        if (!m.poster_path) continue; // 포스터 없는 작품은 제외
        if (seenIds.has(m.id)) continue; // 중복 방지 (페이지 경계 겹침 + variant 간 겹침 모두 방지)
        if (config.excludeOriginCountries) {
          const origins = m.origin_country || [];
          if (origins.some((c) => config.excludeOriginCountries.includes(c))) continue;
        }
        seenIds.add(m.id);
        movies.push({
          id: m.id,
          title: m.title,
          year: (m.release_date || '').slice(0, 4),
          poster: `${POSTER_BASE}${m.poster_path}`,
          rating: m.vote_average,
        });
      }

      // TMDB rate limit(초당 요청 수 제한)을 배려해서 살짝 텀을 둬요.
      await new Promise((r) => setTimeout(r, 150));

      if (page >= (data.total_pages || 1)) break; // TMDB가 가진 페이지를 다 돌았으면 중단
      if (movies.length >= POOL_SIZE) break;
    }
    if (movies.length >= POOL_SIZE) break;
  }

  const pool = movies.slice(0, POOL_SIZE);
  await redis.set(poolKey, pool);
  console.log(`[${poolKey}] 영화 풀 ${pool.length}편 캐싱 완료 (중복 제거됨)`);
  return pool;
}

app.get('/api/movies/random16', async (req, res) => {
  try {
    const parsedGenreId = req.query.genre ? parseInt(req.query.genre, 10) : NaN;
    const genreId = Number.isFinite(parsedGenreId) ? parsedGenreId : null;
    const country = typeof req.query.country === 'string' && COUNTRY_CONFIG[req.query.country] ? req.query.country : null;
    const era = typeof req.query.era === 'string' && ERA_CONFIG[req.query.era] ? req.query.era : null;
    const pool = await ensureMoviePool({ genreId, country, era });
    if (!pool || pool.length < 16) {
      return res.status(503).json({ error: '선택한 조건에는 아직 영화가 충분히 모이지 않았어요. 조건을 조금 줄이거나 잠시 후 다시 시도해주세요.' });
    }
    // 캐시된 풀에 혹시 중복 id가 남아있어도 한 번의 뽑기에서 같은 영화가
    // 두 번 나오지 않도록 여기서도 한 번 더 방어적으로 걸러줘요.
    const seen = new Set();
    const uniquePool = pool.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    const shuffled = uniquePool.slice().sort(() => Math.random() - 0.5);
    res.json({ movies: shuffled.slice(0, 16) });
  } catch (err) {
    console.error('random16 error:', err);
    res.status(502).json({ error: '영화 목록을 불러오지 못했어요.' });
  }
});

app.post('/api/movies/result', async (req, res) => {
  try {
    const { winnerId, winnerTitle } = req.body;
    if (!winnerId) return res.status(400).json({ error: '잘못된 요청이에요.' });

    const pipeline = redis.pipeline();
    pipeline.incr('moviecup:totalPlays');
    pipeline.zincrby('moviecup:winCounts', 1, String(winnerId));
    const [totalPlays, myWinCount] = await pipeline.exec();

    const top10 = await redis.zrange('moviecup:winCounts', 0, 9, { rev: true, withScores: true });
    // top10은 [member, score, member, score, ...] 형태예요.
    const leaderboard = [];
    for (let i = 0; i < top10.length; i += 2) {
      leaderboard.push({ movieId: top10[i], wins: Number(top10[i + 1]) });
    }

    res.json({
      totalPlays: Number(totalPlays),
      myWinCount: Number(myWinCount),
      myWinPct: Math.round((Number(myWinCount) / Number(totalPlays)) * 1000) / 10,
      leaderboard, // [{movieId, wins}] — 제목은 클라이언트가 이미 갖고 있는 값으로 매핑
      winnerTitle: winnerTitle || null,
    });
  } catch (err) {
    console.error('result error:', err);
    res.status(500).json({ error: '결과를 저장하지 못했어요.' });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`moviecup server listening on :${PORT}`);
});
