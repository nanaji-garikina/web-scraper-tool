const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MAX_ITEMS = 60; // cap list sizes so huge pages don't blow up the response
const FETCH_TIMEOUT_MS = 12000;

function normalizeUrl(input) {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url;
}

function absolutize(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).href;
  } catch {
    return maybeRelative;
  }
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
// Broad phone-shaped sequence: optional +, digits mixed with spaces/dashes/
// dots/parens. Filtered further in findPhone() to cut down false positives
// (dates, order numbers, etc).
const PHONE_RE = /\+?\d[\d\-.\s()]{6,16}\d/;

function looksLikeDate(candidate) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(candidate.trim()) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(candidate.trim())
  );
}

function findPhone(text) {
  const match = text.match(PHONE_RE);
  if (!match) return null;
  const candidate = match[0].trim();
  const digitCount = (candidate.match(/\d/g) || []).length;
  const hasSeparator = /[\-.\s()]/.test(candidate) || candidate.startsWith('+');
  if (digitCount < 7 || digitCount > 15) return null;
  if (!hasSeparator) return null; // bare digit runs are more likely IDs/order numbers
  if (looksLikeDate(candidate)) return null;
  return candidate;
}

// Best-effort extraction of person/profile-like records (name, bio, LinkedIn,
// email, phone) so pages such as team directories or advisor listings can be
// exported in a contacts-style CSV. Fields we can't reliably infer from a
// generic page (organisation, designation, years, city, state, country, any
// scoring fields) are intentionally left blank rather than guessed.
function extractContacts($, finalUrl) {
  const containers = new Set();

  $('a[href*="linkedin.com/in/"]').each((_, el) => {
    let node = el.parent;
    let chosen = null;
    // Climb at most 5 levels looking for a card-sized ancestor. Stop as soon
    // as we hit one that already contains an email or phone, since that's
    // almost certainly the single-person container; otherwise settle for
    // whatever we reached after 5 levels rather than climbing indefinitely
    // (climbing too far risks landing on a shared ancestor that wraps
    // several people, merging them into one record).
    for (let i = 0; i < 5 && node && node.type === 'tag'; i++) {
      const text = $(node).text().trim();
      if (text.length > 15) {
        chosen = node;
        if (EMAIL_RE.test(text) || PHONE_RE.test(text)) break;
      }
      node = node.parent;
    }
    if (chosen) containers.add(chosen);
  });

  const records = [];

  containers.forEach((container) => {
    const $c = $(container);
    const text = $c.text().replace(/\s+/g, ' ').trim();

    const linkedinHref = $c.find('a[href*="linkedin.com/in/"]').first().attr('href') || '';
    const emailMatch = text.match(EMAIL_RE);
    const phone = findPhone(text);

    let name = $c.find('h1, h2, h3, h4, strong, b').first().text().replace(/\s+/g, ' ').trim();
    if (!name) name = text.split(' ').slice(0, 5).join(' ');

    let bio = '';
    let longest = 0;
    $c.find('p').each((_, p) => {
      const t = $(p).text().replace(/\s+/g, ' ').trim();
      if (t.length > longest) {
        longest = t.length;
        bio = t;
      }
    });
    if (!bio) bio = text.slice(0, 300);

    records.push({
      name: name.slice(0, 120),
      bio: bio.slice(0, 400),
      linkedin: linkedinHref ? absolutize(finalUrl, linkedinHref) : '',
      email: emailMatch ? emailMatch[0] : '',
      phone: phone || ''
    });
  });

  // Fallback: no LinkedIn-anchored cards found at all, page is likely a single
  // contact/about page rather than a directory. Grab one record from whatever
  // email/phone appears on the page, if any.
  if (records.length === 0) {
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const emailMatch = bodyText.match(EMAIL_RE);
    const phone = findPhone(bodyText);
    if (emailMatch || phone) {
      records.push({
        name: $('title').first().text().trim().slice(0, 120),
        bio: '',
        linkedin: '',
        email: emailMatch ? emailMatch[0] : '',
        phone: phone || ''
      });
    }
  }

  // Dedupe by the strongest identifying field available.
  const seen = new Set();
  return records
    .filter((r) => {
      const key = r.linkedin || r.email || r.phone || r.name;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 200);
}

const PRICE_RE = /[$₹€£]\s?\d{1,3}(?:[,.]\d{3})*(?:\.\d{1,2})?/;
const RATING_RE = /\b([0-5](?:\.\d{1,2})?)\s?(?:\/\s?5|out of 5|stars?|★)/i;

// Generic "listing" detector: works on course catalogs, product grids, job
// boards, article indexes, directories — anything built as a repeated card.
// Rather than hard-coding rules for any one site, it looks for the actual
// structural signal a listing leaves behind: a parent element with several
// children that share the same tag + class ("siblings that repeat").
function extractListings($, finalUrl) {
  const MIN_REPEATS = 4;
  const candidates = [];

  $('body *').each((_, el) => {
    const childEls = (el.children || []).filter((c) => c.type === 'tag');
    if (childEls.length < MIN_REPEATS) return;

    const groups = new Map();
    childEls.forEach((c) => {
      const cls = c.attribs && c.attribs.class ? c.attribs.class.trim().split(/\s+/).sort().join('.') : '';
      const key = c.tagName + '|' + cls;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    });

    groups.forEach((items) => {
      if (items.length >= MIN_REPEATS) candidates.push(items);
    });
  });

  if (!candidates.length) return [];

  const avgTextLen = (items) => {
    const total = items.reduce((sum, it) => sum + $(it).text().trim().length, 0);
    return total / items.length;
  };

  // Category/filter menus (e.g. a sidebar of topics, each expanding into a
  // dozen sub-links) also repeat many times and can look "text-heavy" once
  // every nested sub-link's text is counted together — but they rarely carry
  // a price, rating, image, or their own paragraph, and each item nests far
  // more links than a real content card would. Score every candidate group
  // on those signals so a genuine listing gets picked over a nav tree.
  function scoreGroup(items) {
    let richCount = 0;
    let totalLinks = 0;
    items.forEach((it) => {
      const $it = $(it);
      const text = $it.text();
      const hasP = $it.find('p').length > 0;
      const hasImg = $it.find('img').length > 0;
      const hasPriceOrRating = PRICE_RE.test(text) || RATING_RE.test(text);
      if (hasP || hasImg || hasPriceOrRating) richCount++;
      totalLinks += $it.find('a').length;
    });
    return {
      avgLinks: totalLinks / items.length,
      richness: richCount / items.length
    };
  }

  const real = candidates
    .map((items) => ({ items, ...scoreGroup(items) }))
    .filter(
      (c) =>
        avgTextLen(c.items) >= 20 &&
        c.items.length <= 300 &&
        c.avgLinks <= 4 && // real cards rarely nest more than a couple links
        (c.richness > 0 || c.avgLinks <= 1.5) // needs SOME content signal, unless it's a plain single-link-per-row list
    );
  if (!real.length) return [];

  // Prefer groups that look like genuine content (price/rating/image/
  // paragraph present) over ones that just happen to be large.
  real.sort((a, b) => b.richness - a.richness || b.items.length - a.items.length);
  const chosen = real[0].items;

  const rows = [];
  chosen.slice(0, 200).forEach((item) => {
    const $item = $(item);
    const text = $item.text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    const linkHref = $item.is('a[href]') ? $item.attr('href') : $item.find('a[href]').first().attr('href');
    const link = linkHref ? absolutize(finalUrl, linkHref) : '';

    let title = $item.find('h1, h2, h3, h4, h5').first().text().replace(/\s+/g, ' ').trim();
    if (!title) title = $item.find('a').first().text().replace(/\s+/g, ' ').trim();
    if (!title) title = text.slice(0, 100);

    const imgSrc = $item.find('img[src]').first().attr('src');
    const image = imgSrc ? absolutize(finalUrl, imgSrc) : '';

    const priceMatch = text.match(PRICE_RE);
    const ratingMatch = text.match(RATING_RE);

    // Description is pulled specifically from a <p> inside the card — never
    // from "whatever text happens to be left over" — so it can't end up
    // stuffed with sibling links, prices, or nested menu text that belongs
    // in other columns.
    const description = $item.find('p').first().text().replace(/\s+/g, ' ').trim().slice(0, 220);

    rows.push({
      title: title.slice(0, 160),
      link,
      image,
      price: priceMatch ? priceMatch[0] : '',
      rating: ratingMatch ? ratingMatch[1] : '',
      description
    });
  });

  // Dedupe identical rows (some sites repeat a card in both a "featured" and
  // a "grid" section).
  const seen = new Set();
  return rows.filter((r) => {
    const key = r.link || r.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const RENDER_TIMEOUT_MS = 25000;
let browserPromise = null;

// Playwright is required lazily so the whole server doesn't crash on startup
// if it hasn't been installed yet (`npm install` + `npx playwright install
// chromium`) — it only matters the first time someone actually requests JS
// rendering.
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      let playwright;
      try {
        playwright = require('playwright');
      } catch {
        throw new Error(
          "JavaScript rendering isn't set up. Run `npx playwright install chromium` in the project folder, then restart the server."
        );
      }
      try {
        return await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
      } catch (err) {
        throw new Error(
          "Couldn't start the JS renderer. Run `npx playwright install chromium` in the project folder, then restart the server. (" +
            (err.message || err) +
            ')'
        );
      }
    })();
  }
  return browserPromise;
}

// Fetches a page with a real (headless) browser so JavaScript-rendered
// content — e.g. React/Angular sites like Coursera's course catalog — shows
// up in the HTML we parse. Slower than a plain HTTP fetch, so only used when
// the caller explicitly asks for it.
async function fetchRenderedHtml(targetUrl) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; SimpleScraperTool/1.0; +https://example.com/bot)'
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: RENDER_TIMEOUT_MS
    });
    // Give client-side JS a moment to run, and nudge lazy/infinite-scroll
    // listings (like course catalogs) to load a bit more content.
    await page.waitForTimeout(1200);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(700);
    }
    const html = await page.content();
    return {
      html,
      status: response ? response.status() : 200,
      finalUrl: page.url()
    };
  } finally {
    await context.close();
  }
}

async function analyzePage(targetUrl, options = {}) {
  const { renderJs = false } = options;
  const startedAt = Date.now();

  let html, status, finalUrl;

  if (renderJs) {
    const rendered = await fetchRenderedHtml(targetUrl);
    html = rendered.html;
    status = rendered.status;
    finalUrl = rendered.finalUrl;
  } else {
    const response = await axios.get(targetUrl, {
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; SimpleScraperTool/1.0; +https://example.com/bot)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      validateStatus: () => true
    });

    const contentType = response.headers['content-type'] || '';
    finalUrl = response.request?.res?.responseUrl || targetUrl;

    if (response.status >= 400) {
      return {
        error: `The site responded with status ${response.status}.`,
        status: response.status,
        finalUrl
      };
    }

    if (!contentType.includes('text/html')) {
      return {
        error: `That URL returned "${contentType || 'unknown'}" content, not an HTML page.`,
        status: response.status,
        finalUrl
      };
    }

    html = response.data;
    status = response.status;
  }

  const elapsedMs = Date.now() - startedAt;
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim() || null;
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || null;
  const metaKeywords = $('meta[name="keywords"]').attr('content')?.trim() || null;
  const canonical = $('link[rel="canonical"]').attr('href') || null;
  const ogImage = $('meta[property="og:image"]').attr('content') || null;
  const lang = $('html').attr('lang') || null;

  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    if (headings.length >= MAX_ITEMS) return;
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) headings.push({ tag, text });
  });

  const linksSeen = new Set();
  const links = [];
  $('a[href]').each((_, el) => {
    if (links.length >= MAX_ITEMS) return;
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    const absolute = absolutize(finalUrl, href);
    if (linksSeen.has(absolute)) return;
    linksSeen.add(absolute);
    const text = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120);
    links.push({ href: absolute, text: text || '(no text)' });
  });

  const imagesSeen = new Set();
  const images = [];
  $('img[src]').each((_, el) => {
    if (images.length >= MAX_ITEMS) return;
    const src = $(el).attr('src');
    if (!src) return;
    const absolute = absolutize(finalUrl, src);
    if (imagesSeen.has(absolute)) return;
    imagesSeen.add(absolute);
    const alt = $(el).attr('alt') || '';
    images.push({ src: absolute, alt });
  });

  const paragraphTexts = [];
  $('p').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length > 20) paragraphTexts.push(text);
  });
  const bodyText = paragraphTexts.join(' ');
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
  const excerpt = bodyText.slice(0, 600) + (bodyText.length > 600 ? '…' : '');

  const contacts = extractContacts($, finalUrl);
  const listings = extractListings($, finalUrl);

  // Every same-hostname link found on the page, used by the crawler to decide
  // what to visit next. Not returned to the single-page /scrape response.
  const sameHostLinks = [];
  try {
    const finalHost = new URL(finalUrl).hostname;
    for (const l of links) {
      try {
        const u = new URL(l.href);
        if (u.hostname === finalHost) sameHostLinks.push(u.href);
      } catch {
        /* ignore malformed */
      }
    }
  } catch {
    /* ignore */
  }

  return {
    requestedUrl: targetUrl,
    finalUrl,
    status,
    elapsedMs,
    lang,
    title,
    metaDescription,
    metaKeywords,
    canonical,
    ogImage: ogImage ? absolutize(finalUrl, ogImage) : null,
    counts: {
      headings: headings.length,
      links: links.length,
      images: images.length,
      words: wordCount,
      contacts: contacts.length,
      listings: listings.length
    },
    headings,
    links,
    images,
    excerpt,
    contacts,
    listings,
    sameHostLinks
  };
}

function friendlyFetchError(err) {
  if (err.code === 'ECONNABORTED') {
    return 'The request timed out. The site may be slow or blocking automated requests.';
  } else if (err.code === 'ENOTFOUND') {
    return 'That domain could not be found. Check the URL and try again.';
  } else if (err.response) {
    return `The site responded with status ${err.response.status}.`;
  } else if (err.name === 'TimeoutError') {
    return 'The page took too long to load while rendering JavaScript.';
  } else if (err.message && err.message.includes('playwright install')) {
    return err.message;
  }
  return `Could not reach that URL${err.message ? ' (' + err.message + ')' : ''}.`;
}

app.post('/scrape', async (req, res) => {
  const rawUrl = (req.body && req.body.url) || '';
  if (!rawUrl.trim()) {
    return res.status(400).json({ error: 'Enter a URL to scrape.' });
  }

  let targetUrl;
  try {
    targetUrl = normalizeUrl(rawUrl);
    new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'That URL doesn\'t look valid.' });
  }

  const renderJs = !!(req.body && req.body.renderJs);

  try {
    const result = await analyzePage(targetUrl, { renderJs });
    delete result.sameHostLinks;
    res.json(result);
  } catch (err) {
    res.status(200).json({ error: friendlyFetchError(err) });
  }
});

// ---- Whole-site crawl ----

const CRAWL_SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|ico|css|js|zip|rar|mp4|mp3|wav|woff2?|ttf|eot|json|xml|rss|atom|doc|docx|xls|xlsx|ppt|pptx)(\?|#|$)/i;

async function fetchRobotsDisallowRules(origin) {
  try {
    const r = await axios.get(origin + '/robots.txt', {
      timeout: 5000,
      validateStatus: () => true
    });
    if (r.status >= 400 || typeof r.data !== 'string') return [];
    const rules = [];
    let applies = false;
    for (const raw of r.data.split('\n')) {
      const line = raw.split('#')[0].trim();
      if (!line || !line.includes(':')) continue;
      const idx = line.indexOf(':');
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === 'user-agent') {
        applies = value === '*';
      } else if (key === 'disallow' && applies && value) {
        rules.push(value);
      }
    }
    return rules;
  } catch {
    return [];
  }
}

function isDisallowed(pathname, rules) {
  return rules.some((rule) => rule && pathname.startsWith(rule));
}

function normalizeForVisited(urlStr) {
  try {
    const u = new URL(urlStr);
    u.hash = '';
    let p = u.pathname;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return u.origin + p + u.search;
  } catch {
    return urlStr;
  }
}

const CRAWL_MAX_PAGES_CAP = 30;
const CRAWL_TIME_BUDGET_MS = 50000;
const CRAWL_DELAY_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dedupeContacts(list) {
  const seen = new Set();
  return list.filter((c) => {
    const key = c.linkedin || c.email || c.phone || c.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Shared BFS crawler used by both the plain /crawl endpoint and the live
// /crawl-stream (SSE) endpoint. onProgress, if given, is called once per
// page as soon as it's processed, so callers can stream updates.
async function runCrawl(startUrl, maxPages, onProgress, isAborted, renderJs) {
  const startedAt = Date.now();
  const startHost = new URL(startUrl).hostname;
  const robotsRules = await fetchRobotsDisallowRules(new URL(startUrl).origin);

  const visited = new Set();
  const queue = [{ url: startUrl, parent: null, depth: 0 }];
  const pages = [];
  const headingsAll = [];
  const linksAll = [];
  const imagesAll = [];
  const listingsAll = [];
  let contactsAll = [];
  let stoppedReason = 'completed';

  while (queue.length > 0 && pages.length < maxPages) {
    if (isAborted && isAborted()) {
      stoppedReason = 'aborted';
      break;
    }
    if (Date.now() - startedAt > CRAWL_TIME_BUDGET_MS) {
      stoppedReason = 'time_budget';
      break;
    }

    const { url: nextUrl, parent, depth } = queue.shift();
    const normalized = normalizeForVisited(nextUrl);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    let pathname = '/';
    try {
      pathname = new URL(nextUrl).pathname;
    } catch {
      continue;
    }

    if (isDisallowed(pathname, robotsRules)) {
      const p = { url: nextUrl, status: null, title: null, error: 'Blocked by robots.txt', counts: null, parent, depth };
      pages.push(p);
      if (onProgress) onProgress(p);
      continue;
    }

    if (pages.length > 0) await sleep(CRAWL_DELAY_MS); // be polite between requests

    try {
      const result = await analyzePage(nextUrl, { renderJs });

      if (result.error) {
        const p = { url: nextUrl, status: result.status || null, title: null, error: result.error, counts: null, parent, depth };
        pages.push(p);
        if (onProgress) onProgress(p);
        continue;
      }

      const p = {
        url: result.finalUrl,
        status: result.status,
        title: result.title,
        error: null,
        counts: result.counts,
        parent,
        depth
      };
      pages.push(p);
      if (onProgress) onProgress(p);

      result.headings.forEach((h) => headingsAll.push({ page: result.finalUrl, ...h }));
      result.links.forEach((l) => linksAll.push({ page: result.finalUrl, ...l }));
      result.images.forEach((i) => imagesAll.push({ page: result.finalUrl, ...i }));
      result.listings.forEach((l) => listingsAll.push({ page: result.finalUrl, ...l }));
      contactsAll = contactsAll.concat(result.contacts);

      for (const link of result.sameHostLinks) {
        if (CRAWL_SKIP_EXT.test(link)) continue;
        let linkHost;
        try {
          linkHost = new URL(link).hostname;
        } catch {
          continue;
        }
        if (linkHost !== startHost) continue;
        const norm = normalizeForVisited(link);
        if (!visited.has(norm) && queue.length + pages.length < maxPages * 3) {
          queue.push({ url: link, parent: result.finalUrl, depth: depth + 1 });
        }
      }
    } catch (err) {
      const p = { url: nextUrl, status: null, title: null, error: friendlyFetchError(err), counts: null, parent, depth };
      pages.push(p);
      if (onProgress) onProgress(p);
    }
  }

  if (queue.length > 0 && pages.length >= maxPages) stoppedReason = 'max_pages';

  const dedupedContacts = dedupeContacts(contactsAll).slice(0, 300);

  const seenListing = new Set();
  const dedupedListings = listingsAll
    .filter((l) => {
      const key = l.link || l.title;
      if (!key || seenListing.has(key)) return false;
      seenListing.add(key);
      return true;
    })
    .slice(0, 500);

  return {
    startUrl,
    pagesCrawled: pages.length,
    stoppedReason,
    elapsedMs: Date.now() - startedAt,
    pages,
    headings: headingsAll,
    links: linksAll,
    images: imagesAll,
    contacts: dedupedContacts,
    listings: dedupedListings,
    counts: {
      pages: pages.length,
      headings: headingsAll.length,
      links: linksAll.length,
      images: imagesAll.length,
      contacts: dedupedContacts.length,
      listings: dedupedListings.length
    }
  };
}

function parseCrawlParams(source) {
  const rawUrl = (source && source.url) || '';
  if (!rawUrl.trim()) return { error: 'Enter a URL to crawl.' };
  let startUrl;
  try {
    startUrl = normalizeUrl(rawUrl);
    new URL(startUrl);
  } catch {
    return { error: 'That URL doesn\'t look valid.' };
  }
  let maxPages = parseInt(source && source.maxPages, 10);
  if (!Number.isFinite(maxPages) || maxPages < 1) maxPages = 12;
  maxPages = Math.min(maxPages, CRAWL_MAX_PAGES_CAP);
  const renderJs = source && (source.renderJs === true || source.renderJs === 'true');
  return { startUrl, maxPages, renderJs };
}

app.post('/crawl', async (req, res) => {
  const parsed = parseCrawlParams(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const result = await runCrawl(parsed.startUrl, parsed.maxPages, null, null, parsed.renderJs);
    res.json(result);
  } catch (err) {
    res.status(200).json({ error: friendlyFetchError(err) });
  }
});

// Live version of /crawl using Server-Sent Events, so the frontend can show
// pages arriving in real time instead of waiting for the whole crawl.
app.get('/crawl-stream', async (req, res) => {
  const parsed = parseCrawlParams(req.query || {});
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await runCrawl(
      parsed.startUrl,
      parsed.maxPages,
      (page) => sendEvent('page', page),
      () => aborted,
      parsed.renderJs
    );
    if (!aborted) {
      sendEvent('done', result);
      res.end();
    }
  } catch (err) {
    if (!aborted) {
      sendEvent('done', { error: friendlyFetchError(err) });
      res.end();
    }
  }
});

// ---- Batch mode: user supplies a specific list of URLs (no link-following) ----

const BATCH_MAX_URLS = 25;

app.post('/batch', async (req, res) => {
  const rawList = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const urls = rawList
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean)
    .slice(0, BATCH_MAX_URLS);
  const renderJs = !!(req.body && req.body.renderJs);

  if (urls.length === 0) {
    return res.status(400).json({ error: 'Enter at least one URL.' });
  }

  const startedAt = Date.now();
  const pages = [];
  const headingsAll = [];
  const linksAll = [];
  const imagesAll = [];
  const listingsAll = [];
  let contactsAll = [];

  for (const raw of urls) {
    let targetUrl;
    try {
      targetUrl = normalizeUrl(raw);
      new URL(targetUrl);
    } catch {
      pages.push({ url: raw, status: null, title: null, error: "That URL doesn't look valid.", counts: null });
      continue;
    }

    if (pages.length > 0) await sleep(CRAWL_DELAY_MS);

    try {
      const result = await analyzePage(targetUrl, { renderJs });
      if (result.error) {
        pages.push({ url: targetUrl, status: result.status || null, title: null, error: result.error, counts: null });
        continue;
      }
      pages.push({
        url: result.finalUrl,
        status: result.status,
        title: result.title,
        error: null,
        counts: result.counts
      });
      result.headings.forEach((h) => headingsAll.push({ page: result.finalUrl, ...h }));
      result.links.forEach((l) => linksAll.push({ page: result.finalUrl, ...l }));
      result.images.forEach((i) => imagesAll.push({ page: result.finalUrl, ...i }));
      result.listings.forEach((l) => listingsAll.push({ page: result.finalUrl, ...l }));
      contactsAll = contactsAll.concat(result.contacts);
    } catch (err) {
      pages.push({ url: targetUrl, status: null, title: null, error: friendlyFetchError(err), counts: null });
    }
  }

  const dedupedContacts = dedupeContacts(contactsAll);
  const seenListing = new Set();
  const dedupedListings = listingsAll.filter((l) => {
    const key = l.link || l.title;
    if (!key || seenListing.has(key)) return false;
    seenListing.add(key);
    return true;
  });

  res.json({
    startUrl: `${urls.length} URLs (batch)`,
    pagesCrawled: pages.length,
    stoppedReason: 'completed',
    elapsedMs: Date.now() - startedAt,
    pages,
    headings: headingsAll,
    links: linksAll,
    images: imagesAll,
    contacts: dedupedContacts,
    listings: dedupedListings,
    counts: {
      pages: pages.length,
      headings: headingsAll.length,
      links: linksAll.length,
      images: imagesAll.length,
      contacts: dedupedContacts.length,
      listings: dedupedListings.length
    }
  });
});

app.listen(PORT, () => {
  console.log(`Web scraper tool running at http://localhost:${PORT}`);
});
