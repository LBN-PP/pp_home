#!/usr/bin/env node
/**
 * Dynatrace news aggregator.
 *
 * Fetches every category RSS feed listed in feeds.config.json, merges the
 * items into a single deduplicated list (one article can belong to several
 * categories) and writes it to site/data/news.json, which GitHub Pages serves.
 *
 * Incremental by design:
 *   - conditional requests (ETag / Last-Modified) so unchanged feeds cost a 304;
 *   - only items whose id is not already known are normalized;
 *   - the output file is rewritten only when its content actually changes.
 *
 * Environment overrides (mostly for local testing):
 *   NEWS_OUTPUT             output path, relative to the repo root (default: site/data/news.json)
 *   NEWS_FEED_URL_TEMPLATE  replaces feedUrlTemplate from the config
 *
 * Exit code is 1 only when every feed failed, so a partial outage never
 * publishes an empty or truncated file.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CONFIG_PATH = resolve(HERE, 'feeds.config.json');
const META_PATH = resolve(HERE, 'feeds-meta.json');
const OUTPUT_PATH = resolve(REPO_ROOT, process.env.NEWS_OUTPUT ?? 'site/data/news.json');

const SCHEMA_VERSION = 1;
const SOURCE_URL = 'https://www.dynatrace.com/news/';
const RETRY_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (...args) => console.log(...args);
const warn = (message) => console.log(`::warning::${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** Sibling `.js` module (`window.NEWS_DATA = {...}`) so the static homepage can load it
 *  with a <script> tag instead of fetch(), which browsers refuse for local file:// pages. */
async function writeJsModule(jsonPath, globalName, data) {
  const path = jsonPath.replace(/\.json$/, '.js');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `window.${globalName} = ${JSON.stringify(data, null, 2)};\n`, 'utf8');
}

/** Writes a key=value pair for the next workflow steps (no-op outside Actions). */
async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function addSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** Runs async tasks with a bounded number in flight, to stay polite with the source. */
async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', trade: '™', reg: '®', copy: '©',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Plain text from an HTML fragment: tags removed, entities decoded, whitespace collapsed. */
function htmlToText(html) {
  const withoutBlocks = html
    .replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi, ' ');
  return decodeEntities(withoutBlocks.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** Lowercase, accent-free haystack so the front end can filter with a plain includes(). */
function searchable(...parts) {
  return parts.join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(String(value).trim()));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function firstImageSrc(html) {
  const match = /<img\b[^>]*?\bsrc=["']([^"']+)["']/i.exec(html ?? '');
  return match ? safeHttpUrl(match[1]) : null;
}

function toIsoDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** fast-xml-parser returns either a string or { '#text': ..., '@_attr': ... }. */
const textOf = (value) => (value && typeof value === 'object' ? value['#text'] ?? '' : value ?? '').toString().trim();

// ---------------------------------------------------------------------------
// RSS parsing
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false, // keep titles like "2026" as strings
  trimValues: true,
  htmlEntities: true,
  // Full article bodies are large and unused: keep them as raw, unparsed strings.
  stopNodes: ['rss.channel.item.content:encoded', 'rss.channel.item.customImage'],
  isArray: (_name, jpath) => jpath === 'rss.channel.item' || jpath === 'rss.channel.item.category',
});

function parseFeed(xml) {
  const document = parser.parse(xml);
  const channel = document?.rss?.channel;
  if (!channel) throw new Error('response is not an RSS 2.0 document');
  return channel.item ?? [];
}

function itemId(item) {
  return textOf(item.guid) || safeHttpUrl(textOf(item.link));
}

/** Builds the stored representation of a new article. */
function normalizeItem(item, categoryKey, summaryMaxLength) {
  const link = safeHttpUrl(textOf(item.link));
  const title = htmlToText(textOf(item.title));
  if (!link || !title) return null;

  // WordPress appends "The post X appeared first on Y." to every description.
  const descriptionHtml = textOf(item.description).replace(/<p>\s*The post [\s\S]*?appeared first on[\s\S]*?<\/p>/i, '');
  const summary = truncate(htmlToText(descriptionHtml), summaryMaxLength);
  const tags = [...new Set((item.category ?? []).map((c) => htmlToText(textOf(c))).filter(Boolean))];

  return {
    id: itemId(item),
    title,
    link,
    publishedAt: toIsoDate(textOf(item.pubDate)),
    author: htmlToText(textOf(item['dc:creator'])) || null,
    summary,
    image: firstImageSrc(textOf(item.customImage)) ?? firstImageSrc(descriptionHtml),
    categories: [categoryKey],
    tags,
    search: searchable(title, summary, tags.join(' ')),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchFeed(url, previous, config) {
  const headers = { 'User-Agent': config.userAgent, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.1' };
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;

  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(config.requestTimeoutMs) });
      if (response.status === 304) return { status: 304 };
      if (response.ok) {
        return {
          status: response.status,
          body: await response.text(),
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
        };
      }
      // 4xx will not fix itself; 5xx deserves one retry.
      if (response.status < 500 || attempt >= 2) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (attempt >= 2 || /^HTTP 4/.test(error.message)) throw error;
    }
    await sleep(RETRY_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// Merge & retention
// ---------------------------------------------------------------------------

function compareArticles(a, b) {
  if (a.publishedAt !== b.publishedAt) {
    if (!a.publishedAt) return 1;
    if (!b.publishedAt) return -1;
    return a.publishedAt < b.publishedAt ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function applyRetention(articles, categoryKeys, { maxPerCategory, maxAgeDays }) {
  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * 86_400_000 : null;
  const recentEnough = articles.filter((a) => !cutoff || !a.publishedAt || Date.parse(a.publishedAt) >= cutoff);

  // Keep an article if it is among the N most recent of at least one of its categories.
  const kept = new Set();
  for (const key of categoryKeys) {
    recentEnough.filter((a) => a.categories.includes(key)).slice(0, maxPerCategory).forEach((a) => kept.add(a.id));
  }
  return recentEnough.filter((a) => kept.has(a.id));
}

/** Content without volatile fields, used to decide whether anything changed. */
const fingerprint = (data) => JSON.stringify({ categories: data.categories, articles: data.articles });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = await readJson(CONFIG_PATH);
  const feedUrlTemplate = process.env.NEWS_FEED_URL_TEMPLATE ?? config.feedUrlTemplate;
  const previousOutput = await readJson(OUTPUT_PATH, null);
  const previousMeta = await readJson(META_PATH, { feeds: {} });

  // Without a previous output, a 304 would leave us with nothing: force full downloads.
  const canUseConditional = Boolean(previousOutput?.articles?.length);
  const articles = new Map((previousOutput?.articles ?? []).map((a) => [a.id, a]));
  const nextMeta = { feeds: {} };
  const report = [];

  const results = await mapWithConcurrency(config.categories, config.concurrency, async (category) => {
    const url = feedUrlTemplate.replace('{slug}', encodeURIComponent(category.slug));
    const previous = previousMeta.feeds[category.key];
    const sameUrl = previous?.url === url;
    try {
      const response = await fetchFeed(url, canUseConditional && sameUrl ? previous : null, config);
      return { category, url, previous: sameUrl ? previous : null, response };
    } catch (error) {
      return { category, url, previous: sameUrl ? previous : null, error };
    }
  });

  for (const { category, url, previous, response, error } of results) {
    if (error) {
      warn(`[${category.key}] ${url} failed: ${error.message}`);
      if (previous) nextMeta.feeds[category.key] = previous; // keep validators for next time
      report.push({ key: category.key, status: 'error', detail: error.message, added: 0 });
      continue;
    }

    if (response.status === 304) {
      nextMeta.feeds[category.key] = previous;
      report.push({ key: category.key, status: '304', detail: 'not modified', added: 0 });
      continue;
    }

    let items;
    try {
      items = parseFeed(response.body);
    } catch (parseError) {
      warn(`[${category.key}] invalid feed: ${parseError.message}`);
      if (previous) nextMeta.feeds[category.key] = previous;
      report.push({ key: category.key, status: 'error', detail: parseError.message, added: 0 });
      continue;
    }

    let added = 0;
    for (const item of items) {
      const id = itemId(item);
      if (!id) continue;
      const known = articles.get(id);
      if (known) {
        // Already processed: only record that it also belongs to this category.
        if (!known.categories.includes(category.key)) {
          articles.set(id, { ...known, categories: [...known.categories, category.key].sort() });
        }
        continue;
      }
      const article = normalizeItem(item, category.key, config.summaryMaxLength);
      if (article) {
        articles.set(id, article);
        added++;
      }
    }

    nextMeta.feeds[category.key] = {
      url,
      etag: response.etag ?? null,
      lastModified: response.lastModified ?? null,
    };
    report.push({ key: category.key, status: String(response.status), detail: `${items.length} items`, added });
  }

  const failed = report.filter((r) => r.status === 'error').length;
  if (failed === config.categories.length) {
    throw new Error('every feed failed; keeping the previously published file untouched');
  }

  // Build the output -------------------------------------------------------
  const categoryKeys = config.categories.map((c) => c.key);
  const sorted = [...articles.values()]
    .map((a) => ({ ...a, categories: a.categories.filter((k) => categoryKeys.includes(k)) }))
    .filter((a) => a.categories.length > 0)
    .sort(compareArticles);
  const retained = applyRetention(sorted, categoryKeys, config.retention);

  const output = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: previousOutput?.generatedAt ?? null,
    source: SOURCE_URL,
    categories: config.categories.map(({ key, label }) => ({
      key,
      label,
      count: retained.filter((a) => a.categories.includes(key)).length,
    })),
    articles: retained,
  };

  const newsChanged = !previousOutput || fingerprint(previousOutput) !== fingerprint(output);
  const metaChanged = JSON.stringify(previousMeta) !== JSON.stringify(nextMeta);

  if (newsChanged) {
    output.generatedAt = new Date().toISOString();
    await writeJson(OUTPUT_PATH, output);
    await writeJsModule(OUTPUT_PATH, 'NEWS_DATA', output);
  }
  if (metaChanged) await writeJson(META_PATH, nextMeta);

  // Report -----------------------------------------------------------------
  const totalAdded = report.reduce((sum, r) => sum + r.added, 0);
  log(`Feeds: ${report.length - failed} ok, ${failed} failed. New articles: ${totalAdded}. Kept: ${retained.length}.`);
  log(newsChanged ? `Wrote ${relative(REPO_ROOT, OUTPUT_PATH)}` : 'No content change.');

  await setOutput('news_changed', String(newsChanged));
  await setOutput('meta_changed', String(metaChanged));
  await addSummary([
    `### Dynatrace news — ${newsChanged ? `${totalAdded} new article(s), file updated` : 'no change'}`,
    '',
    '| Category | Status | Detail | New |',
    '|---|---|---|---|',
    ...report.map((r) => `| ${r.key} | ${r.status} | ${r.detail} | ${r.added} |`),
    '',
    `Articles kept after retention: **${retained.length}**`,
  ].join('\n'));
}

main().catch((error) => {
  console.log(`::error::${error.message}`);
  process.exitCode = 1;
});
