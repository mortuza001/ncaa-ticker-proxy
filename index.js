// /api/scores  (Node 18+ / serverless)// /api/scores  (Node 18+[1](https://ncaa-api.henrygd.me/openapi)
    const url = `https://ncaa-api.henrygd.me/scoreboard/${sel.sport}/${sel.path}`;

    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!r.ok) {
      res.status(r.status).json({ error: "score fetch failed", url });
      return;
    }

    const data = await r.json();

    // The OpenAPI shows a "games" array containing game objects with home/away names,
    // plus state fields like gameState, startTime, contestClock, currentPeriod, finalMessage. [1](https://ncaa-api.henrygd.me/openapi)
    const games = Array.isArray(data?.games) ? data.games : [];

    const out = [];

    for (const item of games) {
      const g = item?.game || item; // defensive

      const home = g?.home || {};
      const away = g?.away || {};

      const homeNames = home?.names || {};
      const awayNames = away?.names || {};

      const homeChar6 = (homeNames?.char6 || homeNames?.short || "HOME").toString();
      const awayChar6 = (awayNames?.char6 || awayNames?.short || "AWAY").toString();

      const homeSeo = (homeNames?.seo || "").toString();  // KEY FOR LOGO [1](https://ncaa-api.henrygd.me/openapi)
      const awaySeo = (awayNames?.seo || "").toString();  // KEY FOR LOGO [1](https://ncaa-api.henrygd.me/openapi)

      const homeScore = (home?.score ?? "").toString();
      const awayScore = (away?.score ?? "").toString();

      const gameState = (g?.gameState || "").toString().toLowerCase();
      const startTime = (g?.startTime || "").toString();       // e.g. "5:09PM ET"
      const contestClock = (g?.contestClock || "").toString(); // e.g. "12:34"
      const currentPeriod = (g?.currentPeriod || "").toString();
      const finalMessage = (g?.finalMessage || "").toString();

      // Normalize status to match your ESP32 expectations
      let status = "pre";
      let clock = startTime;

      if (gameState === "final") {
        status = "post";
        clock = finalMessage || "FINAL";
      } else if (gameState === "live" || (contestClock && contestClock !== "0:00")) {
        status = "in";
        clock = (currentPeriod ? `${currentPeriod} ` : "") + contestClock;
      } else {
        status = "pre";
        clock = startTime || "";
      }

      out.push({
        home: homeChar6,
        away: awayChar6,
        home_seo: homeSeo,
        away_seo: awaySeo,
        home_score: homeScore,
        away_score: awayScore,
        clock,
        status
      });
    }

    // Cache hint (15 min) – tune as you like
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=900");
    res.status(200).json(out);

  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
// Uses ncaa-api scoreboard: GET /scoreboard/{sport}/{path} [1](https://ncaa-api.henrygd.me/openapi)

export default async function handler(req, res) {
  try {
    const preset = (req.query.preset || "ncaam").toString().toLowerCase();

    const PRESET_TO_PATH = {
      cfb:   { sport: "football",        path: "fbs" },
      ncaam: { sport: "basketball-men",  path: "d1"  },
      cbase: { sport: "baseball",        path: "d1"  }
    };

    const sel = PRESET_TO_PATH[preset] || PRESET_TO_PATH.ncaam;

