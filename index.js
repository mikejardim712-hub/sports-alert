// ============================================================
//  COMMERCIAL BREAK DETECTOR
//  Paste this into Glitch.com or Replit and run it.
//  It watches up to 2 games and sends you a notification
//  when a game comes back from commercial break.
// ============================================================

// ---- CONFIGURATION (edit these) ----------------------------

const GAMES_TO_WATCH = [
  { nickname: "Marlins game", espnGameId: null },  // espnGameId filled in automatically (see below)
  { nickname: "Nationals game",  espnGameId: null },
];

// Ntfy.sh topic — go to ntfy.sh, pick any unique topic name (like "johns-sports-alert-7742")
// Install the free ntfy app on your phone and subscribe to the same topic name.
const NTFY_TOPIC = process.env.NTFY_TOPIC;

// How many seconds the clock must be frozen before we call it a commercial break
const COMMERCIAL_THRESHOLD_SECONDS = 120; // 2 minutes

// How often to poll ESPN (in milliseconds). 30 seconds is plenty.
const POLL_INTERVAL_MS = 30_000;

// ---- STATE (don't edit) ------------------------------------

const gameState = {};
// gameState[gameId] = {
//   lastClockValue: "12:34",
//   lastClockChangedAt: Date,
//   isOnCommercial: false,
//   notifiedReturn: false,
// }

// ---- ESPN API ----------------------------------------------

// Fetches all live/recent games for a given sport.
// sport options: "basketball/nba", "football/nfl", "baseball/mlb", "hockey/nhl", "basketball/wnba"
async function fetchLiveGames(sport) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard`;
  const res = await fetch(url);
  const json = await res.json();
  return json.events || [];
}

// Returns the current game clock and period for a specific game event.
// Returns null if the game isn't live.
function extractClockInfo(event) {
  const status = event?.status;
  if (!status) return null;

  const type = status.type;

  // Not in progress
  if (type?.state !== "in") return null;

  return {
    clock: status.displayClock,   // e.g. "4:32" or "0:00"
    period: status.period,         // e.g. 3 (3rd quarter)
    description: type?.description // e.g. "In Progress"
  };
}

// ---- NOTIFICATION ------------------------------------------

async function sendNotification(message) {
  console.log(`[NOTIFY] ${message}`);
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      body: message,
      headers: {
        "Title": "🏀 Game is back live!",
        "Priority": "high",
        "Tags": "sports,tv"
      }
    });
  } catch (err) {
    console.error("Failed to send notification:", err.message);
  }
}

// ---- CORE LOGIC --------------------------------------------

function checkForCommercialBreak(gameId, nickname, clockInfo) {
  const now = new Date();
  const state = gameState[gameId];

  // First time seeing this game
  if (!state) {
    gameState[gameId] = {
      lastClockValue: clockInfo.clock,
      lastClockChangedAt: now,
      isOnCommercial: false,
    };
    console.log(`[${nickname}] Tracking started. Clock: ${clockInfo.clock}, Period: ${clockInfo.period}`);
    return;
  }

  const clockChanged = clockInfo.clock !== state.lastClockValue;

  if (clockChanged) {
    // Clock is moving — game is live
    const wasOnCommercial = state.isOnCommercial;

    state.lastClockValue = clockInfo.clock;
    state.lastClockChangedAt = now;
    state.isOnCommercial = false;

    if (wasOnCommercial) {
      // It was on commercial and just came back!
      const message = `${nickname} is back from commercial! (${clockInfo.period === 1 ? "1st" : clockInfo.period === 2 ? "2nd" : clockInfo.period === 3 ? "3rd" : clockInfo.period + "th"} period, ${clockInfo.clock} left)`;
      console.log(`[${nickname}] ✅ BACK LIVE — ${clockInfo.clock}`);
      sendNotification(message);
    } else {
      console.log(`[${nickname}] Live. Clock: ${clockInfo.clock}, Period: ${clockInfo.period}`);
    }
  } else {
    // Clock hasn't moved — check how long it's been frozen
    const frozenMs = now - state.lastClockChangedAt;
    const frozenSec = Math.floor(frozenMs / 1000);

    if (frozenSec >= COMMERCIAL_THRESHOLD_SECONDS && !state.isOnCommercial) {
      state.isOnCommercial = true;
      console.log(`[${nickname}] 📺 On commercial (frozen ${frozenSec}s)`);
    } else {
      console.log(`[${nickname}] Clock frozen for ${frozenSec}s... (threshold: ${COMMERCIAL_THRESHOLD_SECONDS}s)`);
    }
  }
}

// ---- MAIN LOOP ---------------------------------------------

// Detects which sport a nickname likely refers to (simple keyword match)
function detectSport(nickname) {
  const n = nickname.toLowerCase();
  if (n.includes("celtics") || n.includes("lakers") || n.includes("nba") || n.includes("warriors") || n.includes("heat") || n.includes("bucks") || n.includes("knicks") || n.includes("nets")) return "basketball/nba";
  if (n.includes("patriots") || n.includes("eagles") || n.includes("nfl") || n.includes("chiefs") || n.includes("cowboys") || n.includes("giants") || n.includes("49ers")) return "football/nfl";
  if (n.includes("yankees") || n.includes("red sox") || n.includes("mlb") || n.includes("dodgers") || n.includes("cubs")) return "baseball/mlb";
  if (n.includes("bruins") || n.includes("rangers") || n.includes("nhl") || n.includes("penguins") || n.includes("blackhawks")) return "hockey/nhl";
  return "basketball/nba"; // default
}

// Finds the ESPN game ID by matching the team name in the nickname
async function findGameId(gameConfig) {
  if (gameConfig.espnGameId) return gameConfig.espnGameId; // already set

  const sport = detectSport(gameConfig.nickname);
  const events = await fetchLiveGames(sport);

  for (const event of events) {
    const name = event.name?.toLowerCase() || "";
    const shortName = event.shortName?.toLowerCase() || "";
    const nick = gameConfig.nickname.toLowerCase();

    // Check if any word in the nickname matches the game name
    const words = nick.replace(" game", "").trim().split(" ");
    const matches = words.some(w => w.length > 3 && (name.includes(w) || shortName.includes(w)));

    if (matches) {
      console.log(`[${gameConfig.nickname}] Found game: ${event.name} (ID: ${event.id})`);
      return event.id;
    }
  }

  console.log(`[${gameConfig.nickname}] No live game found right now.`);
  return null;
}

async function poll() {
  for (const game of GAMES_TO_WATCH) {
    try {
      // Auto-find the game ID if not set
      if (!game.espnGameId) {
        game.espnGameId = await findGameId(game);
      }
      if (!game.espnGameId) continue;

      // Fetch current scoreboard and find this game
      const sport = detectSport(game.nickname);
      const events = await fetchLiveGames(sport);
      const event = events.find(e => e.id === game.espnGameId);

      if (!event) {
        console.log(`[${game.nickname}] Game not found in scoreboard (may have ended).`);
        game.espnGameId = null; // reset so it re-searches next poll
        continue;
      }

      const clockInfo = extractClockInfo(event);
      if (!clockInfo) {
        console.log(`[${game.nickname}] Game not currently live.`);
        continue;
      }

      checkForCommercialBreak(game.espnGameId, game.nickname, clockInfo);

    } catch (err) {
      console.error(`[${game.nickname}] Error during poll:`, err.message);
    }
  }
}

// ---- STARTUP -----------------------------------------------

console.log("===========================================");
console.log("  Commercial Break Detector — Starting up");
console.log("===========================================");
console.log(`Watching: ${GAMES_TO_WATCH.map(g => g.nickname).join(", ")}`);
console.log(`Notifications: ntfy.sh/${NTFY_TOPIC}`);
console.log(`Polling every ${POLL_INTERVAL_MS / 1000}s`);
console.log("-------------------------------------------");

// Run immediately, then on an interval
poll();
setInterval(poll, POLL_INTERVAL_MS);
