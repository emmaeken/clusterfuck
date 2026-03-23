require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files (index.html, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// ── NEWS PROXY ──────────────────────────────────────────────
// The browser can't call NewsAPI directly due to CORS.
// This server-side route fetches on behalf of the browser.
app.get('/api/news', async (req, res) => {
  const { q } = req.query;
  const apiKey = process.env.NEWS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'NEWS_API_KEY not set. Add it in Replit Secrets (the padlock icon).'
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

    // Filter out removed articles and send back
    const articles = (data.articles || [])
      .filter(a => a.title && a.title !== '[Removed]' && a.url)
      .slice(0, 5);

    res.json({ articles });
  } catch (err) {
    console.error('Proxy fetch error:', err);
    res.status(500).json({ error: 'Failed to reach NewsAPI: ' + err.message });
  }
});

// Fallback: serve index.html for any unmatched route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Newsphere running on http://localhost:${PORT}`);
});
