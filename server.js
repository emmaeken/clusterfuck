require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(express.static(path.join(__dirname, 'public')));

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

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY missing' });
    }

    if (!Array.isArray(articles) || articles.length === 0) {
      return res.status(400).json({ error: 'No articles provided' });
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Newsphere running on http://localhost:${PORT}`);
});