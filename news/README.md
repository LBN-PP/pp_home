# Dynatrace news aggregator

Hourly GitHub Actions job that fetches the Dynatrace news RSS feeds by category, merges them into a single JSON file and publishes it with GitHub Pages.

```
.github/workflows/dynatrace-news.yml   # schedule → fetch → commit → deploy
news/
  feeds.config.json                    # categories, retention, HTTP settings
  fetch-news.mjs                       # aggregation script (Node.js ≥ 20)
  feeds-meta.json                      # generated: ETag / Last-Modified per feed
site/
  data/news.json                       # generated: the file served by Pages
```

## How it works

1. The workflow runs every hour (minute 17), on manual dispatch, and on pushes touching `news/`, `site/` or the workflow.
2. `fetch-news.mjs` sends conditional requests (`If-None-Match` / `If-Modified-Since`), so unchanged feeds answer `304` with no body.
3. Only items whose `guid` is unknown are normalized. An article found in several category feeds is stored once, with all its categories.
4. Retention keeps the 60 most recent articles of each category, and nothing older than 365 days.
5. `news.json` is rewritten only when its content changes, so `generatedAt` stays stable and no empty commit is made.
6. The job commits the changed files, then deploys the `site/` folder to Pages. Scheduled runs with no change skip the deployment.

A failing feed never deletes its articles: they are kept until the feed recovers. The run fails, and nothing is published, only if **every** feed fails.

## Setup

1. **Pages source:** *Settings → Pages → Build and deployment → Source: GitHub Actions*.
2. **Plan:** Pages on a private repository requires a paid GitHub plan. The published site is public.
3. **Branch:** the workflow assumes the default branch is `main`. Adjust `on.push.branches` otherwise.
4. **Branch protection:** if `main` requires pull requests, the bot cannot push. Allow GitHub Actions to bypass the rule, or commit the data to a dedicated branch.
5. Run the workflow once manually (*Actions → Dynatrace news → Run workflow*) and check the job summary: it lists the HTTP status of every feed.

The JSON is then available at `https://<owner>.github.io/<repo>/data/news.json`.

## Adding or fixing a category

Edit `feeds.config.json`. Each entry has a `key` (used in the JSON and the UI), a `label`, and the `slug` used in the feed URL `https://www.dynatrace.com/news/category/{slug}/feed/`. A slug that returns `404` shows up as a warning in the job summary.

## Running locally

```bash
cd news
npm ci
node fetch-news.mjs
```

`NEWS_FEED_URL_TEMPLATE` overrides the feed URL template (useful to test against local fixtures), and `NEWS_OUTPUT` the output path, relative to the repository root.

## `news.json` contract

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-23T13:17:42.000Z",   // last content change
  "source": "https://www.dynatrace.com/news/",
  "categories": [{ "key": "ai", "label": "AI", "count": 42 }],
  "articles": [
    {
      "id": "https://www.dynatrace.com/news/?p=75553",   // RSS guid, stable
      "title": "…",
      "link": "https://www.dynatrace.com/news/blog/…",   // always http(s)
      "publishedAt": "2026-10-08T20:49:22.000Z",          // or null
      "author": "…",                                      // or null
      "summary": "Plain text, HTML removed, ≤ 280 chars",
      "image": "https://news.cdn.dm.dynatrace.com/…",     // or null
      "categories": ["ai", "devops"],                     // config keys
      "tags": ["AI", "DevOps", "agentic AI"],             // WordPress categories and tags
      "search": "lowercase accent-free title + summary + tags"
    }
  ]
}
```

Articles are sorted newest first. `summary` and `title` are plain text: render them with `textContent`, never `innerHTML`.

The homepage (`../index.html`) fetches this file over HTTPS from the published Pages URL (configured as `data.newsUrl` in `../config.js`) rather than reading it locally — that keeps the private repo's HTML separate from the publicly-published `site/` folder. GitHub Pages serves every file with `Access-Control-Allow-Origin: *`, so the cross-origin `fetch()` works with no extra CORS setup.
