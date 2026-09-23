/**
 * NCAA Proxy for ESP32 Tickers (GUID-FIRST)
 *
 * Key rules:
 * - logoId (GUID) is the PRIMARY logo identity
 * - teamId is fallback only
 * - /scores emits logoId
 * - /logo prefers logoId param
 *
 * Update:
 * - Added default group (80) & limit (300) for College Football API requests.
 * - For upcoming games (status === "pre"), format start time using tz offset as: "4 Apr, 9:00 PM"
 *   (computed from ESPN ISO event time, NOT by parsing "EDT" text)
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

// ---------------- HELPERS ----------------

function isTbdClock(detail) {
  if (!detail || typeof detail !== "string") return false;
  const s = detail.toUpperCase();
  return s.includes("TBD") || s.includes("TBA");
}

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

// ✅ UPDATED: Added automatic defaults for groups and limit
function buildScoreboardUrl(sport, league, dates, groups, limit = 300) {
  const url = new URL(`https://site.web.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`);
  
  if (dates) {
    url.searchParams.set("dates", dates);
  }
  
  // Default to FBS (group 80) for college football unless overridden
  const activeGroup = groups || (league === "college-football" ? "80" : null);
  if (activeGroup) {
    url.searchParams.set("groups", activeGroup);
  }

  if (limit) {
    url.searchParams.set("limit", String(limit));
  }

  return url.toString();
}

function isGuid36(s) {
  return typeof s === "string" && /^[0-9a-fA-F-]{36}$/.test(s);
}

function extractGuidFromUrl(u) {
  if (!u || typeof u !== "string") return "";
  const m = u.match(/\/guid\/([0-9a-fA-F-]{36})\//);
  return m ? m[1] : "";
}

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

function extractLogoIdFromTeam(team) {
  if (Array.isArray(team?.logos)) {
    for (const l of team.logos) {
      const id = extractGuidFromUrl(l?.href);
      if (id) return id;
    }
  }
  if (typeof team?.logo === "string") {
    return extractGuidFromUrl(team.logo);
  }
  return "";
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

const MON_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatLocalFromUtcIso_DDMon_Time(isoUtc, tzOffsetHours) {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return "";

  const t = new Date(d.getTime() + (tzOffsetHours * 3600 * 1000));

  const day = t.getUTCDate();
  const mon = MON_ABBR[t.getUTCMonth()];

  let hour = t.getUTCHours();
  const minute = t.getUTCMinutes();

  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;

  const mm = String(minute).padStart(2, "0");

  return `${day} ${mon}, ${hour}:${mm} ${ampm}`;
}

// ---------------- ROUTER ----------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/scores") return handleScores(url);
    if (url.pathname === "/teamlogo") return handleTeamLogo(url);
    if (url.pathname === "/logo" || url.pathname === "/logo32" || url.pathname === "/logo24") {
      const size = url.pathname === "/logo32" ? 32 : (url.pathname === "/logo24" ? 24 : 16);
      return handleLogo(url, env, size);
    }

    return new Response("NCAA Worker (GUID-first) Online", { status: 200 });
  }
};

// ---------------- /scores ----------------

async function handleScores(url) {
  const preset = (getQS(url, "preset") || "").toLowerCase();
  let sport = NCAA_PRESETS[preset]?.sport;
  let league = NCAA_PRESETS[preset]?.league;

  if (!sport || !league) {
    sport = "basketball";
    league = "mens-college-basketball";
  }

  const tzOffset = intOr(getQS(url, "tz"), -5);
  
  // ✅ UPDATED: Extract dates, groups, and limit from query string
  const dates = getQS(url, "dates");
  const groups = getQS(url, "groups");
  const limit = getQS(url, "limit");

  const espnUrl = buildScoreboardUrl(sport, league, dates, groups, limit);
  const res = await fetch(espnUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cf: { cacheEverything: true, cacheTtl: SCORE_SUBFETCH_TTL_SEC }
  });

  if (!res.ok) return json({ error: "ESPN Fetch Failed" }, 502);

  const data = await res.json();

  const games = (data.events || []).map(e => {
    const c = e?.competitions?.[0];
    const homeRaw = c?.competitors?.find(x => x.homeAway === "home");
    const awayRaw = c?.competitors?.find(x => x.homeAway === "away");
    const homeTeam = homeRaw?.team || {};
    const awayTeam = awayRaw?.team || {};

    const status = c?.status?.type?.state || "pre";
    const detail = c?.status?.type?.detail || "";

    const startIsoUtc = e?.date || c?.date || "";

    let clock = detail;

    if (status === "pre" && isTbdClock(detail)) {
      clock = detail;
    }
    else if (status === "pre" && startIsoUtc) {
      const pretty = formatLocalFromUtcIso_DDMon_Time(startIsoUtc, tzOffset);
      if (pretty) clock = pretty;
    }

    return {
      away: homeTeam.abbreviation || "",
      home: awayTeam.abbreviation || "",
      away_id: String(homeTeam.id || ""),
      home_id: String(awayTeam.id || ""),

      away_logoId: extractLogoIdFromTeam(homeTeam),
      home_logoId: extractLogoIdFromTeam(awayTeam),

      away_short: pickShortTeamName(homeTeam),
      home_short: pickShortTeamName(awayTeam),

      away_score: homeRaw?.score || "0",
      home_score: awayRaw?.score || "0",

      clock,
      status
    };
  });

  return json(games, 200, "public, s-maxage=10");
}

// ---------------- /teamlogo ----------------

async function handleTeamLogo(url) {
  const teamId = getQS(url, "teamId");
  const preset = (getQS(url, "preset") || "").toLowerCase();

  if (!teamId || !NCAA_PRESETS[preset]) {
    return json({ error: "Invalid teamId or preset" }, 400);
  }

  const cacheKey = new Request(url.toString());
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const { sport, league } = NCAA_PRESETS[preset];
  
  // ✅ UPDATED: Ensures team lookups fetch from the full list of games (FBS + limit 300)
  const espnUrl = buildScoreboardUrl(sport, league, null, null, 300);

  const res = await fetch(espnUrl);
  const data = await res.json();

  let logoId = "";
  let logoUrl = "";

  outer:
  for (const e of data.events || []) {
    for (const c of e?.competitions?.[0]?.competitors || []) {
      if (String(c?.team?.id) === String(teamId)) {
        logoId = extractLogoIdFromTeam(c.team);
        logoUrl = c.team?.logo || "";
        break outer;
      }
    }
  }

  const payload = { teamId, preset, logoId, logoUrl };
  const out = json(payload, 200, `public, s-maxage=${LOGO_CACHE_TTL_SEC}`);
  await caches.default.put(cacheKey, out.clone());
  return out;
}

// ---------------- /logo ----------------

async function handleLogo(url, env, size) {
  const teamId = getQS(url, "teamId") || getQS(url, "id");
  const preset = (getQS(url, "preset") || "").toLowerCase();
  const debug = getQS(url, "debug") === "1";

  const logoIdParam = getQS(url, "logoId");
  let logoId = isGuid36(logoIdParam) ? logoIdParam : "";
  let logoIdSource = logoId ? "query" : "none";

  if (!logoId && !teamId) {
    return new Response("Missing logoId or teamId", { status: 400 });
  }

  const vercelBase = getVercelBase(env).replace(/\/$/, "");

  if (!logoId && teamId && preset && NCAA_PRESETS[preset]) {
    const mapUrl = new URL(url.toString());
    mapUrl.pathname = "/teamlogo";
    mapUrl.search = `teamId=${encodeURIComponent(teamId)}&preset=${encodeURIComponent(preset)}`;

    const mapRes = await fetch(mapUrl.toString(), {
      cf: { cacheEverything: true, cacheTtl: LOGO_CACHE_TTL_SEC }
    });

    if (mapRes.ok) {
      const mapJson = await mapRes.json();
      if (isGuid36(mapJson.logoId)) {
        logoId = mapJson.logoId;
        logoIdSource = "teamlogo";
      }
    }
  }

  const params = new URLSearchParams();
  params.set("size", String(size));
  if (logoId) params.set("logoId", logoId);
  else params.set("teamId", String(teamId));

  const vercelUrl = `${vercelBase}/api/logo?${params.toString()}`;

  const res = await fetch(vercelUrl, {
    cf: { cacheEverything: true, cacheTtl: LOGO_CACHE_TTL_SEC }
  });

  const cacheControl = res.ok
    ? `public, s-maxage=${LOGO_CACHE_TTL_SEC}`
    : `public, s-maxage=${FAIL_CACHE_TTL_SEC}`;

  const out = withCors(res, cacheControl);

  if (debug) {
    out.headers.set("X-TeamId", String(teamId || ""));
    out.headers.set("X-Preset", preset || "");
    out.headers.set("X-LogoId", logoId || "");
    out.headers.set("X-LogoId-Source", logoIdSource);
    out.headers.set("X-Vercel-Url", vercelUrl);
  }

  return out;
}
