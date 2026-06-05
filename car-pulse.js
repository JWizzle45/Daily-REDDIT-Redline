#!/usr/bin/env node

/**
 * CAR PULSE — Social Listening Newsletter
 * ========================================
 * Tracks what real car people are talking about on Reddit and X/Twitter.
 * No press releases. No PR spin. Just the unfiltered conversation.
 *
 * IMPORTANT: Reddit blocks all direct HTTP from GitHub Actions (datacenter IPs).
 * Both Reddit and X data are fetched via Claude's built-in web_search tool,
 * which routes through Anthropic's infrastructure — no direct Reddit/X calls.
 *
 * Pipeline:
 *   Stage 1a: Claude web_search → finds top Reddit threads across car subreddits
 *   Stage 1b: Claude web_search → finds trending automotive topics on X/Twitter
 *   Stage 2:  Claude scores, clusters, finds trending conversation topics
 *   Stage 3:  Claude writes newsletter copy
 *   Stage 4:  Pure JS assembles final HTML email
 */

"use strict";

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
  MODEL             : "claude-sonnet-4-5",
  MAX_TOKENS        : 8000,
};

const REQUIRED_SEND = ["ANTHROPIC_API_KEY", "SENDGRID_API_KEY", "FROM_EMAIL", "TO_EMAIL"];
const REQUIRED_DRY  = ["ANTHROPIC_API_KEY", "FROM_EMAIL", "TO_EMAIL"];
const required = CONFIG.DRY_RUN ? REQUIRED_DRY : REQUIRED_SEND;
const missing  = required.filter((k) => !CONFIG[k]);

if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// ─────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────

const D = {
  bg        : "#0d0d0d",
  cardBg    : "#181818",
  headerBg  : "#111111",
  divider   : "#2a2a2a",
  accent    : "#ff3c00",
  accentAlt : "#7c3aed",
  xBlue     : "#1d9bf0",
  text      : "#f0f0f0",
  muted     : "#888888",
  silver    : "#cccccc",
  upvote    : "#ff4500",
  border    : "#2d2d2d",
};

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

function log(msg)  { console.log(`[${new Date().toISOString()}]  ${msg}`); }
function warn(msg) { console.warn(`[${new Date().toISOString()}] WARNING  ${msg}`); }

function getDisplayDate() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

function extractJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

// ─────────────────────────────────────────────
// STAGE 1a: FETCH REDDIT via Claude web_search
//
// Reddit blocks direct HTTP from GitHub Actions datacenter IPs.
// Claude's web_search tool routes through Anthropic's infrastructure,
// bypassing this block. This is the reliable solution.
// ─────────────────────────────────────────────

async function fetchRedditPosts() {
  log("STAGE 1a: Fetching Reddit posts via Claude web search...");
  const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

  const today = getDisplayDate();

  const prompt = `You are a Reddit research assistant. Search Reddit RIGHT NOW to find the hottest, most discussed car and automotive posts from today.

Search these subreddits for their top posts from the last 24-48 hours:
- r/cars (general car discussion)
- r/electricvehicles (EV news and discussion)
- r/formula1 (F1 racing)
- r/Justrolledintotheshop (funny/interesting mechanic finds)
- r/teslamotors (Tesla discussion)
- r/whatcar (car recommendations)
- r/BMW, r/Toyota, r/ford (brand subreddits)
- r/projectcar (DIY builds)

Search queries to run:
1. site:reddit.com/r/cars hot posts today cars
2. site:reddit.com/r/electricvehicles top posts today
3. site:reddit.com/r/formula1 hot today
4. site:reddit.com/r/Justrolledintotheshop top today
5. site:reddit.com/r/teslamotors trending today

Find 15-25 real Reddit posts. For each post collect:
- The actual post title
- Which subreddit it's from
- The Reddit URL (reddit.com/r/...)
- Approximate comment count if visible
- A brief summary of what's being discussed
- Whether it seems controversial, funny, informative, or a hot take

Today is ${today}.

Respond ONLY with JSON (no markdown fences):
{
  "posts": [
    {
      "title": "Exact post title",
      "subreddit": "r/cars",
      "url": "https://reddit.com/r/cars/comments/...",
      "comments": 245,
      "summary": "Brief description of the discussion",
      "vibe": "controversial|funny|informative|hot_take|question|news"
    }
  ],
  "fetch_note": "Any notes about what you found"
}`;

  try {
    const response = await client.messages.create({
      model     : CONFIG.MODEL,
      max_tokens: 6000,
      tools     : [{ type: "web_search_20250305", name: "web_search" }],
      messages  : [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const data = extractJSON(text);

    if (!data || !data.posts || data.posts.length === 0) {
      warn("No Reddit posts found in web search response. Will use X signals only.");
      return [];
    }

    // Normalize posts into our standard shape
    const posts = data.posts.map((p) => ({
      source    : "Reddit",
      subreddit : p.subreddit || "r/cars",
      title     : p.title || "",
      text      : p.summary || "",
      url       : p.url || "",
      comments  : typeof p.comments === "number" ? p.comments : 0,
      vibe      : p.vibe || "informative",
      image     : "",
      pubDate   : new Date().toISOString(),
    })).filter((p) => p.title && p.url);

    // Sort by comment count descending
    posts.sort((a, b) => b.comments - a.comments);

    log(`Found ${posts.length} Reddit posts via web search.`);
    if (data.fetch_note) log(`  Note: ${data.fetch_note}`);
    return posts;

  } catch (e) {
    warn(`Reddit web search failed: ${e.message}. Continuing without Reddit data.`);
    return [];
  }
}

// ─────────────────────────────────────────────
// STAGE 1b: FETCH X/TWITTER via Claude web_search
// ─────────────────────────────────────────────

async function fetchXSignals() {
  log("STAGE 1b: Searching for X/Twitter signals via Claude web search...");
  const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

  const prompt = `You are a social media analyst. Search the web to find what automotive topics are trending or being hotly debated on X (Twitter) today.

Search for:
1. Trending car news and controversies on X today
2. Viral automotive posts or hot takes on X in the last 24 hours
3. Electric vehicle drama or debate on X today
4. Motorsport buzz on X today (F1, NASCAR, etc.)
5. Funny or viral car memes or moments on X today

Find 8-12 distinct trending topics. Respond ONLY with JSON (no markdown fences):
{
  "x_signals": [
    {
      "topic": "Short topic name",
      "summary": "What's being said and why it's getting attention",
      "sentiment": "heated|positive|negative|mixed",
      "mentions": ["Tesla", "specific car model"],
      "quote": "Representative quote or headline if available",
      "engagement_level": "viral|high|moderate"
    }
  ],
  "overall_mood": "One sentence on the general automotive mood on X today"
}`;

  try {
    const response = await client.messages.create({
      model     : CONFIG.MODEL,
      max_tokens: 4000,
      tools     : [{ type: "web_search_20250305", name: "web_search" }],
      messages  : [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const data = extractJSON(text);

    if (!data) {
      warn("Could not parse X signals JSON. Using empty signals.");
      return { x_signals: [], overall_mood: "Automotive community is active today." };
    }

    log(`Found ${(data.x_signals || []).length} X signals.`);
    return data;
  } catch (e) {
    warn(`X signals fetch failed: ${e.message}. Continuing without X data.`);
    return { x_signals: [], overall_mood: "" };
  }
}

// ─────────────────────────────────────────────
// STAGE 2: CLUSTER + ANALYZE
// ─────────────────────────────────────────────

async function scoreAndCluster(redditPosts, xSignals) {
  log("STAGE 2: Clustering and analyzing posts...");
  const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

  const postList = redditPosts.slice(0, 25)
    .map((p, i) =>
      `[${i + 1}] ${p.subreddit} | ${p.comments} comments | vibe: ${p.vibe}\n    "${p.title}"\n    ${p.text ? p.text.slice(0, 120) : ""}`
    ).join("\n\n");

  const xList = (xSignals.x_signals || [])
    .map((s, i) => `[X-${i + 1}] ${s.topic} (${s.sentiment}): ${s.summary}`)
    .join("\n");

  const prompt = `Analyze these Reddit posts and X signals about cars. Identify the best content for a newsletter.

REDDIT POSTS:
${postList || "No Reddit posts available today."}

X/TWITTER SIGNALS:
${xList || "No X signals available today."}

Tasks:
1. TOP THREAD — pick the single most interesting/engaging Reddit post (index 0-based)
2. TRENDING TOPICS — 3-4 recurring themes across posts and platforms
3. HOT TAKES — 3 posts with strong opinions, controversy, or community debate (0-based indices)
4. COMMUNITY MOOD — one sentence vibe check + emoji

Respond ONLY with JSON (no markdown):
{
  "top_thread_index": 0,
  "trending_topics": [
    { "name": "Topic Name", "description": "Why it is trending", "x_topic": "X-2 or null" }
  ],
  "hot_take_indices": [1, 2, 3],
  "community_mood": "One sentence vibe",
  "mood_emoji": "🔥"
}`;

  let clusters = {
    top_thread_index  : 0,
    trending_topics   : [],
    hot_take_indices  : [1, 2, 3],
    community_mood    : "The car community is buzzing today.",
    mood_emoji        : "🔥",
  };

  try {
    const resp = await client.messages.create({
      model     : CONFIG.MODEL,
      max_tokens: 2000,
      messages  : [{ role: "user", content: prompt }],
    });
    const parsed = extractJSON(resp.content[0]?.text || "");
    if (parsed) clusters = { ...clusters, ...parsed };
  } catch (e) {
    warn(`Stage 2 error: ${e.message}. Using defaults.`);
  }

  log(`Stage 2 complete. Top thread index: ${clusters.top_thread_index}`);
  return clusters;
}

// ─────────────────────────────────────────────
// STAGE 3: WRITE COPY
// ─────────────────────────────────────────────

async function writeCopy(redditPosts, xSignals, clusters) {
  log("STAGE 3: Writing newsletter copy...");
  const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

  const topThread    = redditPosts[clusters.top_thread_index] || redditPosts[0];
  const hotTakePosts = (clusters.hot_take_indices || [1, 2, 3])
    .map((i) => redditPosts[i]).filter(Boolean);

  // Build fallback content from X signals if no Reddit posts
  const hasReddit = redditPosts.length > 0;
  const topContent = hasReddit && topThread
    ? `Title: "${topThread.title}"\nSubreddit: ${topThread.subreddit}\nComments: ${topThread.comments}\nSummary: ${topThread.text}\nURL: ${topThread.url}`
    : `No Reddit posts available. Use X signals as the main content source.`;

  const prompt = `Write a newsletter called "CAR PULSE" — daily digest of what car people are saying on Reddit and X. Tone: punchy, street-smart, genuine. NOT corporate.

TODAY: ${getDisplayDate()}

TOP THREAD:
${topContent}

HOT TAKES:
${hotTakePosts.map((p, i) => `${i + 1}. [${p.subreddit}] "${p.title}" — ${p.comments} comments`).join("\n") || "None available"}

TRENDING TOPICS:
${(clusters.trending_topics || []).map((t) => `- ${t.name}: ${t.description}`).join("\n") || "None"}

X SIGNALS:
${(xSignals.x_signals || []).map((s) => `[${s.sentiment.toUpperCase()}] ${s.topic}: ${s.summary}`).join("\n") || "None today"}

MOOD: ${clusters.community_mood} ${clusters.mood_emoji}

Respond ONLY with JSON (no markdown):
{
  "subject_line": "Punchy subject line max 70 chars with emoji",
  "intro_line": "2-3 sentence opener. Set the mood.",
  "top_thread_headline": "Punchy rewritten headline",
  "top_thread_summary": "3-4 sentences. What is happening, why the community cares.",
  "top_thread_cta": "3-5 word button text",
  "hot_takes": [
    { "headline": "Short punchy headline", "summary": "2 sentences. The take and the reaction.", "vibe": "🔥" }
  ],
  "trending_topic_summaries": [
    { "name": "Topic", "what_theyre_saying": "2 sentences." }
  ],
  "x_highlight": "2-3 sentences on the most interesting X automotive topic today.",
  "pulse_fact": "One surprising or funny fact related to today's topics. 1-2 sentences.",
  "outro": "1 short punchy closing line."
}`;

  let copy = {
    subject_line            : `🚗 CAR PULSE — ${getDisplayDate()}`,
    intro_line              : "Here's what the car community is talking about today.",
    top_thread_headline     : topThread?.title || "Top story today",
    top_thread_summary      : "The car community is having a big conversation today.",
    top_thread_cta          : "Read the thread →",
    hot_takes               : [],
    trending_topic_summaries: [],
    x_highlight             : "",
    pulse_fact              : "Cars are endlessly fascinating.",
    outro                   : "See you tomorrow.",
  };

  try {
    const resp = await client.messages.create({
      model     : CONFIG.MODEL,
      max_tokens: CONFIG.MAX_TOKENS,
      messages  : [{ role: "user", content: prompt }],
    });
    const parsed = extractJSON(resp.content[0]?.text || "");
    if (parsed) copy = { ...copy, ...parsed };
  } catch (e) {
    warn(`Stage 3 error: ${e.message}. Using fallback copy.`);
  }

  log("Stage 3 complete.");
  return { topThread, hotTakePosts, copy };
}

// ─────────────────────────────────────────────
// STAGE 4: BUILD HTML EMAIL
// ─────────────────────────────────────────────

function buildHTML(redditPosts, xSignals, clusters, topThread, hotTakePosts, copy) {
  log("STAGE 4: Building HTML...");
  const date = getDisplayDate();

  const FALLBACK_IMGS = [
    "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1544636331-e26879cd4d9b?w=600&auto=format&fit=crop&q=80",
    "https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=600&auto=format&fit=crop&q=80",
  ];

  const heroImage      = topThread?.image || FALLBACK_IMGS[0];
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
          <span style="background:${D.upvote};color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:12px;">💬 ${post.comments}</span>
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
        <p style="font-size:13px;color:${D.silver};line-height:1.5;margin:0;">${summary?.what_theyre_saying || topic.description}</p>
        ${topic.x_topic ? `<div style="margin-top:8px;font-size:11px;color:${D.xBlue};">Also trending on 𝕏</div>` : ""}
      </div>`;
  }).join("");

  const xSignalsHTML = xSignalList.length > 0 ? `
    <div style="background:${D.cardBg};border-radius:8px;padding:24px;margin:0 0 24px 0;border:1px solid ${D.xBlue}33;">
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

  const usedIndices = new Set([
    clusters.top_thread_index,
    ...(clusters.hot_take_indices || []),
  ]);
  const quickHits = redditPosts.filter((_, i) => !usedIndices.has(i)).slice(0, 6);

  const quickHitsHTML = quickHits.map((p) => `
    <div style="padding:12px 0;border-bottom:1px solid ${D.divider};">
      <a href="${p.url}" style="color:${D.text};text-decoration:none;font-size:13px;font-weight:500;display:block;margin-bottom:4px;line-height:1.4;">${p.title}</a>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="color:${D.upvote};font-size:11px;font-weight:700;">💬 ${p.comments}</span>
        <span style="color:${D.muted};font-size:11px;">${p.subreddit}</span>
      </div>
    </div>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CAR PULSE — ${date}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:${D.bg}; color:${D.text}; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif; }
    .container { max-width:600px; margin:0 auto; background:${D.bg}; }
    @media(max-width:600px){ .container{margin:0;} }
  </style>
</head>
<body>
<div class="container">

  <!-- HEADER -->
  <div style="background:${D.headerBg};padding:32px 24px 24px;border-bottom:2px solid ${D.accent};">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
      <h1 style="font-size:28px;font-weight:900;letter-spacing:-1px;color:${D.text};">🚗 CAR PULSE</h1>
      <div style="display:flex;gap:6px;">
        <span style="background:${D.upvote};color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;">REDDIT</span>
        <span style="background:${D.xBlue};color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;">𝕏</span>
      </div>
    </div>
    <div style="font-size:12px;color:${D.muted};text-transform:uppercase;letter-spacing:1px;">What real car people are saying · ${date}</div>
    <div style="margin-top:16px;background:${D.divider};border-radius:6px;padding:12px 16px;border-left:3px solid ${D.accent};">
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
      <img src="${heroImage}" alt="Car" style="width:100%;height:200px;object-fit:cover;display:block;" onerror="this.style.display='none'">
      <div style="padding:22px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
          <span style="background:${D.upvote};color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:12px;">💬 ${(topThread?.comments || 0).toLocaleString()} comments</span>
          <span style="color:${D.accentAlt};font-size:11px;font-weight:600;">${topThread?.subreddit || ""}</span>
        </div>
        <h2 style="font-size:22px;font-weight:800;color:${D.text};line-height:1.3;margin-bottom:12px;">${copy.top_thread_headline}</h2>
        <p style="font-size:14px;color:${D.silver};line-height:1.6;margin-bottom:18px;">${copy.top_thread_summary}</p>
        <a href="${topThread?.url || "#"}" style="display:inline-block;background:${D.accent};color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px;">${copy.top_thread_cta || "Jump in the thread →"}</a>
      </div>
    </div>
  </div>

  <!-- HOT TAKES -->
  ${hotTakePosts.length > 0 || (copy.hot_takes || []).length > 0 ? `
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
  <div style="background:${D.cardBg};padding:24px;">
    <div style="font-size:11px;font-weight:700;color:${D.muted};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:16px;">⚡ Quick Hits from Reddit</div>
    ${quickHitsHTML}
  </div>` : ""}

  <!-- PULSE FACT -->
  <div style="padding:24px;">
    <div style="background:${D.cardBg};border-left:4px solid ${D.accent};border-radius:0 8px 8px 0;padding:18px 20px;">
      <div style="font-size:11px;font-weight:700;color:${D.accent};text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">⚙ Pulse Fact</div>
      <p style="font-size:14px;color:${D.silver};line-height:1.6;margin:0;">${copy.pulse_fact}</p>
    </div>
  </div>

  <!-- FOOTER -->
  <div style="background:${D.headerBg};padding:24px;border-top:1px solid ${D.divider};text-align:center;">
    <p style="font-size:14px;color:${D.silver};margin-bottom:16px;font-style:italic;">${copy.outro}</p>
    <div style="font-size:11px;color:${D.muted};margin-bottom:8px;">Powered by Reddit + X · Curated by Claude AI</div>
    <div style="font-size:11px;color:${D.muted};"><a href="%unsubscribe_link%" style="color:${D.muted};">Unsubscribe</a></div>
  </div>

</div>
</body>
</html>`;

  log("Stage 4 complete.");
  return { html, subjectLine: copy.subject_line || `🚗 CAR PULSE — ${date}` };
}

// ─────────────────────────────────────────────
// SEND
// ─────────────────────────────────────────────

async function sendNewsletter(html, subjectLine) {
  if (CONFIG.DRY_RUN) {
    log("DRY RUN — email not sent.");
    log(`Subject: ${subjectLine}`);
    console.log("\n" + html.slice(0, 600) + "\n...[truncated]\n");
    return;
  }
  log("Sending via SendGrid...");
  sgMail.setApiKey(CONFIG.SENDGRID_API_KEY);
  try {
    await sgMail.send({
      to: CONFIG.TO_EMAIL, from: CONFIG.FROM_EMAIL,
      subject: subjectLine, html,
    });
    log(`Email sent to ${CONFIG.TO_EMAIL}`);
  } catch (err) {
    log(`SendGrid error: ${err.message}`);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

(async () => {
  try {
    log("🚗 CAR PULSE starting...");

    // Stages 1a + 1b run in parallel
    const [redditPosts, xSignals] = await Promise.all([
      fetchRedditPosts(),
      fetchXSignals(),
    ]);

    if (redditPosts.length === 0 && (xSignals.x_signals || []).length === 0) {
      log("ERROR: No content fetched from Reddit or X. Check ANTHROPIC_API_KEY. Exiting.");
      process.exit(1);
    }

    if (redditPosts.length === 0) {
      warn("No Reddit posts found — newsletter will be X-signals only.");
    }

    const clusters = await scoreAndCluster(redditPosts, xSignals);
    const { topThread, hotTakePosts, copy } = await writeCopy(redditPosts, xSignals, clusters);
    const { html, subjectLine } = buildHTML(redditPosts, xSignals, clusters, topThread, hotTakePosts, copy);

    await sendNewsletter(html, subjectLine);
    log("CAR PULSE complete!");
  } catch (err) {
    log(`FATAL: ${err.message}`);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  }
})();
