import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const sessionExpireMs = Number(process.env.SESSION_EXPIRE_MS || 5 * 60 * 1000);
const sampleFile = process.env.WEREAD_SAMPLE_FILE || path.resolve(process.cwd(), 'server/sample-highlights.json');
const loginProviderBaseUrl = (process.env.WEREAD_LOGIN_PROVIDER_URL || '').trim().replace(/\/+$/, '');
const maxSyncBooks = Number(process.env.WEREAD_MAX_SYNC_BOOKS || 2000);
const defaultMaxRecords = Number(process.env.WEREAD_MAX_SYNC_RECORDS || 200);
const preferRealData = String(process.env.WEREAD_PREFER_REAL_DATA || 'true') === 'true';
const strictRealData = process.env.WEREAD_STRICT_REAL_DATA !== undefined
  ? String(process.env.WEREAD_STRICT_REAL_DATA) === 'true'
  : process.env.NODE_ENV === 'production';
const cookieCloudUrl = (process.env.CC_URL || '').trim().replace(/\/+$/, '');
const cookieCloudId = (process.env.CC_ID || '').trim();
const cookieCloudPassword = (process.env.CC_PASSWORD || '').trim();
const wereadCookieEnv = (process.env.WEREAD_COOKIE || '').trim();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const sessions = new Map();
const jobs = new Map();

const WEREAD_URL = 'https://weread.qq.com/';
const WEREAD_NOTEBOOKS_URL = 'https://weread.qq.com/api/user/notebook';
const WEREAD_BOOKMARK_LIST_URL = 'https://weread.qq.com/web/book/bookmarklist';
const WEREAD_REVIEW_LIST_URL = 'https://weread.qq.com/web/review/list';
const WEREAD_CHAPTER_INFOS_URL = 'https://weread.qq.com/web/book/chapterInfos';

function now() {
  return Date.now();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickString(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number') {
      return String(value);
    }
  }
  return '';
}

function toTimestamp(value) {
  if (typeof value === 'number') {
    if (value <= 0) return undefined;
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const t = new Date(value).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

function normalizeHighlight(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tags = Array.isArray(raw.tags) ? raw.tags.map((v) => String(v)).join('、') : pickString(raw, ['tags', 'tag']);
  const result = {
    bookTitle: pickString(raw, ['bookTitle', 'book_name', 'bookName', 'title']),
    author: pickString(raw, ['author', 'bookAuthor']),
    chapter: pickString(raw, ['chapter', 'chapterTitle', 'chapter_name']),
    highlightText: pickString(raw, ['highlightText', 'markText', 'text', 'highlight_content']),
    noteText: pickString(raw, ['noteText', 'reviewContent', 'note', 'comment']),
    tags,
    highlightId: pickString(raw, ['highlightId', 'markId', 'bookmarkId']),
    bookId: pickString(raw, ['bookId', 'book_id']),
    highlightedAt: toTimestamp(raw.highlightedAt ?? raw.createTime ?? raw.markTime),
    updatedAt: toTimestamp(raw.updatedAt ?? raw.updateTime)
  };
  if (!result.bookTitle && !result.highlightText && !result.noteText) {
    return null;
  }
  return result;
}

async function loadSampleHighlights() {
  const content = await fs.readFile(sampleFile, 'utf8');
  const parsed = JSON.parse(content);
  const list = asArray(parsed);
  return list.map(normalizeHighlight).filter(Boolean);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败: ${response.status}`);
  }
  return response.json();
}

function toCookieHeaderFromCookieCloudDomain(list) {
  const pairs = asArray(list)
    .map((item) => {
      const name = String(item?.name || '').trim();
      const value = String(item?.value || '').trim();
      if (!name) return '';
      return `${name}=${value}`;
    })
    .filter(Boolean);
  return pairs.join('; ');
}

async function getWereadCookieFromCookieCloud() {
  if (!cookieCloudUrl || !cookieCloudId || !cookieCloudPassword) {
    return '';
  }

  const payload = await fetchJson(`${cookieCloudUrl}/get/${encodeURIComponent(cookieCloudId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ password: cookieCloudPassword })
  });

  const cookieData = payload?.cookie_data || payload?.data?.cookie_data || {};
  const wereadCookies = cookieData?.['weread.qq.com'];
  return toCookieHeaderFromCookieCloudDomain(wereadCookies);
}

async function tryProviderRequest(specs, body) {
  let lastError = null;
  for (const spec of specs) {
    try {
      const result = await fetchJson(`${loginProviderBaseUrl}${spec.path}`, {
        method: spec.method,
        headers: {
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      });
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('登录服务调用失败');
}

function resolveProviderSessionId(payload) {
  return String(
    payload?.sessionId ||
      payload?.id ||
      payload?.data?.sessionId ||
      payload?.data?.id ||
      ''
  );
}

function resolveProviderQr(payload) {
  return {
    qrCodeUrl:
      payload?.qrCodeUrl ||
      payload?.qrcodeUrl ||
      payload?.qrUrl ||
      payload?.qrConnectUrl ||
      payload?.loginUrl ||
      payload?.data?.qrCodeUrl ||
      payload?.data?.qrUrl ||
      payload?.url,
    qrCodeBase64: payload?.qrCodeBase64 || payload?.qrcode || payload?.data?.qrCodeBase64
  };
}

function resolveProviderStatus(payload) {
  const raw = String(payload?.status || payload?.state || payload?.data?.status || '').toLowerCase();
  if (raw === 'authorized' || raw === 'success' || raw === 'confirmed') return 'authorized';
  if (raw === 'expired' || raw === 'timeout') return 'expired';
  if (raw === 'failed' || raw === 'error') return 'failed';
  return 'pending';
}

function resolveProviderCookie(payload) {
  return String(
    payload?.wereadCookie ||
      payload?.cookie ||
      payload?.data?.wereadCookie ||
      payload?.data?.cookie ||
      ''
  ).trim();
}

async function createProviderLoginSession() {
  const payload = await tryProviderRequest(
    [
      { method: 'POST', path: '/api/weread/auth/session' },
      { method: 'POST', path: '/api/weread/login/session' },
      { method: 'POST', path: '/session' }
    ],
    {}
  );

  const providerSessionId = resolveProviderSessionId(payload);
  if (!providerSessionId) {
    throw new Error('登录态服务未返回会话ID');
  }

  const qr = resolveProviderQr(payload);
  return {
    providerSessionId,
    qrCodeUrl: qr.qrCodeUrl,
    qrCodeBase64: qr.qrCodeBase64,
    pollIntervalMs: Number(payload?.pollIntervalMs || payload?.pollInterval || 2000)
  };
}

async function getProviderSessionStatus(providerSessionId) {
  const payload = await tryProviderRequest([
    { method: 'GET', path: `/api/weread/auth/session/${encodeURIComponent(providerSessionId)}/status` },
    { method: 'GET', path: `/api/weread/login/session/${encodeURIComponent(providerSessionId)}/status` },
    { method: 'GET', path: `/session/${encodeURIComponent(providerSessionId)}/status` }
  ]);

  return {
    status: resolveProviderStatus(payload),
    message: payload?.message || payload?.msg || '',
    wereadCookie: resolveProviderCookie(payload)
  };
}

async function getProviderSessionCookie(providerSessionId) {
  const payload = await tryProviderRequest([
    { method: 'GET', path: `/api/weread/auth/session/${encodeURIComponent(providerSessionId)}/cookie` },
    { method: 'GET', path: `/api/weread/login/session/${encodeURIComponent(providerSessionId)}/cookie` },
    { method: 'GET', path: `/session/${encodeURIComponent(providerSessionId)}/cookie` },
    { method: 'GET', path: `/session/${encodeURIComponent(providerSessionId)}` }
  ]);
  return resolveProviderCookie(payload);
}

async function wereadRequestJson(url, options, wereadCookie) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Referer: WEREAD_URL,
      Origin: 'https://weread.qq.com',
      'User-Agent': 'Mozilla/5.0',
      Cookie: wereadCookie,
      ...(options?.headers || {})
    }
  });

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const bodyText = await response.text();

  if (!response.ok) {
    const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`微信读书接口失败: ${response.status} ${snippet}`);
  }

  if (!contentType.includes('application/json')) {
    const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`微信读书返回非JSON内容，通常是Cookie失效或被风控拦截: ${snippet}`);
  }

  try {
    return JSON.parse(bodyText);
  } catch (_) {
    const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`微信读书JSON解析失败，可能返回了登录页或错误页: ${snippet}`);
  }
}

async function fetchChapterMap(bookId, wereadCookie) {
  const payload = await wereadRequestJson(
    WEREAD_CHAPTER_INFOS_URL,
    {
      method: 'POST',
      body: JSON.stringify({
        bookIds: [bookId],
        syncKeys: [0],
        teenmode: 0
      })
    },
    wereadCookie
  );

  const list = asArray(payload?.data);
  if (!list.length) return {};
  const updated = asArray(list[0]?.updated);
  const chapterMap = {};
  for (const item of updated) {
    const chapterUid = item?.chapterUid;
    if (chapterUid !== undefined && chapterUid !== null) {
      chapterMap[String(chapterUid)] = String(item?.title || '');
    }
  }
  return chapterMap;
}

async function fetchBookmarks(bookId, wereadCookie) {
  const pageSize = 100;
  const maxPages = 20;
  const records = [];
  const seen = new Set();
  let maxIdx = '0';
  let syncKey = '0';

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      bookId: String(bookId),
      maxIdx,
      count: String(pageSize),
      syncKey
    });
    const payload = await wereadRequestJson(`${WEREAD_BOOKMARK_LIST_URL}?${params.toString()}`, { method: 'GET' }, wereadCookie);
    const list = asArray(payload?.updated);
    if (!list.length) break;

    for (const item of list) {
      const dedupeKey = String(item?.bookmarkId || item?.markId || `${item?.chapterUid || ''}-${item?.markTime || ''}`);
      if (dedupeKey && seen.has(dedupeKey)) continue;
      if (dedupeKey) seen.add(dedupeKey);
      records.push(item);
    }

    const nextMaxIdx = String(payload?.nextMaxIdx ?? payload?.maxIdx ?? '');
    const nextSyncKey = String(payload?.syncKey ?? payload?.synckey ?? '');
    const hasMore = payload?.hasMore === true || payload?.continueFlag === 1 || payload?.isFinished === 0;
    const cursorChanged = (nextMaxIdx && nextMaxIdx !== maxIdx) || (nextSyncKey && nextSyncKey !== syncKey);
    if (!hasMore && !cursorChanged) break;
    if (!cursorChanged && list.length < pageSize) break;
    if (nextMaxIdx) maxIdx = nextMaxIdx;
    if (nextSyncKey) syncKey = nextSyncKey;
  }

  return records;
}

async function fetchReviews(bookId, wereadCookie) {
  const pageSize = 100;
  const maxPages = 20;
  const reviews = [];
  const seen = new Set();
  let maxIdx = '0';
  let syncKey = '0';

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      bookId: String(bookId),
      listType: '4',
      maxIdx,
      count: String(pageSize),
      listMode: '2',
      syncKey
    });
    const payload = await wereadRequestJson(`${WEREAD_REVIEW_LIST_URL}?${params.toString()}`, { method: 'GET' }, wereadCookie);
    const list = asArray(payload?.reviews);
    if (!list.length) break;

    for (const item of list) {
      const review = item?.review || item || null;
      if (!review) continue;
      const dedupeKey = String(review?.reviewId || review?.bookmarkId || '');
      if (dedupeKey && seen.has(dedupeKey)) continue;
      if (dedupeKey) seen.add(dedupeKey);
      reviews.push(review);
    }

    const nextMaxIdx = String(payload?.nextMaxIdx ?? payload?.maxIdx ?? '');
    const nextSyncKey = String(payload?.syncKey ?? payload?.synckey ?? '');
    const hasMore = payload?.hasMore === true || payload?.continueFlag === 1 || payload?.isFinished === 0;
    const cursorChanged = (nextMaxIdx && nextMaxIdx !== maxIdx) || (nextSyncKey && nextSyncKey !== syncKey);
    if (!hasMore && !cursorChanged) break;
    if (!cursorChanged && list.length < pageSize) break;
    if (nextMaxIdx) maxIdx = nextMaxIdx;
    if (nextSyncKey) syncKey = nextSyncKey;
  }

  return reviews
    .map((review) => ({
      markText: String(review?.abstract || ''),
      noteText: String(review?.content || ''),
      reviewId: String(review?.reviewId || ''),
      createTime: review?.createTime,
      chapterUid: Number(review?.type) === 4 ? 1000000 : review?.chapterUid
    }))
    .filter((x) => x.markText || x.noteText);
}

function normalizeMaxBooks(value, fallback = maxSyncBooks) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(2000, Math.floor(n)));
}

function normalizeMaxRecords(value, fallback = defaultMaxRecords) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500000, Math.floor(n)));
}

async function fetchNotebooks(wereadCookie, maxBooksLimit = maxSyncBooks) {
  const payload = await wereadRequestJson(WEREAD_NOTEBOOKS_URL, { method: 'GET' }, wereadCookie);
  const books = asArray(payload?.books).sort((a, b) => Number(b?.sort || 0) - Number(a?.sort || 0));
  return books.slice(0, normalizeMaxBooks(maxBooksLimit));
}

async function fetchHighlightsByWereadCookie(wereadCookie, maxRecords = defaultMaxRecords, maxBooksLimit = maxSyncBooks) {
  if (!wereadCookie) return { highlights: [], books: [] };
  const books = await fetchNotebooks(wereadCookie, maxBooksLimit);
  const highlights = [];
  const booksMeta = [];

  for (const item of books) {
    if (highlights.length >= maxRecords) break;
    const book = item?.book || {};
    const bookId = String(book?.bookId || '');
    if (!bookId) continue;

    const bookTitle = String(book?.title || '');
    const author = String(book?.author || '');
    const tags = asArray(book?.categories).map((x) => String(x?.title || '')).filter(Boolean).join('、');
    booksMeta.push(item);

    let chapterMap = {};
    try {
      chapterMap = await fetchChapterMap(bookId, wereadCookie);
    } catch (_) {
      chapterMap = {};
    }

    try {
      const bookmarks = await fetchBookmarks(bookId, wereadCookie);
      const reviews = await fetchReviews(bookId, wereadCookie);
      for (const row of bookmarks) {
        const chapter = chapterMap[String(row?.chapterUid)] || '';
        const mapped = normalizeHighlight({
          bookTitle,
          author,
          chapter,
          highlightText: row?.markText || row?.text || row?.highlightText,
          noteText: '',
          tags,
          highlightId: row?.bookmarkId || row?.markId || '',
          bookId,
          highlightedAt: row?.createTime || row?.markTime,
          updatedAt: row?.updateTime || row?.createTime
        });
        if (mapped) highlights.push(mapped);
        if (highlights.length >= maxRecords) break;
      }
      for (const row of reviews) {
        const chapter = chapterMap[String(row?.chapterUid)] || '';
        const mapped = normalizeHighlight({
          bookTitle,
          author,
          chapter,
          highlightText: row?.markText || '',
          noteText: row?.noteText || '',
          tags,
          highlightId: row?.reviewId || '',
          bookId,
          highlightedAt: row?.createTime,
          updatedAt: row?.createTime
        });
        if (mapped) highlights.push(mapped);
        if (highlights.length >= maxRecords) break;
      }
    } catch (e) {
      console.error(`Error fetching highlights for book ${bookId}:`, e.message);
    }
  }

  return {
    highlights: highlights.slice(0, maxRecords),
    books: booksMeta
  };
}

async function fetchSyncPayloadForSession(session) {
  if (preferRealData && session?.wereadCookie) {
    try {
      const realData = await fetchHighlightsByWereadCookie(session.wereadCookie, session?.maxRecords, session?.maxBooks);
      if (asArray(realData?.highlights).length) {
        return realData;
      }
      if (strictRealData) {
        throw new Error('真实数据抓取结果为空，请检查 Cookie 是否仍有效，或账号是否存在划线/笔记');
      }
    } catch (error) {
      if (strictRealData) {
        throw new Error(`真实数据抓取失败：${error.message || 'unknown error'}`);
      }
    }
  }

  const api = process.env.WEREAD_UPSTREAM_API;
  if (api) {
    const response = await fetch(api, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`上游接口调用失败: ${response.status}`);
    }
    const result = await response.json();
    const list = asArray(result?.highlights ?? result);
    return {
      highlights: list.map(normalizeHighlight).filter(Boolean),
      books: asArray(result?.books)
    };
  }
  return {
    highlights: await loadSampleHighlights(),
    books: []
  };
}

function ensureSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('登录会话不存在');
  }
  if (session.expiresAt < now()) {
    session.status = 'expired';
    throw new Error('登录会话已过期');
  }
  return session;
}

app.get('/healthz', (_, res) => {
  res.json({ ok: true, now: now() });
});

app.post('/api/weread/login/session', async (_, res) => {
  const sessionId = uuidv4();
  const expiresAt = now() + sessionExpireMs;
  if (loginProviderBaseUrl) {
    try {
      const providerSession = await createProviderLoginSession();
      sessions.set(sessionId, {
        sessionId,
        status: 'pending',
        mode: 'provider',
        providerSessionId: providerSession.providerSessionId,
        expiresAt,
        createdAt: now(),
        wereadCookie: ''
      });
      return res.json({
        sessionId,
        qrCodeUrl: providerSession.qrCodeUrl,
        qrCodeBase64: providerSession.qrCodeBase64,
        expiresAt,
        pollIntervalMs: providerSession.pollIntervalMs
      });
    } catch (error) {
      sessions.set(sessionId, {
        sessionId,
        status: 'pending',
        mode: 'manual',
        expiresAt,
        createdAt: now(),
        wereadCookie: ''
      });
      return res.json({
        sessionId,
        expiresAt,
        pollIntervalMs: 2000,
        mode: 'manual',
        message: `登录服务不可用，已切换到手动Cookie模式: ${error.message || 'unknown error'}`
      });
    }
  }

  try {
    const confirmUrl = `${baseUrl}/api/weread/login/mock-confirm?sessionId=${encodeURIComponent(sessionId)}`;
    const qrCodeBase64 = await QRCode.toDataURL(confirmUrl, {
      margin: 1,
      width: 280
    });

    sessions.set(sessionId, {
      sessionId,
      status: 'pending',
      mode: 'mock',
      expiresAt,
      createdAt: now(),
      wereadCookie: ''
    });

    return res.json({
      sessionId,
      qrCodeBase64,
      expiresAt,
      pollIntervalMs: 2000
    });
  } catch (error) {
    return res.status(500).json({
      status: 'failed',
      message: error.message || '创建登录会话失败'
    });
  }
});

app.get('/api/weread/login/session/:sessionId/status', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ status: 'failed', message: '会话不存在' });
  }
  if (session.expiresAt < now()) {
    session.status = 'expired';
  }
  if (session.mode === 'provider' && session.providerSessionId) {
    try {
      const result = await getProviderSessionStatus(session.providerSessionId);
      session.status = result.status;
      if (result.wereadCookie) {
        session.wereadCookie = result.wereadCookie;
      }
      return res.json({
        status: session.status,
        message: result.message || (session.status === 'pending' ? '等待扫码确认' : undefined)
      });
    } catch (error) {
      return res.status(500).json({
        status: 'failed',
        message: error.message || '查询登录状态失败'
      });
    }
  }

  return res.json({ status: session.status, message: session.status === 'pending' ? '等待扫码确认' : undefined });
});

app.get('/api/weread/login/mock-confirm', (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).send('<h3>会话不存在，请返回插件重新生成二维码</h3>');
    return;
  }
  if (session.expiresAt < now()) {
    session.status = 'expired';
    res.status(410).send('<h3>二维码已过期，请返回插件重新生成</h3>');
    return;
  }
  session.status = 'authorized';
  res.send('<h2>登录确认成功</h2><p>请返回飞书插件点击“同步到多维表格”。</p>');
});

app.post('/api/weread/login/session/:sessionId/cookie', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ status: 'failed', message: '会话不存在' });
  }

  const wereadCookie = String(req.body?.wereadCookie || req.body?.cookie || '').trim();
  if (!wereadCookie) {
    return res.status(400).json({ status: 'failed', message: 'cookie 不能为空' });
  }

  session.wereadCookie = wereadCookie;
  session.status = 'authorized';
  return res.json({ status: 'authorized' });
});

app.post('/api/weread/sync', async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  const directCookie = String(req.body?.wereadCookie || req.body?.cookie || '').trim();
  const requestMaxBooks = normalizeMaxBooks(req.body?.maxBooks, maxSyncBooks);
  const requestMaxRecords = normalizeMaxRecords(req.body?.maxRecords, defaultMaxRecords);
  let session = null;

  if (sessionId) {
    try {
      session = ensureSession(sessionId);
    } catch (error) {
      res.status(400).json({ status: 'failed', message: error.message });
      return;
    }
  } else {
    const tempSessionId = `temp-${uuidv4()}`;
    session = {
      sessionId: tempSessionId,
      status: 'pending',
      mode: 'manual',
      expiresAt: now() + sessionExpireMs,
      createdAt: now(),
      wereadCookie: directCookie,
      maxBooks: requestMaxBooks,
      maxRecords: requestMaxRecords
    };
    sessions.set(tempSessionId, session);
  }

  session.maxBooks = requestMaxBooks;
  session.maxRecords = requestMaxRecords;

  if (directCookie) {
    session.wereadCookie = directCookie;
  }

  if (!session.wereadCookie && session.mode === 'provider' && session.providerSessionId) {
    try {
      const cookie = await getProviderSessionCookie(session.providerSessionId);
      if (cookie) {
        session.wereadCookie = cookie;
      }
    } catch (_) {}
  }

  if (!session.wereadCookie) {
    try {
      const cloudCookie = await getWereadCookieFromCookieCloud();
      if (cloudCookie) {
        session.wereadCookie = cloudCookie;
      }
    } catch (_) {}
  }

  if (!session.wereadCookie && wereadCookieEnv) {
    session.wereadCookie = wereadCookieEnv;
  }

  if (session.wereadCookie && session.status !== 'authorized') {
    session.status = 'authorized';
  }

  if (session.status !== 'authorized') {
    res.status(400).json({ status: 'failed', message: '会话未授权，请先绑定 Cookie 或配置 CookieCloud' });
    return;
  }

  const jobId = uuidv4();
  jobs.set(jobId, { jobId, status: 'processing', createdAt: now(), highlights: [], books: [] });
  res.json({ status: 'processing', jobId });

  setTimeout(async () => {
    const job = jobs.get(jobId);
    if (!job) return;
    try {
      const syncPayload = await fetchSyncPayloadForSession(session);
      job.status = 'completed';
      job.highlights = asArray(syncPayload?.highlights);
      job.books = asArray(syncPayload?.books);
      job.finishedAt = now();
    } catch (error) {
      job.status = 'failed';
      job.message = error.message || '同步失败';
      job.finishedAt = now();
    }
  }, 600);
});

app.get('/api/weread/sync/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ status: 'failed', message: '任务不存在' });
  }
  if (job.status === 'failed') {
    return res.status(500).json({ status: 'failed', message: job.message || '同步失败' });
  }
  return res.json({
    status: job.status,
    highlights: job.status === 'completed' ? job.highlights : undefined,
    books: job.status === 'completed' ? job.books : undefined
  });
});

app.listen(port, host, () => {
  console.log(`weread sync server is running at ${baseUrl}`);
});
