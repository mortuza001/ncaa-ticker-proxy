// teams-list.js
// NCAA /teams-list endpoint helper
//
// Usage (from main worker):
//   import { handleTeamsList } from "./teams-list.js";
//   if (url.pathname === "/teams-list") return handleTeamsList(url);

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

function getQS(url, key) {
  // supports both normal and HTML-encoded amp;key
  return url.searchParams.get(key) ?? url.searchParams.get(`amp;${key}`) ?? null;
}

function normalizeCode(s) {
  if (!s || typeof s !== "string") return "";
  return s.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function buildTeamsUrl(sport, league) {
  return `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams`;
}

function responseText(body, ttlSec = 86400) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      "Cache-Control": `public, s-maxage=${ttlSec}`,
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function responseJson(obj, ttlSec = 86400) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": `public, s-maxage=${ttlSec}`,
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function teamsListFallback(format = "text") {
  const fallback = ["NCAA"]; // minimal fallback
  return (format === "json")
    ? responseJson(fallback, 3600)
    : responseText(fallback.join(", "), 3600);
}

export async function handleTeamsList(url) {
  const preset = (getQS(url, "preset") || "ncaam").toLowerCase();
  const format = (getQS(url, "format") || "text").toLowerCase(); // "text" | "json"

  let sport = NCAA_PRESETS[preset]?.sport;
  let league = NCAA_PRESETS[preset]?.league;

  if (!sport || !league) {
    // default to men's college basketball
    sport = "basketball";
    league = "mens-college-basketball";
  }

  // Optional: allow shorter TTL override for testing (e.g., ttl=60)
  const ttl = intOr(getQS(url, "ttl"), 86400);

  const listUrl = buildTeamsUrl(sport, league);

  try {
    const res = await fetch(listUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cf: { cacheEverything: true, cacheTtl: ttl }
    });

    if (!res.ok) return teamsListFallback(format);

    const data = await res.json();

    // ESPN sometimes nests as sports[0].leagues[0].teams, sometimes has "teams"
    const teamsArray =
      data?.sports?.[0]?.leagues?.[0]?.teams ||
      data?.leagues?.[0]?.teams ||
      data?.teams ||
      [];

    const teamAbbrs = [];
    teamAbbrs.push("NCAA"); // header token, like your NFL example uses "NFL"

    for (const t of teamsArray) {
      const team = t?.team || t;
      const abbr = normalizeCode(team?.abbreviation || "");
      if (abbr) teamAbbrs.push(abbr);
    }

    // De-dupe & sort, keep header first
    const header = teamAbbrs.shift();
    const uniq = Array.from(new Set(teamAbbrs)).sort();
    uniq.unshift(header);

    return (format === "json")
      ? responseJson(uniq, ttl)
      : responseText(uniq.join(", "), ttl);

  } catch (e) {
    return teamsListFallback(format);
  }
}
