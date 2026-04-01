/**
 * NCAA Proxy for ESP32 Tickers (Football + Basketball + Baseball)
 * - /scores returns compact JSON including home_id/away_id (unchanged)
 * - /teamlogo resolves ESPN GUID logoId for a given teamId+preset (cached)
 * - /logo and /logo32 proxy to Vercel BMP backend and cache at Cloudflare edge
 *
 * Key behavior:
 * - If preset is provided, /logo ALWAYS tries to resolve logoId via /teamlogo
 * - Then calls Python ONCE with teamId and (if found) logoId
 *
 * Examples:
 *  /scores?preset=cbase&tz=-4
 *  /teamlogo?teamId=73&preset=cbase
 *  /logo?teamId=73&preset=cbase
 *  /logo32?teamId=73&preset=cbase
 */

// ----------------------
// CONFIG
// ----------------------

const DEFAULT_VERCEL_BASE = "https://ncaa-proxy.vercel.app";

const LOGO_CACHE_TTL_SEC = 7 * 24 * 60 * 60;  // 7 days
const SCORE_SUBFETCH_TTL_SEC = 15;            // 15s edge cache for ESPN scoreboard fetch
const FAIL_CACHE_TTL_SEC = 60;                // short cache for failures

const NCAA_PRESETS = {
  cfb:   { sport: "football",   league: "college-football" },
  ncaam: { sport: "basketball", league: "mens-college-basketball" },
  ncaaw: { sport: "basketball", league: "womens-college-basketball" },
  cbase: { sport: "baseball",   league: "college-baseball" }
};

const SHOW_DATE_FOR_TBD = true;

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

// --- Baseball helpers ---
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

function compactInning(detail) {
  if (!detail) return "";
  let s = String(detail);
  s = s.replace(/Bottom/i, "Bot");
  s = s.replace(/Top/i, "Top");
  s = s.replace(/(\d+)(st|nd|rd|th)/gi, "$1");
  return s.replace(/\s+/g, " ").trim();
}

function basesCompact(situation) {
  if (!situation) return "--";
  const on1 = !!situation.onFirst;
  const on2 = !!situation.onSecond;
  const on3 = !!situation.onThird;
  if (!on1 && !on2 && !on3) return "--";
  if (on1 && !on2 && !on3) return "1";
  if (!on1 && on2 && !on3) return "2";
  if (!on1 && !on2 && on3) return "3";
  if (on1 && on2 && !on3) return "1&2";
  if (on1 && !on2 && on3) return "1&3";
  if (!on1 && on2 && on3) return "2&3";
  return "1&2&3";
}

function outsCompact(situation) {
  if (!situation) return "";
  const o = situation.outs;
  if (typeof o === "number" && o >= 0 && o <= 2) return `${o}O`;
  return "";
}

function buildSitLine(inningText, outsText, basesText) {
  const parts = [];
  if (inningText) parts.push(inningText);
  if (outsText) parts.push(outsText);
  if (basesText && basesText !== "--") parts.push(basesText);
  return parts.join(" • ");
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
// /scores  (ENHANCED OUTPUT)
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
  const dates = getQS(url, "dates"); // optional YYYYMMDD
  const teamFilter = (getQS(url, "team") || "").toUpperCase(); // optional

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

      // --- Baseball situation fields ---
      const situation = competition?.situation || null;
      const clockUpper = (clock || "").toUpperCase();
      const looksBaseball = clockUpper.includes("TOP") || clockUpper.includes("BOT") || clockUpper.includes("BOTTOM");

      let inning = "";
      let outs = "";
      let on_base = "--";
      let sit = "";

      if (situation || looksBaseball) {
        inning = compactInning(clock);       // uses "Bot"
        outs = outsCompact(situation);       // "2O"
        on_base = basesCompact(situation);   // "1&3"
        sit = buildSitLine(inning, outs, on_base);
      }

      // --- Short team names ---
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

        // --- New fields for 128px baseball ---
        home_short: homeShort,
        away_short: awayShort,
        inning,
        outs,
        on_base,
        sit
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

// ----------------------
// /teamlogo  (option 1: on-demand ESPN lookup)
// ----------------------

async function handleTeamLogo(url) {
  const teamId = getQS(url, "teamId") || getQS(url, "id");
  const preset = (getQS(url, "preset") || "").toLowerCase();
  const dates = getQS(url, "dates"); // optional

  if (!teamId || !/^\d+$/.test(teamId)) {
    return json({ error: "Missing or invalid teamId" }, 400);
  }
  if (!preset || !NCAA_PRESETS[preset]) {
    return json({ error: "Missing or invalid preset" }, 400);
  }

  // Cache mapping result at edge
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const { sport, league } = NCAA_PRESETS[preset];
  const espnUrl = buildScoreboardUrl(sport, league, dates);

  const res = await fetch(espnUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cf: { cacheEverything: true, cacheTtl: SCORE_SUBFETCH_TTL_SEC }
  });

  if (!res.ok) {
    const err = json({ error: "ESPN Fetch Failed", status: res.status }, 502, `public, s-maxage=${FAIL_CACHE_TTL_SEC}`);
    await cache.put(cacheKey, err.clone());
    return err;
  }

  const data = await res.json();

  let foundLogoUrl = null;

  outer:
  for (const event of (data.events || [])) {
    const comp = event?.competitions?.[0];
    for (const c of (comp?.competitors || [])) {
      const t = c?.team;
      if (!t) continue;
      if (String(t.id) !== String(teamId)) continue;

      if (typeof t.logo === "string" && t.logo.startsWith("http")) {
        foundLogoUrl = t.logo;
        break outer;
      }
      if (Array.isArray(t.logos) && t.logos.length) {
        const href = t.logos[0]?.href;
        if (typeof href === "string" && href.startsWith("http")) {
          foundLogoUrl = href;
          break outer;
        }
      }
    }
  }

  if (!foundLogoUrl) {
    const miss = json(
      { teamId: String(teamId), preset, error: "Logo URL not found in scoreboard" },
      404,
      `public, s-maxage=${FAIL_CACHE_TTL_SEC}`
    );
    await cache.put(cacheKey, miss.clone());
    return miss;
  }

  const logoId = extractGuidFromUrl(foundLogoUrl) || "";

  const payload = {
    teamId: String(teamId),
    preset,
    logoId,
    logoUrl: foundLogoUrl,
    source: logoId ? "espn-guid" : "espn-url"
  };

  const ok = json(payload, 200, `public, s-maxage=${LOGO_CACHE_TTL_SEC}`);
  await cache.put(cacheKey, ok.clone());
  return ok;
}

// ----------------------
// /logo and /logo32
// ----------------------

async function handleLogo(url, env, size) {
  const teamId = getQS(url, "teamId") || getQS(url, "id");
  const preset = (getQS(url, "preset") || "").toLowerCase();
  const debug = getQS(url, "debug") === "1";

  if (!teamId) return new Response("Missing teamId", { status: 400 });

  const vercelBase = getVercelBase(env).replace(/\/$/, "");

  // Always attempt to resolve GUID when preset is provided
  let logoId = "";
  let logoIdSource = "none";

  if (preset && NCAA_PRESETS[preset]) {
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

  // Call Python ONCE, passing teamId and (if found) logoId
  const params = new URLSearchParams();
  params.set("teamId", String(teamId));
  params.set("size", String(size));
  if (logoId) params.set("logoId", logoId);

  const vercelUrl = `${vercelBase}/api/logo?${params.toString()}`;

  const res = await fetch(vercelUrl, {
    cf: { cacheEverything: true, cacheTtl: LOGO_CACHE_TTL_SEC }
  });

  // Cache-control: successes long, failures short
  const cacheControl = res.ok
    ? `public, s-maxage=${LOGO_CACHE_TTL_SEC}`
    : `public, s-maxage=${FAIL_CACHE_TTL_SEC}`;

  const out = withCors(res, cacheControl);

  // Optional debug headers to verify behavior
  if (debug) {
    out.headers.set("X-TeamId", String(teamId));
    out.headers.set("X-Preset", preset || "");
    out.headers.set("X-LogoId", logoId || "");
    out.headers.set("X-LogoId-Source", logoIdSource);
    out.headers.set("X-Vercel-Url", vercelUrl);
  }

