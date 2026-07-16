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
  // 恢復 intitle: 前綴：確保只搜書名符合的書，避免撈到內文提到相同字詞的不相關書籍
  // （503 問題已靠下面的自動重試解決，不是 intitle: 造成的）
  const u = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent('intitle:' + q)
    + '&country=TW&maxResults=20&key=' + GOOGLE_BOOKS_KEY;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
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
  try {
    let r = await callGoogleBooksOnce(q);
    if (r.status === 503) {
      // Google 圖書後端偶爾短暫不穩，稍等後重試一次再放棄
      await new Promise(res => setTimeout(res, 800));
      r = await callGoogleBooksOnce(q);
    }
    if (!r.ok) {
      const body = await r.text();
      return { items: [], reason: 'http-' + r.status, detail: body.slice(0, 200) };
    }
    const data = await r.json();
    if (!data.items) return { items: [], reason: 'no-items', totalItems: data.totalItems || 0 };

    // 優先用台灣 ISBN 篩選（978957／978986 開頭）；但很多圖書館目錄型紀錄（標示「無預覽」）
    // 根本沒填 ISBN，硬性要求會把這些正常書一起濾掉。改成：有 ISBN 資料就用它判斷，
    // 沒有 ISBN 資料的則退而求其次，只憑書名含中文字保留（反正 Google 圖書天生不會混進玩具）
    const hasChinese = (t) => /[\u4e00-\u9fff]/.test(t || '');
    const hasIdentifiers = (v) => ((v.volumeInfo && v.volumeInfo.industryIdentifiers) || []).length > 0;
    // intitle: 有時還是會混進相關度低的書，用查詢字詞跟書名的重疊比例再把關一次
    const ql = q.trim();
    const relevant = (t) => {
      const clean = t.replace(/[！!？?。，,、：:（）()「」『』【】\s]/g, '');
      const qClean = ql.replace(/[！!？?。，,、：:（）()「」『』【】\s]/g, '');
      if (!qClean) return true;
      const overlap = [...qClean].filter(ch => clean.includes(ch)).length;
      return overlap / qClean.length >= 0.6; // 查詢字詞至少 6 成要出現在書名裡
    };

    const seen = new Set(), items = [];
    for (const v of data.items) {
      const ti = v.volumeInfo && v.volumeInfo.title;
      if (!ti || seen.has(ti)) continue;
      if (hasIdentifiers(v) && !isTaiwanISBN(v)) continue; // 有 ISBN 但不是台版，排除
      if (!hasChinese(ti)) continue; // 沒有中文字的（純日文/英文書名）不收
      if (!relevant(ti)) continue; // 書名跟查詢字詞重疊太少，多半是不相關的書
      seen.add(ti);
      items.push({ title: ti, url: '' });
    }
    return { items, reason: items.length ? 'ok' : 'no-match', totalItems: data.totalItems };
  } catch (e) {
    return { items: [], reason: 'error:' + String(e).slice(0, 60) };
  }
}

async function searchBooks(q, res) {
  const g = await searchGoogleBooks(q);
  return res.status(200).json({
    v: 13, source: 'google',
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
