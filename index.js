/**
 * NCAA Proxy for ESP32 Tickers (Football + Basketball * Examples: * NCAA Proxy for ESP32 Tickers (Football + Basketball + Baseball)
 *  /scores?preset=ncaam&tz=-4
 *  /scores?preset=cfb&tz=-4
 *  /scores?preset=cbase&tz=-4
 *
 *  /logo?team=illinois
 *  /logo32?team=illinois
 */

// ----------------------
// CONFIG
// ----------------------

const DEFAULT_VERCEL_BASE = "https://ncaa-proxy.vercel.app";

// Cache settings
const LOGO_CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const SCORE_SUBFETCH_TTL_SEC = 30;           // short edge cache for ncaa-api scoreboard

// NCAA presets -> ncaa-api scoreboard paths
const NCAA_PRESETS = {
  cfb:   { sport: "football",        path: "fbs" },
  ncaam: { sport: "basketball-men",  path: "d1"  },
  ncaaw: { sport: "basketball-women",path: "d1"  },
  cbase: { sport: "baseball",        path: "d1"  }
};

// ----------------------
// HELPERS
// ----------------------

function getVercelBase(env) {
  return (env && env.NCAA_VERCEL_BASE) ? env.NCAA_VERCEL_BASE : DEFAULT_VERCEL_BASE;
}

function intOr(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

function pickPreset(url) {
  const preset = url.searchParams.get("preset")?.toLowerCase();
  return NCAA_PRESETS[preset] || NCAA_PRESETS.ncaam;
}

function buildScoreboardUrl({ sport, path }) {
  return `https://ncaa-api.henrygd.me/scoreboard/${sport}/${path}`;
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
// WORKER ROUTER
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
  const preset = pickPreset(url);
  const tzOffset = intOr(url.searchParams.get("tz"), -5);
  const teamFilter = url.searchParams.get("team")?.toLowerCase();

  const apiUrl = buildScoreboardUrl(preset);

  try {
    const res = await fetch(apiUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cf: { cacheEverything: true, cacheTtl: SCORE_SUBFETCH_TTL_SEC }
    });

    if (!res.ok) {
      return json({ error: "NCAA API Fetch Failed", status: res.status }, 502);
    }

    const data = await res.json();
    const gamesRaw = Array.isArray(data?.games) ? data.games : [];

    let anyActive = false;
    let anyUpcoming = false;

    const games = gamesRaw.map(item => {
      const g = item.game || item;

      const home = g.home || {};
      const away = g.away || {};
      const hn = home.names || {};
      const an = away.names || {};

      const gameState = (g.gameState || "").toLowerCase();

      let status = "pre";
      let clock = g.startTime || "";

      if (gameState === "final") {
        status = "post";
        clock = g.finalMessage || "FINAL";
      } else if (gameState === "live") {
        status = "in";
        clock = `${g.currentPeriod || ""} ${g.contestClock || ""}`.trim();
      }

      if (status === "in") anyActive = true;
      else if (status === "pre") anyUpcoming = true;

      return {
        home: hn.char6 || "",
        away: an.char6 || "",
        home_seo: hn.seo || "",
        away_seo: an.seo || "",
        home_score: home.score || "0",
        away_score: away.score || "0",
        clock,
        status
      };
    });

    let responseData = games;

    if (teamFilter) {
      const matches = games.filter(
        g => g.home_seo === teamFilter || g.away_seo === teamFilter
      );
      responseData =
        matches.find(g => g.status === "in") ||
        matches[0] ||
        { error: "Game Not Found", status: "No Game" };
    }

    // Smart polling logic (same as ESPN worker)
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
    return json({ error: "NCAA API Error", message: String(e) }, 500);
  }
}

// ----------------------
// /logo and /logo32
// ----------------------

async function handleLogo(url, env, size) {
  const team = url.searchParams.get("team");
  if (!team) return new Response("Missing team", { status: 400 });

  const vercelBase = getVercelBase(env).replace(/\/$/, "");
  const vercelUrl = `${vercelBase}/api/logo?team=${encodeURIComponent(team)}&size=${size}`;

  const res = await fetch(vercelUrl, {
    cf: { cacheEverything: true, cacheTtl: LOGO_CACHE_TTL_SEC }
  });

  return withCors(res, `public, s-maxage=${LOGO_CACHE_TTL_SEC}`);
}

