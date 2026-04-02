/**
 * NCAA Proxy for ESP32 Tickers (GUID-FIRST)
 *
 * Key rules:
 * - logoId (GUID) is the PRIMARY logo identity
 * - teamId is fallback only
 * - /scores emits logoId
 * - /logo prefers logoId param
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

// ---------------- ROUTER ----------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/scores") return handleScores(url);
    if (url.pathname === "/teamlogo") return handleTeamLogo(url);
    if (url.pathname === "/logo" || url.pathname === "/logo32") {
      const size = url.pathname === "/logo32" ? 32 : 16;
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
  const dates = getQS(url, "dates");

  const espnUrl = buildScoreboardUrl(sport, league, dates);
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

    return {
      home: homeTeam.abbreviation || "",
      away: awayTeam.abbreviation || "",
      home_id: String(homeTeam.id || ""),
      away_id: String(awayTeam.id || ""),

      // ✅ PRIMARY
      home_logoId: extractLogoIdFromTeam(homeTeam),
      away_logoId: extractLogoIdFromTeam(awayTeam),

      home_short: pickShortTeamName(homeTeam),
      away_short: pickShortTeamName(awayTeam),

      home_score: homeRaw?.score || "0",
      away_score: awayRaw?.score || "0",

      clock: c?.status?.type?.detail || "",
      status: c?.status?.type?.state || "pre"
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
  const espnUrl = buildScoreboardUrl(sport, league);

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
  const logoIdParam = getQS(url, "logoId");
  const teamId = getQS(url, "teamId");
  const preset = (getQS(url, "preset") || "").toLowerCase();

  let logoId = isGuid36(logoIdParam) ? logoIdParam : "";

  // Resolve GUID ONLY if missing
  if (!logoId && teamId && NCAA_PRESETS[preset]) {
    const mapUrl = new URL(url.toString());
    mapUrl.pathname = "/teamlogo";
    mapUrl.search = `teamId=${teamId}&preset=${preset}`;
    const mapRes = await fetch(mapUrl);
    if (mapRes.ok) {
      const j = await mapRes.json();
      if (isGuid36(j.logoId)) logoId = j.logoId;
    }
  }

  const params = new URLSearchParams({ size: String(size) });
  if (logoId) params.set("logoId", logoId);
  else params.set("teamId", teamId || "");

  const vercelUrl = `${getVercelBase(env)}/api/logo?${params.toString()}`;

  const res = await fetch(vercelUrl, {
    cf: { cacheEverything: true, cacheTtl: LOGO_CACHE_TTL_SEC }
  });

  return withCors(
    res,
    res.ok
      ? `public, s-maxage=${LOGO_CACHE_TTL_SEC}`
      : `public, s-maxage=${FAIL_CACHE_TTL_SEC}`
  );
}
