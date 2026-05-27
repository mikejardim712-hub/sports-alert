// ============================================================
//  COMMERCIAL BREAK DETECTOR — All Sports Edition v4
//  Baseball: innings/outs | NBA/NFL: game clock | NHL: periods
// ============================================================

const NTFY_TOPIC = process.env.NTFY_TOPIC || process.env.NTFY_TOPIC;
const POLL_INTERVAL_MS = 20_000; // 20 seconds

// ============================================================
//  TEAM ALIASES — every team in MLB, NBA, NFL, NHL
// ============================================================
const TEAM_ALIASES = {

  // ---- MLB --------------------------------------------------
  "angels":           "los angeles angels",
  "astros":           "houston astros",
  "athletics":        "oakland athletics",
  "blue jays":        "toronto blue jays",
  "bluejays":         "toronto blue jays",
  "braves":           "atlanta braves",
  "brewers":          "milwaukee brewers",
  "cardinals":        "st. louis cardinals",
  "cubs":             "chicago cubs",
  "diamondbacks":     "arizona diamondbacks",
  "dbacks":           "arizona diamondbacks",
  "dodgers":          "los angeles dodgers",
  "giants":           "san francisco giants",
  "guardians":        "cleveland guardians",
  "mariners":         "seattle mariners",
  "marlins":          "miami marlins",
  "mets":             "new york mets",
  "nationals":        "washington nationals",
  "orioles":          "baltimore orioles",
  "padres":           "san diego padres",
  "phillies":         "philadelphia phillies",
  "pirates":          "pittsburgh pirates",
  "rangers":          "texas rangers",
  "rays":             "tampa bay rays",
  "red sox":          "boston red sox",
  "redsox":           "boston red sox",
  "reds":             "cincinnati reds",
  "rockies":          "colorado rockies",
  "royals":           "kansas city royals",
  "tigers":           "detroit tigers",
  "twins":            "minnesota twins",
  "white sox":        "chicago white sox",
  "whitesox":         "chicago white sox",
  "yankees":          "new york yankees",

  // ---- NBA --------------------------------------------------
  "76ers":            "philadelphia 76ers",
  "sixers":           "philadelphia 76ers",
  "bucks":            "milwaukee bucks",
  "bulls":            "chicago bulls",
  "cavaliers":        "cleveland cavaliers",
  "cavs":             "cleveland cavaliers",
  "celtics":          "boston celtics",
  "clippers":         "los angeles clippers",
  "grizzlies":        "memphis grizzlies",
  "hawks":            "atlanta hawks",
  "heat":             "miami heat",
  "hornets":          "charlotte hornets",
  "jazz":             "utah jazz",
  "kings":            "sacramento kings",
  "knicks":           "new york knicks",
  "lakers":           "los angeles lakers",
  "magic":            "orlando magic",
  "mavericks":        "dallas mavericks",
  "mavs":             "dallas mavericks",
  "nets":             "brooklyn nets",
  "nuggets":          "denver nuggets",
  "pacers":           "indiana pacers",
  "pelicans":         "new orleans pelicans",
  "pistons":          "detroit pistons",
  "raptors":          "toronto raptors",
  "rockets":          "houston rockets",
  "spurs":            "san antonio spurs",
  "suns":             "phoenix suns",
  "thunder":          "oklahoma city thunder",
  "timberwolves":     "minnesota timberwolves",
  "wolves":           "minnesota timberwolves",
  "trail blazers":    "portland trail blazers",
  "blazers":          "portland trail blazers",
  "warriors":         "golden state warriors",
  "wizards":          "washington wizards",

  // ---- NFL --------------------------------------------------
  "49ers":            "san francisco 49ers",
  "bears":            "chicago bears",
  "bengals":          "cincinnati bengals",
  "bills":            "buffalo bills",
  "broncos":          "denver broncos",
  "browns":           "cleveland browns",
  "buccaneers":       "tampa bay buccaneers",
  "bucs":             "tampa bay buccaneers",
  "cardinals":        "arizona cardinals",
  "chargers":         "los angeles chargers",
  "chiefs":           "kansas city chiefs",
  "colts":            "indianapolis colts",
  "commanders":       "washington commanders",
  "cowboys":          "dallas cowboys",
  "dolphins":         "miami dolphins",
  "eagles":           "philadelphia eagles",
  "falcons":          "atlanta falcons",
  "giants":           "new york giants",
  "jaguars":          "jacksonville jaguars",
  "jags":             "jacksonville jaguars",
  "jets":             "new york jets",
  "lions":            "detroit lions",
  "packers":          "green bay packers",
  "panthers":         "carolina panthers",
  "patriots":         "new england patriots",
  "pats":             "new england patriots",
  "raiders":          "las vegas raiders",
  "rams":             "los angeles rams",
  "ravens":           "baltimore ravens",
  "saints":           "new orleans saints",
  "seahawks":         "seattle seahawks",
  "steelers":         "pittsburgh steelers",
  "texans":           "houston texans",
  "titans":           "tennessee titans",
  "vikings":          "minnesota vikings",

  // ---- NHL --------------------------------------------------
  "avalanche":        "colorado avalanche",
  "avs":              "colorado avalanche",
  "blackhawks":       "chicago blackhawks",
  "blue jackets":     "columbus blue jackets",
  "blues":            "st. louis blues",
  "bruins":           "boston bruins",
  "canadiens":        "montreal canadiens",
  "habs":             "montreal canadiens",
  "canucks":          "vancouver canucks",
  "capitals":         "washington capitals",
  "caps":             "washington capitals",
  "coyotes":          "arizona coyotes",
  "devils":           "new jersey devils",
  "ducks":            "anaheim ducks",
  "flames":           "calgary flames",
  "flyers":           "philadelphia flyers",
  "golden knights":   "vegas golden knights",
  "knights":          "vegas golden knights",
  "hurricanes":       "carolina hurricanes",
  "canes":            "carolina hurricanes",
  "islanders":        "new york islanders",
  "kings":            "los angeles kings",
  "kraken":           "seattle kraken",
  "lightning":        "tampa bay lightning",
  "bolts":            "tampa bay lightning",
  "maple leafs":      "toronto maple leafs",
  "leafs":            "toronto maple leafs",
  "oilers":           "edmonton oilers",
  "panthers":         "florida panthers",
  "penguins":         "pittsburgh penguins",
  "pens":             "pittsburgh penguins",
  "predators":        "nashville predators",
  "preds":            "nashville predators",
  "rangers":          "new york rangers",
  "red wings":        "detroit red wings",
  "sabres":           "buffalo sabres",
  "senators":         "ottawa senators",
  "sens":             "ottawa senators",
  "sharks":           "san jose sharks",
  "stars":            "dallas stars",
  "wild":             "minnesota wild",
  "winnipeg jets":    "winnipeg jets",
};

// ============================================================
//  SPORT DETECTION — figures out which ESPN endpoint to use
// ============================================================
const MLB_TEAMS  = ["angels","astros","athletics","blue jays","bluejays","braves","brewers","cardinals","cubs","diamondbacks","dbacks","dodgers","giants","guardians","mariners","marlins","mets","nationals","orioles","padres","phillies","pirates","rangers","rays","red sox","redsox","reds","rockies","royals","tigers","twins","white sox","whitesox","yankees"];
const NBA_TEAMS  = ["76ers","sixers","bucks","bulls","cavaliers","cavs","celtics","clippers","grizzlies","hawks","heat","hornets","jazz","kings","knicks","lakers","magic","mavericks","mavs","nets","nuggets","pacers","pelicans","pistons","raptors","rockets","spurs","suns","thunder","timberwolves","wolves","trail blazers","blazers","warriors","wizards"];
const NFL_TEAMS  = ["49ers","bears","bengals","bills","broncos","browns","buccaneers","bucs","chargers","chiefs","colts","commanders","cowboys","dolphins","eagles","falcons","giants","jaguars","jags","jets","lions","packers","panthers","patriots","pats","raiders","rams","ravens","saints","seahawks","steelers","texans","titans","vikings"];
const NHL_TEAMS  = ["avalanche","avs","blackhawks","blue jackets","blues","bruins","canadiens","habs","canucks","capitals","caps","coyotes","devils","ducks","flames","flyers","golden knights","knights","hurricanes","canes","islanders","kraken","lightning","bolts","maple leafs","leafs","oilers","penguins","pens","predators","preds","rangers","red wings","sabres","senators","sens","sharks","stars","wild","winnipeg jets"];

function detectSport(nickname) {
  const n = nickname.toLowerCase();
  if (MLB_TEAMS.some(t => n.includes(t))) return "baseball/mlb";
  if (NBA_TEAMS.some(t => n.includes(t))) return "basketball/nba";
  if (NFL_TEAMS.some(t => n.includes(t))) return "football/nfl";
  if (NHL_TEAMS.some(t => n.includes(t))) return "hockey/nhl";
  return "baseball/mlb";
}

// ============================================================
//  ESPN API
// ============================================================
async function fetchLiveGames(sport) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN API error: ${res.status}`);
  const json = await res.json();
  return json.events || [];
}

function findMatchingEvent(events, nickname) {
  const nick = nickname.toLowerCase().replace(" game", "").trim();
  const fullName = TEAM_ALIASES[nick] || nick;
  console.log(`[${nickname}] Looking for: "${fullName}" among ${events.length} games`);
  for (const event of events) {
    const eventName = (event.name || "").toLowerCase();
    const shortName = (event.shortName || "").toLowerCase();
    console.log(`  → ESPN has: ${event.name} (${event.status?.type?.description})`);
    if (eventName.includes(fullName) || shortName.includes(fullName)) return event;
    const lastWord = fullName.split(" ").pop();
    if (lastWord.length > 4 && (eventName.includes(lastWord) || shortName.includes(lastWord))) return event;
  }
  return null;
}

// ============================================================
//  SITUATION EXTRACTORS — one per sport
// ============================================================

// BASEBALL: watch innings + outs
function extractBaseball(event) {
  const comp = event?.competitions?.[0];
  const status = comp?.status;
  if (!status || status?.type?.state !== "in") return null;
  const situation = comp?.situation;
  const inning = status?.period || 1;
  const outs = situation?.outs ?? null;
  const detail = status?.type?.shortDetail || "";
  const halfInning = detail.toLowerCase().includes("bot") ? "bottom" : "top";
  console.log(`  → [MLB] ${halfInning} ${inning}, Outs: ${outs}`);
  return { sport: "mlb", inning, halfInning, outs };
}

// BASKETBALL: watch game clock frozen time
function extractBasketball(event) {
  const comp = event?.competitions?.[0];
  const status = comp?.status;
  if (!status || status?.type?.state !== "in") return null;
  const clock = status.displayClock || "0:00";
  const period = status.period || 1;
  console.log(`  → [NBA] Period ${period}, Clock: ${clock}`);
  return { sport: "nba", clock, period };
}

// FOOTBALL: watch game clock frozen time (shorter threshold)
function extractFootball(event) {
  const comp = event?.competitions?.[0];
  const status = comp?.status;
  if (!status || status?.type?.state !== "in") return null;
  const clock = status.displayClock || "0:00";
  const period = status.period || 1;
  console.log(`  → [NFL] Quarter ${period}, Clock: ${clock}`);
  return { sport: "nfl", clock, period };
}

// HOCKEY: watch periods — commercial only happens between periods
function extractHockey(event) {
  const comp = event?.competitions?.[0];
  const status = comp?.status;
  if (!status || status?.type?.state !== "in") return null;
  const period = status.period || 1;
  const clock = status.displayClock || "0:00";
  const detail = (status?.type?.shortDetail || "").toLowerCase();
  // "end of period" or clock at 0:00 = intermission = commercial
  const isIntermission = detail.includes("end") || detail.includes("intermission") || clock === "0:00";
  console.log(`  → [NHL] Period ${period}, Clock: ${clock}, Intermission: ${isIntermission}`);
  return { sport: "nhl", period, clock, isIntermission };
}

function extractSituation(event, sport) {
  if (sport === "baseball/mlb")   return extractBaseball(event);
  if (sport === "basketball/nba") return extractBasketball(event);
  if (sport === "football/nfl")   return extractFootball(event);
  if (sport === "hockey/nhl")     return extractHockey(event);
  return null;
}

// ============================================================
//  COMMERCIAL BREAK LOGIC — one per sport
// ============================================================
const gameState = {};

// Thresholds (seconds clock must be frozen to call it a commercial)
const NBA_THRESHOLD = 120; // 2 minutes
const NFL_THRESHOLD = 90;  // 1.5 minutes

function ordinal(n) {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

async function sendNotification(title, message) {
  console.log(`[NOTIFY] ${title} — ${message}`);
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      body: message,
      headers: {
        "Title": title,
        "Priority": "high",
        "Tags": "sports,tv",
      },
    });
    console.log("  ✅ Notification sent successfully");
  } catch (err) {
    console.error("  ❌ Notification failed:", err.message);
  }
}

// --- Baseball logic (innings/outs) ---
function checkBaseball(gameId, nickname, sit) {
  const now = new Date();
  const s = gameState[gameId];
  if (!s) {
    gameState[gameId] = { lastInning: sit.inning, lastHalfInning: sit.halfInning, lastOuts: sit.outs, isOnCommercial: false };
    console.log(`[${nickname}] ✅ Tracking — ${sit.halfInning} ${ordinal(sit.inning)}, ${sit.outs} outs`);
    return;
  }
  const halfChanged = sit.inning !== s.lastInning || sit.halfInning !== s.lastHalfInning;
  const isBreak = sit.outs === null || sit.outs >= 3;
  const backLive = halfChanged && (sit.outs === 0 || sit.outs === 1);
  if (backLive && s.isOnCommercial) {
    const half = sit.halfInning === "top" ? "Top" : "Bottom";
    sendNotification("⚾ Game is back!", `${nickname} is back — ${half} of the ${ordinal(sit.inning)} starting.`);
    console.log(`[${nickname}] ✅ BACK LIVE`);
    s.isOnCommercial = false;
  } else if (isBreak && !s.isOnCommercial) {
    console.log(`[${nickname}] 📺 Commercial — between half-innings`);
    s.isOnCommercial = true;
  } else if (!isBreak) {
    console.log(`[${nickname}] ▶ Live — ${sit.halfInning} ${ordinal(sit.inning)}, ${sit.outs} out(s)`);
    s.isOnCommercial = false;
  } else {
    console.log(`[${nickname}] 📺 Still on commercial...`);
  }
  s.lastInning = sit.inning;
  s.lastHalfInning = sit.halfInning;
  s.lastOuts = sit.outs;
}

// --- Clock-based logic (NBA + NFL) ---
function checkClock(gameId, nickname, sit, thresholdSec, emoji) {
  const now = new Date();
  const s = gameState[gameId];
  if (!s) {
    gameState[gameId] = { lastClock: sit.clock, lastClockChangedAt: now, lastPeriod: sit.period, isOnCommercial: false };
    console.log(`[${nickname}] ✅ Tracking — Period ${sit.period}, Clock: ${sit.clock}`);
    return;
  }
  const clockChanged = sit.clock !== s.lastClock || sit.period !== s.lastPeriod;
  if (clockChanged) {
    const wasOnCommercial = s.isOnCommercial;
    s.lastClock = sit.clock;
    s.lastClockChangedAt = now;
    s.lastPeriod = sit.period;
    s.isOnCommercial = false;
    if (wasOnCommercial) {
      sendNotification(`${emoji} Game is back!`, `${nickname} is back live — ${ordinal(sit.period)} period/quarter, ${sit.clock} left.`);
      console.log(`[${nickname}] ✅ BACK LIVE`);
    } else {
      console.log(`[${nickname}] ▶ Live — Period ${sit.period}, Clock: ${sit.clock}`);
    }
  } else {
    const frozenSec = Math.floor((now - s.lastClockChangedAt) / 1000);
    if (frozenSec >= thresholdSec && !s.isOnCommercial) {
      s.isOnCommercial = true;
      console.log(`[${nickname}] 📺 Commercial detected (frozen ${frozenSec}s)`);
    } else {
      console.log(`[${nickname}] Clock frozen ${frozenSec}s / ${thresholdSec}s`);
    }
  }
}

// --- Hockey logic (between periods) ---
function checkHockey(gameId, nickname, sit) {
  const now = new Date();
  const s = gameState[gameId];
  if (!s) {
    gameState[gameId] = { lastPeriod: sit.period, isOnCommercial: sit.isIntermission };
    console.log(`[${nickname}] ✅ Tracking — Period ${sit.period}, Intermission: ${sit.isIntermission}`);
    return;
  }
  const periodChanged = sit.period !== s.lastPeriod;
  if (periodChanged && s.isOnCommercial) {
    sendNotification("🏒 Game is back!", `${nickname} is back — ${ordinal(sit.period)} period starting.`);
    console.log(`[${nickname}] ✅ BACK LIVE — Period ${sit.period}`);
    s.isOnCommercial = false;
  } else if (sit.isIntermission && !s.isOnCommercial) {
    console.log(`[${nickname}] 📺 Intermission after period ${sit.period}`);
    s.isOnCommercial = true;
  } else if (!sit.isIntermission) {
    console.log(`[${nickname}] ▶ Live — Period ${sit.period}, Clock: ${sit.clock}`);
    s.isOnCommercial = false;
  } else {
    console.log(`[${nickname}] 📺 Still in intermission...`);
  }
  s.lastPeriod = sit.period;
}

function checkSituation(gameId, nickname, sit) {
  if (sit.sport === "mlb") checkBaseball(gameId, nickname, sit);
  if (sit.sport === "nba") checkClock(gameId, nickname, sit, NBA_THRESHOLD, "🏀");
  if (sit.sport === "nfl") checkClock(gameId, nickname, sit, NFL_THRESHOLD, "🏈");
  if (sit.sport === "nhl") checkHockey(gameId, nickname, sit);
}

// ============================================================
//  GAMES TO WATCH — change these to whatever you're watching!
// ============================================================
const GAMES_TO_WATCH = [
  { nickname: "Red Sox game", espnGameId: null, sport: null },
  { nickname: "Rays game",   espnGameId: null, sport: null },
];

// ============================================================
//  MAIN POLL LOOP
// ============================================================
async function poll() {
  console.log("\n─── Poll:", new Date().toLocaleTimeString(), "───────────────────");

  for (const game of GAMES_TO_WATCH) {
    try {
      // Auto-detect sport from nickname if not set
      if (!game.sport) {
        game.sport = detectSport(game.nickname);
        console.log(`[${game.nickname}] Sport detected: ${game.sport}`);
      }

      const events = await fetchLiveGames(game.sport);

      if (!game.espnGameId) {
        const event = findMatchingEvent(events, game.nickname);
        if (event) {
          game.espnGameId = event.id;
          console.log(`[${game.nickname}] 🔒 Locked: ${event.name}`);
        } else {
          console.log(`[${game.nickname}] Not found yet — waiting for game to start.`);
          continue;
        }
      }

      const event = events.find(e => e.id === game.espnGameId);
      if (!event) {
        console.log(`[${game.nickname}] Game ended or dropped.`);
        game.espnGameId = null;
        continue;
      }

      const sit = extractSituation(event, game.sport);
      if (!sit) {
        console.log(`[${game.nickname}] Not currently in progress.`);
        continue;
      }

      checkSituation(game.espnGameId, game.nickname, sit);

    } catch (err) {
      console.error(`[${game.nickname}] Error:`, err.message);
    }
  }
}

// ============================================================
//  START
// ============================================================
console.log("═══════════════════════════════════════════");
console.log("  Commercial Break Detector — All Sports v4");
console.log("═══════════════════════════════════════════");
console.log(`Watching: ${GAMES_TO_WATCH.map(g => g.nickname).join(", ")}`);
console.log(`Notifications → ntfy.sh/${NTFY_TOPIC}`);
console.log("───────────────────────────────────────────");

// Test notification on startup so you know ntfy is connected
sendNotification("✅ Detector started!", `Now watching: ${GAMES_TO_WATCH.map(g => g.nickname).join(", ")}`);

poll();
setInterval(poll, POLL_INTERVAL_MS);
