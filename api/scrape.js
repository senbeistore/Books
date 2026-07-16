export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: '缺少網址' });
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SenbeiBot/1.0)' }
    });
    const html = await r.text();

    let title = '', author = '', publisher = '';

    const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of ld) {
      try {
        const data = JSON.parse(m[1]);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item.name) title = title || item.name;
          if (item.author) author = author || (item.author.name || item.author);
          if (item.publisher) publisher = publisher || (item.publisher.name || item.publisher);
        }
      } catch(e){}
    }

    if (!title) {
      const og = html.match(/property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
      const t = html.match(/<title>([^<]+)<\/title>/i);
      title = (og && og[1]) || (t && t[1]) || '';
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ title: title.trim(), author: (author||'').trim(), publisher: (publisher||'').trim() });
  } catch (e) {
    res.status(500).json({ error: '抓取失敗' });
  }
}
