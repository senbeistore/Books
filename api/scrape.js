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

async function searchGoogleBooks(q) {
  if (!GOOGLE_BOOKS_KEY) return { items: [], reason: 'no-key' };
  try {
    const u = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent('intitle:' + q)
      + '&langRestrict=zh&country=TW&maxResults=20&key=' + GOOGLE_BOOKS_KEY;
    // 金鑰限制了只接受這個網站的請求，伺服器對伺服器呼叫不會自動帶 Referer，要手動補上
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(u, {
      headers: { Referer: 'https://books-senbei.vercel.app/' },
      signal: ctrl.signal
    }).finally(() => clearTimeout(t));
    if (!r.ok) {
      const body = await r.text();
      return { items: [], reason: 'http-' + r.status, detail: body.slice(0, 200) };
    }
    const data = await r.json();
    if (!data.items) return { items: [], reason: 'no-items', totalItems: data.totalItems || 0 };

    const seen = new Set(), items = [];
    for (const v of data.items.filter(isTaiwanISBN)) {
      const ti = v.volumeInfo && v.volumeInfo.title;
      if (!ti || seen.has(ti)) continue;
      seen.add(ti);
      items.push({ title: ti, url: '' });
    }
    return { items, reason: items.length ? 'ok' : 'no-tw-isbn', totalItems: data.totalItems };
  } catch (e) {
    return { items: [], reason: 'error:' + String(e).slice(0, 60) };
  }
}

async function searchBooks(q, res) {
  const g = await searchGoogleBooks(q);
  return res.status(200).json({
    v: 10, source: 'google',
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
