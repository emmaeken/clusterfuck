require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const USE_OPENAI_FEATURES = false;
const client = USE_OPENAI_FEATURES && process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(express.static(path.join(__dirname, 'public')));

function cleanArticleText(text = '') {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/\[[^\]]*\]/g, '')
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
    articles.map(article => cleanArticleText(article.source?.name || '')).filter(Boolean)
  )];
}

function buildFallbackTopicSummary(mode = 'short', articles = []) {
  const picked = articles.slice(0, mode === 'long' ? 5 : 3);
  const details = picked
    .map(article => cleanArticleText(article.description || article.title))
    .filter(Boolean);
  const sources = uniqueSourceNames(picked);

  if (mode === 'long') {
    return {
      longSummary: [
        details.slice(0, 2).join(' ') || 'Recent coverage shows several connected developments moving at once.',
        details.slice(2, 5).join(' ') || 'The reporting suggests the situation is still evolving and being interpreted across multiple angles.',
        sources.length
          ? `This overview is based on recent reporting from ${sources.join(', ')}.`
          : 'This overview is based on recent reporting from multiple sources.'
      ].join('\n\n'),
      sources: picked.map(article => ({
        title: article.title,
        url: article.url
      }))
    };
  }

  return {
    shortSummary: [
      details.join(' ') || 'Recent coverage points to a fast-moving topic with several linked developments.',
      sources.length
        ? `Based on reporting from ${sources.join(', ')}.`
        : 'Based on reporting from multiple sources.'
    ].join(' ')
  };
}

function buildFallbackTimelineEvents(topicKey, topicName, articles = []) {
  const picked = (articles || []).slice(0, 4);

  return picked.map((article, index) => {
    const rawLabel = cleanArticleText(article.title || article.description || `${topicName} update`);
    const label = rawLabel.split(/[:\-|]/)[0].slice(0, 42) || `${topicName} update ${index + 1}`;
    const publishedAt = article.publishedAt ? new Date(article.publishedAt) : null;
    const dateLabel = publishedAt && !isNaN(publishedAt)
      ? publishedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'Now';
    const baseQuery = cleanArticleText(label);

    return {
      id: `${topicKey}-${slugify(label)}`,
      label,
      dateLabel,
      importance: index === 0 ? 'high' : 'medium',
      backgroundQuery: `${baseQuery} ${topicName} overview`,
      latestQuery: `${baseQuery} latest news`,
      whyItMatters: cleanArticleText(article.description || article.title).slice(0, 180) || `A major live development inside ${topicName}.`
    };
  });
}

function getBroadTopicEvents(topicKey, topicName) {
  const presets = {
    politics: [
      { id: 'federal-power', label: 'Federal power', dateLabel: 'Big picture', importance: 'high', backgroundQuery: 'US federal power White House Congress courts overview', latestQuery: 'US federal power White House Congress courts latest news', whyItMatters: 'This tracks the biggest fights over who can act, block, or reshape policy.' },
      { id: 'elections-and-parties', label: 'Elections and parties', dateLabel: 'Campaigns', importance: 'high', backgroundQuery: 'US elections parties campaign strategy overview', latestQuery: 'US elections parties campaign strategy latest news', whyItMatters: 'This captures the broad contest for support, messaging, and electoral control.' },
      { id: 'legal-accountability', label: 'Legal accountability', dateLabel: 'Courts', importance: 'medium', backgroundQuery: 'US legal cases investigations accountability politics overview', latestQuery: 'US investigations court rulings political accountability latest news', whyItMatters: 'This includes major legal and investigative storylines that can reshape the political field.' },
      { id: 'foreign-flashpoints', label: 'Foreign flashpoints', dateLabel: 'World stage', importance: 'medium', backgroundQuery: 'US politics foreign policy crisis overview', latestQuery: 'US foreign policy crisis politics latest news', whyItMatters: 'This covers external crises that quickly become defining domestic political stories.' }
    ],
    ukraine: [
      { id: 'battlefield-shifts', label: 'Battlefield shifts', dateLabel: 'Front line', importance: 'high', backgroundQuery: 'Ukraine war battlefield shifts overview', latestQuery: 'Ukraine war battlefield shifts latest news', whyItMatters: 'This follows the biggest changes in territory, momentum, and military pressure.' },
      { id: 'aid-and-allies', label: 'Aid and allies', dateLabel: 'Support', importance: 'high', backgroundQuery: 'Ukraine western aid allies overview', latestQuery: 'Ukraine western aid allies latest news', whyItMatters: 'This tracks the outside support that shapes what Ukraine can sustain.' },
      { id: 'diplomacy', label: 'Diplomacy', dateLabel: 'Negotiations', importance: 'medium', backgroundQuery: 'Ukraine diplomacy ceasefire talks overview', latestQuery: 'Ukraine diplomacy ceasefire talks latest news', whyItMatters: 'This covers negotiation efforts, public positions, and peace-process pressure.' },
      { id: 'civilian-impact', label: 'Civilian impact', dateLabel: 'Homes', importance: 'medium', backgroundQuery: 'Ukraine war civilians infrastructure overview', latestQuery: 'Ukraine war civilians infrastructure latest news', whyItMatters: 'This keeps the human and infrastructure consequences visible in the wider story.' }
    ],
    climate: [
      { id: 'climate-diplomacy', label: 'Climate diplomacy', dateLabel: 'Big picture', importance: 'high', backgroundQuery: 'global climate diplomacy cop policy overview', latestQuery: 'global climate diplomacy cop policy latest news', whyItMatters: 'This covers the international decisions and political bargaining around climate action.' },
      { id: 'extreme-weather', label: 'Extreme weather', dateLabel: 'Impacts', importance: 'high', backgroundQuery: 'extreme weather climate impacts overview', latestQuery: 'extreme weather climate impacts latest news', whyItMatters: 'This tracks the biggest visible consequences, from heat and floods to fire and drought.' },
      { id: 'energy-transition', label: 'Energy transition', dateLabel: 'Power', importance: 'medium', backgroundQuery: 'renewable energy transition climate overview', latestQuery: 'renewable energy transition climate latest news', whyItMatters: 'This follows the shift in how countries build power, industry, and transport.' },
      { id: 'science-and-thresholds', label: 'Science and thresholds', dateLabel: 'Signals', importance: 'medium', backgroundQuery: 'climate science thresholds emissions overview', latestQuery: 'climate science thresholds emissions latest news', whyItMatters: 'This captures the benchmark moments that signal how fast the climate is changing.' }
    ]
  };

  return (presets[topicKey] || [
    { id: 'big-picture', label: `${topicName} big picture`, dateLabel: 'Overview', importance: 'high', backgroundQuery: `${topicName} overview`, latestQuery: `${topicName} latest news`, whyItMatters: `This follows the biggest forces shaping ${topicName}.` }
  ]).map(event => ({ ...event }));
}

function buildTimelineEventPayload(topicKey, topicName, articles = []) {
  return {
    overviewEvents: getBroadTopicEvents(topicKey, topicName),
    detailEvents: buildFallbackTimelineEvents(topicKey, topicName, articles)
  };
}

function buildFallbackEventOverview(topicName, eventLabel, articles = []) {
  const picked = articles.slice(0, 4);
  const details = picked
    .map(article => cleanArticleText(article.description || article.title))
    .filter(Boolean);
  const sources = uniqueSourceNames(picked);

  const first = details[0] || `${eventLabel} is one of the main developments inside ${topicName}.`;
  const second = details[1] || 'Coverage suggests the story is still active and evolving.';
  const third = sources.length
    ? `Recent reporting from ${sources.join(', ')} keeps this storyline in focus.`
    : 'Recent reporting across multiple outlets keeps this storyline in focus.';

  return `${first} ${second} ${third}`.trim();
}

app.get('/api/news', async (req, res) => {
  const { q } = req.query;
  const apiKey = process.env.NEWS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'NEWS_API_KEY not set'
    });
  }

  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter ?q=' });
  }

  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=6&apiKey=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'error') {
      return res.status(400).json({ error: data.message });
    }

    const articles = (data.articles || [])
      .filter(a => a.title && a.title !== '[Removed]' && a.url)
      .slice(0, 5);

    res.json({ articles });
  } catch (err) {
    console.error('Proxy fetch error:', err);
    res.status(500).json({ error: 'Failed to reach NewsAPI: ' + err.message });
  }
});
app.get('/api/hello', (req, res) => {
  res.json({ message: 'hello from the RIGHT server file' });
});
app.post('/api/summary', async (req, res) => {
  try {
    const { mode = 'short', articles = [] } = req.body;

    if (!Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ error: 'No articles provided' });
    }

    if (!USE_OPENAI_FEATURES || !client) {
      return res.json(buildFallbackTopicSummary(mode, articles));
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
        ? `You are writing a clear news overview for an interactive news interface.
Summarize this topic in 2 short paragraphs.
Only use the article information below.
Do not invent facts.

${articleText}`
        : `You are writing a short news summary for an interactive news interface.
Summarize what is happening right now in maximum 5 sentences.
Be clear, simple, and factual.
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
        sources: picked.map(a => ({
          title: a.title,
          url: a.url
        }))
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
      return res.json(buildTimelineEventPayload(topicKey, topicName || topicKey, articles));
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
      return res.json(buildTimelineEventPayload(topicKey, topicName || topicKey, articles));
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
      overviewEvents: getBroadTopicEvents(topicKey, topicName || topicKey),
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
    const { topicName = '', eventLabel = '', articles = [] } = req.body;

    if (!Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ error: 'No articles provided' });
    }

    const picked = articles.slice(0, 6);

    if (!USE_OPENAI_FEATURES || !client) {
      return res.json({
        overview: buildFallbackEventOverview(topicName, eventLabel, picked)
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
