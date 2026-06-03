# 🚗 CAR PULSE — Social Listening Newsletter

A daily automotive newsletter that tracks what **real car people are actually saying** on Reddit and X/Twitter — not press releases or PR fluff. Powered by Claude AI. Delivered every morning via SendGrid.

---

## What Makes This Different

Most car newsletters curate from news sites and press releases. **CAR PULSE reads the community.** It tracks Reddit's hottest car threads and what's trending on X, then uses Claude to surface the conversations worth reading.

**Sources:**
- Reddit: `r/cars`, `r/electricvehicles`, `r/formula1`, `r/Justrolledintotheshop`, `r/teslamotors`, `r/BMW`, `r/Toyota`, `r/ford`, and more
- X/Twitter: Claude uses its web search tool to find trending automotive topics and viral posts on X without requiring the X API

---

## How It Works

The system runs a **5-stage pipeline**:

| Stage | What happens |
|-------|-------------|
| **Stage 1a** | Fetch hot/new posts from 12+ subreddits via Reddit's public JSON API |
| **Stage 1b** | Claude searches the web to find trending automotive topics on X/Twitter |
| **Stage 2** | Claude scores posts, clusters by topic, finds cross-platform buzz |
| **Stage 3** | Claude writes newsletter copy: intro, summaries, hot takes, trending topics |
| **Stage 4** | Pure JavaScript assembles the final HTML email |

---

## Newsletter Structure

Each daily email contains:

1. **Community Mood** — One-line vibe check with emoji (😤🔥😂🤔)
2. **Top Thread** — The most upvoted/discussed Reddit post with context
3. **Hot Takes** — 3 spicy opinions or controversial posts with reaction summaries
4. **What X Is Saying** — Trending automotive topics from X/Twitter
5. **Trending Topics** — Cross-platform themes and conversations
6. **Quick Hits** — 6 more Reddit posts at a glance
7. **Pulse Fact** — One interesting fact related to today's topics

---

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/YOUR_USERNAME/car-pulse.git
cd car-pulse
npm install
```

### 2. Set Up Environment

```bash
cp .env.example .env
# Edit .env with your API keys
```

### 3. Test Locally

```bash
# Dry run — no email sent, shows preview
npm run dry-run

# Fast test — only 10 Reddit posts
npm test

# Full send
npm start
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key — get at [console.anthropic.com](https://console.anthropic.com/) |
| `SENDGRID_API_KEY` | Yes | SendGrid key — get at [app.sendgrid.com](https://app.sendgrid.com/) |
| `FROM_EMAIL` | Yes | Sender address (must be verified in SendGrid) |
| `TO_EMAIL` | Yes | Recipient email |
| `DRY_RUN` | No | `true` = skip sending email (default: `false`) |
| `MAX_POSTS` | No | Max Reddit posts to process (default: `40`) |
| `DEBUG` | No | `true` = print full error stacks |

---

## Getting API Keys

### Anthropic (Claude)

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. **API Keys → Create Key**
3. Copy the key (starts with `sk-ant-`)

### SendGrid

1. Go to [app.sendgrid.com](https://app.sendgrid.com/)
2. **Settings → API Keys → Create API Key**
3. Choose **Restricted Access** → enable **Mail Send → Full Access**
4. Copy the key (starts with `SG.`)
5. **Also verify your sender:** Settings → Sender Authentication

> Note: Reddit and X data require no API keys. Reddit's JSON API is public. X signals are fetched via Claude's built-in web search tool.

---

## GitHub Actions Setup

### 1. Add package-lock.json

```bash
npm install
git add package-lock.json
git commit -m "Add lock file"
git push
```

### 2. Add Workflow File

The workflow is already at `.github/workflows/car-pulse.yml`. Just push it.

### 3. Add GitHub Secrets

Go to **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `SENDGRID_API_KEY` | `SG....` |
| `FROM_EMAIL` | Your verified sender email |
| `TO_EMAIL` | Your recipient email |

### 4. Test the Workflow

1. Go to **Actions → CAR PULSE — Social Newsletter**
2. Click **Run workflow**
3. Set `dry_run: true` for a test run
4. Watch the logs

---

## Customizing Subreddits

Open `car-pulse.js` and update `REDDIT_FEEDS`:

```js
const REDDIT_FEEDS = [
  { url: "https://www.reddit.com/r/cars/hot.json?limit=15&raw_json=1", sub: "r/cars" },
  { url: "https://www.reddit.com/r/Porsche/hot.json?limit=8&raw_json=1", sub: "r/Porsche" },
  // Add any subreddit — format: /r/SUBREDDIT/hot.json?limit=N&raw_json=1
];
```

Any public subreddit works. Good additions: `r/Porsche`, `r/subaru`, `r/Miata`, `r/CarComments`, `r/projectcar`, `r/Justrolledintotheshop`.

---

## Customizing X Search

The `X_SEARCH_QUERIES` array drives what Claude searches for on X. Customize to match your interests:

```js
const X_SEARCH_QUERIES = [
  "site:x.com Porsche viral today",
  "site:x.com EV charging controversy today",
  // Add your own
];
```

---

## Schedule

Runs daily at **7:00 AM PDT** (2:00 PM UTC):

```yaml
- cron: '0 14 * * *'
```

Change the time by editing `.github/workflows/car-pulse.yml`. Use [crontab.guru](https://crontab.guru/) to find your UTC time.

---

## Architecture Notes

### Why no X API?

The official X API is expensive ($100+/month for basic access). Instead, this newsletter uses Claude's built-in `web_search` tool to find trending automotive content on X — zero cost beyond the normal Claude API call, no extra credentials.

### Reddit Rate Limiting

The script adds 300ms delays between Reddit fetches and uses a descriptive `User-Agent` header per Reddit's API guidelines. For personal, low-volume use this is well within acceptable limits.

### Why separate Reddit fetch + X search?

They run in parallel (`Promise.all`) to save time. Reddit fetch (~10s) and Claude web search (~20s) overlap. Total Stage 1 time is roughly 20–25 seconds instead of 30+.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| No Reddit posts | Reddit may be rate-limiting. Reduce `REDDIT_FEEDS` count or add delays |
| No X signals | Claude web search may not surface X posts — still works, just skips X section |
| Email not received | Check SendGrid Activity log; verify `FROM_EMAIL` is authenticated |
| `403 Forbidden` SendGrid | Verify sender email in SendGrid → Sender Authentication |
| `DRY_RUN` shows no output | Increase `MAX_POSTS` for a fuller preview |

---

## Performance

| Stage | Time |
|-------|------|
| Reddit fetch | ~10–15s |
| X signals (Claude search) | ~20–25s |
| Stage 1 total (parallel) | ~25s |
| Stage 2 (scoring) | ~30s |
| Stage 3 (copy writing) | ~60s |
| Stage 4 (HTML build) | <1s |
| SendGrid | ~10s |
| **Total** | **~3–4 min** |

---

## Cost

| Resource | Cost |
|----------|------|
| Claude API | ~$0.003–0.008 per newsletter |
| Reddit API | Free |
| X data (via Claude search) | Included in Claude API cost |
| SendGrid | Free (up to 100/day) |
| GitHub Actions | Free (2,000 min/month) |
| **Monthly total** | **~$0.10–0.25** |

---

## File Structure

```
├── car-pulse.js                    # Main script
├── package.json                    # Dependencies
├── .env.example                    # Environment template
├── .gitignore
├── README.md
└── .github/
    └── workflows/
        └── car-pulse.yml           # GitHub Actions schedule
```

---

## License

MIT — use freely, customize fully, share improvements!

---

Happy scrolling. 🚗💨
