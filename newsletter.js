#!/usr/bin/env node

/**
 * STREET PULSE — Community Voice Newsletter
 * ==========================================
 * A car newsletter built entirely from what real people are saying on
 * Reddit and X (Twitter). No press releases. No PR spin. Just the
 * unfiltered voice of the car community.
 *
 * Pipeline:
 *   Stage 1 : Fetch Reddit RSS + X (via scrape/nitter) posts
 *   Stage 2 : Score & cluster by topic/sentiment
 *   Stage 3 : Claude writes community-voice newsletter copy
 *   Stage 4 : Build HTML email
 *   Stage 5 : Send via SendGrid
 *
 * Run:       node src/newsletter.js
 * Dry run:   DRY_RUN=true node src/newsletter.js
 */

"use strict";

const Parser    = require("rss-parser");
const Anthropic = require("@anthropic-ai/sdk");
const sgMail    = require("@sendgrid/mail");
const https     = require("https");

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

const CONFIG = {
  ANTHROPIC_API_KEY  : process.env.ANTHROPIC_API_KEY,
  SENDGRID_API_KEY   : process.env.SENDGRID_API_KEY,
  FROM_EMAIL         : process.env.FROM_EMAIL,
  TO_EMAIL           : process.env.TO_EMAIL,
  X_BEARER_TOKEN     : process.env.X_BEARER_TOKEN,      // optional — enables real X data
  DRY_RUN            : process.env.DRY_RUN === "true",
  MAX_POSTS          : parseInt(process.env.MAX_POSTS || "40", 10),
  MODEL              : "claude-sonnet-4-20250514",
  MAX_TOKENS         : 8000,
};

const REQUIRED_ALWAYS = ["FROM_EMAIL", "TO_EMAIL"];
const REQUIRED_SEND   = ["ANTHROPIC_API_KEY", "SENDGRID_API_KEY"];

const missing = (CONFIG.DRY_RUN ? REQUIRED_ALWAYS : [...REQUIRED_ALWAYS, ...REQUIRED_SEND])
  .filter((k) => !CONFIG[k]);

if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// ─────────────────────────────────────────────
// REDDIT RSS FEEDS
// Pull the top posts from car-focused subreddits.
// Sorted from broad → niche → culture.
// ─────────────────────────────────────────────

const REDDIT_FEEDS = [
  // General car discussion
  { url: "https://www.reddit.com/r/cars/.rss?limit=10",               subreddit: "r/cars"                   },
  { url: "https://www.reddit.com/r/Autos/.rss?limit=10",              subreddit: "r/Autos"                  },
  { url: "https://www.reddit.com/r/carscirclejerk/.rss?limit=5",       subreddit: "r/carscirclejerk"         },

  // Buying, ownership, advice
  { url: "https://www.reddit.com/r/whatcarshouldIbuy/.rss?limit=8",   subreddit: "r/whatcarshouldIbuy"      },
  { url: "https://www.reddit.com/r/askcarsales/.rss?limit=8",         subreddit: "r/askcarsales"            },
  { url: "https://www.reddit.com/r/MechanicAdvice/.rss?limit=8",      subreddit: "r/MechanicAdvice"         },

  // Culture & wrenching
  { url: "https://www.reddit.com/r/Justrolledintotheshop/.rss?limit=8", subreddit: "r/Justrolledintotheshop" },
  { url: "https://www.reddit.com/r/projectcar/.rss?limit=8",          subreddit: "r/projectcar"             },
  { url: "https://www.reddit.com/r/carmodification/.rss?limit=5",     subreddit: "r/carmodification"        },

  // EV community
  { url: "https://www.reddit.com/r/electricvehicles/.rss?limit=8",    subreddit: "r/electricvehicles"       },
  { url: "https://www.reddit.com/r/teslamotors/.rss?limit=5",         subreddit: "r/teslamotors"            },

  // Brand passion
  { url: "https://www.reddit.com/r/Cartalk/.rss?limit=5",             subreddit: "r/Cartalk"                },
  { url: "https://www.reddit.com/r/spotted/.rss?limit=5",             subreddit: "r/spotted"                },
];

// ─────────────────────────────────────────────
// X / TWITTER SEARCH TERMS
// Used when X_BEARER_TOKEN is set. Each query
// targets a specific kind of car conversation.
// ─────────────────────────────────────────────

const X_QUERIES = [
  "car deal just bought",
  "dealership nightmare",
  "new car day",
  "#carsoftwitter",
  "EV range anxiety",
  "project car update",
  "just fixed my",
  "mechanic quote",
  "car community",
  "#JDM OR #USDM OR #stance",
];

// ─────────────────────────────────────────────
// FALLBACK IMAGES (Unsplash, free, no key)
// ─────────────────────────────────────────────

const FALLBACK_IMAGES = {
  "Buying & Ownership"   : "https://images.unsplash.com/photo-1560958089-b8a63dd89c94?w=600&auto=format&fit=crop&q=80",
  "Wrenching & Projects" : "https://images.unsplash.com/photo-1530046339160-ce3e530c7d2f?w=600&auto=format&fit=crop&q=80",
  "Car Culture"          : "https://images.unsplash.com/photo-1594882645126-14020914d58d?w=600&auto=format&fit=crop&q=80",
  "EV Talk"              : "https://images.unsplash.com/photo-1579399788625-e7abb4bb9d3f?w=600&auto=format&fit=crop&q=80",
  "Hot Takes"            : "https://images.unsplash.com/photo-1552820728-8ac41f1ce891?w=600&auto=format&fit=crop&q=80",
  "Spotted & Shared"     : "https://images.unsplash.com/photo-1533473359331-35acda7ce3f1?w=600&auto=format&fit=crop&q=80",
  default                : "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=600&auto=format&fit=crop&q=80",
};

// ─────────────────────────────────────────────
// DESIGN TOKENS — raw street aesthetic
// ─────────────────────────────────────────────

const D = {
  black     : "#0a0a0a",
  dark      : "#111111",
  card      : "#1a1a1a",
  border    : "#2a2a2a",
  steel     : "#333333",
  text      : "#f0f0f0",
  muted     : "#888888",
  silver    : "#cccccc",
  red       : "#e63946",      // community heat
  orange    : "#f77f00",      // hot takes
  blue      : "#4361ee",      // X/Twitter
  reddit    : "#ff4500",      // Reddit orange
  green     : "#2dc653",      // positive sentiment
};

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function getDisplayDate() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

function stripHtml(html = "") {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ─────────────────────────────────────────────
// STAGE 1A: FETCH REDDIT
// ─────────────────────────────────────────────

async function fetchReddit() {
  log("STAGE 1A: Fetching Reddit RSS feeds...");
  const parser = new Parser({
    headers: {
      "User-Agent": "StreetPulseNewsletter/1.0 (automated newsletter bot)",
    },
    customFields: {
      item: [["media:thumbnail", "mediaThumbnail"]],
    },
  });

  const posts = [];

  for (const feed of REDDIT_FEEDS) {
    try {
      const data = await parser.parseURL(feed.url);
      for (const item of (data.items || []).slice(0, 5)) {
        if (!item.title || !item.link) continue;

        // Skip stickied/mod posts
        if (item.title.toLowerCase().includes("[mod]")) continue;

        posts.push({
          id         : item.guid || item.link,
          title      : item.title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
          link       : item.link,
          source     : feed.subreddit,
          platform   : "reddit",
          description: stripHtml(item.content || item.description || ""),
          image      : item.mediaThumbnail?.$ ?.url || "",
          pubDate    : item.pubDate || new Date().toISOString(),
          score      : 0,
          category   : "Car Culture",
        });
      }
    } catch (e) {
      log(`⚠ Reddit fetch failed for ${feed.subreddit}: ${e.message}`);
    }
  }

  log(`✓ Reddit: fetched ${posts.length} posts from ${REDDIT_FEEDS.length} subreddits.`);
  return posts;
}

// ─────────────────────────────────────────────
// STAGE 1B: FETCH X (TWITTER)
// Uses the X v2 API if X_BEARER_TOKEN is set.
// Falls back to a curated set of simulated posts
// for dry-run / demo mode.
// ─────────────────────────────────────────────

async function fetchX() {
  log("STAGE 1B: Fetching X posts...");

  if (CONFIG.X_BEARER_TOKEN) {
    return fetchXLive();
  }

  log("  No X_BEARER_TOKEN — using demo X posts for dry-run/testing.");
  return getDemoXPosts();
}

async function fetchXLive() {
  const posts = [];

  for (const query of X_QUERIES.slice(0, 5)) {
    try {
      const encodedQuery = encodeURIComponent(`${query} -is:retweet lang:en`);
      const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodedQuery}&max_results=10&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,name`;

      const res = await httpsGet(url, {
        "Authorization": `Bearer ${CONFIG.X_BEARER_TOKEN}`,
        "User-Agent"   : "StreetPulseNewsletter/1.0",
      });

      if (res.status !== 200) {
        log(`  X API returned ${res.status} for query "${query}"`);
        continue;
      }

      const data = JSON.parse(res.body);
      const users = {};
      (data.includes?.users || []).forEach((u) => { users[u.id] = u; });

      for (const tweet of (data.data || [])) {
        const user = users[tweet.author_id] || {};
        posts.push({
          id         : tweet.id,
          title      : tweet.text.slice(0, 120),
          link       : `https://x.com/i/web/status/${tweet.id}`,
          source     : `@${user.username || "unknown"} on X`,
          platform   : "x",
          description: tweet.text,
          image      : "",
          pubDate    : tweet.created_at || new Date().toISOString(),
          score      : tweet.public_metrics?.like_count || 0,
          category   : "Car Culture",
          likes      : tweet.public_metrics?.like_count || 0,
          retweets   : tweet.public_metrics?.retweet_count || 0,
        });
      }
    } catch (e) {
      log(`⚠ X fetch failed for "${query}": ${e.message}`);
    }
  }

  log(`✓ X (live): fetched ${posts.length} posts.`);
  return posts;
}

function getDemoXPosts() {
  // Demo posts used when no X_BEARER_TOKEN is available.
  // Replace with real API data in production.
  return [
    {
      id: "demo_1", platform: "x", source: "@CarguyMike on X",
      title: "Just got quoted $4,200 to replace a water pump on a 3-year-old BMW. Is this real life?",
      link: "https://x.com", description: "Just got quoted $4,200 to replace a water pump on a 3-year-old BMW. Is this real life? Going independent.", image: "", pubDate: new Date().toISOString(), score: 0, likes: 3400, retweets: 820, category: "Hot Takes",
    },
    {
      id: "demo_2", platform: "x", source: "@EVDailyDriver on X",
      title: "Road trip from LA to Vegas in the Model Y. Charged once. 22 mins. Back on the road. EV anxiety is dead.",
      link: "https://x.com", description: "Road trip from LA to Vegas in the Model Y. Charged once. 22 mins. Back on the road. EV anxiety is dead.", image: "", pubDate: new Date().toISOString(), score: 0, likes: 7200, retweets: 1500, category: "EV Talk",
    },
    {
      id: "demo_3", platform: "x", source: "@JDMLifer on X",
      title: "Dealers adding $5k markup on a Civic. A CIVIC. This is why people buy used.",
      link: "https://x.com", description: "Dealers adding $5k markup on a Civic. A CIVIC. This is why people buy used.", image: "", pubDate: new Date().toISOString(), score: 0, likes: 12800, retweets: 3400, category: "Buying & Ownership",
    },
    {
      id: "demo_4", platform: "x", source: "@WrenchWitch on X",
      title: "Swapped my own brakes for the first time. $45 in parts vs $380 dealer quote. This hobby pays for itself.",
      link: "https://x.com", description: "Swapped my own brakes for the first time. $45 in parts vs $380 dealer quote. This hobby pays for itself.", image: "", pubDate: new Date().toISOString(), score: 0, likes: 5600, retweets: 900, category: "Wrenching & Projects",
    },
    {
      id: "demo_5", platform: "x", source: "@AutoTherapist on X",
      title: "The manual transmission is not dying. It is migrating to people who actually care about driving.",
      link: "https://x.com", description: "The manual transmission is not dying. It is migrating to people who actually care about driving.", image: "", pubDate: new Date().toISOString(), score: 0, likes: 9100, retweets: 2200, category: "Hot Takes",
    },
    {
      id: "demo_6", platform: "x", source: "@GarageTherapy on X",
      title: "3 years into this E30 project. It moves under its own power for the first time today. Never giving up.",
      link: "https://x.com", description: "3 years into this E30 project. It moves under its own power for the first time today. Never giving up.", image: "", pubDate: new Date().toISOString(), score: 0, likes: 22000, retweets: 4100, category: "Wrenching & Projects",
    },
  ];
}

// ─────────────────────────────────────────────
// STAGE 2: SCORE & CATEGORIZE (Claude)
// ─────────────────────────────────────────────

async function scoreAndCategorize(allPosts) {
  log("STAGE 2: Scoring and categorizing posts with Claude...");

  const sample = allPosts.slice(0, CONFIG.MAX_POSTS);
  const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

  const postList = sample
    .map((p, i) => `${i + 1}. [${p.platform.toUpperCase()} | ${p.source}]\n   "${p.title}"\n   ${p.description.slice(0, 120)}`)
    .join("\n\n");

  const prompt = `You are a car community curator. Score and categorize each post for its value to an automotive enthusiast newsletter.

POSTS:
${postList}

Respond ONLY with valid JSON (no markdown, no preamble):
{
  "posts": [
    {
      "index": 1,
      "relevance_score": 4,
      "category": "Buying & Ownership",
      "sentiment": "frustrated",
      "viral_potential": "high",
      "reason": "Relatable dealer markup story"
    }
  ]
}

Categories: Buying & Ownership, Wrenching & Projects, Car Culture, EV Talk, Hot Takes, Spotted & Shared
Sentiment: excited, frustrated, proud, funny, informative, angry, nostalgic
Viral potential: low, medium, high
Scores: 1–5 (5 = every car person can relate; 1 = noise)`;

  const response = await client.messages.create({
    model     : CONFIG.MODEL,
    max_tokens: CONFIG.MAX_TOKENS,
    messages  : [{ role: "user", content: prompt }],
  });

  let scoreData = { posts: [] };
  try {
    const text = (response.content[0]?.text || "").replace(/```json|```/g, "").trim();
    scoreData = JSON.parse(text);
  } catch (e) {
    log(`⚠ Stage 2 parse error: ${e.message}. Using defaults.`);
  }

  const enriched = sample.map((p, i) => {
    const s = scoreData.posts.find((x) => x.index === i + 1);
    return {
      ...p,
      relevance_score : s?.relevance_score || 3,
      category        : s?.category || "Car Culture",
      sentiment       : s?.sentiment || "informative",
      viral_potential : s?.viral_potential || "medium",
    };
  });

  log(`✓ Stage 2 complete. Scored ${enriched.length} posts.`);
  return enriched.sort((a, b) => b.relevance_score - a.relevance_score);
}

// ─────────────────────────────────────────────
// STAGE 3: WRITE NEWSLETTER COPY (Claude)
// ─────────────────────────────────────────────

async function writeCopy(posts) {
  log("STAGE 3: Writing newsletter copy with Claude...");

  const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });
  const top    = posts.slice(0, 12);
  const hero   = top[0];

  const topList = top
    .map((p, i) => `${i + 1}. [${p.category} | ${p.sentiment}] "${p.title}" (${p.source})`)
    .join("\n");

  const prompt = `You are the editor of "Street Pulse" — a car newsletter that covers ONLY what real people are saying on Reddit and X (not press releases or sponsored content).

Write newsletter copy for today's issue. Tone: casual, sharp, opinionated. Like a car guy texting his friends.

TOP POSTS:
${topList}

HERO POST (write the most copy for this):
"${hero.title}"
${hero.description}
Source: ${hero.source}

Respond ONLY with valid JSON (no markdown):
{
  "issue_title": "catchy 3-6 word title for today's issue",
  "intro_line": "1-2 casual punchy sentences setting the vibe for today — what's the community fired up about?",
  "hero_summary": "3-4 sentence summary/riff on the hero post. Community voice. Reference the platform. Don't just summarize — add the editor's take.",
  "hero_cta": "short 3-5 word CTA button text",
  "highlights_copy": [
    { "index": 2, "teaser": "1 punchy sentence — what's interesting about this one?" },
    { "index": 3, "teaser": "1 punchy sentence" },
    { "index": 4, "teaser": "1 punchy sentence" }
  ],
  "hot_take": "A sharp 1-2 sentence editorial hot take based on a pattern you see in today's posts.",
  "community_pulse": "1 sentence summarizing the overall mood of the car community today.",
  "sign_off": "A casual 1-sentence sign-off for the footer."
}`;

  const response = await client.messages.create({
    model     : CONFIG.MODEL,
    max_tokens: CONFIG.MAX_TOKENS,
    messages  : [{ role: "user", content: prompt }],
  });

  let copy = {
    issue_title     : "The Community Speaks",
    intro_line      : "Here's what the car internet is talking about today.",
    hero_summary    : hero.description,
    hero_cta        : "Read the thread →",
    highlights_copy : [],
    hot_take        : "The community is fired up.",
    community_pulse : "Energy is high today.",
    sign_off        : "Stay in gear.",
  };

  try {
    const text = (response.content[0]?.text || "").replace(/```json|```/g, "").trim();
    copy = JSON.parse(text);
  } catch (e) {
    log(`⚠ Stage 3 parse error: ${e.message}. Using fallback copy.`);
  }

  log("✓ Stage 3 complete.");
  return { copy, hero, highlights: top.slice(1, 4), quickHits: top.slice(4, 10) };
}

// ─────────────────────────────────────────────
// STAGE 4: BUILD HTML EMAIL
// ─────────────────────────────────────────────

function buildHTML({ copy, hero, highlights, quickHits }) {
  log("STAGE 4: Building HTML email...");

  function platformBadge(platform) {
    if (platform === "reddit") return `<span style="background:${D.reddit};color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;letter-spacing:0.5px;">REDDIT</span>`;
    if (platform === "x")      return `<span style="background:${D.blue};color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;letter-spacing:0.5px;">X</span>`;
    return "";
  }

  function getImage(post) {
    if (post.image && post.image.startsWith("http") && !post.image.includes("default")) return post.image;
    return FALLBACK_IMAGES[post.category] || FALLBACK_IMAGES.default;
  }

  const highlightRows = highlights.map((h, i) => {
    const teaser = copy.highlights_copy?.[i]?.teaser || h.description.slice(0, 80);
    return `
    <tr>
      <td style="padding:16px 24px;border-bottom:1px solid ${D.border};">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="90" style="vertical-align:top;padding-right:14px;">
              <img src="${getImage(h)}" width="90" height="90" alt="" style="border-radius:4px;display:block;object-fit:cover;">
            </td>
            <td style="vertical-align:top;">
              <div style="margin-bottom:6px;">${platformBadge(h.platform)}</div>
              <div style="font-size:13px;font-weight:600;color:${D.text};line-height:1.4;margin-bottom:6px;">${h.title}</div>
              <div style="font-size:12px;color:${D.muted};line-height:1.4;margin-bottom:8px;">${teaser}</div>
              <a href="${h.link}" style="font-size:11px;color:${D.orange};font-weight:700;text-decoration:none;text-transform:uppercase;letter-spacing:0.5px;">View thread →</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join("");

  const quickHitRows = quickHits.map((q) => `
    <tr>
      <td style="padding:10px 24px;border-bottom:1px solid ${D.border};">
        ${platformBadge(q.platform)}&nbsp;&nbsp;
        <a href="${q.link}" style="font-size:13px;color:${D.silver};text-decoration:none;font-weight:500;">${q.title}</a>
        <div style="font-size:11px;color:${D.muted};margin-top:3px;">${q.source}</div>
      </td>
    </tr>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Street Pulse — ${getDisplayDate()}</title>
</head>
<body style="margin:0;padding:0;background:${D.black};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:${D.black};">
  <tr><td align="center" style="padding:20px 10px;">

  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${D.dark};">

    <!-- HEADER -->
    <tr>
      <td style="background:${D.black};padding:32px 24px 24px;border-bottom:3px solid ${D.red};">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <div style="font-size:28px;font-weight:900;color:${D.text};letter-spacing:-1px;line-height:1;">🛞 STREET PULSE</div>
              <div style="font-size:11px;color:${D.muted};text-transform:uppercase;letter-spacing:2px;margin-top:6px;">What the car community is actually saying</div>
            </td>
            <td align="right" style="vertical-align:bottom;">
              <div style="font-size:10px;color:${D.muted};">${getDisplayDate()}</div>
              <div style="margin-top:4px;">
                <span style="font-size:10px;background:${D.reddit};color:#fff;padding:2px 7px;border-radius:3px;margin-right:4px;font-weight:700;">REDDIT</span>
                <span style="font-size:10px;background:${D.blue};color:#fff;padding:2px 7px;border-radius:3px;font-weight:700;">X</span>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ISSUE TITLE + INTRO -->
    <tr>
      <td style="padding:24px 24px 16px;background:${D.card};border-bottom:1px solid ${D.border};">
        <div style="font-size:20px;font-weight:800;color:${D.red};margin-bottom:8px;text-transform:uppercase;letter-spacing:-0.5px;">${copy.issue_title}</div>
        <div style="font-size:14px;color:${D.silver};line-height:1.6;">${copy.intro_line}</div>
      </td>
    </tr>

    <!-- HERO POST -->
    <tr>
      <td style="padding:0;">
        <img src="${getImage(hero)}" width="600" alt="" style="display:block;width:100%;height:240px;object-fit:cover;">
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px 24px;background:${D.card};border-bottom:1px solid ${D.border};">
        <div style="margin-bottom:10px;">
          ${platformBadge(hero.platform)}
          <span style="font-size:11px;color:${D.muted};margin-left:8px;">${hero.source}</span>
        </div>
        <div style="font-size:18px;font-weight:700;color:${D.text};line-height:1.3;margin-bottom:12px;">${hero.title}</div>
        <div style="font-size:14px;color:${D.silver};line-height:1.6;margin-bottom:16px;">${copy.hero_summary}</div>
        <a href="${hero.link}" style="display:inline-block;background:${D.red};color:#fff;font-size:12px;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:4px;text-transform:uppercase;letter-spacing:0.5px;">${copy.hero_cta}</a>
      </td>
    </tr>

    <!-- HOT TAKE BOX -->
    <tr>
      <td style="padding:0 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:${D.steel};border-left:4px solid ${D.orange};margin:20px 0 0;border-radius:4px;">
          <tr>
            <td style="padding:16px 18px;">
              <div style="font-size:11px;color:${D.orange};font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">🔥 Editor's Hot Take</div>
              <div style="font-size:13px;color:${D.silver};line-height:1.6;">${copy.hot_take}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- HIGHLIGHTS HEADER -->
    <tr>
      <td style="padding:24px 24px 8px;">
        <div style="font-size:12px;color:${D.orange};font-weight:700;text-transform:uppercase;letter-spacing:1.5px;">Top Threads</div>
      </td>
    </tr>

    <!-- HIGHLIGHTS -->
    <table width="100%" cellpadding="0" cellspacing="0">
      ${highlightRows}
    </table>

    <!-- QUICK HITS HEADER -->
    <tr>
      <td style="padding:24px 24px 8px;">
        <div style="font-size:12px;color:${D.blue};font-weight:700;text-transform:uppercase;letter-spacing:1.5px;">⚡ Quick Hits</div>
      </td>
    </tr>

    <!-- QUICK HITS -->
    <table width="100%" cellpadding="0" cellspacing="0">
      ${quickHitRows}
    </table>

    <!-- COMMUNITY PULSE -->
    <tr>
      <td style="padding:20px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:${D.card};border:1px solid ${D.border};border-radius:4px;">
          <tr>
            <td style="padding:16px 18px;">
              <div style="font-size:11px;color:${D.green};font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">🌡 Community Pulse</div>
              <div style="font-size:13px;color:${D.silver};line-height:1.5;">${copy.community_pulse}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- FOOTER -->
    <tr>
      <td style="padding:20px 24px;background:${D.black};border-top:1px solid ${D.border};text-align:center;">
        <div style="font-size:12px;color:${D.muted};margin-bottom:6px;">${copy.sign_off}</div>
        <div style="font-size:11px;color:${D.border};margin-top:12px;">
          <a href="%unsubscribe_link%" style="color:${D.muted};text-decoration:none;">Unsubscribe</a>
          &nbsp;·&nbsp;
          <span>Street Pulse — by the community, for the community</span>
        </div>
      </td>
    </tr>

  </table>
  </td></tr>
</table>

</body>
</html>`;

  log("✓ Stage 4 complete.");
  return html;
}

// ─────────────────────────────────────────────
// STAGE 5: SEND
// ─────────────────────────────────────────────

async function sendNewsletter(html, issueTitle) {
  if (CONFIG.DRY_RUN) {
    log("DRY_RUN mode — skipping SendGrid. Preview first 800 chars:");
    console.log(html.slice(0, 800) + "\n...[truncated]");
    return;
  }

  log("Sending via SendGrid...");
  sgMail.setApiKey(CONFIG.SENDGRID_API_KEY);

  await sgMail.send({
    to      : CONFIG.TO_EMAIL,
    from    : CONFIG.FROM_EMAIL,
    subject : `🛞 Street Pulse — ${issueTitle} (${getDisplayDate()})`,
    html,
  });

  log(`✓ Sent to ${CONFIG.TO_EMAIL}`);
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

(async () => {
  try {
    const [redditPosts, xPosts] = await Promise.all([fetchReddit(), fetchX()]);
    const allPosts = [...redditPosts, ...xPosts];
    log(`Total posts collected: ${allPosts.length}`);

    const scoredPosts             = await scoreAndCategorize(allPosts);
    const { copy, hero, highlights, quickHits } = await writeCopy(scoredPosts);
    const html                    = buildHTML({ copy, hero, highlights, quickHits });

    await sendNewsletter(html, copy.issue_title);
    log("✓ Street Pulse complete!");
  } catch (err) {
    log(`FATAL: ${err.message}`);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  }
})();
