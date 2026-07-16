const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-TW,zh;q=0.9' };
const SITE_SUFFIX = /\s*[|｜\-－–—]\s*(誠品線上|誠品|金石堂[^]*|三民網路書店|三民)\s*$/i;
const GENERIC = ['誠品線上','誠品','金石堂','金石堂網路書店','三民網路書店','親子館','中文書','童書'];

function decode(s) {
  return s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#0?39;/g,"'")
          .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
          .replace(/&hellip;/g,'…').replace(/\s+/g,' ').trim();
}

// 用書名去金石堂搜尋，回傳候選書單
async function searchBooks(q, res) {
  try {
    const u = 'https://www.kingstone.com.tw/search/key/' + encodeURIComponent(q);
    const r = await fetch(u, { redirect: 'follow', headers: HEADERS });
    const html = await r.text();

    const seen = new Set(), items = [];
    // 抓所有商品連結 /basic/數字/ 及其連結文字
    const re = /href="(https?:\/\/www\.kingstone\.com\.tw)?\/basic\/(\d+)\/[^"]*"[^>]*>([^<]{2,150}?)</gi;
    let m;
    while ((m = re.exec(html)) !== null && items.length < 6) {
      const id = m[2];
      let t = decode(m[3]);
      if (!t || t.length < 2 || seen.has(id)) continue;
      if (/^【電子書】/.test(t)) continue;        // 排掉電子書
      if (/^(買整套|試閱|下次再買|加入購物車|貨到通知)$/.test(t)) continue; // 排掉按鈕文字
      seen.add(id);
      items.push({ title: t, url: 'https://www.kingstone.com.tw/basic/' + id + '/' });
    }
    return res.status(200).json({ found: items.length > 0, items });
  } catch (e) {
    return res.status(200).json({ found: false, items: [] });
  }
}

// 用網址抓單一商品頁書名
async function scrapeTitle(url, res) {
  try {
    const r = await fetch(url, { redirect: 'follow', headers: HEADERS });
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
