/**
 * NCAA Sport-Agnostic Ticker Proxy (ESPN)
 * - /scores : ESPN scoreboard -> compact JSON, includes home_id/away_id
 * - /logo   : returns 16x16 BMP via external converter backend
 * - /logo32 : returns 32x32 BMP via external converter backend
 *
 * Hosted example:
 *   https://ncaa-ticker-proxy.g-mortuza.workers.dev/scores?preset=ncaam&tz=-4
 *
 * Query params:
 *   /scores?preset=cfb|ncaam|ncaaw|cbase
 *   /scores?sport=football&league=college-football&dates=YYYYMMDD&team=DUKE&tz=-4
 *
 * Logo:
 *   /logo?teamId=150
 *   /logo32?teamId=150
 *
 * IMPORTANT:
 * Cloudflare Workers cannot natively decode PNG -> BMP without extra libraries/WASM.
 * So /logo and /logo32 forward to a BMP conversion backend you control.
 *
 * Configure in Worker env vars:
 *   LOGO_BMP_BACKEND_BASE = "https://your-bmp-service.example.com"
 * Backend contract (recommended):
 *   GET {LOGO_BMP_BACKEND_BASE}/espn/ncaa/logo?teamId=150&size=16   -> image/bmp
 *   GET {LOGO_BMP_BACKEND_BASE}/espn/ncaa/logo?teamId=150&size=32   -> image/bmp
 */

const NCAA_PRESETS = {
  cfb:   { sport: "football",   league: "college-football" },
  ncaam: { sport: "basketball", league: "mens-college-basketball" },
  ncaaw: { sport: "basketball", league: "womens-college-basketball" },
  cbase: { sport: "baseball",   league: "college-baseball" }
};

function intOr(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
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

function pickTeamAndLeague(url) {
  const preset = url.searchParams.get("preset")?.toLowerCase();
  let sport = url.searchParams.get("sport");
  let league = url.searchParams.get("league");

  if (preset && NCAA_PRESETS[preset]) {
    sport = NCAA_PRESETS[preset].sport;
    league = NCAA_PRESETS[preset].league;
  }

  // Default to NCAA baseball if omitted (safe default; adjust if you want)
  if (!sport || !league) {
    sport = "baseball";
    league = "college-baseball";
  }

  return { sport, league };
}

/**
 * Optional: Resolve teamId from abbreviation if caller provides team=DUKE
 * ESPN supports team info routes under each league.
 * NOTE: This adds an extra call; best practice is to use home_id/away_id from /scores.
 */
async function resolveTeamIdFromAbbr(sport, league, abbr) {
  if (!abbr) return "";
  const t = abbr.toLowerCase();
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${encodeURIComponent(t)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return "";
  const data = await res.json();
  const id = data?.team?.id || data?.id || "";
  return id ? String(id) : "";
}

/**
 * ESPN NCAA team logo (PNG) pattern.
 * Example visible on ESPN pages: https://a.espncdn.com/i/teamlogos/ncaa/500/2612.png [1](https://www.espn.com.sg/mens-college-basketball/)
 */
function espnNcaaPngUrl(teamId, size = 500) {
  return `https://a.espncdn.com/i/teamlogos/ncaa/${size}/${teamId}.png`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/scores") {
      return handleScores(url);
    }

    if (url.pathname === "/logo" || url.pathname === "/logo32") {
      return handleLogo(url, env, url.pathname === "/logo32" ? 32 : 16);
    }

    return new Response(
      "NCAA ESPN Ticker Proxy Online. Try /scores?preset=ncaam or /scores?preset=cfb",
      { status: 200 }
    );
  }
};

async function handleScores(url) {
  const { sport, league } = pickTeamAndLeague(url);

  const tzOffset = intOr(url.searchParams.get("tz"), -5);
  const dates = url.searchParams.get("dates"); // YYYYMMDD (optional)
  const teamFilter = url.searchParams.get("team")?.toUpperCase();

  const espnUrl = buildScoreboardUrl(sport, league, dates);

  try {
    const res = await fetch(espnUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cf: { cacheTtl: 15 }
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
      const statusState = status?.type?.state || "pre"; // pre | in | post

      if (statusState === "in") anyActive = true;
      else if (statusState === "pre") anyUpcoming = true;

      let displayClock = status?.type?.detail || "";

      // pre-game: show scheduled time derived from event.date
      if (statusState === "pre") {
        displayClock = formatPreGameTime(event?.date, tzOffset);
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
        clock: displayClock,
        status: statusState,
        // helpful for debugging and/or for ESP32 to know which sport it is
        sport,
        league
      };
    });

    // Filter by team abbreviation if requested (works only within the chosen sport/league)
    let out = games;
    if (teamFilter) {
      const matches = games.filter((g) => g.home === teamFilter || g.away === teamFilter);
      const inProgress = matches.find((g) => g.status === "in");
      out = inProgress || matches[0] || { error: "Game Not Found", status: "No Game" };
    }

    let pollInterval = 10;
    let swr = 10;
    if (!anyActive && anyUpcoming) {
      pollInterval = 600;
      swr = 60;
    }
    if (!anyActive && !anyUpcoming) {
      pollInterval = 7200;
      swr = 300;
    }

    return new Response(JSON.stringify(out), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": `public, s-maxage=${pollInterval}, stale-while-revalidate=${swr}`
      }
    });
  } catch (e) {
    return json({ error: "ESPN Exception", message: String(e) }, 500);
  }
}

async function handleLogo(url, env, size) {
  // Prefer teamId passed explicitly
  let teamId = url.searchParams.get("teamId") || url.searchParams.get("id") || "";

  // Optional support: if caller sends team=DUKE plus sport/league, resolve ID
  if (!teamId) {
    const teamAbbr = url.searchParams.get("team")?.toUpperCase() || "";
    const { sport, league } = pickTeamAndLeague(url);
    if (teamAbbr) {
      teamId = await resolveTeamIdFromAbbr(sport, league, teamAbbr);
    }
  }

  if (!teamId) {
    return new Response("Missing teamId (or team+sport/league)", { status: 400 });
  }

  // If you have a BMP backend, forward to it (recommended for ESP32)
  const backend = env.LOGO_BMP_BACKEND_BASE;
  if (backend) {
    const forwardUrl = `${backend.replace(/\/$/, "")}/espn/ncaa/logo?teamId=${encodeURIComponent(teamId)}&size=${size}`;
    // Just proxy the BMP stream back
    const res = await fetch(forwardUrl, { cf: { cacheTtl: 604800 } });
    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "image/bmp",
        "Cache-Control": "public, s-maxage=604800",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // Fallback: return the upstream PNG URL so you can validate mapping quickly in a browser
  // NOTE: This won't work with your current ESP32 BMP pipeline — intended for testing only.
  const png = espnNcaaPngUrl(teamId, 500);
  return json({
    warning: "LOGO_BMP_BACKEND_BASE not set. Returning PNG URL for testing only.",
    teamId,
    png
  }, 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
``
