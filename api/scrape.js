const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-TW,zh;q=0.9' };
const SITE_SUFFIX = /\s*[|｜\-－–—]\s*(誠品線上|誠品|金石堂[^]*|三民網路書店|三民)\s*$/i;
const GENERIC = ['誠品線上','誠品','金石堂','金石堂網路書店','三民網路書店','親子館','中文書','童書'];
function decode(s) {
  return s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#0?39;/g,"'")
          .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
          .replace(/&hellip;/g,'…').replace(/\s+/g,' ').trim();
}

function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { redirect: 'follow', headers: HEADERS, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Google 圖書官方目錄天生不會收錄玩具周邊，資料品質比爬蟲猜測可靠，設為優先來源
// 用金鑰放在 Vercel 環境變數（SENBEIBOOKS_API_KEY），不寫死在公開程式碼裡
const GOOGLE_BOOKS_KEY = process.env.SENBEIBOOKS_API_KEY;

function isTaiwanISBN(item) {
  const ids = (item.volumeInfo && item.volumeInfo.industryIdentifiers) || [];
  return ids.some(x => /^978(957|986)/.test((x.identifier || '').replace(/-/g, '')));
}

async function callGoogleBooksOnce(q) {
  // 不用 intitle: 前綴（純文字查詢，混進來的不相關結果交給下面的相關度過濾處理）
  const u = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q)
    + '&country=TW&maxResults=20&key=' + GOOGLE_BOOKS_KEY;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    return await fetch(u, {
      headers: { Referer: 'https://books-senbei.vercel.app/' },
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(t);
  }
}

async function searchGoogleBooks(q) {
  if (!GOOGLE_BOOKS_KEY) return { items: [], reason: 'no-key' };

  // Google 圖書 API 會隨機吐 503（Google 自己的 issue tracker 有這筆已知問題），
  // 同一個查詢有時成功有時失敗，跟查詢寫法無關 → 只能靠重試硬碰。
  // 每次逾時 2.5 秒、最多試 3 次、間隔遞增，總計控制在 Vercel 的 10 秒上限內。
  let r = null, lastStatus = 0, lastBody = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) await new Promise(res => setTimeout(res, attempt === 2 ? 300 : 700));
      r = await callGoogleBooksOnce(q);
      if (r.ok) break;
      lastStatus = r.status;
      lastBody = await r.text();
      // 只有伺服器端的暫時性錯誤值得重試；403（金鑰問題）之類重試也沒用
      if (![500, 502, 503, 504].includes(r.status)) break;
      r = null;
    } catch (e) {
      lastBody = String(e);
      r = null;
    }
  }
  if (!r || !r.ok) {
    return { items: [], reason: lastStatus ? 'http-' + lastStatus : 'timeout', detail: lastBody.slice(0, 150) };
  }

  try {
    const data = await r.json();
    if (!data.items) return { items: [], reason: 'no-items', totalItems: data.totalItems || 0 };

    const hasIdentifiers = (v) => ((v.volumeInfo && v.volumeInfo.industryIdentifiers) || []).length > 0;
    const ql = q.trim();
    const isEnglishQuery = /^[a-zA-Z0-9\s\-'!?.,:&]+$/.test(ql);

    // 相關度把關：中文用「字元重疊」，英文用「單詞重疊」
    // （英文若用字元比對會太寬鬆；純用單詞比對也不夠，因為 the/and/for 這類
    // 高頻虛詞幾乎出現在所有書名裡，等於沒有過濾效果，必須先排除掉）
    const EN_STOPWORDS = new Set(['the','and','for','with','from','this','that','book','books',
      'of','in','on','at','as','is','are','was','were','to','it','its','an','a','by','or','be']);
    const relevant = (t) => {
      const strip = (s) => s.replace(/[！!？?。，,、：:（）()「」『』【】\s\-–—_]/g, '');
      if (isEnglishQuery) {
        const words = ql.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !EN_STOPWORDS.has(w));
        // 整句都是虛詞（例如只搜了 "the" 這種單字）→ 沒有可比對的依據，
        // 寧可查無結果讓客人改用貼網址，也不要放行明顯不相關的書
        if (!words.length) return false;
        const tl = t.toLowerCase();
        return words.filter(w => tl.includes(w)).length / words.length >= 0.6;
      }
      const clean = strip(t), qClean = strip(ql);
      if (!qClean) return true;
      return [...qClean].filter(ch => clean.includes(ch)).length / qClean.length >= 0.6;
    };

    // 中文查詢只收台版（擋簡體）；英文查詢放行原文版（英文原版 ISBN 是 978-0/978-1 開頭，
    // 硬套台灣 ISBN 規則會把英文繪本全部誤殺）
    const isbnOk = (v) => {
      if (!hasIdentifiers(v)) return true; // 沒 ISBN 資料的（圖書館目錄型紀錄）不誤殺
      if (isEnglishQuery) return true;
      return isTaiwanISBN(v);
    };

    const seen = new Set(), items = [];
    for (const v of data.items) {
      const info = v.volumeInfo || {};
      const ti = info.title;
      if (!ti || seen.has(ti)) continue;
      if (!isbnOk(v)) continue;
      if (!relevant(ti)) continue; // 書名跟查詢重疊太少，多半不相關
      seen.add(ti);
      items.push({
        title: ti,
        url: '',
        author: (info.authors || []).join('、'),
        publisher: info.publisher || '',
        year: (info.publishedDate || '').slice(0, 4)
      });
    }
    return { items, reason: items.length ? 'ok' : 'no-match', totalItems: data.totalItems };
  } catch (e) {
    return { items: [], reason: 'error:' + String(e).slice(0, 60) };
  }
}

async function searchBooks(q, res) {
  const g = await searchGoogleBooks(q);
  return res.status(200).json({
    v: 17, source: 'google',
    found: g.items.length > 0,
    items: g.items.slice(0, 6),
    googleReason: g.reason,
    googleDetail: g.detail || ''
  });
}

async function scrapeTitle(url, res) {
  try {
    const r = await fetchWithTimeout(url, 5000);
    const p = new URL(r.url).pathname;
    if (p === '/' || p === '') return res.status(200).json({ found: false, reason: 'blocked' });

    const html = await r.text();
    let title = '';
    const og = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
           || html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (og) title = og[1];
    if (!title) { const t = html.match(/<title>([^<]+)<\/title>/i); if (t) title = t[1]; }

    title = decode(title).replace(SITE_SUFFIX, '').trim();
    if (!title || title.length < 2 || GENERIC.includes(title)) {
      return res.status(200).json({ found: false, reason: 'no-title' });
    }
    return res.status(200).json({ found: true, title });
  } catch (e) {
    return res.status(200).json({ found: false, reason: 'error' });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url, q } = req.query;
  if (q) return searchBooks(q, res);
  if (url) return scrapeTitle(url, res);
  return res.status(400).json({ found: false });
}
