#!/usr/bin/env node

/**
 * CAR PULSE — Social Listening Newsletter
 * ========================================
 * Tracks what real car people are talking about on Reddit and X/Twitter.
 * No press releases. No PR spin. Just the unfiltered conversation.
 *
 * Pipeline:
 *   Stage 1: Fetch Reddit posts via RSS + fetch X/Twitter via Claude web search
 *   Stage 2: Claude scores, clusters, and finds the trending conversation topics
 *   Stage 3: Claude selects layout (top thread, hot takes, trending topics)
 *   Stage 4: Claude writes newsletter copy (summaries, hot take quotes, pulse fact)
 *   Stage 5: Pure JS assembles final HTML email
 *
 * Run:      node car-pulse.js
 * Dry run:  DRY_RUN=true node car-pulse.js
 */

"use strict";

const Parser    = require("rss-parser");
const Anthropic = require("@anthropic-ai/sdk");
const sgMail    = require("@sendgrid/mail");

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

const CONFIG = {
  ANTHROPIC_API_KEY : process.env.ANTHROPIC_API_KEY,
  SENDGRID_API_KEY  : process.env.SENDGRID_API_KEY,
  FROM_EMAIL        : process.env.FROM_EMAIL,
  TO_EMAIL          : process.env.TO_EMAIL,
  DRY_RUN           : process.env.DRY_RUN === "true",
  MAX_POSTS         : parseInt(process.env.MAX_POSTS || "40", 10),
  MODEL             : "claude-sonnet-4-5",
  MAX_TOKENS        : 8000,
};

const REQUIRED_ALWAYS = ["FROM_EMAIL", "TO_EMAIL"];
const REQUIRED_SEND   = ["ANTHROPIC_API_KEY", "SENDGRID_API_KEY", "FROM_EMAIL", "TO_EMAIL"];
const required = CONFIG.DRY_RUN ? REQUIRED_ALWAYS : REQUIRED_SEND;
const missing  = required.filter((k) => !CONFIG[k]);

if (missing.length) {
  console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// ─────────────────────────────────────────────
// REDDIT RSS FEEDS
// Using RSS endpoints instead of JSON API —
// RSS works from GitHub Actions CI; the JSON API
// blocks datacenter IPs with 403s.
// Format: https://www.reddit.com/r/SUBREDDIT/.rss
// ─────────────────────────────────────────────

const REDDIT_FEEDS = [
  { url: "https://www.reddit.com/r/cars/.rss",                   sub: "r/cars"                  },
  { url: "https://www.reddit.com/r/cars/new/.rss",               sub: "r/cars"                  },
  { url: "https://www.reddit.com/r/electricvehicles/.rss",       sub: "r/electricvehicles"      },
  { url: "https://www.reddit.com/r/teslamotors/.rss",            sub: "r/teslamotors"           },
  { url: "https://www.reddit.com/r/formula1/.rss",               sub: "r/formula1"              },
  { url: "https://www.reddit.com/r/Justrolledintotheshop/.rss",  sub: "r/Justrolledintotheshop" },
  { url: "https://www.reddit.com/r/whatcar/.rss",                sub: "r/whatcar"               },
  { url: "https://www.reddit.com/r/Cartalk/.rss",                sub: "r/Cartalk"               },
  { url: "https://www.reddit.com/r/BMW/.rss",                    sub: "r/BMW"                   },
  { url: "https://www.reddit.com/r/Toyota/.rss",                 sub: "r/Toyota"                },
  { url: "https://www.reddit.com/r/ford/.rss",                   sub: "r/ford"                  },
  { url: "https://www.reddit.com/r/projectcar/.rss",             sub: "r/projectcar"            },
];

// ─────────────────────────────────────────────
// X / TWITTER SEARCH QUERIES
// Claude web_search will run these to find trending X posts.
// We simulate this by giving Claude targeted search strings.
// ─────────────────────────────────────────────

const X_SEARCH_QUERIES = [
  "site:twitter.com OR site:x.com car news trending today",
  "site:x.com EV electric vehicle controversy viral today",
  "site:x.com car recall hot take trending",
  "site:x.com Tesla Ford Toyota drama today",
  "site:x.com motorsport F1 NASCAR viral moment today",
];

// ─────────────────────────────────────────────
// DESIGN TOKENS — Dark, edgy, community-feel
// ─────────────────────────────────────────────

const D = {
  bg          : "#0d0d0d",
  cardBg      : "#181818",
  headerBg    : "#111111",
  divider     : "#2a2a2a",
  accent      : "#ff3c00",   // hot red-orange
  accentAlt   : "#7c3aed",   // purple (Reddit vibe)
  xBlue       : "#1d9bf0",   // X/Twitter blue
  text        : "#f0f0f0",
  muted       : "#888888",
  silver      : "#cccccc",
  upvote      : "#ff4500",   // Reddit upvote orange
  border      : "#2d2d2d",
};

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

function log(msg)  { console.log(`[${new Date().toISOString()}]  ${msg}`); }
function warn(msg) { console.warn(`[${new Date().toISOString()}] ⚠  ${msg}`); }

function getDisplayDate() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

function cleanText(str = "") {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\n/g, " ")
    .trim()
    .slice(0, 300);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
// STAGE 1a: FETCH REDDIT (via RSS)
// Reddit's RSS feeds work from CI/datacenter IPs.
// The JSON API blocks them; RSS does not.
// We use rss-parser (already a dependency) to parse.
// Upvote counts are not available in RSS — we use
// comment count and recency as a proxy for engagement.
// ─────────────────────────────────────────────

async function fetchRedditPosts() {
  log("STAGE 1a: Fetching Reddit posts via RSS...");
  const rssParser = new Parser({
    headers: {
      "User-Agent": "CarPulseNewsletter/1.0 (daily newsletter bot)",
    },
    timeout: 10000,
  });
  const posts = [];

  for (const feed of REDDIT_FEEDS) {
    try {
      const data = await rssParser.parseURL(feed.url);
      for (const item of (data.items || [])) {
        if (!item.title || !item.link) continue;

        // Skip stickied/mod posts (titles often start with these patterns)
        const titleLower = item.title.toLowerCase();
        if (titleLower.startsWith("[mod") || titleLower.startsWith("mod post")) continue;

        // Extract comment count from content if available
        const commentMatch = (item.content || item.contentSnippet || "").match(/(\d+)\s+comment/i);
        const comments = commentMatch ? parseInt(commentMatch[1], 10) : 0;

        // Extract a thumbnail image if embedded in content
        const imgMatch = (item.content || "").match(/<img[^>]+src="([^"]+)"/i);
        const image = imgMatch ? imgMatch[1] : "";

        posts.push({
          source    : "Reddit",
          subreddit : feed.sub,
          title     : cleanText(item.title),
          text      : cleanText(item.contentSnippet || item.content || ""),
          url       : item.link,
          score     : 0,           // Not available via RSS
          comments,
          author    : item.author || item.creator || "unknown",
          flair     : "",
          image,
          pubDate   : item.pubDate || item.isoDate || new Date().toISOString(),
        });
      }
      await sleep(400); // be polite to Reddit's servers
    } catch (e) {
      warn(`Failed to fetch ${feed.sub}: ${e.message}`);
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const unique = posts.filter((p) => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  // Sort by comment count (best engagement proxy available in RSS)
  unique.sort((a, b) => b.comments - a.comments);

  log(`✓ Fetched ${unique.length} Reddit posts from ${REDDIT_FEEDS.length} subreddit feeds.`);
  return unique.slice(0, CONFIG.MAX_POSTS);
}

// ─────────────────────────────────────────────
// STAGE 1b: FETCH X/TWITTER SIGNALS via Claude Web Search
// We use Claude's built-in web_search tool to find trending
// automotive conversations on X without needing the X API.
// ─────────────────────────────────────────────

async function fetchXSignals() {
  log("STAGE 1b: Searching for X/Twitter signals via Claude web search...");
  const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

  const searchPrompt = `You are a social media analyst. Search the web to find what automotive topics, car brands, EVs, and car culture are trending or being hotly debated on X (Twitter) RIGHT NOW today.

Search for these topics:
1. Trending car news and controversies on X/Twitter today
2. Viral automotive posts or hot takes on X in the last 24 hours
3. What car enthusiasts on X are arguing about today
4. Electric vehicle drama or news on X today
5. Motorsport or racing buzz on X today

After searching, compile a list of 8–12 distinct trending topics or viral posts you found. For each, provide:
- The topic or post summary
- Why it's generating buzz (controversy, excitement, meme, etc.)
- Approximate sentiment (positive/negative/mixed/heated)
- Any specific accounts, brands, or cars mentioned
- A sample representative quote or headline if available

Format your response as JSON only (no markdown fences):
{
  "x_signals": [
    {
      "topic": "Short topic name",
      "summary": "What's being said and why",
      "sentiment": "heated|positive|negative|mixed",
      "mentions": ["Tesla", "Elon Musk"],
      "quote": "Representative quote or headline",
      "engagement_level": "viral|high|moderate"
    }
  ],
  "search_timestamp": "ISO date string",
  "overall_mood": "One sentence on the general automotive mood on X today"
}`;

  try {
    const response = await client.messages.create({
      model    : CONFIG.MODEL,
      max_tokens: 4000,
      tools    : [{ type: "web_search_20250305", name: "web_search" }],
      messages : [{ role: "user", content: searchPrompt }],
    });

    // Extract text from all content blocks (Claude may use web_search + return text)
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .replace(/```json|```/g, "")
      .trim();

    // Find the JSON object in the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      warn("Could not parse X signals JSON. Using empty signals.");
      return { x_signals: [], overall_mood: "Automotive community is active today." };
    }

    const data = JSON.parse(jsonMatch[0]);
    log(`✓ Found ${(data.x_signals || []).length} X signals.`);
    return data;
  } catch (e) {
    warn(`X signals fetch failed: ${e.message}. Continuing without X data.`);
    return { x_signals: [], overall_mood: "" };
  }
}

// ─────────────────────────────────────────────
// STAGE 2: SCORE + CLUSTER REDDIT POSTS
// ─────────────────────────────────────────────

async function scoreAndCluster(redditPosts, xSignals) {
  log("STAGE 2: Scoring and clustering posts...");
  const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

  const top30 = redditPosts.slice(0, 30);
  const postList = top30
    .map((p, i) =>
      `[${i + 1}] ${p.subreddit} | Comments: ${p.comments} | ${p.pubDate ? new Date(p.pubDate).toLocaleTimeString() : ""}\n    "${p.title}" ${p.text ? `— ${p.text.slice(0, 100)}` : ""}`
    )
    .join("\n");

  const xList = (xSignals.x_signals || [])
    .map((s, i) => `[X-${i + 1}] ${s.topic} (${s.sentiment}): ${s.summary}`)
    .join("\n");

  const stage2Prompt = `You are a car community pulse analyst. Analyze these Reddit posts and X/Twitter signals about cars and automotive topics.

REDDIT POSTS (sorted by comment count — RSS doesn't include upvote scores):
${postList}

X/TWITTER SIGNALS:
${xList || "No X signals available today."}

Your task:
1. Identify the TOP THREAD — the single most engaging Reddit post (most comments + most controversial or interesting topic)
2. Find 3–4 TRENDING TOPICS — recurring themes appearing across multiple posts or both platforms
3. Pick 3 HOT TAKES — posts with spicy opinions, controversies, or strong community reactions
4. Find any CROSS-PLATFORM BUZZ — topics appearing on both Reddit and X
5. Assess COMMUNITY MOOD today (excited? angry? meme-ing? debating?)

Respond ONLY with JSON (no markdown):
{
  "top_thread_index": 1,
  "trending_topics": [
    { "name": "Topic Name", "description": "Why it's trending", "reddit_indices": [1, 5], "x_topic": "X-2 or null" }
  ],
  "hot_take_indices": [2, 7, 12],
  "cross_platform_topics": ["Topic that appears on both Reddit and X"],
  "community_mood": "One sentence on today's automotive community vibe",
  "mood_emoji": "😤 or 🔥 or 😂 or 🤔 etc"
}`;

  let clusters = {
    top_thread_index   : 0,
    trending_topics    : [],
    hot_take_indices   : [1, 2, 3],
    cross_platform_topics: [],
    community_mood     : "The automotive community is buzzing today.",
    mood_emoji         : "🔥",
  };

  try {
    const resp = await client.messages.create({
      model    : CONFIG.MODEL,
      max_tokens: 3000,
      messages : [{ role: "user", content: stage2Prompt }],
    });
    const text = (resp.content[0]?.text || "").replace(/```json|```/g, "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) clusters = JSON.parse(jsonMatch[0]);
  } catch (e) {
    warn(`Stage 2 parse error: ${e.message}. Using defaults.`);
  }

  log(`✓ Stage 2 complete. Top thread: index ${clusters.top_thread_index}`);
  return clusters;
}

// ─────────────────────────────────────────────
// STAGE 3: WRITE NEWSLETTER COPY
// ─────────────────────────────────────────────

async function writeCopy(redditPosts, xSignals, clusters) {
  log("STAGE 3: Writing newsletter copy...");
  const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

  const topThread     = redditPosts[clusters.top_thread_index] || redditPosts[0];
  const hotTakePosts  = (clusters.hot_take_indices || [1, 2, 3])
    .map((i) => redditPosts[i])
    .filter(Boolean);

  const stage3Prompt = `You are writing a newsletter called "CAR PULSE" — a daily digest of what real car people are saying on Reddit and X/Twitter. The tone is punchy, street-smart, and genuine. NOT corporate. Think like a car enthusiast who also writes well.

TODAY: ${getDisplayDate()}

TOP THREAD ON REDDIT:
Title: "${topThread?.title}"
Subreddit: ${topThread?.subreddit}
Comments: ${topThread?.comments} | Subreddit: ${topThread?.subreddit}
Text: ${topThread?.text || "(link post, no body text)"}
URL: ${topThread?.url}

HOT TAKES FROM REDDIT:
${hotTakePosts.map((p, i) => `${i + 1}. [${p.subreddit}] "${p.title}" — ${p.comments} comments`).join("\n")}

TRENDING TOPICS (from both Reddit + X):
${(clusters.trending_topics || []).map((t) => `- ${t.name}: ${t.description}`).join("\n")}

X/TWITTER SIGNALS:
${(xSignals.x_signals || []).map((s) => `[${s.sentiment.toUpperCase()}] ${s.topic}: ${s.summary}`).join("\n") || "No X signals today."}

OVERALL MOOD: ${clusters.community_mood} ${clusters.mood_emoji}
X OVERALL MOOD: ${xSignals.overall_mood || ""}

Write the following newsletter copy. Be concise, punchy, and authentic. NO corporate speak. Sound like a car person.

Respond ONLY with JSON (no markdown):
{
  "subject_line": "Email subject line with today's vibe (max 70 chars, include an emoji)",
  "intro_line": "2–3 sentence opener. Set the mood. Reference what's happening today.",
  "top_thread_headline": "Punchy rewritten headline for the top thread (not just a copy of the title)",
  "top_thread_summary": "3–4 sentences. What's the post about? Why is the community going off? What are people saying?",
  "top_thread_cta": "3–5 word CTA button text (e.g. 'Jump in the thread')",
  "hot_takes": [
    {
      "headline": "Short punchy headline",
      "summary": "2 sentences. The take. The reaction.",
      "vibe": "🔥 or 😤 or 😂 or 🤔 (one emoji capturing the vibe)"
    }
  ],
  "trending_topic_summaries": [
    {
      "name": "Topic name",
      "what_theyre_saying": "2 sentences. What's the conversation? Whose side is everyone on?"
    }
  ],
  "x_highlight": "2–3 sentences summarizing the most interesting thing happening on X/Twitter today re: cars. Skip if no signals.",
  "pulse_fact": "One surprising, interesting, or funny fact related to today's top topics. Keep it tight — 1–2 sentences.",
  "outro": "1 short punchy closing line. Something a human would actually write."
}`;

  let copy = {
    subject_line             : `🚗 CAR PULSE — ${getDisplayDate()}`,
    intro_line               : "Here's what the car community is talking about today.",
    top_thread_headline      : topThread?.title || "Top thread today",
    top_thread_summary       : "A major discussion is happening in the car community.",
    top_thread_cta           : "Read the thread →",
    hot_takes                : [],
    trending_topic_summaries : [],
    x_highlight              : "",
    pulse_fact               : "Cars are fascinating machines.",
    outro                    : "See you tomorrow.",
  };

  try {
    const resp = await client.messages.create({
      model    : CONFIG.MODEL,
      max_tokens: CONFIG.MAX_TOKENS,
      messages : [{ role: "user", content: stage3Prompt }],
    });
    const text = (resp.content[0]?.text || "").replace(/```json|```/g, "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) copy = { ...copy, ...JSON.parse(jsonMatch[0]) };
  } catch (e) {
    warn(`Stage 3 parse error: ${e.message}. Using fallback copy.`);
  }

  log("✓ Stage 3 complete. Copy written.");
  return { topThread, hotTakePosts, copy };
}

// ─────────────────────────────────────────────
// STAGE 4: BUILD HTML EMAIL
// Pure JavaScript — no Claude call.
// ─────────────────────────────────────────────

function buildHTML(redditPosts, xSignals, clusters, topThread, hotTakePosts, copy) {
  log("STAGE 4: Building HTML email...");
  const date = getDisplayDate();

  // Pick images for fallbacks
  const FALLBACK_IMGS = [
    "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1544636331-e26879cd4d9b?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=600&auto=format&fit=crop&q=80",
  ];

  const heroImage = topThread?.image || FALLBACK_IMGS[0];

  const trendingTopics = (clusters.trending_topics || []).slice(0, 4);
  const topicSummaries = copy.trending_topic_summaries || [];
  const xSignalList    = (xSignals.x_signals || []).slice(0, 3);

  const hotTakesHTML = (copy.hot_takes || []).slice(0, 3).map((ht, i) => {
    const post = hotTakePosts[i];
    return `
      <div style="background:${D.cardBg};border-radius:8px;padding:18px;margin-bottom:14px;border-left:3px solid ${D.accentAlt};">
        <div style="font-size:22px;margin-bottom:6px;">${ht.vibe || "🔥"}</div>
        <h4 style="font-size:15px;font-weight:700;color:${D.text};margin:0 0 8px 0;line-height:1.3;">${ht.headline || post?.title || ""}</h4>
        <p style="font-size:13px;color:${D.silver};line-height:1.5;margin:0 0 10px 0;">${ht.summary || ""}</p>
        ${post ? `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="background:${D.upvote};color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:12px;">💬 ${post.comments} comments</span>
          <span style="color:${D.muted};font-size:11px;">💬 ${post.comments} comments</span>
          <span style="color:${D.accentAlt};font-size:11px;font-weight:600;">${post.subreddit}</span>
          <a href="${post.url}" style="color:${D.accentAlt};font-size:11px;text-decoration:none;margin-left:auto;">View thread →</a>
        </div>` : ""}
      </div>`;
  }).join("");

  const trendingHTML = trendingTopics.map((topic, i) => {
    const summary = topicSummaries[i];
    return `
      <div style="background:${D.cardBg};border-radius:8px;padding:16px;margin-bottom:12px;border:1px solid ${D.border};">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span style="background:${D.accentAlt};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;">Trending</span>
          <h4 style="font-size:14px;font-weight:700;color:${D.text};margin:0;">${topic.name}</h4>
        </div>
        <p style="font-size:13px;color:${D.silver};line-height:1.5;margin:0;">
          ${summary?.what_theyre_saying || topic.description}
        </p>
        ${topic.x_topic ? `<div style="margin-top:8px;font-size:11px;color:${D.xBlue};">Also trending on 𝕏</div>` : ""}
      </div>`;
  }).join("");

  const xSignalsHTML = xSignalList.length > 0 ? `
    <div style="background:${D.cardBg};border-radius:8px;padding:24px;margin:0 0 24px 0;border:1px solid ${D.xBlue}22;">
      <h3 style="font-size:13px;font-weight:700;color:${D.xBlue};text-transform:uppercase;letter-spacing:1px;margin:0 0 16px 0;">𝕏 What X Is Saying</h3>
      ${copy.x_highlight ? `<p style="font-size:14px;color:${D.silver};line-height:1.6;margin:0 0 16px 0;">${copy.x_highlight}</p>` : ""}
      ${xSignalList.map((s) => `
        <div style="border-left:2px solid ${
          s.sentiment === "positive" ? "#22c55e" :
          s.sentiment === "negative" ? "#ef4444" :
          s.sentiment === "heated"   ? D.accent  : D.xBlue
        };padding:8px 12px;margin-bottom:10px;">
          <div style="font-size:12px;font-weight:700;color:${D.text};margin-bottom:4px;">${s.topic}</div>
          <div style="font-size:12px;color:${D.silver};line-height:1.4;">${s.summary}</div>
          ${s.quote ? `<div style="font-size:11px;color:${D.muted};margin-top:4px;font-style:italic;">"${s.quote}"</div>` : ""}
        </div>`).join("")}
    </div>` : "";

  // Quick hits: remaining Reddit posts (not the top thread or hot takes)
  const usedIndices = new Set([
    clusters.top_thread_index,
    ...(clusters.hot_take_indices || []),
  ]);
  const quickHits = redditPosts
    .filter((_, i) => !usedIndices.has(i))
    .slice(0, 6);

  const quickHitsHTML = quickHits.map((p) => `
    <div style="padding:12px 0;border-bottom:1px solid ${D.divider};">
      <a href="${p.url}" style="color:${D.text};text-decoration:none;font-size:13px;font-weight:500;display:block;margin-bottom:4px;line-height:1.4;">${p.title}</a>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="color:${D.upvote};font-size:11px;font-weight:700;">💬 ${p.comments}</span>
        <span style="color:${D.muted};font-size:11px;">${p.subreddit}</span>
        <span style="color:${D.muted};font-size:11px;">💬 ${p.comments}</span>
      </div>
    </div>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CAR PULSE — ${date}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: ${D.bg}; color: ${D.text}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    .container { max-width: 600px; margin: 0 auto; background: ${D.bg}; }
    @media (max-width: 600px) {
      .container { margin: 0; }
      .hero-content h2 { font-size: 20px !important; }
    }
  </style>
</head>
<body>
  <div class="container">

    <!-- HEADER -->
    <div style="background:${D.headerBg};padding:32px 24px 24px;border-bottom:2px solid ${D.accent};">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <h1 style="font-size:28px;font-weight:900;letter-spacing:-1px;color:${D.text};">🚗 CAR PULSE</h1>
        <div style="display:flex;gap:6px;align-items:center;">
          <span style="background:${D.upvote};color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;">REDDIT</span>
          <span style="background:${D.xBlue};color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;">𝕏</span>
        </div>
      </div>
      <div style="font-size:12px;color:${D.muted};text-transform:uppercase;letter-spacing:1px;">What real car people are saying · ${date}</div>
      <div style="margin-top:16px;background:${D.divider};border-radius:6px;padding:12px 16px;border-left:3px solid ${clusters.mood_emoji ? D.accent : D.accentAlt};">
        <span style="font-size:20px;">${clusters.mood_emoji || "🔥"}</span>
        <span style="font-size:13px;color:${D.silver};margin-left:8px;font-style:italic;">${clusters.community_mood || "The car community is active today."}</span>
      </div>
    </div>

    <!-- INTRO -->
    <div style="padding:24px;background:${D.cardBg};border-bottom:1px solid ${D.divider};">
      <p style="font-size:15px;color:${D.silver};line-height:1.7;">${copy.intro_line}</p>
    </div>

    <!-- TOP THREAD -->
    <div style="padding:24px;">
      <div style="font-size:11px;font-weight:700;color:${D.accent};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">🔥 Top Thread Today</div>
      <div style="background:${D.cardBg};border-radius:10px;overflow:hidden;border:1px solid ${D.border};">
        <img src="${heroImage}" alt="Thread hero" style="width:100%;height:200px;object-fit:cover;display:block;background:${D.divider};" onerror="this.style.display='none'">
        <div style="padding:22px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
            <span style="background:${D.upvote};color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:12px;">💬 ${(topThread?.comments || 0).toLocaleString()} comments</span>
            <span style="color:${D.muted};font-size:11px;">${topThread?.subreddit || ""}</span>
            <span style="color:${D.accentAlt};font-size:11px;font-weight:600;">${topThread?.subreddit || ""}</span>
          </div>
          <h2 style="font-size:22px;font-weight:800;color:${D.text};line-height:1.3;margin-bottom:12px;">${copy.top_thread_headline}</h2>
          <p style="font-size:14px;color:${D.silver};line-height:1.6;margin-bottom:18px;">${copy.top_thread_summary}</p>
          <a href="${topThread?.url || "#"}" style="display:inline-block;background:${D.accent};color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px;">${copy.top_thread_cta || "Jump in the thread →"}</a>
        </div>
      </div>
    </div>

    <!-- HOT TAKES -->
    ${hotTakePosts.length > 0 ? `
    <div style="padding:0 24px 24px;">
      <div style="font-size:11px;font-weight:700;color:${D.accentAlt};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">😤 Hot Takes</div>
      ${hotTakesHTML}
    </div>` : ""}

    <!-- X SIGNALS -->
    ${xSignalsHTML ? `<div style="padding:0 24px 24px;">${xSignalsHTML}</div>` : ""}

    <!-- TRENDING TOPICS -->
    ${trendingTopics.length > 0 ? `
    <div style="padding:0 24px 24px;">
      <div style="font-size:11px;font-weight:700;color:${D.text};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">📈 Trending Topics</div>
      ${trendingHTML}
    </div>` : ""}

    <!-- QUICK HITS -->
    ${quickHits.length > 0 ? `
    <div style="background:${D.cardBg};padding:24px;margin:0 0 0 0;">
      <div style="font-size:11px;font-weight:700;color:${D.muted};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:16px;">⚡ Quick Hits from Reddit</div>
      ${quickHitsHTML}
      <div style="padding-top:4px;"></div>
    </div>` : ""}

    <!-- PULSE FACT -->
    <div style="padding:24px;">
      <div style="background:${D.cardBg};border-left:4px solid ${D.accent};border-radius:0 8px 8px 0;padding:18px 20px;">
        <div style="font-size:11px;font-weight:700;color:${D.accent};text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">⚙ Pulse Fact</div>
        <p style="font-size:14px;color:${D.silver};line-height:1.6;margin:0;">${copy.pulse_fact}</p>
      </div>
    </div>

    <!-- OUTRO + FOOTER -->
    <div style="background:${D.headerBg};padding:24px;border-top:1px solid ${D.divider};text-align:center;">
      <p style="font-size:14px;color:${D.silver};margin-bottom:16px;font-style:italic;">${copy.outro}</p>
      <div style="font-size:11px;color:${D.muted};margin-bottom:8px;">
        Powered by Reddit + X · Curated by Claude AI
      </div>
      <div style="font-size:11px;color:${D.muted};">
        <a href="%unsubscribe_link%" style="color:${D.muted};">Unsubscribe</a>
      </div>
    </div>

  </div>
</body>
</html>`;

  log("✓ Stage 4 complete. HTML built.");
  return { html, subjectLine: copy.subject_line || `🚗 CAR PULSE — ${date}` };
}

// ─────────────────────────────────────────────
// SEND EMAIL
// ─────────────────────────────────────────────

async function sendNewsletter(html, subjectLine) {
  if (CONFIG.DRY_RUN) {
    log("DRY RUN: Email not sent. HTML preview (first 800 chars):");
    console.log(html.slice(0, 800) + "\n...[truncated]\n");
    log(`Subject would be: ${subjectLine}`);
    return;
  }

  log("Sending via SendGrid...");
  sgMail.setApiKey(CONFIG.SENDGRID_API_KEY);

  try {
    await sgMail.send({
      to      : CONFIG.TO_EMAIL,
      from    : CONFIG.FROM_EMAIL,
      subject : subjectLine,
      html,
    });
    log(`✓ Email sent to ${CONFIG.TO_EMAIL}`);
  } catch (err) {
    log(`ERROR sending email: ${err.message}`);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

(async () => {
  try {
    log("🚗 CAR PULSE starting...\n");

    // Stage 1: Fetch sources in parallel where possible
    const [redditPosts, xSignals] = await Promise.all([
      fetchRedditPosts(),
      fetchXSignals(),
    ]);

    if (redditPosts.length === 0) {
      log("ERROR: No Reddit posts fetched. Check network access. Exiting.");
      process.exit(1);
    }

    // Stage 2: Score and cluster
    const clusters = await scoreAndCluster(redditPosts, xSignals);

    // Stage 3: Write copy
    const { topThread, hotTakePosts, copy } = await writeCopy(redditPosts, xSignals, clusters);

    // Stage 4: Build HTML
    const { html, subjectLine } = buildHTML(redditPosts, xSignals, clusters, topThread, hotTakePosts, copy);

    // Send
    await sendNewsletter(html, subjectLine);

    log("✅ CAR PULSE complete!\n");
  } catch (err) {
    log(`FATAL: ${err.message}`);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  }
})();
