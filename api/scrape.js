const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-TW,zh;q=0.9' };
const SITE_SUFFIX = /\s*[|｜\-－–—]\s*(誠品線上|誠品|金石堂[^]*|三民網路書店|三民)\s*$/i;
const GENERIC = ['誠品線上','誠品','金石堂','金石堂網路書店','三民網路書店','親子館','中文書','童書'];
// 快速初篩：標題含這些字的，多半是文具/生活雜貨周邊，先擋掉大宗，減少後面要驗證分類的數量
const MERCH_WORDS = ['杯','水壺','水瓶','餐具','餐盤','餐碗','筷','湯匙','背包','書包','鉛筆盒','筆袋','文具組',
  '貼紙','磁鐵','鑰匙圈','吊飾','玩偶','娃娃','公仔','積木','拼圖','骨牌','撲克牌','桌遊','夜燈',
  '雨傘','帽','襪','手錶','行李箱','野餐墊','便當','收納','保溫瓶','安撫巾','口水巾','圍兜','睡袋','抱枕',
  '悠遊卡','月曆','桌曆','行事曆','年曆','提袋','托特包','束口袋','護照套','零錢包','徽章','馬克杯'];
function isMerch(t){ return MERCH_WORDS.some(w=>t.includes(w)); }

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

// 打開單一商品頁，確認金石堂自己標的「類別」是不是童書／繪本／親子教育類
// 這比用標題猜關鍵字準確，因為是直接讀金石堂自己的分類欄位
async function isBookCategory(url) {
  try {
    const r = await fetchWithTimeout(url, 3500);
    const html = await r.text();
    const og = html.match(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
           || html.match(/content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
    const desc = og ? decode(og[1]) : '';
    const m = desc.match(/類別[:：]\s*([^|]+)/);
    if (!m) return true; // 抓不到分類欄位時不誤殺，讓標題過濾繼續把關
    // 金石堂分類格式是「大類 ＞ 中類 ＞ 小類」，只看第一層最準，避免「親子」這種
    // 玩具跟童書都會用到的字造成誤判（金石堂玩具分類本身就叫「玩具親子」）
    const topCat = m[1].split(/＞|>/)[0].trim();
    const MERCH_TOP = ['玩具親子','文具','日用食品','居家休閒','3C電玩','家電','影音','售票','美妝保養','服飾配件'];
    if (MERCH_TOP.some(c => topCat.includes(c))) return false;
    return true; // 不在明確的周邊分類黑名單裡，就保留，避免誤殺
  } catch (e) {
    return true; // 驗證失敗（逾時等）不誤殺，僅靠標題過濾
  }
}

async function searchBooks(q, res) {
  try {
    const u = 'https://www.kingstone.com.tw/search/key/' + encodeURIComponent(q);
    const r = await fetchWithTimeout(u, 6000);
    const html = await r.text();

    const seen = new Set(), raw = [];
    const re = /href="[^"]*\/basic\/(\d+)\/\?lid=search[^"]*"[^>]*>([^<]{2,150}?)</gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      let t = decode(m[2]);
      if (!t || t.length < 2 || seen.has(id)) continue;
      if (!/^20/.test(id)) continue;
      if (isMerch(t)) continue;
      if (/^【電子書】/.test(t)) continue;
      if (/^(買整套|試閱|下次再買|加入購物車|貨到通知)$/.test(t)) continue;
      seen.add(id);
      raw.push({ title: t, url: 'https://www.kingstone.com.tw/basic/' + id + '/' });
    }

    // 依書名相關度排序（完全符合 > 開頭符合 > 包含），同級書名短的優先
    const ql = q.trim().toLowerCase();
    const score = (t) => {
      const tl = t.toLowerCase();
      if (tl === ql) return 0;
      if (tl.startsWith(ql)) return 1;
      if (tl.includes(ql)) return 2;
      return 3;
    };
    raw.sort((a, b) => {
      const d = score(a.title) - score(b.title);
      return d !== 0 ? d : a.title.length - b.title.length;
    });

    // 取排序後前面較相關的候選，逐一驗證金石堂自己標的分類（平行請求，避免逾時）
    const candidates = raw.slice(0, 10);
    const checks = await Promise.all(candidates.map(x => isBookCategory(x.url)));
    const items = candidates.filter((_, i) => checks[i]).slice(0, 6);

    return res.status(200).json({ v: 6, found: items.length > 0, items });
  } catch (e) {
    return res.status(200).json({ v: 6, found: false, items: [] });
  }
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

// 診斷用：直接測 Google Books API 在真實伺服器環境能不能用、台灣童書涵蓋率如何
// 用法：/api/scrape?gb=書名
async function testGoogleBooks(q, res) {
  try {
    const u = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent('intitle:' + q) + '&country=TW&maxResults=10';
    const r = await fetchWithTimeout(u, 6000);
    const status = r.status;
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch(e) {}
    if (!data || !data.items) {
      return res.status(200).json({ gb: true, httpStatus: status, totalItems: (data && data.totalItems) || 0, items: [], raw: text.slice(0, 300) });
    }
    const items = data.items.map(v => ({
      title: v.volumeInfo && v.volumeInfo.title,
      authors: v.volumeInfo && v.volumeInfo.authors,
      publisher: v.volumeInfo && v.volumeInfo.publisher,
      lang: v.volumeInfo && v.volumeInfo.language
    }));
    return res.status(200).json({ gb: true, httpStatus: status, totalItems: data.totalItems, items });
  } catch (e) {
    return res.status(200).json({ gb: true, error: String(e) });
  }
}

// 診斷用：不透過 API、直接爬 Google 圖書網站搜尋頁（跟爬金石堂搜尋頁同個思路）
// 用法：/api/scrape?gbweb=書名 → 回傳抓到的候選數量與前幾筆，方便判斷網頁結構
async function testGoogleBooksWeb(q, res) {
  try {
    const u = 'https://books.google.com/books?q=' + encodeURIComponent(q) + '&hl=zh-TW&country=TW';
    const r = await fetchWithTimeout(u, 6000);
    const html = await r.text();

    // 嘗試幾種常見的 Google 圖書搜尋結果連結格式，看哪種抓得到東西
    const patterns = {
      bookIdLinks: [...html.matchAll(/href="[^"]*\/books\?id=([a-zA-Z0-9_-]+)[^"]*"/g)].length,
      titleTags: [...html.matchAll(/<h3[^>]*>([^<]{2,100})<\/h3>/g)].map(m=>m[1]).slice(0,5),
      hasReactRoot: /__NEXT_DATA__|data-react|window\.__INITIAL/.test(html),
      htmlLength: html.length,
      snippet: html.replace(/\s+/g,' ').slice(0, 500)
    };
    return res.status(200).json({ gbweb: true, url: u, patterns });
  } catch (e) {
    return res.status(200).json({ gbweb: true, error: String(e) });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url, q, gb, gbweb } = req.query;
  if (gbweb) return testGoogleBooksWeb(gbweb, res);
  if (gb) return testGoogleBooks(gb, res);
  if (q) return searchBooks(q, res);
  if (url) return scrapeTitle(url, res);
  return res.status(400).json({ found: false });
}
