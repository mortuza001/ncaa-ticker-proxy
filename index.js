/**
 * Sport-agnostic ESPN /scores proxy 
 *
 * Endpoint:
 *   /scores?preset=cbase&team=UCLA&tz=-4
 *   /scores?sport=football&league=college-football&dates=20260901&tz=-4
 *
 * ESPN scoreboard pattern:
 *   https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard
 * Common NCAA leagues include:
 *   football/college-football
 *   basketball/mens-college-basketball
 *   basketball/womens-college-basketball
 *   baseball/college-baseball
 */

const NCAA_PRESETS = {
  // NCAA presets grounded in common ESPN league slugs
  cfb:   { sport: "football",   league: "college-football" },
  ncaam: { sport: "basketball", league: "mens-college-basketball" },
  ncaaw: { sport: "basketball", league: "womens-college-basketball" },
  cbase: { sport: "baseball",   league: "college-baseball" },
};

function parseIntSafe(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

function buildScoreboardUrl(sport, league, dates) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`;
  if (!dates) return base;
  // ESPN supports dates=YYYYMMDD for scoreboards in many leagues
  return `${base}?dates=${encodeURIComponent(dates)}`;
}

function formatPreGameTime(isoDateStr, tzOffsetHours) {
  // isoDateStr is typically UTC ISO from ESPN (event.date)
  // We'll shift by tzOffsetHours for a simple offset-based local time.
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/scores") {
      return handleScores(url);
    }

    return new Response("ESPN Sport-Agnostic Scores Worker Online", { status: 200 });
  }
};

async function handleScores(url) {
  // Inputs
  const preset = url.searchParams.get("preset")?.toLowerCase();
  const teamParam = url.searchParams.get("team")?.toUpperCase();
  const dates = url.searchParams.get("dates"); // YYYYMMDD
  const tzOffset = parseIntSafe(url.searchParams.get("tz"), -5);

  // Determine sport/league
  let sport = url.searchParams.get("sport");
  let league = url.searchParams.get("league");

  if (preset && NCAA_PRESETS[preset]) {
    sport = NCAA_PRESETS[preset].sport;
    league = NCAA_PRESETS[preset].league;
  }

  // Default if nothing provided (keeps behavior sensible)
  if (!sport || !league) {
    sport = "baseball";
    league = "college-baseball";
  }

  const espnUrl = buildScoreboardUrl(sport, league, dates);

  try {
    const res = await fetch(espnUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      // small edge cache to reduce repeated upstream hits
      cf: { cacheTtl: 15 }
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: "ESPN Fetch Failed", status: res.status }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const data = await res.json();

    let anyActive = false;
    let anyUpcoming = false;

    const processedGames = (data.events || []).map((event) => {
      const competition = event?.competitions?.[0];
      const status = competition?.status ?? event?.status ?? {};
      const statusState = status?.type?.state || "pre"; // pre | in | post

      if (statusState === "in") anyActive = true;
      else if (statusState === "pre") anyUpcoming = true;

      let displayClock = status?.type?.detail || "";

      // Pre-game: show scheduled start time (avoid NaN)
      if (statusState === "pre") {
        displayClock = formatPreGameTime(event?.date, tzOffset);
      }

      const homeRaw = competition?.competitors?.find((c) => c.homeAway === "home");
      const awayRaw = competition?.competitors?.find((c) => c.homeAway === "away");

      return {
        home: homeRaw?.team?.abbreviation || "",
        away: awayRaw?.team?.abbreviation || "",
        home_score: homeRaw?.score || "0",
        away_score: awayRaw?.score || "0",
        clock: displayClock,
        status: statusState
      };
    });

    // Smart polling (same logic you used before)
    let pollInterval = 10;
    let swr = 10;

    if (!anyActive && anyUpcoming) {
      pollInterval = 600; // upcoming only
      swr = 60;
    }
    if (!anyActive && !anyUpcoming) {
      pollInterval = 7200; // no games
      swr = 300;
    }

    // Optional team filter
    let responseData = processedGames;
    if (teamParam) {
      const matches = processedGames.filter(
        (g) => g.home === teamParam || g.away === teamParam
      );
      const inProgress = matches.find((g) => g.status === "in");
      responseData = inProgress || matches[0] || { error: "Game Not Found", status: "No Game" };
    }

    return new Response(JSON.stringify(responseData), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": `public, s-maxage=${pollInterval}, stale-while-revalidate=${swr}`
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "ESPN Exception", message: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}
