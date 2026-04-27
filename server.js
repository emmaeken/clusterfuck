require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;
const GUARDIAN_API_KEY = process.env.GUARDIAN_API_KEY || 'test';
const USE_NEWS_API = process.env.USE_NEWS_API !== 'false';

app.use(express.json());

const USE_OPENAI_FEATURES = false;
const client = USE_OPENAI_FEATURES && process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(express.static(path.join(__dirname, 'public')));

function cleanArticleText(text = '') {
  return String(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
}

function toPlainSearchQuery(text = '') {
  return cleanArticleText(text)
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[()]/g, ' ')
    .replace(/\b(?:AND|OR|NOT)\b/gi, ' ')
    .replace(/["']/g, ' ')
    .replace(/[^a-z0-9\s-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'event';
}

function extractJsonArray(text = '') {
  const match = String(text).match(/\[[\s\S]*\]/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function uniqueSourceNames(articles = []) {
  return [...new Set(
    articles.map(article => getArticleSourceName(article)).filter(Boolean)
  )];
}

function getArticleSourceName(article = {}) {
  const sourceName = cleanArticleText(article.source?.name || '');
  if (sourceName) return sourceName;

  try {
    return new URL(article.url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function collectSourceLinks(articles = [], limit = 6) {
  const links = [];
  const seenSources = new Set();

  for (const article of articles) {
    const url = cleanArticleText(article.url || '');
    const sourceName = getArticleSourceName(article);
    const sourceKey = sourceName.toLowerCase();

    if (!url || !sourceName || seenSources.has(sourceKey)) continue;

    seenSources.add(sourceKey);
    links.push({
      sourceName,
      title: cleanArticleText(article.title || sourceName),
      url
    });

    if (links.length >= limit) break;
  }

  return links;
}

const QUERY_STOPWORDS = new Set([
  'about', 'after', 'before', 'from', 'into', 'over', 'under', 'with',
  'this', 'that', 'these', 'those', 'have', 'will', 'what', 'when',
  'where', 'which', 'their', 'there', 'than', 'them', 'they', 'your',
  'topic', 'latest', 'news', 'update', 'updates', 'overview'
]);

function extractQueryTerms(query = '') {
  return cleanArticleText(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(term => term.length > 2 && !QUERY_STOPWORDS.has(term));
}

function scoreArticleRelevance(article = {}, queryTerms = []) {
  if (!queryTerms.length) return 0;

  const title = cleanArticleText(article.title || '').toLowerCase();
  const description = cleanArticleText(article.description || '').toLowerCase();
  const sourceName = getArticleSourceName(article).toLowerCase();

  return queryTerms.reduce((score, term) => {
    let nextScore = score;
    if (title.includes(term)) nextScore += 5;
    if (description.includes(term)) nextScore += 2;
    if (sourceName.includes(term)) nextScore += 1;
    return nextScore;
  }, 0);
}

function getPublishedAtValue(article = {}) {
  const publishedAt = article.publishedAt ? new Date(article.publishedAt) : null;
  return publishedAt && !isNaN(publishedAt) ? publishedAt.getTime() : 0;
}

function prioritizeArticles(articles = [], query = '', limit = 5) {
  const queryTerms = extractQueryTerms(query);
  const seenUrls = new Set();
  const seenTitles = new Set();

  const deduped = articles
    .filter(article => {
      const title = cleanArticleText(article.title || '');
      const url = cleanArticleText(article.url || '');

      if (!title || title === '[Removed]' || !url) return false;

      const titleKey = title.toLowerCase();
      if (seenUrls.has(url) || seenTitles.has(titleKey)) return false;

      seenUrls.add(url);
      seenTitles.add(titleKey);
      return true;
    })
    .map(article => ({
      ...article,
      _publishedAtValue: getPublishedAtValue(article),
      _relevanceScore: scoreArticleRelevance(article, queryTerms),
      _sourceKey: getArticleSourceName(article).toLowerCase()
    }))
    .sort((a, b) => {
      if (b._relevanceScore !== a._relevanceScore) {
        return b._relevanceScore - a._relevanceScore;
      }

      return b._publishedAtValue - a._publishedAtValue;
    });

  const selected = [];
  const overflow = [];
  const seenSources = new Set();

  deduped.forEach(article => {
    if (selected.length < limit && article._sourceKey && !seenSources.has(article._sourceKey)) {
      seenSources.add(article._sourceKey);
      selected.push(article);
      return;
    }

    overflow.push(article);
  });

  for (const article of overflow) {
    if (selected.length >= limit) break;
    selected.push(article);
  }

  return selected.slice(0, limit).map(article => {
    const { _publishedAtValue, _relevanceScore, _sourceKey, ...cleanArticle } = article;
    return cleanArticle;
  });
}

function getTopicSearchProfile(topicKey = '') {
  const profiles = {
    politics: {
      newsApiQuery: '"US politics" AND (Trump OR "White House" OR Congress OR "Supreme Court" OR immigration OR redistricting OR Iran)',
      guardianQuery: '"US politics" OR Trump OR "White House" OR Congress OR "Supreme Court" OR immigration OR redistricting OR Iran',
      guardianSection: 'us-news'
    },
    ukraine: {
      newsApiQuery: '(Ukraine OR Ukrainian) AND (Russia OR Kremlin OR battlefield OR frontline OR aid OR ceasefire)',
      guardianQuery: 'Ukraine OR Ukrainian OR Russia OR Kremlin OR battlefield OR frontline OR aid OR ceasefire',
      guardianSection: 'world'
    },
    climate: {
      newsApiQuery: '("climate change" OR "global warming") AND (emissions OR renewable OR "extreme weather" OR COP OR policy)',
      guardianQuery: '"climate change" OR "global warming" OR emissions OR renewable OR "extreme weather" OR COP OR policy',
      guardianSection: 'environment'
    }
  };

  return profiles[topicKey] || null;
}

function getEffectiveQuery(rawQuery = '', topicKey = '', kind = '', provider = 'newsapi') {
  const cleanedQuery = cleanArticleText(rawQuery);
  const profile = getTopicSearchProfile(topicKey);
  const wantsStructuredTopicQuery = ['main', 'month'].includes(kind);

  if (!wantsStructuredTopicQuery) {
    return toPlainSearchQuery(cleanedQuery) || cleanedQuery;
  }

  if (!profile) return cleanedQuery;

  return provider === 'guardian'
    ? profile.guardianQuery
    : profile.newsApiQuery;
}

async function readJsonResponse(response, providerName = 'API') {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${providerName} returned invalid JSON`);
  }
}

function normalizeNewsApiArticle(article = {}) {
  return {
    title: cleanArticleText(article.title || ''),
    description: cleanArticleText(article.description || ''),
    url: cleanArticleText(article.url || ''),
    image: cleanArticleText(article.urlToImage || article.image || ''),
    source: {
      name: cleanArticleText(article.source?.name || '') || 'Unknown source'
    },
    publishedAt: cleanArticleText(article.publishedAt || ''),
    provider: 'newsapi'
  };
}

function normalizeGuardianArticle(item = {}) {
  const sectionName = cleanArticleText(item.sectionName || '');

  return {
    title: cleanArticleText(item.webTitle || ''),
    description: cleanArticleText(item.fields?.trailText || ''),
    url: cleanArticleText(item.webUrl || ''),
    image: cleanArticleText(item.fields?.thumbnail || ''),
    source: {
      name: sectionName ? `The Guardian | ${sectionName}` : 'The Guardian'
    },
    publishedAt: cleanArticleText(item.webPublicationDate || ''),
    provider: 'guardian'
  };
}

function buildFallbackReason(code = '', detail = '') {
  const safeCode = cleanArticleText(code).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  const safeDetail = cleanArticleText(detail).replace(/\s+/g, ' ').slice(0, 160);
  return safeDetail ? `${safeCode}:${safeDetail}` : safeCode;
}

function pickNextUniqueArticle(queue = [], seenUrls = new Set(), seenTitles = new Set()) {
  while (queue.length) {
    const article = queue.shift();
    const url = cleanArticleText(article.url || '');
    const title = cleanArticleText(article.title || '');
    const titleKey = title.toLowerCase();

    if (!url || !title || seenUrls.has(url) || seenTitles.has(titleKey)) continue;

    seenUrls.add(url);
    seenTitles.add(titleKey);
    return article;
  }

  return null;
}

function mergeProviderArticles(providerBuckets = {}, query = '', limit = 8) {
  const providerNames = Object.keys(providerBuckets).filter(name => {
    return Array.isArray(providerBuckets[name]) && providerBuckets[name].length > 0;
  });

  if (!providerNames.length) return [];

  const providerQueues = Object.fromEntries(
    providerNames.map(name => [
      name,
      prioritizeArticles(providerBuckets[name], query, providerBuckets[name].length)
    ])
  );

  const providerOrder = [...providerNames].sort((a, b) => {
    const byDate = getPublishedAtValue(providerQueues[b][0]) - getPublishedAtValue(providerQueues[a][0]);
    if (byDate !== 0) return byDate;
    return providerQueues[b].length - providerQueues[a].length;
  });

  const selected = [];
  const seenUrls = new Set();
  const seenTitles = new Set();

  while (selected.length < limit) {
    let addedThisRound = false;

    for (const providerName of providerOrder) {
      const article = pickNextUniqueArticle(
        providerQueues[providerName],
        seenUrls,
        seenTitles
      );

      if (!article) continue;

      selected.push(article);
      addedThisRound = true;

      if (selected.length >= limit) break;
    }

    if (!addedThisRound) break;
  }

  return selected.slice(0, limit);
}

function countArticlesByProvider(articles = []) {
  return articles.reduce((counts, article) => {
    const providerName = cleanArticleText(article.provider || '').toLowerCase();
    if (!providerName) return counts;

    counts[providerName] = (counts[providerName] || 0) + 1;
    return counts;
  }, {});
}

async function fetchNewsApiArticles({
  query = '',
  topicKey = '',
  from = '',
  to = '',
  limit = 8,
  fetchPageSize = 12,
  sortBy = 'publishedAt',
  kind = ''
}) {
  const apiKey = process.env.NEWS_API_KEY;

  if (!apiKey) {
    throw new Error('NEWS_API_KEY not set');
  }

  const effectiveQuery = getEffectiveQuery(query, topicKey, kind, 'newsapi');
  const url = new URL('https://newsapi.org/v2/everything');
  url.searchParams.set('q', effectiveQuery || query);
  url.searchParams.set('language', 'en');
  url.searchParams.set('searchIn', 'title,description');
  url.searchParams.set('sortBy', sortBy);
  url.searchParams.set('pageSize', String(fetchPageSize));
  url.searchParams.set('apiKey', apiKey);

  if (from) url.searchParams.set('from', from);
  if (to) url.searchParams.set('to', to);

  const response = await fetch(url.toString());
  const data = await readJsonResponse(response, 'NewsAPI');

  if (!response.ok || data.status === 'error') {
    const message = cleanArticleText(
      data.message || `NewsAPI request failed with status ${response.status}`
    );
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const normalizedArticles = (data.articles || []).map(normalizeNewsApiArticle);
  return prioritizeArticles(normalizedArticles, effectiveQuery || query, limit);
}

async function fetchGuardianArticles({
  query = '',
  topicKey = '',
  from = '',
  to = '',
  limit = 8,
  fetchPageSize = 10,
  sortBy = 'publishedAt',
  kind = ''
}) {
  const providerQuery = getEffectiveQuery(query, topicKey, kind, 'guardian');
  const profile = getTopicSearchProfile(topicKey);
  const url = new URL('https://content.guardianapis.com/search');

  url.searchParams.set('api-key', GUARDIAN_API_KEY);
  url.searchParams.set('q', providerQuery || cleanArticleText(query));
  url.searchParams.set('page-size', String(Math.min(Math.max(fetchPageSize, 1), 25)));
  url.searchParams.set('order-by', sortBy === 'publishedAt' ? 'newest' : 'relevance');
  url.searchParams.set('show-fields', 'trailText,thumbnail');

  if (from) url.searchParams.set('from-date', from);
  if (to) url.searchParams.set('to-date', to);
  if (profile?.guardianSection) url.searchParams.set('section', profile.guardianSection);

  const response = await fetch(url.toString());
  const data = await readJsonResponse(response, 'The Guardian API');

  if (!response.ok || data?.response?.status !== 'ok') {
    const message = data?.response?.message || data?.message || 'Guardian archive request failed';
    throw new Error(message);
  }

  const articles = (data.response?.results || []).map(normalizeGuardianArticle);

  return prioritizeArticles(articles, providerQuery || query, limit);
}

function getBriefingFocus(topicKey = '') {
  const focus = {
    politics: 'White House security, Trump administration policy, courts, Congress, immigration, foreign policy, and 2026 election map fights',
    ukraine: 'battlefield conditions, diplomacy, military support, and civilian impact',
    climate: 'policy decisions, emissions pressure, energy choices, and visible climate impacts'
  };
  return focus[topicKey] || 'the main actors, decisions, consequences, and public response';
}

function getTopicDisplayName(topicKey = '') {
  const names = {
    politics: 'US Politics',
    ukraine: 'Ukraine Conflict',
    climate: 'Climate'
  };
  return names[topicKey] || 'This topic';
}

function cleanBriefingPoint(article = {}) {
  const raw = cleanArticleText(article.title || article.description || '');
  if (!raw) return '';

  return raw
    .replace(/\s+[-|]\s+[^-|]{2,48}$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .slice(0, 150)
    .trim();
}

function uniqueBriefingPoints(articles = [], limit = 4) {
  const seen = new Set();
  const points = [];

  for (const article of articles) {
    const point = cleanBriefingPoint(article);
    const key = point.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
    if (!point || seen.has(key)) continue;

    seen.add(key);
    points.push(point);
    if (points.length >= limit) break;
  }

  return points;
}

function joinBriefingPoints(points = []) {
  if (points.length <= 1) return points[0] || '';
  if (points.length === 2) return `${points[0]} and ${points[1]}`;
  return `${points.slice(0, -1).join(', ')}, and ${points[points.length - 1]}`;
}

function buildFallbackTopicSummary(mode = 'short', articles = [], topicKey = '') {
  const picked = articles.slice(0, mode === 'long' ? 6 : 5);
  const points = uniqueBriefingPoints(picked, mode === 'long' ? 5 : 3);
  const sources = uniqueSourceNames(picked).slice(0, mode === 'long' ? 4 : 3);
  const sourceLinks = collectSourceLinks(picked);
  const topicName = getTopicDisplayName(topicKey);
  const focus = getBriefingFocus(topicKey);

  if (mode === 'long') {
    const firstParagraph = points[0]
      ? `${topicName} is currently anchored by ${points[0]}. This is the lead item in the latest coverage, and it gives the topic its immediate direction.`
      : `${topicName} is currently moving through several connected developments. The latest coverage gives a broad view rather than one single settled storyline.`;
    const middlePoints = points.slice(1, 4);
    const secondParagraph = middlePoints.length
      ? `The surrounding coverage adds context around ${joinBriefingPoints(middlePoints)}. Read together, those updates show how the story connects across ${focus}.`
      : `The surrounding coverage is useful because it connects the immediate news to ${focus}.`;
    const thirdParagraph = sources.length
      ? `This brief draws on reporting from ${joinBriefingPoints(sources)}. The source trail below is there so you can open the original articles and check the details directly.`
      : 'The source trail below is there so you can open the original articles and check the details directly.';

    return {
      longSummary: `${firstParagraph}\n\n${secondParagraph}\n\n${thirdParagraph}`,
      sources: sourceLinks
    };
  }

  const lead = points[0]
    ? `${topicName} is currently led by one clear development: ${points[0]}.`
    : `${topicName} is moving through several connected developments.`;
  const second = points.length > 1
    ? `Related coverage also points to ${joinBriefingPoints(points.slice(1))}.`
    : `The story is best read through ${focus}.`;
  const third = `Together, the articles frame the topic through ${focus}.`;

  return {
    shortSummary: `${lead} ${second} ${third}`
  };
}

function buildFallbackTimelineEvents(topicKey, topicName, articles = []) {
  const picked = (articles || []).slice(0, 4);

  return picked.map((article, index) => {
    const rawLabel = cleanArticleText(article.title || article.description || `${topicName} update`);
    const label = rawLabel.split(/[:\-|]/)[0].slice(0, 42) || `${topicName} update ${index + 1}`;
    const safeLabelQuery = toPlainSearchQuery(label);
    const safeTopicQuery = toPlainSearchQuery(topicName);
    const backgroundQuery = [safeLabelQuery, safeTopicQuery, 'overview']
      .filter(Boolean)
      .join(' ');
    const latestQuery = [safeLabelQuery, safeTopicQuery, 'latest']
      .filter(Boolean)
      .join(' ');
    const publishedAt = article.publishedAt ? new Date(article.publishedAt) : null;
    const dateLabel = publishedAt && !isNaN(publishedAt)
      ? publishedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'Now';

    return {
      id: `${topicKey}-${slugify(label)}`,
      label,
      dateLabel,
      importance: index === 0 ? 'high' : 'medium',
      backgroundQuery: backgroundQuery || safeTopicQuery || topicKey,
      latestQuery: latestQuery || safeTopicQuery || topicKey,
      whyItMatters: cleanArticleText(article.description || article.title).slice(0, 180) || `A major live development inside ${topicName}.`
    };
  });
}

function getPinnedDetailTimelineEvents(topicKey = '') {
  if (topicKey !== 'politics') return [];
  return [
    {
      id: 'white-house-dinner-shooting',
      label: 'WHCD shooting',
      date: '2026-04-27',
      dateLabel: 'Apr 27',
      importance: 'high',
      eventType: 'story',
      backgroundQuery: 'White House Correspondents Dinner shooting suspect charges Trump Secret Service overview',
      latestQuery: 'White House Correspondents Dinner shooting latest Trump Secret Service',
      whyItMatters: 'The shooting has put presidential-event security, Secret Service protocols and the political climate around Trump back at the center of the US politics story.'
    }
  ];
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function getBroadTopicEvents(topicKey, topicName, mainQuery = '') {
  const baseline = new Date();
  const startOfCurrentMonth = new Date(Date.UTC(
    baseline.getUTCFullYear(),
    baseline.getUTCMonth(),
    1
  ));
  const cleanedQuery = cleanArticleText(mainQuery || topicName || topicKey);
  const monthOffsets = [1, 0, ...Array.from({ length: 10 }, (_, index) => -(index + 1))];

  return monthOffsets.map((monthOffset, index) => {
    const monthStart = new Date(Date.UTC(
      startOfCurrentMonth.getUTCFullYear(),
      startOfCurrentMonth.getUTCMonth() + monthOffset,
      1
    ));
    const monthEnd = new Date(Date.UTC(
      monthStart.getUTCFullYear(),
      monthStart.getUTCMonth() + 1,
      0
    ));
    const longLabel = monthStart.toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    });
    const shortLabel = monthStart.toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    });

    return {
      id: `${topicKey}-month-${formatIsoDate(monthStart).slice(0, 7)}`,
      label: longLabel,
      dateLabel: shortLabel,
      importance: index < 3 ? 'high' : 'medium',
      eventType: 'month',
      query: cleanedQuery,
      fromDate: formatIsoDate(monthStart),
      toDate: formatIsoDate(monthEnd),
      backgroundQuery: cleanedQuery,
      latestQuery: cleanedQuery
    };
  });
}

function buildTimelineEventPayload(topicKey, topicName, mainQuery = '', articles = []) {
  return {
    overviewEvents: getBroadTopicEvents(topicKey, topicName, mainQuery),
    detailEvents: [
      ...getPinnedDetailTimelineEvents(topicKey),
      ...buildFallbackTimelineEvents(topicKey, topicName, articles)
    ]
  };
}

function buildFallbackEventOverview(topicName, eventLabel, articles = [], eventType = 'story') {
  const picked = articles.slice(0, 4);
  const details = picked
    .map(article => cleanArticleText(article.description || article.title))
    .filter(Boolean);
  const sources = uniqueSourceNames(picked);

  if (eventType === 'month') {
    const first = details[0] || `${topicName} in ${eventLabel} was shaped by several connected developments.`;
    const second = details[1] || `The coverage from ${eventLabel} points to a month where the story kept moving across multiple fronts.`;
    const third = sources.length
      ? `The strongest reporting for ${eventLabel} came from outlets including ${sources.join(', ')}.`
      : `The linked articles below capture the clearest reporting we found for ${eventLabel}.`;

    return `${first} ${second} ${third}`.trim();
  }

  const first = details[0] || `${eventLabel} is one of the main developments inside ${topicName}.`;
  const second = details[1] || 'Coverage suggests the story is still active and evolving.';
  const third = sources.length
    ? `Recent reporting from ${sources.join(', ')} keeps this storyline in focus.`
    : 'Recent reporting across multiple outlets keeps this storyline in focus.';

  return `${first} ${second} ${third}`.trim();
}

app.get('/api/news', async (req, res) => {
  const { q } = req.query;
  const hasNewsApiKey = Boolean(process.env.NEWS_API_KEY);
  const canUseNewsApi = USE_NEWS_API && hasNewsApiKey;
  const topicKey = cleanArticleText(req.query.topicKey || '');
  const kind = cleanArticleText(req.query.kind || '');
  const provider = cleanArticleText(req.query.provider || '');
  const strictGuardianProvider = provider === 'guardian';
  const strictNewsApiProvider = provider === 'newsapi';
  const forceGuardian = kind === 'month' && !strictNewsApiProvider;

  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter ?q=' });
  }

  try {
    const from = cleanArticleText(req.query.from || '');
    const to = cleanArticleText(req.query.to || '');
    const sortBy = ['publishedAt', 'relevancy', 'popularity'].includes(req.query.sortBy)
      ? req.query.sortBy
      : 'publishedAt';
    const requestedPageSize = Number.parseInt(req.query.pageSize, 10);
    const limit = Number.isFinite(requestedPageSize)
      ? Math.min(Math.max(requestedPageSize, 1), 12)
      : 5;
    const fetchPageSize = Math.min(Math.max(limit * 3, 12), 36);
    const safeQuery = cleanArticleText(q);
    const fetchOptions = {
      query: q,
      topicKey,
      from,
      to,
      limit,
      fetchPageSize,
      sortBy,
      kind
    };

    if (strictGuardianProvider || forceGuardian) {
      try {
        const articles = await fetchGuardianArticles(fetchOptions);

        console.info(
          `[api/news] The Guardian served "${safeQuery}" with ${articles.length} articles${forceGuardian && !strictGuardianProvider ? ' (forced provider).' : '.'}`
        );
        return res.json({
          articles,
          provider: 'guardian',
          providerBreakdown: countArticlesByProvider(articles),
          fallbackReason: 'forced_guardian_provider'
        });
      } catch (guardianErr) {
        console.warn(`[api/news] Guardian request failed for "${safeQuery}".`, guardianErr.message);
        return res.status(500).json({
          error: guardianErr.message || 'Guardian request failed'
        });
      }
    }

    if (strictNewsApiProvider) {
      if (!canUseNewsApi) {
        return res.status(500).json({
          error: buildFallbackReason(hasNewsApiKey ? 'newsapi_disabled' : 'newsapi_key_missing')
        });
      }

      const articles = await fetchNewsApiArticles(fetchOptions);
      console.info(`[api/news] NewsAPI served "${safeQuery}" with ${articles.length} articles (forced provider).`);
      return res.json({
        articles,
        provider: 'newsapi',
        providerBreakdown: countArticlesByProvider(articles)
      });
    }

    const providerTasks = [
      {
        name: 'guardian',
        task: fetchGuardianArticles(fetchOptions)
      }
    ];
    const fallbackReasons = [];

    if (canUseNewsApi) {
      providerTasks.unshift({
        name: 'newsapi',
        task: fetchNewsApiArticles(fetchOptions)
      });
    } else {
      fallbackReasons.push(
        buildFallbackReason(hasNewsApiKey ? 'newsapi_disabled' : 'newsapi_key_missing')
      );
    }

    const results = await Promise.allSettled(providerTasks.map(providerTask => providerTask.task));
    const providerBuckets = {};

    results.forEach((result, index) => {
      const providerName = providerTasks[index].name;

      if (result.status === 'fulfilled') {
        providerBuckets[providerName] = result.value;
        return;
      }

      fallbackReasons.push(
        buildFallbackReason(`${providerName}_failed`, result.reason?.message || 'request failed')
      );
    });

    const articles = mergeProviderArticles(providerBuckets, q, limit);
    const providerBreakdown = countArticlesByProvider(articles);
    const providersUsed = Object.keys(providerBreakdown);
    const responseProvider = providersUsed.length > 1
      ? 'mixed'
      : providersUsed[0] || Object.keys(providerBuckets)[0] || 'unknown';
    const fallbackReason = fallbackReasons.filter(Boolean).join(' | ');

    if (articles.length > 0 || Object.keys(providerBuckets).length > 0) {
      console.info(
        `[api/news] ${responseProvider === 'mixed' ? 'Mixed provider feed' : responseProvider} served "${safeQuery}" with ${articles.length} articles.`
      );
      return res.json({
        articles,
        provider: responseProvider,
        providerBreakdown,
        fallbackReason
      });
    }

    return res.status(500).json({
      error: fallbackReason || 'Both NewsAPI and The Guardian API failed'
    });
  } catch (err) {
    console.error('Proxy fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch articles: ' + err.message });
  }
});
app.get('/api/hello', (req, res) => {
  res.json({ message: 'hello from the RIGHT server file' });
});
app.post('/api/summary', async (req, res) => {
  try {
    const { mode = 'short', articles = [], topicKey = '' } = req.body;

    if (!Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ error: 'No articles provided' });
    }

    if (!USE_OPENAI_FEATURES || !client) {
      return res.json(buildFallbackTopicSummary(mode, articles, topicKey));
    }

    const picked = articles.slice(0, 5);

    const articleText = picked.map((a, i) => `
Article ${i + 1}
Title: ${a.title || 'No title'}
Description: ${a.description || ''}
Source: ${a.source?.name || 'Unknown source'}
URL: ${a.url || ''}
`).join('\n');

    const prompt =
      mode === 'long'
        ? `You are writing a clear news briefing for an interactive news interface.
Summarize this topic in 2 short paragraphs.
Start with the main development, then explain the related developments and why they matter together.
Avoid vague phrases like "fast-moving topic" unless the articles directly support them.
Only use the article information below.
Do not invent facts.

${articleText}`
        : `You are writing a short news briefing for an interactive news interface.
Summarize what is happening right now in 3 to 4 sentences.
Start with the main development, then connect 1 or 2 related developments.
Be clear, simple, and factual.
Avoid repeating article titles verbatim unless needed for clarity.
Only use the article information below.
Do not invent facts.

${articleText}`;

    const response = await client.responses.create({
      model: 'gpt-4o-mini',
      input: prompt
    });

    const text = response.output_text?.trim();

    if (!text) {
      return res.status(500).json({ error: 'No AI response returned' });
    }

    if (mode === 'long') {
      return res.json({
        longSummary: text,
        sources: collectSourceLinks(picked)
      });
    }

    return res.json({
      shortSummary: text
    });
  } catch (err) {
    console.error('OPENAI SUMMARY ERROR FULL:', err);
    return res.status(500).json({
      error: err.message,
      details: err?.status ? `status ${err.status}` : 'no status'
    });
  }
});

app.post('/api/timeline-events', async (req, res) => {
  try {
    const { topicKey = '', topicName = '', mainQuery = '', articles = [] } = req.body;

    if (!Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ error: 'No articles provided' });
    }

    if (!USE_OPENAI_FEATURES || !client) {
      return res.json(buildTimelineEventPayload(topicKey, topicName || topicKey, mainQuery, articles));
    }

    const picked = articles.slice(0, 8);
    const articleText = picked.map((a, i) => `
Article ${i + 1}
Title: ${cleanArticleText(a.title || '')}
Description: ${cleanArticleText(a.description || '')}
Source: ${cleanArticleText(a.source?.name || 'Unknown source')}
Published: ${cleanArticleText(a.publishedAt || '')}
URL: ${cleanArticleText(a.url || '')}
`).join('\n');

    const prompt = `You are helping build a live news topic timeline UI.

Topic key: ${topicKey}
Topic name: ${topicName}
Main query: ${mainQuery}

Based only on the article list below, identify 3 to 5 major current happenings inside this topic.
Choose only big storylines, not small one-off updates.
Examples of acceptable event labels: "Iran strike", "Epstein files", "COP talks", "Aid package", "Ceasefire push".

Return JSON only as an array. Each item must have:
- id: short kebab-case id
- label: 2 to 5 words
- dateLabel: short display text like "Apr 7" or "This week"
- importance: "high" or "medium"
- backgroundQuery: a search query for overview/background articles about the happening
- latestQuery: a search query for the most recent coverage of the happening
- whyItMatters: one sentence under 140 characters

Do not include markdown. Do not include any text before or after the JSON.

Articles:
${articleText}`;

    const response = await client.responses.create({
      model: 'gpt-4o-mini',
      input: prompt
    });

    const text = response.output_text?.trim() || '';
    const parsed = extractJsonArray(text);

    if (!parsed || parsed.length === 0) {
      return res.json(buildTimelineEventPayload(topicKey, topicName || topicKey, mainQuery, articles));
    }

    const events = parsed
      .slice(0, 5)
      .map((event, index) => {
        const label = cleanArticleText(event.label || `Event ${index + 1}`).slice(0, 50);
        const dateLabel = cleanArticleText(event.dateLabel || 'Now').slice(0, 18);
        const backgroundQuery = cleanArticleText(event.backgroundQuery || `${label} ${topicName} overview`);
        const latestQuery = cleanArticleText(event.latestQuery || `${label} latest news`);
        const whyItMatters = cleanArticleText(event.whyItMatters || `A major current development in ${topicName}.`).slice(0, 140);

        return {
          id: slugify(event.id || `${topicKey}-${label}`),
          label,
          dateLabel,
          importance: event.importance === 'high' ? 'high' : 'medium',
          backgroundQuery,
          latestQuery,
          whyItMatters
        };
      })
      .filter(event => event.label && event.backgroundQuery && event.latestQuery);

    return res.json({
      overviewEvents: getBroadTopicEvents(topicKey, topicName || topicKey, mainQuery),
      detailEvents: events.length
        ? events
        : buildFallbackTimelineEvents(topicKey, topicName || topicKey, articles)
    });
  } catch (err) {
    console.error('TIMELINE EVENTS ERROR:', err);
    return res.status(500).json({
      error: err.message || 'Failed to build timeline events'
    });
  }
});

app.post('/api/event-overview', async (req, res) => {
  try {
    const { topicName = '', eventLabel = '', eventType = 'story', articles = [] } = req.body;

    if (!Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ error: 'No articles provided' });
    }

    const picked = articles.slice(0, 6);

    if (!USE_OPENAI_FEATURES || !client) {
      return res.json({
        overview: buildFallbackEventOverview(topicName, eventLabel, picked, eventType)
      });
    }

    const articleText = picked.map((a, i) => `
Article ${i + 1}
Title: ${cleanArticleText(a.title || '')}
Description: ${cleanArticleText(a.description || '')}
Source: ${cleanArticleText(a.source?.name || 'Unknown source')}
URL: ${cleanArticleText(a.url || '')}
`).join('\n');

    const prompt = `You are writing a concise event overview for a news sidebar.

Topic: ${topicName}
Happening: ${eventLabel}
Type: ${eventType}

Using only the articles below, explain what this happening is, why it matters, and what phase it seems to be in.
Write one tight paragraph in 3 to 5 sentences.
Do not invent facts.

${articleText}`;

    const response = await client.responses.create({
      model: 'gpt-4o-mini',
      input: prompt
    });

    const overview = response.output_text?.trim();

    if (!overview) {
      return res.status(500).json({ error: 'No overview returned' });
    }

    return res.json({ overview });
  } catch (err) {
    console.error('EVENT OVERVIEW ERROR:', err);
    return res.status(500).json({
      error: err.message || 'Failed to build event overview'
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Newsphere running on http://localhost:${PORT}`);
});
