/**
 * 나만의 명작영화 월드컵 백엔드 예제 (Express, TMDB API + Upstash Redis)
 *
 * 전체 흐름
 * 1. 카테고리(모든 영화/한국영화/서양영화/아시아영화/장르별)마다 TMDB에서 영화를 긁어와
 *    Upstash에 "따로" 캐싱해요 (카테고리별 캐시 키가 달라요. getPoolKey 참고).
 *    - /discover/movie를 vote_average.desc로 정렬해서 모아요.
 *    - 국가/언어 필터는 TMDB가 콤마로 OR 검색을 지원하지 않아서, 카테고리별로 여러 번
 *      나눠서 요청한 뒤 합쳐요 (예: 아시아영화 = 한국어+일본어+중국어+힌디어+태국어 영화를 합침).
 *    - TMDB Rate limit은 넉넉한 편이지만, 매 요청마다 새로 긁으면 느리고 낭비라 캐싱이 필수예요.
 * 2. GET /api/movies/random16?category=xxx&genre=yyy → 해당 카테고리 풀 중 16편을 무작위로 뽑아
 *    클라이언트에 내려줘요. category는 all/korean/western/asian/genre 중 하나,
 *    genre를 쓸 때는 genre=TMDB_장르ID도 같이 보내요 (예: genre=28은 액션).
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
 * 카테고리별 설정.
 * - variants: TMDB /discover/movie에 추가로 붙일 파라미터들. 여러 개면 각각 따로 긁어서 합쳐요
 *   (TMDB가 origin_country/original_language를 콤마로 OR 검색하게 해주지 않아서 이렇게 우회해요).
 * - minVoteCount: 카테고리가 좁을수록(예: 한국영화) 기준 투표수를 낮춰야 16편 이상이 모여요.
 * - pagesPerVariant: variant 하나당 최대로 긁을 페이지 수(20개/페이지).
 */
const CATEGORY_CONFIG = {
  all: {
    minVoteCount: 1000,
    pagesPerVariant: 50,
    variants: [{}],
  },
  korean: {
    minVoteCount: 200,
    pagesPerVariant: 50,
    variants: [{ with_origin_country: 'KR' }],
  },
  western: {
    minVoteCount: 800,
    pagesPerVariant: 50,
    variants: [{ original_language: 'en' }],
  },
  asian: {
    minVoteCount: 150,
    pagesPerVariant: 50,
    variants: [
      { original_language: 'ko' },
      { original_language: 'ja' },
      { original_language: 'zh' },
      { original_language: 'hi' },
      { original_language: 'th' },
    ],
  },
};

function getCategoryConfig(category, genreId) {
  if (category === 'genre' && genreId) {
    return {
      minVoteCount: 400,
      pagesPerVariant: 50,
      variants: [{ with_genres: String(genreId) }],
    };
  }
  return CATEGORY_CONFIG[category] || CATEGORY_CONFIG.all;
}

function getPoolKey(category, genreId) {
  // v3: 아시아영화 pagesPerVariant를 15→50으로 늘려서 더 캐서, 캐시를 새로 만들게 키를 올렸어요.
  if (category === 'genre' && genreId) return `moviecup:pool:v3:genre:${genreId}`;
  if (CATEGORY_CONFIG[category]) return `moviecup:pool:v3:${category}`;
  return 'moviecup:pool:v3:all';
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
 * 카테고리(및 장르)별로 TMDB에서 영화를 긁어와 Upstash에 캐싱해요.
 * 이미 캐싱돼 있으면 그대로 반환해요.
 */
async function ensureMoviePool(category, genreId) {
  const poolKey = getPoolKey(category, genreId);
  const cached = await redis.get(poolKey);
  if (cached) return cached;

  const config = getCategoryConfig(category, genreId);
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
    const category = typeof req.query.category === 'string' ? req.query.category : 'all';
    const genreId = req.query.genre ? parseInt(req.query.genre, 10) : null;
    const pool = await ensureMoviePool(category, genreId);
    if (!pool || pool.length < 16) {
      return res.status(503).json({ error: '선택한 카테고리에는 아직 영화가 충분히 모이지 않았어요. 잠시 후 다시 시도해주세요.' });
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
