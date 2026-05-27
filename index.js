// ============================================================
//  COMMERCIAL BREAK DETECTOR — Fixed Version
// ============================================================

const NTFY_TOPIC = process.env.NTFY_TOPIC || process.env.NTFY_TOPIC;
const COMMERCIAL_THRESHOLD_SECONDS = 120;
const POLL_INTERVAL_MS = 30_000;

// ---- TEAM NAME MAP -----------------------------------------
// Maps common nicknames to ESPN's full team name (lowercase)
const TEAM_ALIASES = {
  // MLB
  "marlins":    "miami marlins",
  "blue jays":  "toronto blue jays",
  "bluejays":   "toronto blue jays",
  "nationals":  "washington nationals",
  "guardians":  "cleveland guardians",
  "yankees":    "new york yankees",
  "red sox":    "boston red sox",
  "dodgers":    "los angeles dodgers",
  "cubs":       "chicago cubs",
  "mets":       "new york mets",
  "braves":     "atlanta braves",
  "astros":     "houston astros",
  "phillies":   "philadelphia phillies",
  "cardinals":  "st. louis cardinals",
  "giants":     "san francisco giants",
  "padres":     "san diego padres",
  "brewers":    "milwaukee brewers",
  "pirates":    "pittsburgh pirates",
  "reds":       "cincinnati reds",
  "rockies":    "colorado rockies",
  "diamondbacks": "arizona diamondbacks",
  "angels":     "los angeles angels",
  "athletics":  "oakland athletics",
  "mariners":   "seattle mariners",
  "rangers":    "texas rangers",
  "twins":      "minnesota twins",
  "tigers":     "detroit tigers",
  "royals":     "kansas city royals",
  "white sox":  "chicago white sox",
  "orioles":    "baltimore orioles",
  "rays":       "tampa bay rays",
  // NBA
  "celtics":    "boston celtics",
  "lakers":     "los angeles lakers",
  "warriors":   "golden state warriors",
  "heat":       "miami heat",
  "bucks":      "milwaukee bucks",
  "knicks":     "new york knicks",
  "nets":       "brooklyn nets",
  // NFL
  "patriots":   "new england patriots",
  "eagles":     "philadelphia eagles",
  "chiefs":     "kansas city chiefs",
  "cowboys":    "dallas cowboys",
  "49ers":      "san francisco 49ers",
  // NHL
  "bruins":     "boston bruins",
  "rangers":    "new york rangers",
  "penguins":   "pittsburgh penguins",
};

// ---- SPORT DETECTION ---------------------------------------
function detectSport(nickname) {
  const n = nickname.toLowerCase();
  const mlbTeams = ["marlins","blue jays","nationals","guardians","yankees","red sox","dodgers","cubs","mets","braves","astros","phillies","cardinals","giants","padres","brewers","pirates","reds","rockies","diamondbacks","angels","athletics","mariners","rangers","twins","tigers","royals","white sox","orioles","rays"];
  const nbaTeams = ["celtics","lakers","warriors","heat","bucks","knicks","nets"];
  const nflTeams = ["patriots","eagles","chiefs","cowboys","49ers"];
  const nhlTeams = ["bruins","rangers","penguins","blackhawks"];

  if (mlbTeams.some(t => n.includes(t))) return "baseball/mlb";
  if (nbaTeams.some(t => n.includes(t))) return "basketball/nba";
  if (nflTeams.some(t => n.includes(t))) return "football/nfl";
  if (nhlTeams.some(t => n.includes(t))) return "hockey/nhl";
  return "baseball/mlb";
}

// ---- ESPN API ----------------------------------------------
async function fetchLiveGames(sport) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN API error: ${res.status}`);
  const json = await res.json();
  return json.events || [];
}

// ---- GAME MATCHING -----------------------------------------
function findMatchingEvent(events, nickname) {
  const nick = nickname.toLowerCase().replace(" game", "").trim();
  const fullName = TEAM_ALIASES[nick] || nick;

  console.log(`[${nickname}] Searching for: "${fullName}" among ${events.length} games`);

  for (const event of events) {
    const eventName = (event.name || "").toLowerCase();
    const shortName = (event.shortName || "").toLowerCase();

    // Log every game found so we can debug
    console.log(`  → Found game: ${event.name} | status: ${event.status?.type?.description}`);

    if (eventName.includes(fullName) || shortName.includes(fullName)) {
      return event;
    }

    // Also try matching just the city or team nickname word by word
    const words = fullName.split(" ");
    const lastWord = words[words.length - 1]; // e.g. "marlins" from "miami marlins"
    if (lastWord.length > 4 && (eventName.includes(lastWord) || shortName.includes(lastWord))) {
      return event;
    }
  }

  return null;
}

// ---- CLOCK EXTRACTION --------------------------------------
function extractClockInfo(event) {
  const competition = event?.competitions?.[0];
  const status = competition?.status;
  if (!status) return null;

  const state = status?.type?.state;
  const description = status?.type?.description || "";

  console.log(`  → State: "${state}", Description: "${description}", Clock: "${status.displayClock}", Period: ${status.period}`);

  // Only track if in progress
  if (state !== "in") return null;

  return {
    clock: status.displayClock || "0:00",
    period: status.period || 1,
    description,
  };
}

// ---- STATE & NOTIFICATION ----------------------------------
const gameState = {};

async function sendNotification(message) {
  console.log(`[NOTIFY] ${message}`);
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      body: message,
      headers: {
        "Title": "⚾ Game is back live!",
        "Priority": "high",
        "Tags": "sports,tv",
      },
    });
  } catch (err) {
    console.error("Notification failed:", err.message);
  }
}

function checkClock(gameId, nickname, clockInfo) {
  const now = new Date();
  const state = gameState[gameId];

  if (!state) {
    gameState[gameId] = {
      lastClockValue: clockInfo.clock,
      lastClockChangedAt: now,
      isOnCommercial: false,
    };
    console.log(`[${nickname}] ✅ Now tracking! Clock: ${clockInfo.clock}, Period: ${clockInfo.period}`);
    return;
  }

  const clockChanged = clockInfo.clock !== state.lastClockValue;

  if (clockChanged) {
    const wasOnCommercial = state.isOnCommercial;
    state.lastClockValue = clockInfo.clock;
    state.lastClockChangedAt = now;
    state.isOnCommercial = false;

    if (wasOnCommercial) {
      sendNotification(`${nickname} is back from commercial! Period ${clockInfo.period}, clock: ${clockInfo.clock}`);
      console.log(`[${nickname}] ✅ BACK LIVE`);
    } else {
      console.log(`[${nickname}] Live — Clock: ${clockInfo.clock}, Period: ${clockInfo.period}`);
    }
  } else {
    const frozenSec = Math.floor((now - state.lastClockChangedAt) / 1000);
    if (frozenSec >= COMMERCIAL_THRESHOLD_SECONDS && !state.isOnCommercial) {
      state.isOnCommercial = true;
      console.log(`[${nickname}] 📺 Commercial detected (frozen ${frozenSec}s)`);
    } else {
      console.log(`[${nickname}] Clock frozen ${frozenSec}s / ${COMMERCIAL_THRESHOLD_SECONDS}s threshold`);
    }
  }
}

// ---- GAMES TO WATCH ----------------------------------------
const GAMES_TO_WATCH = [
  { nickname: "Phillies game",   sport: "baseball/mlb", espnGameId: null },
  { nickname: "Nationals game", sport: "baseball/mlb", espnGameId: null },
];

// ---- MAIN POLL ---------------------------------------------
async function poll() {
  console.log("\n--- Poll at", new Date().toLocaleTimeString(), "---");

  for (const game of GAMES_TO_WATCH) {
    try {
      const events = await fetchLiveGames(game.sport);

      if (!game.espnGameId) {
        const event = findMatchingEvent(events, game.nickname);
        if (event) {
          game.espnGameId = event.id;
          console.log(`[${game.nickname}] Game ID locked: ${event.id}`);
        } else {
          console.log(`[${game.nickname}] Not found yet — game may not have started.`);
          continue;
        }
      }

      const event = events.find(e => e.id === game.espnGameId);
      if (!event) {
        console.log(`[${game.nickname}] Game ended or dropped from scoreboard.`);
        game.espnGameId = null;
        continue;
      }

      const clockInfo = extractClockInfo(event);
      if (!clockInfo) {
        console.log(`[${game.nickname}] Game not currently in progress.`);
        continue;
      }

      checkClock(game.espnGameId, game.nickname, clockInfo);

    } catch (err) {
      console.error(`[${game.nickname}] Error:`, err.message);
    }
  }
}

// ---- START -------------------------------------------------
console.log("===========================================");
console.log("  Commercial Break Detector — v2 (Fixed)");
console.log("===========================================");
console.log(`Watching: ${GAMES_TO_WATCH.map(g => g.nickname).join(", ")}`);
console.log(`Notifications → ntfy.sh/${NTFY_TOPIC}`);
console.log("-------------------------------------------");

poll();
setInterval(poll, POLL_INTERVAL_MS);
