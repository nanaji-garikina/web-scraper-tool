# Extract — a web scraping tool

Paste a URL, get its title, meta description, headings, links, images, contacts, and course/product/job-style **listings** back as clean, exportable data — as CSV, JSON, or Excel (.xlsx).

## Run it

```
npm install
npx playwright install chromium
npm start
```

Then open http://localhost:3000

(The `npx playwright install chromium` step downloads a headless browser, needed only for the **Render JavaScript** option below. It's a one-time ~300MB download. You can skip it if you don't need that option — the rest of the tool works fine without it.)

## Three modes

- **Single page** — scrape just the URL you enter.
- **Crawl whole site** — starting from the URL you enter, it follows same-domain links (up to a page limit you set, max 30), with a **live progress bar** showing pages as they're found. Respects `robots.txt` where present, and waits briefly between requests to be polite to the target site.
- **Batch URLs** — paste a list of specific URLs (one per line, up to 25) and run them all in one go.

## Render JavaScript (for sites like Coursera)

Some sites (React/Angular/Next.js apps — Coursera's browse/search pages are a good example) build their content with client-side JavaScript, so a plain HTML fetch sees an empty shell. Check **"Render JavaScript"** before running to fetch those pages with a real headless browser instead, which waits for the page to load and even scrolls to trigger lazy/infinite-scroll content. It's slower — use it only when the plain fetch comes back thin.

## Listings — the "get me all the courses" feature

Alongside Headings/Links/Images/Contacts, the tool looks for **repeated card-style content** on a page — course catalogs, product grids, job boards, article indexes — and pulls out a clean table of Title / Link / Price / Rating / Description for each item, automatically. No site-specific configuration needed; it detects the repeating pattern itself. This is what you want for "give me all the courses on this page" type requests.

## Exports

- **Every panel** (Headings, Links, Images, Contacts, Listings, Pages) has **CSV, JSON, and Excel (XLSX)** export buttons.
- **"Export full report (.xlsx)"** — one button (next to the status line, once a run finishes) that bundles everything into a single Excel workbook, one sheet per data type. This is the fastest way to get, say, every course from a whole site into one spreadsheet.
- All exports are de-duplicated — if the same course/contact/row is detected more than once (e.g. it appears in two different sections of a page, or on two different crawled pages), it only appears once in what you export.
- **Search/filter** boxes on Headings, Links, Images, Contacts, and Listings to quickly narrow a long list before exporting.

## Other features

- **Site map graph** — a simple visual tree of the pages found during a crawl and how they link together.
- **History drawer** (top right) — every run is saved in your browser (`localStorage`) so you can revisit past results without re-scraping. Nothing is sent anywhere; it's local to your browser only.
- **Contacts extraction** — best-effort detection of people/profile-like data (name, bio, LinkedIn, email, phone) useful for team or advisor directory pages. Fields a generic page can't reliably provide (organisation, city, custom scores, etc.) are left blank rather than guessed.

## Deploying so anyone can use it via a live URL

GitHub only stores your code — it doesn't run it. You need two things: a GitHub repo, and a hosting platform that keeps a Node.js server running.

### 1. Push to GitHub

From inside the `scraper-tool` folder:

```
git init
git add .
git commit -m "Initial commit"
```

Then create an empty repo on [github.com/new](https://github.com/new) (don't add a README/license there), and:

```
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO-NAME.git
git branch -M main
git push -u origin main
```

### 2. Deploy it (recommended: Render.com — free tier available)

1. Go to [render.com](https://render.com) and sign up / log in with GitHub.
2. Click **New → Web Service**, and pick your repo.
3. Render should auto-detect the settings from the included `render.yaml`. If it asks manually, use:
   - **Build Command:** `npm install && npx playwright install --with-deps chromium`
   - **Start Command:** `npm start`
4. Click **Create Web Service**. After a few minutes you'll get a live URL like `https://extract-web-scraper.onrender.com`.

Every time you `git push` to `main`, Render redeploys automatically.

**Other options:** [Railway](https://railway.app) and [Fly.io](https://fly.io) work the same way (connect the GitHub repo, they detect Node.js automatically). Vercel/Netlify are built for static sites and serverless functions, not a long-running Express server like this one, so they're a poorer fit here.

**A note on free tiers:** the "Render JavaScript" feature runs a real headless Chromium browser, which needs more memory and time than free hosting tiers usually give you generously. Plain scraping (the default, JS-rendering unchecked) is lightweight and works fine on a free plan. If JS rendering times out or the service restarts under memory pressure, that's the free tier's limits, not a bug — a paid plan (or self-hosting on your own machine/VPS) removes that ceiling.



- Works on public pages. Pages that require login may return little or nothing.
- Some sites block automated requests entirely, JS-rendering or not.
- Respect robots.txt and each site's terms of service — this tool makes a best effort to follow `robots.txt`, but you're responsible for how you use it.
