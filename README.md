# Newsphere — Setup Guide

## How to run on Replit (5 minutes)

### Step 1 — Create a Replit project
1. Go to **replit.com** and sign in (free account)
2. Click **"+ Create Repl"**
3. Choose **"Node.js"** as the template
4. Name it `newsphere` → click Create

### Step 2 — Upload the files
In the Replit file panel (left sidebar), upload or create these files:

```
newsphere/
├── server.js          ← the backend proxy
├── package.json       ← dependencies
└── public/
    └── index.html     ← the frontend
```

**Easiest way:** Click each file in Replit, delete the default content,
and paste in the contents from the files in this folder.

### Step 3 — Add your NewsAPI key (IMPORTANT — never paste keys in code!)
1. In Replit, click the **padlock icon** in the left sidebar (called "Secrets")
2. Click **"New Secret"**
3. Key: `NEWS_API_KEY`
4. Value: paste your API key from newsapi.org
5. Click **"Add Secret"**

This keeps your key private and out of your code.

### Step 4 — Run it
1. Click the big **Run** button at the top
2. Replit will install dependencies automatically (`npm install`)
3. Your site opens in the preview panel on the right
4. You'll also get a public URL like `https://newsphere.yourname.repl.co`

---

## Get a free NewsAPI key
1. Go to https://newsapi.org/register
2. Sign up with your email
3. Copy the API key from your dashboard
4. Free plan: 100 requests/day, plenty for prototyping

---

## How it works
- The browser talks to `/api/news?q=your+query` on YOUR server
- Your server (server.js) fetches from NewsAPI using the secret key
- This bypasses the CORS restriction that blocked direct browser requests
- Each graph node has its own search query — clicking a node fetches live headlines

---

## Troubleshooting
- **"NEWS_API_KEY not set"** → Add the secret in Replit's padlock panel
- **No articles showing** → Check your key is valid at newsapi.org
- **Port errors** → Replit sets PORT automatically, don't change it
