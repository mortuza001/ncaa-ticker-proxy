/**
 * NCAA Proxy for ESP32 Tickers (Football + Basketball + Baseball)
 * - /scores returns compact JSON including home_id/away_id (unchanged)
 * - /teamlogo resolves ESPN GUID logoId for a given teamId+preset (cached)
 * - /logo and /logo32 proxy to Vercel BMP backend and cache at Cloudflare edge
 *
 * Key behavior:
 * - If preset is provided, /logo ALWAYS tries to resolve logoId via /teamlogo
 * - Then calls Python ONCE with teamId and (if found) logoId
 */

const DEFAULT_VERCEL_BASE = "https://ncaa-proxy.vercel.app";
const LOGO_CACHE_TTL_SEC = 7 * 24 * 60 * 60;
const SCORE_SUBFETCH_TTL_SEC = 15;
const FAIL_CACHE_TTL_SEC = 60;

const NCAA_PRESETS = {
  cfb:   { sport: "football",   league: "college-football" },
  ncaam: { sport: "basketball", league: "mens-college-basketball" },
  ncaaw: { sport: "basketball", league: "womens-college-basketball" },
  cbase: { sport: "baseball",   league: "college-baseball" }
};

const SHOW_DATE_FOR_TBD = true;

// --- Helpers ---

function getVercelBase(env) {
  return (env && env.NCAA_VERCEL_BASE) ? env.NCAA_VERCEL_BASE : DEFAULT_VERCEL_BASE;
}

function intOr(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

function getQS(url, key) {
  return url.searchParams.get(key) ?? url.searchParams.get(`amp;${key}`) ?? null;
}

function buildScoreboardUrl(sport, league, dates) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`;
  return dates ? `${base}?dates=${encodeURIComponent(dates)}` : base;
}

function formatPreGameTimeSmart(isoDateStr, tzOffsetHours) {
  if (!isoDateStr) return "Scheduled";
  const d = new Date(isoDateStr);
  if (isNaN(d.getTime())) return "Scheduled";
  d.setHours(d.getHours() + tzOffsetHours);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hh = d.getHours();
  const mm = d.getMinutes();
  if (hh === 0 && mm === 0) {
    return SHOW_DATE_FOR_TBD ? `${month}/${day} - TBD` : "TBD";
  }
  let hours12 = hh;
  const minutes = String(mm).padStart(2, "0");
  const ampm = hours12 >= 12 ? "PM" : "AM";
  hours12 = (hours12 % 12) || 12;
  return `${month}/${day} - ${hours12}:${minutes} ${ampm}`;
}

function getPreGameClock(event, competition, tzOffsetHours) {
  const status = competition?.status ?? event?.status ?? {};
  const detail = status?.type?.detail || "";
  const shortDetail = status?.type?.shortDetail || "";
  if (/tbd/i.test(detail) || /tbd/i.test(shortDetail)) {
    const iso = event?.date;
    if (SHOW_DATE_FOR_TBD && iso) {
      const d = new Date(iso);
      if (!isNaN(d.getTime())) {
        d.setHours(d.getHours() + tzOffsetHours);
        const month = d.getMonth() + 1;
        const day = d.getDate();
        return `${month}/${day} - TBD`;
      }
    }
    return "TBD";
  }
  return formatPreGameTimeSmart(event?.date, tzOffsetHours);
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

function withCors(res, cacheControl) {
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", "*");
  if (cacheControl) out.headers.set("Cache-Control", cacheControl);
  return out;
}

function isGuid36(s) {
  return typeof s === "string" && /^[0-9a-fA-F-]{36}$/.test(s);
}

function extractGuidFromUrl(u) {
  if (!u || typeof u !== "string") return null;
  const m = u.match(/\/guid\/([0-9a-fA-F-]{36})\//);
  return m ? m[1] : null;
}

// --- Short team name helper ---
function pickShortTeamName(team) {
  return (
    team?.shortDisplayName ||
    team?.displayName ||
    team?.location ||
    team?.name ||
    team?.abbreviation ||
    ""
  );
}

// ----------------------
// WORKER ROUTES
// ----------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/scores") return handleScores(url);
    if (url.pathname === "/teamlogo") return handleTeamLogo(url);
    if (url.pathname === "/logo" || url.pathname === "/logo32") {
      const size = (url.pathname === "/logo32") ? 32 : 16;
      return handleLogo(url, env, size);
    }

    return new Response("NCAA Cloudflare Worker Online", { status: 200 });
  }
};

// ----------------------
// /scores (now with home_short/away_short for all sports)
// ----------------------

async function handleScores(url) {
  const preset = (getQS(url, "preset") || "").toLowerCase();
  let sport = getQS(url, "sport");
  let league = getQS(url, "league");

  if (preset && NCAA_PRESETS[preset]) {
    sport = NCAA_PRESETS[preset].sport;
    league = NCAA_PRESETS[preset].league;
  }
  if (!sport || !league) {
    sport = "basketball";
    league = "mens-college-basketball";
  }

  const tzOffset = intOr(getQS(url, "tz"), -5);
  const dates = getQS(url, "dates");
  const teamFilter = (getQS(url, "team") || "").toUpperCase();

  const espnUrl = buildScoreboardUrl(sport, league, dates);

  try {
    const res = await fetch(espnUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cf: { cacheEverything: true, cacheTtl: SCORE_SUBFETCH_TTL_SEC }
    });

    if (!res.ok) return json({ error: "ESPN Fetch Failed", status: res.status }, 502);

    const data = await res.json();

    let anyActive = false;
    let anyUpcoming = false;

    const games = (data.events || []).map((event) => {
      const competition = event?.competitions?.[0];
      const status = competition?.status ?? event?.status ?? {};
      const state = status?.type?.state || "pre";

      if (state === "in") anyActive = true;
      else if (state === "pre") anyUpcoming = true;

      let clock = status?.type?.detail || "";
      if (state === "pre") clock = getPreGameClock(event, competition, tzOffset);

      const homeRaw = competition?.competitors?.find((c) => c.homeAway === "home");
      const awayRaw = competition?.competitors?.find((c) => c.homeAway === "away");
      const homeTeam = homeRaw?.team || {};
      const awayTeam = awayRaw?.team || {};

      // --- Short team names for all sports ---
      const homeShort = pickShortTeamName(homeTeam);
      const awayShort = pickShortTeamName(awayTeam);

      return {
        home: homeTeam.abbreviation || "",
        away: awayTeam.abbreviation || "",
        home_id: homeTeam.id ? String(homeTeam.id) : "",
        away_id: awayTeam.id ? String(awayTeam.id) : "",
        home_score: homeRaw?.score || "0",
        away_score: awayRaw?.score || "0",
        clock,
        status: state,
        home_short: homeShort,
        away_short: awayShort
      };
    });

    let responseData = games;
    if (teamFilter) {
      const matches = games.filter(g => g.home === teamFilter || g.away === teamFilter);
      const inProgress = matches.find(g => g.status === "in");
      responseData = inProgress || matches[0] || { error: "Game Not Found", status: "No Game" };
    }

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

// ... (rest of your Worker unchanged: /teamlogo, /logo, etc.) ...
