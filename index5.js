/**
 * NCAA Proxy for ESP32 Tickers (Football + Basketball + Baseball)
 * - /scores returns compact JSON including home_id/away_id
 * - /logo and /logo32 proxy to Vercel BMP backend and cache at Cloudflare edge
 *
 * Example:
 *  /scores?preset=ncaam&tz=-4
 *  /scores?preset=cfb&tz=-4
 *  /scores?preset=cbase&tz=-4
 *
 *  /logo?teamId=2294
 *  /logo32?teamId=150
 *
 * Cloudflare caching uses fetch cf options cacheEverything/cacheTtl. [1](https://developers.cloudflare.com/workers/examples/cache-using-fetch/)
 */

// ----------------------
// CONFIG
// ----------------------

// Hardcode your working Vercel BMP backend:
const DEFAULT_VERCEL_BASE = "https://ncaa-proxy.vercel.app";

// Cache settings
const LOGO_CACHE_TTL_SEC = 7 * 24 * 60 * 60;  // 7 days
const SCORE_SUBFETCH_TTL_SEC = 15;            // 15s edge cache for ESPN scoreboard fetch

// NCAA presets -> ESPN {sport}/{league}
const NCAA_PRESETS = {
  cfb:   { sport: "football",   league: "college-football" },
  ncaam: { sport: "basketball", league: "mens-college-basketball" },
  ncaaw: { sport: "basketball", league: "womens-college-basketball" },
  cbase: { sport: "baseball",   league: "college-baseball" }
};

// ----------------------
// HELPERS
// ----------------------

function getVercelBase(env) {
  // Optional env override (nice if you have multiple backends)
  return (env && env.NCAA_VERCEL_BASE) ? env.NCAA_VERCEL_BASE : DEFAULT_VERCEL_BASE;
}

function intOr(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

function pickSportLeague(url) {
  const preset = url.searchParams.get("preset")?.toLowerCase();
  let sport = url.searchParams.get("sport");
  let league = url.searchParams.get("league");

  if (preset && NCAA_PRESETS[preset]) {
    sport = NCAA_PRESETS[preset].sport;
    league = NCAA_PRESETS[preset].league;
  }

  // Default if nothing provided
  if (!sport || !league) {
    sport = "basketball";
    league = "mens-college-basketball";
  }

  return { sport, league };
}

function buildScoreboardUrl(sport, league, dates) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`;
  return dates ? `${base}?dates=${encodeURIComponent(dates)}` : base;
}

function formatPreGameTime(isoDateStr, tzOffsetHours) {
  const d = new Date(isoDateStr);
  if (isNaN(d.getTime())) return "Scheduled";

  d.setHours(d.getHours() + tzOffsetHours);

  const month = d.getMonth() + 1;
  const day = d.getDate();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = (hours % 12) || 12;

  return `${month}/${day} - ${hours}:${minutes} ${ampm}`;
}

function withCors(res, cacheControl) {
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", "*");
  if (cacheControl) out.headers.set("Cache-Control", cacheControl);
  return out;
}

function json(obj, status = 200, cacheControl = null) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...(cacheControl ? { "Cache-Control": cacheControl } : {})
    }
  });
}

// ----------------------
// WORKER
// ----------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/scores") {
      return handleScores(url);
    }

    if (url.pathname === "/logo" || url.pathname === "/logo32") {
      const size = (url.pathname === "/logo32") ? 32 : 16;
      return handleLogo(url, env, size);
    }

    return new Response("NCAA Cloudflare Worker Online", { status: 200 });
  }
};

// ----------------------
// /scores
// ----------------------

async function handleScores(url) {
  const { sport, league } = pickSportLeague(url);

  const tzOffset = intOr(url.searchParams.get("tz"), -5);
  const dates = url.searchParams.get("dates"); // optional YYYYMMDD
  const teamFilter = url.searchParams.get("team")?.toUpperCase(); // optional

  const espnUrl = buildScoreboardUrl(sport, league, dates);

  try {
    // Cache ESPN subrequest briefly at edge to reduce repeated hits. [1](https://developers.cloudflare.com/workers/examples/cache-using-fetch/)
    const res = await fetch(espnUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cf: { cacheEverything: true, cacheTtl: SCORE_SUBFETCH_TTL_SEC }
    });

    if (!res.ok) {
      return json({ error: "ESPN Fetch Failed", status: res.status }, 502);
    }

    const data = await res.json();

    let anyActive = false;
    let anyUpcoming = false;

    const games = (data.events || []).map((event) => {
      const competition = event?.competitions?.[0];
      const status = competition?.status ?? event?.status ?? {};
      const state = status?.type?.state || "pre"; // pre | in | post

      if (state === "in") anyActive = true;
      else if (state === "pre") anyUpcoming = true;

      let clock = status?.type?.detail || "";

      if (state === "pre") {
        clock = formatPreGameTime(event?.date, tzOffset);
      }

      const homeRaw = competition?.competitors?.find((c) => c.homeAway === "home");
      const awayRaw = competition?.competitors?.find((c) => c.homeAway === "away");

      const homeTeam = homeRaw?.team || {};
      const awayTeam = awayRaw?.team || {};

      return {
        home: homeTeam.abbreviation || "",
        away: awayTeam.abbreviation || "",
        home_id: homeTeam.id ? String(homeTeam.id) : "",
        away_id: awayTeam.id ? String(awayTeam.id) : "",
        home_score: homeRaw?.score || "0",
        away_score: awayRaw?.score || "0",
        clock,
        status: state
      };
    });

    // Filter by abbreviation if requested (scoped to chosen sport/league)
    let responseData = games;
    if (teamFilter) {
      const matches = games.filter(g => g.home === teamFilter || g.away === teamFilter);
      const inProgress = matches.find(g => g.status === "in");
      responseData = inProgress || matches[0] || { error: "Game Not Found", status: "No Game" };
    }

    // Same smart polling behavior as your MLB worker
    let pollInterval = 10;
    let swr = 10;
    if (!anyActive && anyUpcoming) { pollInterval = 600; swr = 60; }
    if (!anyActive && !anyUpcoming) { pollInterval = 7200; swr = 300; }

    return new Response(JSON.stringify(responseData), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": `public, s-maxage=${pollInterval}, stale-while-revalidate=${swr}`
      }
    });

  } catch (e) {
    return json({ error: "NCAA Fetch Failed", message: String(e) }, 500);
  }
}

// ----------------------
// /logo and /logo32
// ----------------------

async function handleLogo(url, env, size) {
  const teamId = url.searchParams.get("teamId") || url.searchParams.get("id");
  if (!teamId) return new Response("Missing teamId", { status: 400 });

  const vercelBase = getVercelBase(env).replace(/\/$/, "");
  const vercelUrl = `${vercelBase}/api/logo?teamId=${encodeURIComponent(teamId)}&size=${size}`;

  // Force Cloudflare edge caching regardless of origin cache headers. [1](https://developers.cloudflare.com/workers/examples/cache-using-fetch/)
  const res = await fetch(vercelUrl, {
    cf: { cacheEverything: true, cacheTtl: LOGO_CACHE_TTL_SEC }
  });

  // Pass through as BMP; normalize headers for ESP32 + browser testing
  return withCors(res, `public, s-maxage=${LOGO_CACHE_TTL_SEC}`);
}
