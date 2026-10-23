const RELEASE_CATEGORY_KEY = "release-notes";
const MAX_RELEASES = 30; // releases-list scrolls, so this is a generous cap rather than a hard "top N"
const CATEGORY_PREVIEW_LIMIT = 10; // articles shown inside an expanded sidebar category card
const RECENT_DAYS = 7;

const state = {
  categories: [],
  articles: [],
  activeCategories: new Set(), // empty = no filter (show all)
  expandedCategories: new Set(), // sidebar accordion cards currently open
  query: "",
};

const el = {
  shortcuts: document.getElementById("shortcuts"),
  tagline: document.getElementById("site-tagline"),
  liveClock: document.getElementById("live-clock"),
  searchInput: document.getElementById("search-input"),
  filterWrap: document.getElementById("filter-wrap"),
  filterBtn: document.getElementById("filter-btn"),
  filterBtnBadge: document.getElementById("filter-btn-badge"),
  filterMenu: document.getElementById("filter-menu"),
  filterMenuChips: document.getElementById("filter-menu-chips"),
  filterReset: document.getElementById("filter-reset"),
  releasesWidget: document.getElementById("releases-widget"),
  releasesList: document.getElementById("releases-list"),
  releasesNewBadge: document.getElementById("releases-new-badge"),
  categoryNav: document.getElementById("category-nav"),
  articlesGrid: document.getElementById("articles-grid"),
  articlesTitle: document.getElementById("articles-title"),
  resultCount: document.getElementById("result-count"),
  emptyState: document.getElementById("empty-state"),
  generatedAt: document.getElementById("generated-at"),
  sourceLink: document.getElementById("source-link"),
};

const dateFormatter = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
const clockFormatter = new Intl.DateTimeFormat("fr-FR", {
  weekday: "short", day: "2-digit", month: "short",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function formatDate(iso) {
  if (!iso) return "Date inconnue";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Date inconnue";
  return dateFormatter.format(d);
}

function isRecent(iso) {
  if (!iso) return false;
  const ageMs = Date.now() - new Date(iso).getTime();
  return ageMs >= 0 && ageMs <= RECENT_DAYS * 86_400_000;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function categoryLabel(key) {
  const cat = state.categories.find((c) => c.key === key);
  return cat ? cat.label : key;
}

// ---------- Live clock ----------

function tickClock() {
  el.liveClock.textContent = clockFormatter.format(new Date());
}

// ---------- Shortcuts (from config.js: window.SITE_CONFIG) ----------
//
// Icon resolution: a shortcut uses the remote site's favicon by default; set
// `svg` (raw inline SVG markup) on a shortcut entry to override it.

function faviconUrl(url) {
  try {
    return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(url).hostname}`;
  } catch {
    return null;
  }
}

function buildShortcutIcon(sc) {
  const wrap = document.createElement("span");
  wrap.className = "shortcut-icon-wrap";

  if (sc.svg) {
    wrap.innerHTML = sc.svg; // trusted: static, site-owner-authored config, not user input
    return wrap;
  }

  const favicon = faviconUrl(sc.url);
  if (favicon) {
    const img = document.createElement("img");
    img.src = favicon;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.replaceWith(fallbackIcon(sc.label));
    });
    wrap.appendChild(img);
    return wrap;
  }

  wrap.appendChild(fallbackIcon(sc.label));
  return wrap;
}

function fallbackIcon(label) {
  const span = document.createElement("span");
  span.className = "shortcut-icon-fallback";
  span.textContent = (label || "?").charAt(0).toUpperCase();
  return span;
}

function loadConfig() {
  const config = window.SITE_CONFIG;
  if (!config) {
    console.warn("window.SITE_CONFIG manquant — vérifie que config.js est bien chargé avant script.js.");
    return;
  }

  if (config.site) {
    if (config.site.title) document.title = config.site.title;
    if (config.site.tagline) el.tagline.textContent = config.site.tagline;
  }

  const shortcuts = Array.isArray(config.shortcuts) ? config.shortcuts : [];
  clear(el.shortcuts);
  for (const sc of shortcuts) {
    if (!sc.url || !sc.label) continue;
    const a = document.createElement("a");
    a.className = "shortcut-card";
    a.href = sc.url;
    a.target = "_blank";
    a.rel = "noopener";

    a.appendChild(buildShortcutIcon(sc));

    const label = document.createElement("span");
    label.className = "shortcut-label";
    label.textContent = sc.label;
    a.appendChild(label);

    el.shortcuts.appendChild(a);
  }
}

// ---------- Data (site/data/news.js: window.NEWS_DATA) ----------

function loadNews() {
  const data = window.NEWS_DATA;
  if (!data) {
    throw new Error("window.NEWS_DATA manquant — vérifie que site/data/news.js est bien chargé avant script.js.");
  }
  state.categories = Array.isArray(data.categories) ? data.categories : [];
  state.articles = Array.isArray(data.articles) ? data.articles : [];

  if (data.generatedAt) {
    el.generatedAt.textContent = `Mis à jour le ${formatDate(data.generatedAt)}`;
  }
  if (data.source) {
    el.sourceLink.href = data.source;
  }
}

// ---------- Filter dropdown (multi-select, next to search) ----------

function renderFilterMenu() {
  clear(el.filterMenuChips);

  const sorted = [...state.categories].sort((a, b) => b.count - a.count);
  for (const cat of sorted) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-menu-chip" + (state.activeCategories.has(cat.key) ? " active" : "");

    const label = document.createElement("span");
    label.textContent = cat.label;
    chip.appendChild(label);

    const count = document.createElement("span");
    count.className = "chip-count";
    count.textContent = cat.count;
    chip.appendChild(count);

    chip.addEventListener("click", () => toggleCategoryFilter(cat.key));
    el.filterMenuChips.appendChild(chip);
  }
}

function toggleCategoryFilter(key) {
  if (state.activeCategories.has(key)) {
    state.activeCategories.delete(key);
  } else {
    state.activeCategories.add(key);
  }
  renderFilterMenu();
  updateFilterBadge();
  renderArticles();
}

function updateFilterBadge() {
  const n = state.activeCategories.size;
  el.filterBtnBadge.hidden = n === 0;
  el.filterBtnBadge.textContent = n;
  el.filterBtn.classList.toggle("has-active", n > 0);
}

function openFilterMenu(open) {
  el.filterMenu.hidden = !open;
  el.filterBtn.setAttribute("aria-expanded", String(open));
}

// Hover opens/keeps the menu open; a short close delay absorbs the pixel gap
// between the button and the menu so moving the mouse down doesn't flicker it shut.
let closeTimer = null;
function cancelClose() {
  clearTimeout(closeTimer);
}
function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => openFilterMenu(false), 200);
}

el.filterWrap.addEventListener("mouseenter", () => {
  cancelClose();
  openFilterMenu(true);
});
el.filterWrap.addEventListener("mouseleave", scheduleClose);

// Click toggles too (keyboard/touch, no hover available). Clicks inside the
// wrap (chips, reset button) must never bubble to the document-level closer
// below — the chip list gets rebuilt on every selection, so by the time a
// document listener saw `e.target` it could already be detached from the DOM.
el.filterBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  cancelClose();
  openFilterMenu(el.filterMenu.hidden);
});
el.filterWrap.addEventListener("click", (e) => e.stopPropagation());

document.addEventListener("click", () => openFilterMenu(false));

el.filterReset.addEventListener("click", () => {
  state.activeCategories.clear();
  renderFilterMenu();
  updateFilterBadge();
  renderArticles();
});

// ---------- Category accordion (sidebar) ----------

function renderCategoryNav() {
  clear(el.categoryNav);

  const sorted = state.categories
    .filter((c) => c.key !== RELEASE_CATEGORY_KEY)
    .sort((a, b) => b.count - a.count);

  for (const cat of sorted) {
    const card = document.createElement("div");
    card.className = "category-card" + (cat.count === 0 ? " is-empty" : "");

    const expanded = state.expandedCategories.has(cat.key);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "category-card-header";
    header.setAttribute("aria-expanded", String(expanded));

    const label = document.createElement("span");
    label.textContent = cat.label;
    header.appendChild(label);

    const count = document.createElement("span");
    count.className = "cat-count";
    count.textContent = cat.count;
    header.appendChild(count);

    const chevron = document.createElement("span");
    chevron.className = "cat-chevron" + (expanded ? " expanded" : "");
    chevron.textContent = "▾";
    chevron.setAttribute("aria-hidden", "true");
    header.appendChild(chevron);

    header.addEventListener("click", () => toggleCategoryExpand(cat.key));
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "category-card-body";
    body.hidden = !expanded;

    const items = state.articles
      .filter((a) => (a.categories || []).includes(cat.key))
      .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
      .slice(0, CATEGORY_PREVIEW_LIMIT);

    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "mini-empty";
      empty.textContent = "Aucun article.";
      body.appendChild(empty);
    } else {
      for (const article of items) body.appendChild(buildMiniArticleRow(article));
    }

    card.appendChild(body);
    el.categoryNav.appendChild(card);
  }
}

function toggleCategoryExpand(key) {
  if (state.expandedCategories.has(key)) {
    state.expandedCategories.delete(key);
  } else {
    state.expandedCategories.add(key);
  }
  renderCategoryNav();
}

function buildMiniArticleRow(article) {
  const a = document.createElement("a");
  a.className = "mini-article-row";
  a.href = article.link;
  a.target = "_blank";
  a.rel = "noopener";

  const title = document.createElement("span");
  title.className = "mini-article-title";
  title.textContent = article.title;
  a.appendChild(title);

  const date = document.createElement("span");
  date.className = "mini-article-date";
  date.textContent = formatDate(article.publishedAt);
  a.appendChild(date);

  return a;
}

// ---------- Releases widget (sidebar, always expanded, scrollable) ----------

function renderReleasesWidget() {
  const releases = state.articles
    .filter((a) => Array.isArray(a.categories) && a.categories.includes(RELEASE_CATEGORY_KEY))
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, MAX_RELEASES);

  clear(el.releasesList);

  if (releases.length === 0) {
    el.releasesWidget.hidden = true;
    return;
  }
  el.releasesWidget.hidden = false;

  const recentCount = releases.filter((r) => isRecent(r.publishedAt)).length;
  el.releasesNewBadge.hidden = recentCount === 0;
  if (recentCount > 0) {
    el.releasesNewBadge.textContent = `${recentCount} nouvelle${recentCount > 1 ? "s" : ""} < 7j`;
  }

  for (const article of releases) {
    const a = document.createElement("a");
    a.className = "release-row";
    a.href = article.link;
    a.target = "_blank";
    a.rel = "noopener";

    const head = document.createElement("div");
    head.className = "release-row-head";

    const badge = document.createElement("span");
    badge.className = "release-badge";
    badge.textContent = "🚀 Release";
    head.appendChild(badge);

    if (isRecent(article.publishedAt)) {
      const newBadge = document.createElement("span");
      newBadge.className = "badge-new";
      newBadge.textContent = "Nouveau";
      head.appendChild(newBadge);
    }
    a.appendChild(head);

    const h3 = document.createElement("h3");
    h3.textContent = article.title;
    a.appendChild(h3);

    const date = document.createElement("span");
    date.className = "release-date";
    date.textContent = formatDate(article.publishedAt);
    a.appendChild(date);

    el.releasesList.appendChild(a);
  }
}

// ---------- Article grid ----------

function matchesFilters(article) {
  if (state.activeCategories.size > 0) {
    const cats = article.categories || [];
    if (!cats.some((c) => state.activeCategories.has(c))) return false;
  }
  if (state.query) {
    const haystack = article.search || `${article.title} ${article.summary}`.toLowerCase();
    return haystack.includes(state.query);
  }
  return true;
}

function renderArticles() {
  const filtered = state.articles.filter(matchesFilters);

  const n = state.activeCategories.size;
  el.articlesTitle.textContent =
    n === 0 ? "Toutes les actualités"
    : n === 1 ? categoryLabel([...state.activeCategories][0])
    : `${n} catégories sélectionnées`;
  el.resultCount.textContent = `${filtered.length} article${filtered.length > 1 ? "s" : ""}`;

  clear(el.articlesGrid);
  el.emptyState.hidden = filtered.length > 0;

  for (const article of filtered) {
    el.articlesGrid.appendChild(buildArticleCard(article));
  }
}

function buildArticleCard(article) {
  const a = document.createElement("a");
  a.className = "article-card";
  a.href = article.link;
  a.target = "_blank";
  a.rel = "noopener";

  if (article.image) {
    const img = document.createElement("img");
    img.className = "article-image";
    img.src = article.image;
    img.loading = "lazy";
    img.alt = "";
    img.addEventListener("error", () => img.remove());
    a.appendChild(img);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "article-image-fallback";
    fallback.textContent = (article.title || "?").charAt(0).toUpperCase();
    a.appendChild(fallback);
  }

  const body = document.createElement("div");
  body.className = "article-body";

  const tags = document.createElement("div");
  tags.className = "article-tags";
  for (const key of (article.categories || []).slice(0, 3)) {
    const tag = document.createElement("span");
    tag.className = "article-tag";
    tag.textContent = categoryLabel(key);
    tags.appendChild(tag);
  }
  body.appendChild(tags);

  const h3 = document.createElement("h3");
  h3.textContent = article.title;
  body.appendChild(h3);

  const summary = document.createElement("p");
  summary.className = "article-summary";
  summary.textContent = article.summary || "";
  body.appendChild(summary);

  const meta = document.createElement("div");
  meta.className = "article-meta";
  const author = document.createElement("span");
  author.textContent = article.author || "";
  const date = document.createElement("span");
  date.textContent = formatDate(article.publishedAt);
  meta.appendChild(author);
  meta.appendChild(date);
  body.appendChild(meta);

  a.appendChild(body);
  return a;
}

// ---------- Search ----------

let searchDebounce;
el.searchInput.addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  const value = e.target.value;
  searchDebounce = setTimeout(() => {
    state.query = value.trim().toLowerCase();
    renderArticles();
  }, 150);
});

// ---------- Boot ----------

function init() {
  tickClock();
  setInterval(tickClock, 1000);

  loadConfig();
  loadNews();
  renderFilterMenu();
  updateFilterBadge();
  renderCategoryNav();
  renderReleasesWidget();
  renderArticles();
}

try {
  init();
} catch (err) {
  console.error(err);
  el.articlesTitle.textContent = "Erreur de chargement";
  el.resultCount.textContent = "";
  const msg = document.createElement("p");
  msg.className = "empty-state";
  msg.textContent = "Impossible de charger les données (site/data/news.js).";
  el.articlesGrid.appendChild(msg);
}
