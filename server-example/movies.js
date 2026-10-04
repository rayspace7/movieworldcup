/**
 * 나만의 명작영화 월드컵 백엔드 예제 (Express, TMDB API + Upstash Redis)
 *
 * 전체 흐름
 * 1. TMDB에서 평점 상위 1000편을 딱 한 번(또는 재요청 시) 가져와 Upstash에 캐싱해요.
 *    - /discover/movie를 vote_average.desc로 정렬해서 페이지를 50번(20개×50=1000개) 돌아요.
 *    - TMDB Rate limit은 넉넉한 편이지만, 매 요청마다 새로 긁으면 느리고 낭비라 캐싱이 필수예요.
 * 2. GET /api/movies/random16 → 캐싱된 1000편 중 16편을 무작위로 뽑아 클라이언트에 내려줘요.
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
const POOL_KEY = 'moviecup:pool:v2'; // v2: 풀 중복 제거 로직 추가로 캐시 키 변경 (이전 캐시 무효화)
const POOL_SIZE = 1000; // 20개 × 50페이지
const MIN_VOTE_COUNT = 1000; // 평점 상위이면서 "많이 본" 작품 위주로. 너무 낮으면 무명작이 상위권에 낄 수 있어요.

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

async function fetchTmdbPage(page) {
  // vote_average만으로 정렬하면 동점작이 많아서 페이지 경계에서 같은 영화가
  // 여러 페이지에 걸쳐 중복으로 나올 수 있어요. vote_count를 2차 정렬 기준으로
  // 추가해서 페이지 순서를 안정적으로 만들어요(중복 축소용 — 완전히 막아주진 않음).
  const url = `${TMDB_BASE}/discover/movie?api_key=${TMDB_API_KEY}&language=ko-KR&sort_by=vote_average.desc&vote_count.gte=${MIN_VOTE_COUNT}&page=${page}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB API error: ${res.status}`);
  return res.json();
}

/**
 * TMDB에서 1000편을 긁어와 Upstash에 저장해요. 이미 캐싱돼 있으면 그대로 반환해요.
 */
async function ensureMoviePool() {
  const cached = await redis.get(POOL_KEY);
  if (cached) return cached;

  console.log('영화 풀이 없어서 TMDB에서 새로 가져와요. 1~2분 정도 걸릴 수 있어요...');
  const seenIds = new Set();
  const movies = [];
  const totalPages = Math.ceil(POOL_SIZE / 20);

  for (let page = 1; page <= totalPages; page++) {
    const data = await fetchTmdbPage(page);
    for (const m of data.results || []) {
      if (!m.poster_path) continue; // 포스터 없는 작품은 제외
      if (seenIds.has(m.id)) continue; // TMDB 페이지 경계 중복 방지 (동점작이 여러 페이지에 걸쳐 나오는 문제)
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
  }

  const pool = movies.slice(0, POOL_SIZE);
  await redis.set(POOL_KEY, pool);
  console.log(`영화 풀 ${pool.length}편 캐싱 완료 (중복 제거됨)`);
  return pool;
}

app.get('/api/movies/random16', async (req, res) => {
  try {
    const pool = await ensureMoviePool();
    if (!pool || pool.length < 16) {
      return res.status(503).json({ error: '영화 목록을 아직 준비 중이에요. 잠시 후 다시 시도해주세요.' });
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
