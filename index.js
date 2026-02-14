/**
 * College Baseball (NCAA) Proxy for ESP32 Tickers with Timezone Support
 * Mirrors MLB worker structure and response shape.
 *
 * Endpoints:
 *  - /scores?team=UCLA&tz=-5
 *  - /teams-list
 *  - /logo?team=UCLA
 */

const TEAM_MAP = {
  "NCAA": "NCAAB",
  "NCAAB": "NCAAB",
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

    const tzRaw = url.searchParams.get("tz");
    const tzOffset = Number.isFinite(parseInt(tzRaw))
      ? parseInt(tzRaw)
      : -5;

    if (url.pathname === "/scores") {
      return handleScoreRequestCollegeBaseball(teamParam, tzOffset);
    }

    if (url.pathname === "/teams-list") {
      return handleTeamsListCollegeBaseball();
    }

    if (url.pathname === "/logo") {
      if (!teamParam) {
        return new Response("Missing team", { status: 400 });
      }
      const vercelUrl = `https://college-baseball-proxy.vercel.app/api/logo?team=${teamParam}`;
      return fetch(vercelUrl);
    }

    return new Response("College Baseball Worker Online", { status: 200 });
  }
};

async function handleScoreRequestCollegeBaseball(targetTeam, tzOffset) {
  const espnUrl =
    "https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/scoreboard";

  try {
    const res = await fetch(espnUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cf: { cacheTtl: 30 }
    });

    const data = await res.json();

    let anyActive = false;
    let anyUpcoming = false;

    const processedGames = (data.events || [])
      .map((event) => {
        const competition = event?.competitions?.[0];
        if (!competition?.competitors?.length) return null;

        const status = competition?.status ?? event?.status ?? {};
        const statusState = status?.type?.state || "pre"; // pre | in | post

        if (statusState === "in") anyActive = true;
        else if (statusState === "pre") anyUpcoming = true;

        let displayClock = status?.type?.detail || "";

        // Pre-game: localize start time
        if (statusState === "pre" && event?.date) {
          const dateUTC = new Date(event.date);
          dateUTC.setHours(dateUTC.getHours() + tzOffset);

          const month = dateUTC.getMonth() + 1;
          const day = dateUTC.getDate();
          let hours = dateUTC.getHours();
          const minutes = dateUTC.getMinutes().toString().padStart(2, "0");
          const ampm = hours >= 12 ? "PM" : "AM";
          hours = hours % 12 || 12;

          displayClock = `${month}/${day} - ${hours}:${minutes} ${ampm}`;
        }

        if (statusState === "in" && !displayClock) {
          displayClock = "Live";
        }

        const homeRaw = competition.competitors.find(c => c.homeAway === "home");
        const awayRaw = competition.competitors.find(c => c.homeAway === "away");

        return {
          home: normalizeCode(homeRaw?.team?.abbreviation || ""),
          away: normalizeCode(awayRaw?.team?.abbreviation || ""),
          home_score: homeRaw?.score || "0",
          away_score: awayRaw?.score || "0",
          clock: displayClock,
          status: statusState
        };
      })
      .filter(Boolean);

    // Smart polling (ESP32 friendly)
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

    let responseData = processedGames;

    if (targetTeam) {
      const cleanTarget = normalizeCode(targetTeam);
      const matches = processedGames.filter(
        g => g.home === cleanTarget || g.away === cleanTarget
      );

      const inProgress = matches.find(g => g.status === "in");
      responseData =
        inProgress ||
        matches[0] ||
        { error: "Game Not Found", status: "No Game" };
    }

    return new Response(JSON.stringify(responseData), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": `public, s-maxage=${pollInterval}, stale-while-revalidate=${swr}`
      }
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "College Baseball Fetch Failed" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
}

async function handleTeamsListCollegeBaseball() {
  const listUrl =
    "https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/teams";

  try {
    const res = await fetch(listUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cf: { cacheTtl: 86400 }
    });

    const data = await res.json();

    const teamSet = new Set(["NCAAB"]);

    const teams =
      data?.sports?.[0]?.leagues?.[0]?.teams ||
      data?.leagues?.[0]?.teams ||
      data?.teams ||
      [];

    for (const t of teams) {
      const team = t.team || t;
      if (team?.abbreviation) {
        teamSet.add(normalizeCode(team.abbreviation));
      }
    }

    return new Response([...teamSet].join(", "), {
      headers: {
        "Content-Type": "text/plain; charset=UTF-8",
        "Cache-Control": "public, s-maxage=86400",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (e) {
    return new Response("NCAAB", {
      headers: {
        "Content-Type": "text/plain; charset=UTF-8",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}
