/**
 * College Baseball (NCAA) Proxy for ESP32 Tickers with Timezone Support
 * Mirrors your MLB worker structure and response shape.
 *
 * Endpoints:
 *  - /scores?team=UCLA&tz=-5
 *  - /teams-list
 *  - /logo?team=UCLA
 */

const TEAM_MAP = {
  // Optional aliases. College baseball is huge; we keep this light.
  // You can add your own abbreviations/nicknames here if your device uses them.
  "NCAAB": "NCAAB",
  "NCAA": "NCAAB",
};

const normalizeCode = (code) => {
  if (!code) return "";
  const upper = code.toUpperCase();
  return TEAM_MAP[upper] || upper;
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const teamParam = url.searchParams.get("team")?.toUpperCase();
    const tzOffset = parseInt(url.searchParams.get("tz")) ?? -5;

    if (url.pathname === "/scores") {
      return handleScoreRequestCollegeBaseball(teamParam, tzOffset);
    }
    if (url.pathname === "/teams-list") {
      return handleTeamsListCollegeBaseball();
    }
    if (url.pathname === "/logo") {
      if (!teamParam) return new Response("Missing team", { status: 400 });
      // Point this to your Vercel logo proxy (deploy the python handler below)
      const vercelUrl = `https://college-baseball-proxy.vercel.app/api/logo?team=${teamParam}`;
      return fetch(vercelUrl);
    }

    return new Response("College Baseball Worker Online", { status: 200 });
  }
};

async function handleScoreRequestCollegeBaseball(targetTeam, tzOffset) {
  // ESPN College Baseball scoreboard endpoint
  // https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/scoreboard
  const espnUrl =
    "https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/scoreboard";

  try {
    const res = await fetch(espnUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();

    let anyActive = false;
    let anyUpcoming = false;

    const processedGames = (data.events || []).map((event) => {
      const competition = event.competitions?.[0];
      const status = competition?.status || event.status;
      const statusState = status?.type?.state || "pre"; // pre | in | post

      if (statusState === "in") anyActive = true;
      else if (statusState === "pre") anyUpcoming = true;

      let displayClock = status?.type?.detail || "";

      // Pre-game: localize start time using tzOffset
      if (statusState === "pre") {
        const dateUTC = new Date(event.date);
        dateUTC.setHours(dateUTC.getHours() + tzOffset);

        const month = String(dateUTC.getMonth() + 1);
        const day = String(dateUTC.getDate());
        let hours = dateUTC.getHours();
        const minutes = dateUTC.getMinutes().toString().padStart(2, "0");
        const ampm = hours >= 12 ? "PM" : "AM";
        hours = hours % 12;
        hours = hours ? hours : 12;

        displayClock = `${month}/${day} - ${hours}:${minutes} ${ampm}`;
      }

      const homeRaw = competition?.competitors?.find((c) => c.homeAway === "home");
      const awayRaw = competition?.competitors?.find((c) => c.homeAway === "away");

      // NOTE: For NCAA, ESPN abbreviations are often short like "UCLA", "TEX", etc.
      // We return abbreviations to match your device pattern.
      return {
        home: normalizeCode(homeRaw?.team?.abbreviation || ""),
        away: normalizeCode(awayRaw?.team?.abbreviation || ""),
        home_score: homeRaw?.score || "0",
        away_score: awayRaw?.score || "0",
        clock: displayClock,
        status: statusState
      };
    });

    // Smart Polling (same idea as your MLB worker)
    let pollInterval = 10;
    let swr = 10;

    if (!anyActive && anyUpcoming) {
      pollInterval = 600; // 10 min when only upcoming
      swr = 60;
    }
    if (!anyActive && !anyUpcoming) {
      pollInterval = 7200; // 2 hours off-days / post slate
      swr = 300;
    }

    let responseData = processedGames;

    if (targetTeam) {
      const cleanTarget = normalizeCode(targetTeam);
      const matches = processedGames.filter(
        (g) => g.home === cleanTarget || g.away === cleanTarget
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
    return new Response(JSON.stringify({ error: "College Baseball Fetch Failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}

async function handleTeamsListCollegeBaseball() {
  // ESPN pattern for teams is consistent across sports:
  // /teams returns a directory-like list. For college sports it may be large/paginated.
  const listUrl =
    "https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/teams";

  try {
    const res = await fetch(listUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();

    let teamAbbrs = ["NCAAB"];

    // Defensive parsing: ESPN structures can vary. Try common shapes.
    const teams =
      data?.sports?.[0]?.leagues?.[0]?.teams ||
      data?.leagues?.[0]?.teams ||
      data?.teams ||
      [];

    for (const t of teams) {
      const team = t.team || t;
      if (team?.abbreviation) teamAbbrs.push(normalizeCode(team.abbreviation));
    }

    return new Response(teamAbbrs.join(", "), {
      headers: {
        "Content-Type": "text/plain; charset=UTF-8",
        "Cache-Control": "public, s-maxage=86400",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (e) {
    // Fallback (small) — better than failing completely
    return new Response("NCAAB", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=UTF-8", "Access-Control-Allow-Origin": "*" }
    });
  }
}
