/**
 * MoonVault – Cloudflare Worker
 * Replaces the Python/Flask backend entirely.
 * Routes: GET /search  GET /tmdb  GET /tmdb-details  GET /details  GET /
 */

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.5',
  Referer: 'https://www.google.com/',
};

const BF_DOMAINS = [
  'https://new.bollyflix.gd',
  'https://bollyflix.show',
  'https://www.bollyflix.boats',
  'https://bollyflix.ind.in',
];

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p';

// ─── helpers ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html;charset=utf-8' },
  });
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function getWorkingDomain() {
  for (const domain of BF_DOMAINS) {
    try {
      const res = await fetch(domain + '/', {
        headers: HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return domain;
    } catch (_) { /* try next */ }
  }
  return BF_DOMAINS[0];
}

function qualityLabel(text) {
  const t = String(text).toLowerCase();
  if (t.includes('2160p') || t.includes('4k')) return '2160p 4K';
  if (t.includes('1080p')) return '1080p';
  if (t.includes('720p'))  return '720p';
  if (t.includes('480p'))  return '480p';
  return 'N/A';
}

// ─── Cloudflare Workers has no built-in DOM parser.
//     We use lightweight regex-based parsing instead of BeautifulSoup.

function extractArticles(htmlText) {
  const results = [];
  // Match <article ...>...</article> blocks
  const articleRe = /<article[\s\S]*?<\/article>/gi;
  let artMatch;
  while ((artMatch = articleRe.exec(htmlText)) !== null) {
    const art = artMatch[0];

    // Get first link from h2/h3 or .entry-title
    const linkRe = /<(?:h[23]|[^>]+class="[^"]*entry-title[^"]*")[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    const altLinkRe = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    let href = '', title = '';
    const lm = linkRe.exec(art) || altLinkRe.exec(art);
    if (lm) {
      href  = lm[1];
      title = lm[2].replace(/<[^>]+>/g, '').trim();
    }
    if (!href || !title) continue;

    // Image
    let img = '';
    const imgRe = /<img\s[^>]*>/i;
    const im = imgRe.exec(art);
    if (im) {
      const dSrc = /data-src="([^"]+)"/.exec(im[0]);
      const src  = /\bsrc="([^"]+)"/.exec(im[0]);
      img = (dSrc || src || ['', ''])[1];
    }

    // Meta / date
    let meta = '';
    const metaRe = /<(?:div|span|time)[^>]+class="[^"]*(?:entry-meta|post-meta)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|time)>/i;
    const mm = metaRe.exec(art);
    if (mm) meta = mm[1].replace(/<[^>]+>/g, '').trim();

    results.push({ title, href, img, meta, source: 'BollyFlix' });
  }
  return results;
}

function extractDownloads(htmlText) {
  const SKIP = ['how to', 'howto', 'tutorial', 'facebook', 'twitter',
    'instagram', 'telegram', 'whatsapp', 'youtube',
    'category/', '/tag/', '/page/', 'mailto:',
    'privacy', 'contact', 'about', 'dmca'];

  const DL_HOSTS = ['fastdlserver', 'gdflix', 'gofile', 'drive.google',
    'mega.nz', 'mediafire', 'pixeldrain', 'send.cm',
    'uploadhaven', 'filedot', 'buzzheavier', 'driveseed',
    'hubdrive', 'filepress', 'dropbox.com'];

  const QUAL_WORDS = ['480p','720p','1080p','2160p','4k','bluray','webrip','web-dl','hdrip'];

  const results = [];
  const seen    = new Set();

  // Track last heading text for quality detection (same as Render's find_previous logic)
  let lastHeadingText = '';

  // Scan headings AND links together in document order
  const combinedRe = /(<h[2-5][^>]*>([\s\S]*?)<\/h[2-5]>)|(<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>)/gi;
  let cm;
  while ((cm = combinedRe.exec(htmlText)) !== null) {
    if (cm[1]) {
      // It's a heading — save its text for next links
      lastHeadingText = cm[2].replace(/<[^>]+>/g, '').trim();
      continue;
    }

    // It's a link
    const href = cm[4].trim();
    const raw  = cm[5];
    const txt  = raw.replace(/<[^>]+>/g, '').trim();
    const combined = (href + txt).toLowerCase();

    if (!href || href.startsWith('javascript')) continue;
    if (SKIP.some(w => combined.includes(w))) continue;

    const isHost = DL_HOSTS.some(h => href.includes(h));
    const isTextDl = txt.toLowerCase().includes('download') &&
                     txt.length > 8 &&
                     QUAL_WORDS.some(q => txt.toLowerCase().includes(q));

    if (isHost || isTextDl) {
      if (seen.has(href)) continue;
      seen.add(href);

      // 3-step quality detection (mirrors Render's Python logic):
      // 1. From last heading before this link
      let quality = qualityLabel(lastHeadingText);
      // 2. From link text
      if (quality === 'N/A') quality = qualityLabel(txt);
      // 3. From URL itself
      if (quality === 'N/A') quality = qualityLabel(href);

      results.push({
        name:    txt || 'Download',
        url:     href,
        quality: quality,
        size:    'N/A',
      });
    }
  }
  return results;
}

function extractTitle(htmlText) {
  for (const re of [
    /<h1[^>]+class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]+class="[^"]*post-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  ]) {
    const m = re.exec(htmlText);
    if (m) return m[1].replace(/<[^>]+>/g, '').trim();
  }
  return '';
}

// ─── TMDB helpers ────────────────────────────────────────────────────────────

async function tmdbSearch(query, apiKey) {
  if (!apiKey || !query) return null;
  try {
    const url = `${TMDB_BASE}/search/movie?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(query)}&language=en-US`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const m    = (data.results || [])[0];
    if (!m) return null;
    return {
      id:       m.id,
      title:    m.title || '',
      overview: m.overview || '',
      poster:   m.poster_path ? `${TMDB_IMG}/w500${m.poster_path}` : '',
      year:     (m.release_date || '').split('-')[0],
      rating:   m.vote_average || 0,
      genres:   [],
    };
  } catch (_) { return null; }
}

async function tmdbDetails(mid, apiKey) {
  if (!apiKey || !mid) return null;
  try {
    const url = `${TMDB_BASE}/movie/${mid}?api_key=${encodeURIComponent(apiKey)}&append_to_response=credits`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const d = await res.json();
    return {
      overview: d.overview || '',
      rating:   d.vote_average || 0,
      genres:   (d.genres || []).map(g => g.name),
      cast:     ((d.credits || {}).cast || []).slice(0, 5).map(c => c.name),
    };
  } catch (_) { return null; }
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleSearch(searchParams, env) {
  const q = (searchParams.get('q') || '').trim();
  if (!q) return json([]);

  try {
    const base    = await getWorkingDomain();
    const pageUrl = `${base}/?s=${encodeURIComponent(q)}`;
    const pageHtml = await fetchText(pageUrl);
    const results  = extractArticles(pageHtml).slice(0, 30);
    return json(results);
  } catch (e) {
    console.error('[search error]', e);
    return json([]);
  }
}

async function handleTmdb(searchParams, env) {
  const q      = (searchParams.get('q') || '').trim();
  const apiKey = env.TMDB_API_KEY || '';
  if (!q || !apiKey) return json(null);
  return json(await tmdbSearch(q, apiKey));
}

async function handleTmdbDetails(searchParams, env) {
  const mid    = searchParams.get('id');
  const apiKey = env.TMDB_API_KEY || '';
  if (!mid || !apiKey) return json(null);
  return json(await tmdbDetails(parseInt(mid, 10), apiKey));
}

async function handleDetails(searchParams) {
  const url = (searchParams.get('url') || '').trim();
  if (!url) return json({ error: 'missing url' }, 400);

  try {
    const pageHtml = await fetchText(url);
    const title     = extractTitle(pageHtml);
    const downloads = extractDownloads(pageHtml);
    return json({ title, downloads });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MoonVault</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Syne+Mono&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:#05050a;--paper:#0a0a12;--lift:#12121e;--raise:#1a1a2a;
  --rim:rgba(255,255,255,0.07);--fire:#ff3c1f;--ember:#ff6a00;
  --gold:#ffd166;--text:#eeeef5;--dim:#5a5a72;--r:18px;
}
html{scroll-behavior:smooth}
body{font-family:'Inter',sans-serif;background:var(--ink);color:var(--text);min-height:100vh;overflow-x:hidden}
body::after{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.025) 2px,rgba(0,0,0,0.025) 4px);pointer-events:none;z-index:9999}
.ambient{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden}
.amb-a{position:absolute;width:900px;height:900px;background:radial-gradient(circle,rgba(255,60,31,0.07) 0%,transparent 65%);top:-300px;left:-300px;animation:driftA 18s ease-in-out infinite}
.amb-b{position:absolute;width:700px;height:700px;background:radial-gradient(circle,rgba(255,106,0,0.05) 0%,transparent 65%);bottom:-200px;right:-100px;animation:driftB 22s ease-in-out infinite}
.amb-c{position:absolute;width:500px;height:500px;background:radial-gradient(circle,rgba(200,216,255,0.035) 0%,transparent 65%);top:50%;left:50%;transform:translate(-50%,-50%);animation:driftC 30s ease-in-out infinite}
@keyframes driftA{0%,100%{transform:translate(0,0)}40%{transform:translate(120px,80px)}70%{transform:translate(-60px,120px)}}
@keyframes driftB{0%,100%{transform:translate(0,0)}50%{transform:translate(-100px,-80px)}}
@keyframes driftC{0%,100%{transform:translate(-50%,-50%) scale(1)}50%{transform:translate(-50%,-50%) scale(1.4)}}
.filmstrip{position:fixed;top:0;left:0;right:0;height:5px;z-index:100;background:repeating-linear-gradient(90deg,var(--fire) 0,var(--fire) 18px,transparent 18px,transparent 26px);animation:stripScroll 3s linear infinite}
@keyframes stripScroll{from{background-position:0 0}to{background-position:44px 0}}
header{position:sticky;top:5px;z-index:50;display:flex;align-items:center;justify-content:space-between;padding:1.1rem 3rem;background:rgba(5,5,10,0.78);backdrop-filter:blur(24px);border-bottom:1px solid var(--rim)}
.wordmark{font-family:'Syne',sans-serif;font-weight:800;font-size:1.5rem;letter-spacing:-0.5px;display:flex;align-items:center;gap:0.5rem}
.wicon{width:34px;height:34px;background:linear-gradient(135deg,var(--fire),var(--ember));border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1rem;box-shadow:0 0 24px rgba(255,60,31,0.5);animation:iconGlow 3s ease-in-out infinite}
@keyframes iconGlow{0%,100%{box-shadow:0 0 24px rgba(255,60,31,0.5)}50%{box-shadow:0 0 40px rgba(255,60,31,0.8),0 0 80px rgba(255,60,31,0.2)}}
.wtext{background:linear-gradient(100deg,#fff 40%,var(--ember));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.htag{font-family:'Syne Mono',monospace;font-size:0.65rem;color:var(--dim);letter-spacing:2px;text-transform:uppercase;border:1px solid var(--rim);padding:0.3rem 0.8rem;border-radius:99px}
.hero{position:relative;z-index:1;padding:7rem 3rem 4rem;text-align:center}
.hlabel{font-family:'Syne Mono',monospace;font-size:0.65rem;letter-spacing:4px;color:var(--fire);text-transform:uppercase;margin-bottom:1.5rem;opacity:0;animation:revealUp 0.8s 0.1s cubic-bezier(.16,1,.3,1) forwards}
.htitle{font-family:'Syne',sans-serif;font-weight:800;font-size:clamp(3.5rem,9vw,7.5rem);line-height:0.95;letter-spacing:-3px;margin-bottom:1.5rem;opacity:0;animation:revealUp 0.9s 0.2s cubic-bezier(.16,1,.3,1) forwards}
.htitle .fire-line{display:block;background:linear-gradient(100deg,var(--fire) 0%,var(--ember) 40%,var(--gold) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 0 40px rgba(255,60,31,0.4))}
.hsub{color:var(--dim);font-size:1rem;font-weight:300;opacity:0;animation:revealUp 0.8s 0.35s cubic-bezier(.16,1,.3,1) forwards}
@keyframes revealUp{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:translateY(0)}}
.search-zone{position:relative;z-index:1;max-width:680px;margin:3rem auto 0;padding:0 1.5rem;opacity:0;animation:revealUp 0.8s 0.5s cubic-bezier(.16,1,.3,1) forwards}
.search-shell{position:relative;background:var(--lift);border:1px solid var(--rim);border-radius:20px;display:flex;align-items:center;transition:border-color 0.3s,box-shadow 0.3s;overflow:hidden}
.search-shell:focus-within{border-color:rgba(255,60,31,0.5);box-shadow:0 0 0 3px rgba(255,60,31,0.1),0 20px 60px rgba(0,0,0,0.5)}
.sico{padding:0 1.2rem;font-size:1rem;color:var(--dim);flex-shrink:0}
#q{flex:1;padding:1.1rem 0.5rem;background:transparent;border:none;color:var(--text);font-family:'Inter',sans-serif;font-size:0.95rem}
#q::placeholder{color:var(--dim)}
#q:focus{outline:none}
.sbtn{margin:0.4rem;padding:0.75rem 1.8rem;background:linear-gradient(135deg,var(--fire),var(--ember));border:none;border-radius:14px;color:#fff;font-family:'Syne',sans-serif;font-weight:700;font-size:0.85rem;letter-spacing:0.5px;cursor:pointer;transition:transform 0.15s,box-shadow 0.3s}
.sbtn:hover{transform:scale(1.04);box-shadow:0 8px 30px rgba(255,60,31,0.5)}
.sbtn:active{transform:scale(0.97)}
.sbtn:disabled{opacity:0.35;cursor:not-allowed;transform:none}
main{position:relative;z-index:1;max-width:1260px;margin:0 auto;padding:2.5rem 2.5rem 5rem}
.loading{display:none;text-align:center;padding:5rem 0}
.film-loader{display:inline-flex;gap:5px;margin-bottom:1.2rem}
.film-loader span{width:6px;height:36px;background:var(--fire);border-radius:3px;animation:filmLoad 1s ease-in-out infinite}
.film-loader span:nth-child(2){animation-delay:0.1s;background:var(--ember)}
.film-loader span:nth-child(3){animation-delay:0.2s}
.film-loader span:nth-child(4){animation-delay:0.3s;background:var(--gold)}
.film-loader span:nth-child(5){animation-delay:0.4s;background:var(--ember)}
.film-loader span:nth-child(6){animation-delay:0.5s}
@keyframes filmLoad{0%,100%{transform:scaleY(0.4);opacity:0.3}50%{transform:scaleY(1.8);opacity:1}}
.loading p{color:var(--dim);font-family:'Syne Mono',monospace;font-size:0.75rem;letter-spacing:3px;text-transform:uppercase}
.rbar{display:none;align-items:center;justify-content:space-between;margin-bottom:1.8rem;padding-bottom:1rem;border-bottom:1px solid var(--rim)}
.rcount{font-family:'Syne',sans-serif;font-size:0.8rem;color:var(--dim);letter-spacing:1px;text-transform:uppercase}
.rcount strong{color:var(--ember)}
.rtag{font-family:'Syne Mono',monospace;font-size:0.65rem;color:var(--dim);letter-spacing:2px;text-transform:uppercase}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(188px,1fr));gap:1.4rem}
.card{background:var(--lift);border:1px solid var(--rim);border-radius:var(--r);overflow:hidden;cursor:pointer;position:relative;transition:transform 0.3s cubic-bezier(.16,1,.3,1),box-shadow 0.3s,border-color 0.3s;animation:cardReveal 0.6s cubic-bezier(.16,1,.3,1) backwards}
.card:hover{transform:translateY(-8px) scale(1.02);box-shadow:0 30px 70px rgba(0,0,0,0.6),0 0 0 1px rgba(255,60,31,0.25);border-color:rgba(255,60,31,0.25)}
@keyframes cardReveal{from{opacity:0;transform:translateY(40px) scale(0.94)}to{opacity:1;transform:translateY(0) scale(1)}}
.poster{height:260px;background:var(--raise);position:relative;overflow:hidden}
.poster img{width:100%;height:100%;object-fit:cover;transition:transform 0.5s cubic-bezier(.16,1,.3,1);display:block}
.card:hover .poster img{transform:scale(1.1)}
.poster-empty{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.5rem;font-size:2.8rem;background:linear-gradient(145deg,var(--raise),#1e1e30)}
.poster-empty small{font-size:0.65rem;color:var(--dim);font-family:'Syne Mono',monospace;letter-spacing:1px}
.poster::after{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(5,5,10,0.95) 0%,rgba(5,5,10,0.1) 50%,transparent 100%);opacity:0;transition:opacity 0.3s}
.card:hover .poster::after{opacity:1}
.playbtn{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.6);width:50px;height:50px;background:rgba(255,60,31,0.9);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.1rem;opacity:0;transition:all 0.3s cubic-bezier(.16,1,.3,1);box-shadow:0 0 30px rgba(255,60,31,0.6);z-index:2}
.card:hover .playbtn{opacity:1;transform:translate(-50%,-50%) scale(1)}
.qbadge{position:absolute;top:10px;right:10px;font-family:'Syne Mono',monospace;font-size:0.55rem;font-weight:700;letter-spacing:1px;padding:0.2rem 0.5rem;border-radius:6px;background:rgba(255,209,102,0.15);border:1px solid rgba(255,209,102,0.35);color:var(--gold);backdrop-filter:blur(10px);z-index:2}
.srcbadge{position:absolute;top:10px;left:10px;font-family:'Syne Mono',monospace;font-size:0.55rem;font-weight:700;letter-spacing:1px;padding:0.2rem 0.5rem;border-radius:6px;background:rgba(255,60,31,0.2);border:1px solid rgba(255,60,31,0.4);color:var(--fire);backdrop-filter:blur(10px);z-index:2}
.cbody{padding:0.9rem 1rem 1rem}
.ctitle{font-family:'Syne',sans-serif;font-weight:700;font-size:0.82rem;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:0.3rem}
.cmeta{font-size:0.68rem;color:var(--dim);font-family:'Syne Mono',monospace;letter-spacing:0.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{text-align:center;padding:5rem 0;color:var(--dim)}
.empty .ei{font-size:3.5rem;margin-bottom:1rem;opacity:0.3;display:block}
.empty p{font-family:'Syne Mono',monospace;font-size:0.75rem;letter-spacing:2px;text-transform:uppercase}
.modal{display:none;position:fixed;inset:0;z-index:200;align-items:flex-end;justify-content:center;padding:0}
@media(min-width:640px){.modal{align-items:center;padding:1.5rem}}
.modal.open{display:flex;animation:bgFadeIn 0.35s forwards}
@keyframes bgFadeIn{from{background:rgba(0,0,0,0)}to{background:rgba(0,0,0,0.88)}}
.mpanel{background:var(--paper);border:1px solid rgba(255,255,255,0.08);border-radius:24px 24px 0 0;width:100%;max-width:640px;max-height:92vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--raise) transparent;animation:panelUp 0.4s cubic-bezier(.16,1,.3,1) forwards;position:relative}
@media(min-width:640px){.mpanel{border-radius:24px;animation:panelIn 0.4s cubic-bezier(.16,1,.3,1) forwards}}
@keyframes panelUp{from{transform:translateY(120px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes panelIn{from{transform:scale(0.88) translateY(30px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}
.mpanel::before{content:'';display:block;height:3px;background:linear-gradient(90deg,var(--fire),var(--ember),var(--gold));border-radius:24px 24px 0 0}
.mhandle{width:36px;height:4px;background:var(--rim);border-radius:2px;margin:1rem auto 0}
@media(min-width:640px){.mhandle{display:none}}
.mbody{padding:1.5rem 1.8rem 2rem}
.mhero{display:flex;gap:1.2rem;margin-bottom:1.2rem}
.mthumb{width:100px;height:145px;flex-shrink:0;border-radius:12px;overflow:hidden;background:var(--raise);box-shadow:0 10px 30px rgba(0,0,0,0.5)}
.mthumb img{width:100%;height:100%;object-fit:cover}
.mthumb-empty{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2rem;background:linear-gradient(145deg,var(--raise),#1e1e30)}
.minfo{flex:1}
.msrc{display:inline-block;font-family:'Syne Mono',monospace;font-size:0.6rem;letter-spacing:1.5px;text-transform:uppercase;padding:0.2rem 0.6rem;border-radius:6px;margin-bottom:0.6rem;background:rgba(255,60,31,0.15);border:1px solid rgba(255,60,31,0.3);color:var(--fire)}
.mtitle{font-family:'Syne',sans-serif;font-weight:800;font-size:1.5rem;line-height:1.05;letter-spacing:-0.5px;margin-bottom:0.25rem}
.myear{font-size:0.8rem;color:var(--dim);margin-bottom:0.6rem}
.rrow{display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.5rem}
.stars{font-family:'Syne',sans-serif;font-weight:700;font-size:0.85rem;padding:0.2rem 0.6rem;border-radius:8px;background:rgba(255,209,102,0.1);border:1px solid rgba(255,209,102,0.25);color:var(--gold)}
.gpill{font-size:0.65rem;padding:0.2rem 0.6rem;background:rgba(255,255,255,0.04);border:1px solid var(--rim);border-radius:6px;color:#aaa}
.tmdb-btn{display:inline-flex;align-items:center;gap:0.3rem;font-size:0.7rem;color:var(--gold);text-decoration:none;background:rgba(255,209,102,0.07);border:1px solid rgba(255,209,102,0.18);padding:0.2rem 0.6rem;border-radius:6px;transition:background 0.2s;font-family:'Syne Mono',monospace}
.tmdb-btn:hover{background:rgba(255,209,102,0.15)}
.moverview{color:var(--dim);font-size:0.82rem;line-height:1.7;margin:0.8rem 0;padding:0.8rem 1rem;background:rgba(255,255,255,0.02);border-left:2px solid var(--fire);border-radius:0 10px 10px 0}
.mcast{font-size:0.75rem;color:#777;margin-bottom:1rem;padding:0.5rem 0;border-bottom:1px solid var(--rim);font-family:'Syne Mono',monospace}
.sec-hdr{display:flex;align-items:center;gap:0.6rem;margin:1.2rem 0 0.8rem}
.sec-line{flex:1;height:1px;background:var(--rim)}
.sec-hdr span{font-family:'Syne',sans-serif;font-weight:700;font-size:0.65rem;letter-spacing:2.5px;text-transform:uppercase;color:var(--dim)}
.dls-list{display:flex;flex-direction:column;gap:0.5rem}
.dl-row{display:flex;align-items:center;gap:0.7rem;padding:0.75rem 0.9rem;background:var(--lift);border:1px solid var(--rim);border-radius:12px;transition:border-color 0.2s,background 0.2s,transform 0.15s}
.dl-row:hover{border-color:rgba(255,60,31,0.3);background:rgba(255,60,31,0.05);transform:translateX(3px)}
.dl-row a{flex:1;color:var(--text);text-decoration:none;font-size:0.8rem;line-height:1.4;word-break:break-word}
.dl-ico{width:30px;height:30px;flex-shrink:0;background:rgba(255,60,31,0.12);border:1px solid rgba(255,60,31,0.2);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:0.75rem;transition:background 0.2s,transform 0.2s}
.dl-row:hover .dl-ico{background:rgba(255,60,31,0.25);transform:scale(1.1)}
.dl-qual{font-family:'Syne Mono',monospace;font-size:0.62rem;padding:0.18rem 0.5rem;border-radius:6px;background:rgba(255,255,255,0.04);border:1px solid var(--rim);color:#888;white-space:nowrap;flex-shrink:0}
.mclose{width:100%;margin-top:1.5rem;padding:0.85rem;background:var(--lift);border:1px solid var(--rim);border-radius:14px;color:var(--dim);font-family:'Syne',sans-serif;font-weight:600;font-size:0.85rem;letter-spacing:1px;cursor:pointer;text-transform:uppercase;transition:all 0.2s}
.mclose:hover{background:rgba(255,60,31,0.08);border-color:rgba(255,60,31,0.25);color:var(--text)}
.dl-loading{text-align:center;padding:2rem 0;font-family:'Syne Mono',monospace;font-size:0.7rem;letter-spacing:2px;text-transform:uppercase;color:var(--dim)}
.dl-loading::before{content:'';display:block;width:24px;height:24px;border:2px solid var(--rim);border-top-color:var(--fire);border-radius:50%;margin:0 auto 0.8rem;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:640px){
  header{padding:0.9rem 1.2rem}
  .hero{padding:4rem 1.2rem 2.5rem}
  main{padding:1.5rem 1rem 4rem}
  .grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:0.9rem}
  .mhero{flex-direction:column}
  .mthumb{width:100%;height:200px}
  .mbody{padding:1.2rem 1.2rem 1.5rem}
}
</style>
</head>
<body>

<div class="ambient">
  <div class="amb-a"></div>
  <div class="amb-b"></div>
  <div class="amb-c"></div>
</div>

<div class="filmstrip"></div>

<header>
  <div class="wordmark">
    <div class="wicon">🎬</div>
    <span class="wtext">MoonVault</span>
  </div>
  <div class="htag">HD · 4K · Fast</div>
</header>

<div class="hero">
  <div class="hlabel">✦ Your Personal Cinema ✦</div>
  <h1 class="htitle">
    EVERY FILM.<br>
    <span class="fire-line">ONE VAULT.</span>
  </h1>
  <p class="hsub">Search, discover and download movies instantly.</p>
</div>

<div class="search-zone">
  <div class="search-shell">
    <span class="sico">🔍</span>
    <input type="text" id="q" placeholder="Search any movie…" autocomplete="off" onkeydown="if(event.key==='Enter')doSearch()">
    <button class="sbtn" id="btn" onclick="doSearch()">Search</button>
  </div>
</div>

<main>
  <div class="loading" id="loading">
    <div class="film-loader">
      <span></span><span></span><span></span><span></span><span></span><span></span>
    </div>
    <p>Scanning the vault…</p>
  </div>

  <div class="rbar" id="rbar">
    <div class="rcount" id="rcount"></div>
    <div class="rtag">BollyFlix</div>
  </div>

  <div class="grid" id="grid"></div>
  <div class="empty" id="empty"></div>
</main>

<div class="modal" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="mpanel">
    <div class="mhandle"></div>
    <div class="mbody">
      <div class="mhero">
        <div class="mthumb" id="mthumb"><div class="mthumb-empty">🎬</div></div>
        <div class="minfo">
          <div class="msrc" id="msrc">BollyFlix</div>
          <div class="mtitle" id="mtitle">—</div>
          <div class="myear" id="myear"></div>
          <div class="rrow" id="mratings"></div>
          <a id="mtmdb" class="tmdb-btn" target="_blank" style="display:none">⭐ TMDB</a>
        </div>
      </div>
      <div id="moverview"></div>
      <div id="mcast"></div>
      <div id="dl-section" style="display:none">
        <div class="sec-hdr">
          <div class="sec-line"></div>
          <span>📥 Downloads</span>
          <div class="sec-line"></div>
        </div>
        <div class="dls-list" id="mdls"></div>
      </div>
      <div id="dl-loading" class="dl-loading" style="display:none">Loading links…</div>
      <button class="mclose" onclick="closeModal()">✕ &nbsp; Close</button>
    </div>
  </div>
</div>

<script>
let curResults = [];

async function doSearch() {
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  const btn = document.getElementById('btn');
  btn.disabled = true;
  document.getElementById('loading').style.display = 'block';
  document.getElementById('grid').innerHTML = '';
  document.getElementById('empty').innerHTML = '';
  document.getElementById('rbar').style.display = 'none';
  curResults = [];

  try {
    const r = await fetch('/search?q=' + encodeURIComponent(q) + '&type=movie');
    const data = await r.json();

    const enriched = await Promise.all(data.map(async item => {
      try {
        const tr = await fetch('/tmdb?q=' + encodeURIComponent(item.title));
        item.tmdb = await tr.json();
      } catch(e) { item.tmdb = null; }
      return item;
    }));

    curResults = enriched;
    render(enriched);
  } catch(e) {
    document.getElementById('empty').innerHTML =
      '<span class="ei">⚠️</span><p>Network error — try again</p>';
  } finally {
    btn.disabled = false;
    document.getElementById('loading').style.display = 'none';
  }
}

function render(data) {
  const grid  = document.getElementById('grid');
  const empty = document.getElementById('empty');
  grid.innerHTML = ''; empty.innerHTML = '';

  if (!data.length) {
    empty.innerHTML = '<span class="ei">🎬</span><p>No results — try another title</p>';
    return;
  }

  document.getElementById('rbar').style.display = 'flex';
  document.getElementById('rcount').innerHTML =
    'Found <strong>' + data.length + '</strong> result' + (data.length !== 1 ? 's' : '');

  data.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.animationDelay = (i * 0.04) + 's';
    card.onclick = () => openModal(i);

    const poster = (item.tmdb && item.tmdb.poster) ? item.tmdb.poster : (item.img || '');
    const rating = (item.tmdb && item.tmdb.rating) ? item.tmdb.rating.toFixed(1) : '';
    const year   = (item.tmdb && item.tmdb.year)   ? item.tmdb.year : '';

    card.innerHTML =
      '<div class="poster">' +
        (poster
          ? '<img src="' + poster + '" loading="lazy" onerror="this.parentNode.innerHTML=\\'<div class=poster-empty>🎬<small>No Image</small></div>\\'">'
          : '<div class="poster-empty">🎬<small>No Image</small></div>') +
        '<div class="playbtn">▶</div>' +
        '<span class="srcbadge">BF</span>' +
        (rating ? '<span class="qbadge">★ ' + rating + '</span>' : '') +
      '</div>' +
      '<div class="cbody">' +
        '<div class="ctitle">' + item.title + '</div>' +
        '<div class="cmeta">' + (year || '—') + (item.meta ? ' · ' + item.meta.substring(0,22) : '') + '</div>' +
      '</div>';

    grid.appendChild(card);
  });
}

async function openModal(i) {
  const item = curResults[i];

  // Reset
  document.getElementById('msrc').textContent = item.source || 'BollyFlix';
  document.getElementById('mtitle').textContent = item.title;
  document.getElementById('myear').textContent = (item.tmdb && item.tmdb.year) ? item.tmdb.year : '';
  document.getElementById('mratings').innerHTML = '';
  document.getElementById('moverview').innerHTML = '';
  document.getElementById('mcast').innerHTML = '';
  document.getElementById('mdls').innerHTML = '';
  document.getElementById('dl-section').style.display = 'none';
  document.getElementById('dl-loading').style.display = 'block';

  // Poster
  const thumbEl  = document.getElementById('mthumb');
  const posterSrc = (item.tmdb && item.tmdb.poster) ? item.tmdb.poster : (item.img || '');
  thumbEl.innerHTML = posterSrc
    ? '<img src="' + posterSrc + '" onerror="this.parentNode.innerHTML=\\'<div class=mthumb-empty>🎬</div>\\'">'
    : '<div class="mthumb-empty">🎬</div>';

  // TMDB link
  const tmdbLink = document.getElementById('mtmdb');
  if (item.tmdb && item.tmdb.id) {
    tmdbLink.href = 'https://www.themoviedb.org/movie/' + item.tmdb.id;
    tmdbLink.style.display = 'inline-flex';
  } else {
    tmdbLink.style.display = 'none';
  }

  // Ratings + genres
  const ratRow = document.getElementById('mratings');
  if (item.tmdb && item.tmdb.rating) {
    ratRow.innerHTML = '<span class="stars">★ ' + item.tmdb.rating.toFixed(1) + '</span>';
  }
  if (item.tmdb && item.tmdb.genres && item.tmdb.genres.length) {
    item.tmdb.genres.slice(0,3).forEach(function(g) {
      ratRow.innerHTML += '<span class="gpill">' + g + '</span>';
    });
  }

  // Overview
  if (item.tmdb && item.tmdb.overview) {
    document.getElementById('moverview').innerHTML =
      '<div class="moverview">' + item.tmdb.overview + '</div>';
  }

  document.getElementById('modal').classList.add('open');

  // Fetch download links
  try {
    const r = await fetch('/details?source=' + encodeURIComponent(item.source) + '&url=' + encodeURIComponent(item.href));
    const data = await r.json();

    if (data.title) document.getElementById('mtitle').textContent = data.title;

    // Fetch cast from tmdb-details
    if (item.tmdb && item.tmdb.id) {
      try {
        const dr = await fetch('/tmdb-details?id=' + item.tmdb.id);
        const dd = await dr.json();
        if (dd && dd.cast && dd.cast.length) {
          document.getElementById('mcast').innerHTML =
            '<div class="mcast">🎭 ' + dd.cast.join(' · ') + '</div>';
        }
      } catch(e) {}
    }

    document.getElementById('dl-loading').style.display = 'none';
    const dlsEl = document.getElementById('mdls');
    const dlSec = document.getElementById('dl-section');
    dlSec.style.display = 'block';

    if (!data.downloads || !data.downloads.length) {
      dlsEl.innerHTML = '<div class="empty"><span class="ei" style="font-size:2rem">📭</span><p>No links found</p></div>';
    } else {
      data.downloads.forEach(function(d) {
        const row = document.createElement('div');
        row.className = 'dl-row';
        row.innerHTML =
          '<div class="dl-ico">⬇</div>' +
          '<a href="' + d.url + '" target="_blank" rel="noopener">' + (d.name || 'Download') + '</a>' +
          '<span class="dl-qual">' + (d.quality || 'N/A') + (d.size && d.size !== 'N/A' ? ' · ' + d.size : '') + '</span>';
        dlsEl.appendChild(row);
      });
    }
  } catch(e) {
    document.getElementById('dl-loading').style.display = 'none';
    document.getElementById('dl-section').style.display = 'block';
    document.getElementById('mdls').innerHTML =
      '<div class="empty"><p>⚠️ Could not load links</p></div>';
  }
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal();
});
</script>
</body>
</html>`;

async function handleIndex(env) {
  return html(INDEX_HTML);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const { pathname, searchParams } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
      });
    }

    if (pathname === '/search')       return handleSearch(searchParams, env);
    if (pathname === '/tmdb')         return handleTmdb(searchParams, env);
    if (pathname === '/tmdb-details') return handleTmdbDetails(searchParams, env);
    if (pathname === '/details')      return handleDetails(searchParams);
    if (pathname === '/' || pathname === '/index.html') return handleIndex(env);

    return new Response('Not Found', { status: 404 });
  },
};
