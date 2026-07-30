// ---------- element refs ----------
const form = document.getElementById('scrape-form');
const urlInput = document.getElementById('url-input');
const batchInput = document.getElementById('batch-input');
const inputPanelUrl = document.getElementById('input-panel-url');
const scanButton = document.getElementById('scan-button');
const scanButtonLabel = document.getElementById('scan-button-label');
const statusLine = document.getElementById('status-line');
const statusText = document.getElementById('status-text');
const resultsGrid = document.getElementById('results-grid');
const maxPagesWrap = document.getElementById('max-pages-wrap');
const maxPagesInput = document.getElementById('max-pages-input');
const panelOverview = document.getElementById('panel-overview');
const panelPages = document.getElementById('panel-pages');
const panelSitemap = document.getElementById('panel-sitemap');
const panelListings = document.getElementById('panel-listings');
const panelText = document.getElementById('panel-text');
const progressPanel = document.getElementById('progress-panel');
const progressFill = document.getElementById('progress-fill');
const progressCount = document.getElementById('progress-count');
const progressLabel = document.getElementById('progress-label');
const progressLiveList = document.getElementById('progress-live-list');
const renderJsCheckbox = document.getElementById('render-js-checkbox');
const exportAllBtn = document.getElementById('export-all-btn');

// ---------- mode switching ----------
let currentMode = 'single';

document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mode-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentMode = tab.dataset.mode;

    inputPanelUrl.hidden = currentMode === 'batch';
    batchInput.hidden = currentMode !== 'batch';
    maxPagesWrap.hidden = currentMode !== 'crawl';
    scanButtonLabel.textContent =
      currentMode === 'crawl' ? 'Crawl site' : currentMode === 'batch' ? 'Run batch' : 'Extract';
  });
});

function setStatus(text, mode) {
  statusLine.hidden = false;
  statusLine.className = 'status-line' + (mode ? ' ' + mode : '');
  statusText.textContent = text;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pageLabel(item) {
  if (!item.page) return '';
  try {
    const u = new URL(item.page);
    return `<span class="link-url">from ${escapeHtml(u.pathname || '/')}</span>`;
  } catch {
    return '';
  }
}

// ---------- raw data stores (for client-side filtering) ----------
const raw = { headings: [], links: [], images: [], contacts: [], listings: [] };

function matches(text, query) {
  return String(text || '').toLowerCase().includes(query);
}

// Defensive de-duplication used before rendering/exporting, so the same
// record showing up twice (e.g. a course card matched by more than one
// selector, or the same person appearing on two crawled pages) never ends
// up as a duplicate row in the UI or in an exported file. Items with no
// usable key are kept as-is rather than risk dropping a valid row.
function dedupeByKey(arr, keyFn) {
  const seen = new Set();
  return arr.filter((item) => {
    const key = keyFn(item);
    if (!key) return true;
    const k = String(key).toLowerCase().trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- render: headings/links/images/contacts ----------
function renderHeadings(headings) {
  raw.headings = headings;
  const list = document.getElementById('list-headings');
  document.getElementById('count-headings').textContent = headings.length;
  if (!headings.length) {
    list.innerHTML = '<li class="empty-note">No headings found.</li>';
    return;
  }
  list.innerHTML = headings
    .map((h) => `<li><span class="h-tag">${h.tag.toUpperCase()}</span>${escapeHtml(h.text)}${pageLabel(h)}</li>`)
    .join('');
}

function renderLinks(links) {
  raw.links = links;
  const list = document.getElementById('list-links');
  document.getElementById('count-links').textContent = links.length;
  if (!links.length) {
    list.innerHTML = '<li class="empty-note">No links found.</li>';
    return;
  }
  list.innerHTML = links
    .map(
      (l) =>
        `<li><a href="${escapeHtml(l.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          l.text
        )}<span class="link-url">${escapeHtml(l.href)}</span></a>${pageLabel(l)}</li>`
    )
    .join('');
}

function renderImages(images) {
  raw.images = images;
  const grid = document.getElementById('list-images');
  document.getElementById('count-images').textContent = images.length;
  if (!images.length) {
    grid.innerHTML = '<p class="empty-note">No images found.</p>';
    return;
  }
  grid.innerHTML = images
    .map(
      (img) =>
        `<figure><img src="${escapeHtml(img.src)}" alt="${escapeHtml(
          img.alt
        )}" loading="lazy" onerror="this.closest('figure').style.display='none'" />
        <figcaption>${escapeHtml(img.alt || '(no alt text)')}</figcaption></figure>`
    )
    .join('');
}

function renderContacts(contacts) {
  raw.contacts = dedupeByKey(contacts, (c) => c.linkedin || c.email || c.phone || c.name);
  const list = document.getElementById('list-contacts');
  document.getElementById('count-contacts').textContent = raw.contacts.length;
  if (!raw.contacts.length) {
    list.innerHTML = '<li class="empty-note">No name/LinkedIn/email/phone patterns detected.</li>';
    return;
  }
  list.innerHTML = raw.contacts
    .map((c) => {
      const bits = [];
      if (c.email) bits.push(escapeHtml(c.email));
      if (c.phone) bits.push(escapeHtml(c.phone));
      if (c.linkedin)
        bits.push(`<a href="${escapeHtml(c.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>`);
      return `<li><strong>${escapeHtml(c.name || '(unnamed)')}</strong><span class="link-url">${bits.join(' · ')}</span></li>`;
    })
    .join('');
}

function listingRowHtml(l) {
  const titleCell = l.link
    ? `<a href="${escapeHtml(l.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.title || '(untitled)')}</a>`
    : escapeHtml(l.title || '(untitled)');
  return `<tr>
    <td class="lt-title">${titleCell}</td>
    <td class="lt-price">${escapeHtml(l.price || '—')}</td>
    <td class="lt-rating">${escapeHtml(l.rating || '—')}</td>
    <td class="lt-desc">${escapeHtml(l.description || '')}</td>
  </tr>`;
}

function renderListings(listings) {
  raw.listings = dedupeByKey(listings, (l) => l.link || l.title);
  const tbody = document.getElementById('list-listings');
  document.getElementById('count-listings').textContent = raw.listings.length;
  panelListings.hidden = raw.listings.length === 0;
  tbody.innerHTML = raw.listings.length
    ? raw.listings.map(listingRowHtml).join('')
    : '<tr><td colspan="4" class="empty-note">No repeated card-style listings detected.</td></tr>';
}

function renderListingsFiltered(q) {
  const filtered = q
    ? raw.listings.filter((l) => matches(l.title, q) || matches(l.description, q) || matches(l.price, q))
    : raw.listings;
  const tbody = document.getElementById('list-listings');
  document.getElementById('count-listings').textContent = filtered.length;
  tbody.innerHTML = filtered.length
    ? filtered.map(listingRowHtml).join('')
    : '<tr><td colspan="4" class="empty-note">No matches.</td></tr>';
}

// filter inputs re-render a filtered slice of the raw arrays
document.getElementById('filter-headings').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  renderHeadingsFiltered(q);
});
document.getElementById('filter-links').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  renderLinksFiltered(q);
});
document.getElementById('filter-images').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  renderImagesFiltered(q);
});
document.getElementById('filter-contacts').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  renderContactsFiltered(q);
});
document.getElementById('filter-listings').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  renderListingsFiltered(q);
});

function renderHeadingsFiltered(q) {
  const filtered = q ? raw.headings.filter((h) => matches(h.text, q) || matches(h.tag, q)) : raw.headings;
  const list = document.getElementById('list-headings');
  document.getElementById('count-headings').textContent = filtered.length;
  list.innerHTML = filtered.length
    ? filtered.map((h) => `<li><span class="h-tag">${h.tag.toUpperCase()}</span>${escapeHtml(h.text)}${pageLabel(h)}</li>`).join('')
    : '<li class="empty-note">No matches.</li>';
}
function renderLinksFiltered(q) {
  const filtered = q ? raw.links.filter((l) => matches(l.text, q) || matches(l.href, q)) : raw.links;
  const list = document.getElementById('list-links');
  document.getElementById('count-links').textContent = filtered.length;
  list.innerHTML = filtered.length
    ? filtered
        .map(
          (l) =>
            `<li><a href="${escapeHtml(l.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
              l.text
            )}<span class="link-url">${escapeHtml(l.href)}</span></a>${pageLabel(l)}</li>`
        )
        .join('')
    : '<li class="empty-note">No matches.</li>';
}
function renderImagesFiltered(q) {
  const filtered = q ? raw.images.filter((i) => matches(i.alt, q) || matches(i.src, q)) : raw.images;
  const grid = document.getElementById('list-images');
  document.getElementById('count-images').textContent = filtered.length;
  grid.innerHTML = filtered.length
    ? filtered
        .map(
          (img) =>
            `<figure><img src="${escapeHtml(img.src)}" alt="${escapeHtml(
              img.alt
            )}" loading="lazy" onerror="this.closest('figure').style.display='none'" />
            <figcaption>${escapeHtml(img.alt || '(no alt text)')}</figcaption></figure>`
        )
        .join('')
    : '<p class="empty-note">No matches.</p>';
}
function renderContactsFiltered(q) {
  const filtered = q
    ? raw.contacts.filter((c) => matches(c.name, q) || matches(c.email, q) || matches(c.phone, q) || matches(c.bio, q))
    : raw.contacts;
  const list = document.getElementById('list-contacts');
  document.getElementById('count-contacts').textContent = filtered.length;
  list.innerHTML = filtered.length
    ? filtered
        .map((c) => {
          const bits = [];
          if (c.email) bits.push(escapeHtml(c.email));
          if (c.phone) bits.push(escapeHtml(c.phone));
          if (c.linkedin) bits.push(`<a href="${escapeHtml(c.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>`);
          return `<li><strong>${escapeHtml(c.name || '(unnamed)')}</strong><span class="link-url">${bits.join(' · ')}</span></li>`;
        })
        .join('')
    : '<li class="empty-note">No matches.</li>';
}

function renderPages(pages) {
  const list = document.getElementById('list-pages');
  document.getElementById('count-pages').textContent = pages.length;
  list.innerHTML = pages
    .map((p) => {
      if (p.error) {
        return `<li><span class="page-status-err">✕</span> ${escapeHtml(p.url)}<span class="link-url">${escapeHtml(
          p.error
        )}</span></li>`;
      }
      return `<li><span class="page-status-ok">✓</span> ${escapeHtml(p.title || p.url)}<span class="link-url">${escapeHtml(
        p.url
      )} — ${p.counts.headings}h · ${p.counts.links}l · ${p.counts.images}img · ${p.counts.contacts}c</span></li>`;
    })
    .join('');
}

// ---------- sitemap graph ----------
function renderSitemap(pages) {
  const wrap = document.getElementById('sitemap-wrap');
  if (!pages || pages.length < 2) {
    panelSitemap.hidden = true;
    return;
  }
  panelSitemap.hidden = false;

  const nodes = pages.slice(0, 40);
  const byUrl = new Map(nodes.map((p) => [p.url, p]));
  const rows = [];
  nodes.forEach((p) => {
    const d = p.depth || 0;
    if (!rows[d]) rows[d] = [];
    rows[d].push(p);
  });

  const rowHeight = 70;
  const colWidth = 170;
  const maxCols = Math.max(...rows.map((r) => (r ? r.length : 0)), 1);
  const width = Math.max(600, maxCols * colWidth + 40);
  const height = rows.length * rowHeight + 40;

  const pos = new Map();
  rows.forEach((row, d) => {
    if (!row) return;
    const rowW = row.length * colWidth;
    const startX = (width - rowW) / 2 + colWidth / 2;
    row.forEach((p, i) => {
      pos.set(p.url, { x: startX + i * colWidth, y: 30 + d * rowHeight });
    });
  });

  let edges = '';
  nodes.forEach((p) => {
    if (p.parent && pos.has(p.parent) && pos.has(p.url)) {
      const a = pos.get(p.parent);
      const b = pos.get(p.url);
      edges += `<path class="sitemap-edge" d="M${a.x},${a.y + 14} C${a.x},${(a.y + b.y) / 2} ${b.x},${(a.y + b.y) / 2} ${b.x},${b.y - 14}" />`;
    }
  });

  let nodesSvg = '';
  nodes.forEach((p) => {
    const xy = pos.get(p.url);
    if (!xy) return;
    let label = '(untitled)';
    try {
      label = p.title ? p.title.slice(0, 20) : new URL(p.url).pathname.slice(0, 20) || '/';
    } catch {
      /* ignore */
    }
    nodesSvg += `<g class="sitemap-node" transform="translate(${xy.x},${xy.y})">
      <circle r="14" class="${p.error ? 'err' : ''}" />
      <text text-anchor="middle" y="30">${escapeHtml(label)}</text>
    </g>`;
  });

  const truncNote =
    pages.length > 40 ? `<p class="empty-note">Showing first 40 of ${pages.length} pages.</p>` : '';

  wrap.innerHTML = `${truncNote}<svg class="sitemap-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}">${edges}${nodesSvg}</svg>`;
}

// ---------- render: full single-page / crawl results ----------
function renderResults(data) {
  resultsGrid.hidden = false;
  panelOverview.hidden = false;
  panelPages.hidden = true;
  panelSitemap.hidden = true;
  panelText.hidden = false;

  document.getElementById('ov-title').textContent = data.title || '(no title tag found)';
  document.getElementById('ov-desc').textContent = data.metaDescription || 'No meta description on this page.';
  document.getElementById('ov-url').textContent = data.finalUrl;
  document.getElementById('ov-status').textContent = data.status;
  document.getElementById('ov-lang').textContent = data.lang || '—';
  document.getElementById('ov-time').textContent = `${data.elapsedMs} ms`;

  renderHeadings(data.headings || []);
  renderLinks(data.links || []);
  renderImages(data.images || []);
  renderContacts(data.contacts || []);
  renderListings(data.listings || []);

  document.getElementById('count-words').textContent = `${data.counts.words} words`;
  document.getElementById('excerpt-text').textContent = data.excerpt || 'No readable paragraph text found on this page.';
}

function renderCrawlResults(data) {
  resultsGrid.hidden = false;
  panelOverview.hidden = true;
  panelPages.hidden = false;
  panelText.hidden = true;

  const stopNote =
    data.stoppedReason === 'max_pages'
      ? ' (stopped at the page limit — more pages were found but not visited)'
      : data.stoppedReason === 'time_budget'
      ? ' (stopped after a while to avoid a very long wait — some pages may be missing)'
      : '';
  document.getElementById('pages-summary').textContent =
    `Crawled ${data.pagesCrawled} page(s) from ${data.startUrl} in ${(data.elapsedMs / 1000).toFixed(1)}s${stopNote}.`;

  renderPages(data.pages || []);
  renderSitemap(data.pages || []);
  renderHeadings(data.headings || []);
  renderLinks(data.links || []);
  renderImages(data.images || []);
  renderContacts(data.contacts || []);
  renderListings(data.listings || []);
}

function renderBatchResults(data) {
  resultsGrid.hidden = false;
  panelOverview.hidden = true;
  panelPages.hidden = false;
  panelSitemap.hidden = true;
  panelText.hidden = true;

  document.getElementById('pages-summary').textContent =
    `Ran ${data.pagesCrawled} URL(s) in ${(data.elapsedMs / 1000).toFixed(1)}s.`;

  renderPages(data.pages || []);
  renderHeadings(data.headings || []);
  renderLinks(data.links || []);
  renderImages(data.images || []);
  renderContacts(data.contacts || []);
  renderListings(data.listings || []);
}

// ---------- export: CSV + JSON ----------
function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}
function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  return lines.join('\r\n');
}
function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function downloadCsv(filename, csvString) {
  downloadBlob(filename, '\uFEFF' + csvString, 'text/csv;charset=utf-8;');
}
function downloadJson(filename, obj) {
  downloadBlob(filename, JSON.stringify(obj, null, 2), 'application/json;charset=utf-8;');
}
function downloadXlsx(filename, sheetName, rows) {
  if (typeof XLSX === 'undefined') {
    setStatus('Excel export library failed to load — check your internet connection and try again.', 'error');
    return;
  }
  const ws = XLSX.utils.json_to_sheet(rows && rows.length ? rows : [{}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Sheet1').slice(0, 31));
  XLSX.writeFile(wb, filename);
}

function buildPagesRows() {
  return (lastData.pages || []).map((p) => ({
    url: p.url,
    title: p.title || '',
    status: p.status ?? '',
    error: p.error || '',
    headings: p.counts ? p.counts.headings : '',
    links: p.counts ? p.counts.links : '',
    images: p.counts ? p.counts.images : '',
    contacts: p.counts ? p.counts.contacts : '',
    listings: p.counts ? p.counts.listings : ''
  }));
}

const CONTACTS_HEADERS = [
  'Name', 'Short Bio', 'Linkedin Profile', 'Organisation', 'Designation', 'Years of Experience',
  'Email', 'Phone Number', 'City', 'State', 'Country', 'Startup Fit Score', 'Startup Stage Suitability', 'Data Status'
];

// Matches the schema of a typical contacts/profile directory export. Fields
// a generic page can't reliably provide (organisation, designation, years of
// experience, location, curated scores/status) are left blank rather than
// guessed.
function buildContactsRows() {
  return raw.contacts.map((c) => ({
    Name: c.name, 'Short Bio': c.bio, 'Linkedin Profile': c.linkedin, Organisation: '', Designation: '',
    'Years of Experience': '', Email: c.email, 'Phone Number': c.phone, City: '', State: '', Country: '',
    'Startup Fit Score': '', 'Startup Stage Suitability': '', 'Data Status': ''
  }));
}

function buildListingsRows() {
  return raw.listings.map((l) => ({
    Title: l.title || '',
    Link: l.link || '',
    Price: l.price || '',
    Rating: l.rating || '',
    Description: l.description || ''
  }));
}

function hostSlug(data) {
  try {
    const base = data.finalUrl || data.startUrl;
    return new URL(base.replace(/^\d+ URLs.*/, 'http://batch')).hostname.replace(/\./g, '-');
  } catch {
    return 'site';
  }
}

let lastData = null;
let lastMode = 'single';

function exportType(type, format) {
  if (!lastData) return;
  const host = hostSlug(lastData);
  const isCrawl = lastMode !== 'single';

  let rows, headers, jsonData, sheetName;

  if (type === 'pages') {
    rows = buildPagesRows();
    headers = ['url', 'title', 'status', 'error', 'headings', 'links', 'images', 'contacts', 'listings'];
    jsonData = lastData.pages || [];
    sheetName = 'Pages';
  } else if (type === 'headings') {
    rows = raw.headings;
    headers = isCrawl ? ['page', 'tag', 'text'] : ['tag', 'text'];
    jsonData = raw.headings;
    sheetName = 'Headings';
  } else if (type === 'links') {
    rows = raw.links;
    headers = isCrawl ? ['page', 'text', 'href'] : ['text', 'href'];
    jsonData = raw.links;
    sheetName = 'Links';
  } else if (type === 'images') {
    rows = raw.images;
    headers = isCrawl ? ['page', 'src', 'alt'] : ['src', 'alt'];
    jsonData = raw.images;
    sheetName = 'Images';
  } else if (type === 'contacts') {
    rows = buildContactsRows();
    headers = CONTACTS_HEADERS;
    jsonData = raw.contacts;
    sheetName = 'Contacts';
  } else if (type === 'listings') {
    rows = buildListingsRows();
    headers = ['Title', 'Link', 'Price', 'Rating', 'Description'];
    jsonData = raw.listings;
    sheetName = 'Listings';
  } else {
    return;
  }

  if (format === 'json') downloadJson(`${host}-${type}.json`, jsonData);
  else if (format === 'xlsx') downloadXlsx(`${host}-${type}.xlsx`, sheetName, rows);
  else downloadCsv(`${host}-${type}.csv`, toCsv(headers, rows));
}

document.getElementById('results-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('.mini-btn');
  if (!btn) return;
  exportType(btn.dataset.export, btn.dataset.format);
});

// One button that bundles everything gathered so far into a single Excel
// workbook, one tab per data type — the fastest path from "one URL" to
// "a spreadsheet with everything in it" (e.g. a full course catalog).
exportAllBtn.addEventListener('click', () => {
  if (!lastData) return;
  if (typeof XLSX === 'undefined') {
    setStatus('Excel export library failed to load — check your internet connection and try again.', 'error');
    return;
  }
  const host = hostSlug(lastData);
  const wb = XLSX.utils.book_new();

  if (lastMode === 'single') {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        {
          Title: lastData.title || '',
          URL: lastData.finalUrl,
          Status: lastData.status,
          Language: lastData.lang || '',
          'Meta Description': lastData.metaDescription || ''
        }
      ]),
      'Overview'
    );
  } else {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildPagesRows()), 'Pages');
  }

  if (raw.listings.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildListingsRows()), 'Listings');
  if (raw.contacts.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildContactsRows()), 'Contacts');
  if (raw.headings.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(raw.headings), 'Headings');
  if (raw.links.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(raw.links), 'Links');
  if (raw.images.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(raw.images), 'Images');

  XLSX.writeFile(wb, `${host}-full-report.xlsx`);
});

// ---------- history (localStorage) ----------
const HISTORY_KEY = 'extract_history_v1';
const HISTORY_MAX = 20;

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}
function saveToHistory(mode, label, data) {
  try {
    const list = loadHistory();
    list.unshift({ mode, label, timestamp: Date.now(), data });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {
    /* localStorage full or unavailable — skip silently */
  }
}
function renderHistoryList() {
  const list = document.getElementById('history-list');
  const items = loadHistory();
  if (!items.length) {
    list.innerHTML = '<li class="history-empty">Nothing yet — run an extraction to see it here.</li>';
    return;
  }
  list.innerHTML = items
    .map(
      (item, i) => `<li class="history-item" data-index="${i}">
        <div class="history-item-mode">${escapeHtml(item.mode)}</div>
        <div class="history-item-url">${escapeHtml(item.label)}</div>
        <div class="history-item-time">${new Date(item.timestamp).toLocaleString()}</div>
      </li>`
    )
    .join('');
}

const historyDrawer = document.getElementById('history-drawer');
const historyScrim = document.getElementById('history-scrim');

function openHistory() {
  renderHistoryList();
  historyDrawer.classList.add('open');
  historyScrim.classList.add('open');
}
function closeHistory() {
  historyDrawer.classList.remove('open');
  historyScrim.classList.remove('open');
}

document.getElementById('history-toggle').addEventListener('click', openHistory);
document.getElementById('history-close').addEventListener('click', closeHistory);
historyScrim.addEventListener('click', closeHistory);

document.getElementById('history-list').addEventListener('click', (e) => {
  const li = e.target.closest('.history-item');
  if (!li) return;
  const items = loadHistory();
  const item = items[Number(li.dataset.index)];
  if (!item) return;

  lastData = item.data;
  lastMode = item.mode;
  progressPanel.hidden = true;
  exportAllBtn.hidden = false;

  if (item.mode === 'single') renderResults(item.data);
  else if (item.mode === 'crawl') renderCrawlResults(item.data);
  else renderBatchResults(item.data);

  setStatus(`Restored from history: ${item.label}`, 'ok');
  closeHistory();
  resultsGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---------- form submit ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  scanButton.disabled = true;
  resultsGrid.hidden = true;
  progressPanel.hidden = true;
  exportAllBtn.hidden = true;

  try {
    if (currentMode === 'crawl') {
      await runCrawlMode();
    } else if (currentMode === 'batch') {
      await runBatchMode();
    } else {
      await runSingleMode();
    }
  } catch (err) {
    setStatus('Something went wrong reaching the server. Try again.', 'error');
  } finally {
    scanButton.disabled = false;
  }
});

async function runSingleMode() {
  const url = urlInput.value.trim();
  if (!url) return;
  const renderJs = renderJsCheckbox.checked;
  setStatus(`Extracting ${url}${renderJs ? ' (rendering JavaScript — this takes longer)' : ''} …`);

  const res = await fetch('/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, renderJs })
  });
  const data = await res.json();

  if (data.error) {
    setStatus(data.error, 'error');
    return;
  }

  setStatus(`Extracted ${data.finalUrl} — status ${data.status}, ${data.elapsedMs} ms`, 'ok');
  lastData = data;
  lastMode = 'single';
  exportAllBtn.hidden = false;
  renderResults(data);
  saveToHistory('single', data.finalUrl, data);
}

function runCrawlMode() {
  return new Promise((resolve) => {
    const url = urlInput.value.trim();
    if (!url) return resolve();
    const maxPages = Math.min(30, Math.max(1, parseInt(maxPagesInput.value, 10) || 12));
    const renderJs = renderJsCheckbox.checked;

    progressPanel.hidden = false;
    progressLabel.textContent = 'Crawling…';
    progressCount.textContent = `0 / ${maxPages}`;
    progressFill.style.width = '0%';
    progressLiveList.innerHTML = '';
    setStatus(
      `Crawling ${url} (up to ${maxPages} pages)${renderJs ? ', rendering JavaScript — this takes longer' : ''} — watch progress above …`
    );

    const seen = [];
    const es = new EventSource(
      `/crawl-stream?url=${encodeURIComponent(url)}&maxPages=${maxPages}&renderJs=${renderJs}`
    );

    es.addEventListener('page', (e) => {
      const page = JSON.parse(e.data);
      seen.push(page);
      const pct = Math.min(100, Math.round((seen.length / maxPages) * 100));
      progressFill.style.width = pct + '%';
      progressCount.textContent = `${seen.length} / ${maxPages}`;
      const li = document.createElement('li');
      li.innerHTML = `<span class="${page.error ? 'err' : 'ok'}">${page.error ? '✕' : '✓'}</span> ${escapeHtml(
        page.title || page.url
      )}`;
      progressLiveList.prepend(li);
    });

    es.addEventListener('done', (e) => {
      const data = JSON.parse(e.data);
      es.close();
      progressLabel.textContent = 'Done';
      progressFill.style.width = '100%';

      if (data.error) {
        setStatus(data.error, 'error');
        progressPanel.hidden = true;
        return resolve();
      }

      setStatus(`Crawled ${data.pagesCrawled} page(s) from ${data.startUrl} in ${(data.elapsedMs / 1000).toFixed(1)}s`, 'ok');
      lastData = data;
      lastMode = 'crawl';
      exportAllBtn.hidden = false;
      renderCrawlResults(data);
      saveToHistory('crawl', data.startUrl, data);
      resolve();
    });

    es.onerror = () => {
      es.close();
      setStatus('Lost connection to the server mid-crawl. Try again.', 'error');
      resolve();
    };
  });
}

async function runBatchMode() {
  const urls = batchInput.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!urls.length) return;
  const renderJs = renderJsCheckbox.checked;

  setStatus(`Running batch of ${urls.length} URL(s)${renderJs ? ' (rendering JavaScript — this takes longer)' : ''} …`);

  const res = await fetch('/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls, renderJs })
  });
  const data = await res.json();

  if (data.error) {
    setStatus(data.error, 'error');
    return;
  }

  setStatus(`Ran ${data.pagesCrawled} URL(s) in ${(data.elapsedMs / 1000).toFixed(1)}s`, 'ok');
  lastData = data;
  lastMode = 'batch';
  exportAllBtn.hidden = false;
  renderBatchResults(data);
  saveToHistory('batch', `${urls.length} URLs`, data);
}
