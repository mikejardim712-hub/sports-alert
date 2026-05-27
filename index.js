// ============================================================
//  COMMERCIAL BREAK DETECTOR — Baseball Edition
//  Uses inning + outs to detect between-half-inning breaks
// ============================================================

const NTFY_TOPIC = process.env.NTFY_TOPIC || process.env.NTFY_TOPIC;
const POLL_INTERVAL_MS = 20_000; // 20 seconds — pitches happen fast

// ---- TEAM NAME MAP -----------------------------------------
const TEAM_ALIASES = {
  "marlins":      "miami marlins",
  "blue jays":    "toronto blue jays",
  "bluejays":     "toronto blue jays",
  "nationals":    "washington nationals",
  "guardians":    "cleveland guardians",
  "yankees":      "new york yankees",
  "red sox":      "boston red sox",
  "dodgers":      "los angeles dodgers",
  "cubs":         "chicago cubs",
  "mets":         "new york mets",
  "braves":       "atlanta braves",
  "astros":       "houston astros",
  "phillies":     "philadelphia phillies",
  "cardinals":    "st. louis cardinals",
  "giants":       "san francisco giants",
  "padres":       "san diego padres",
  "brewers":      "milwaukee brewers",
  "pirates":      "pittsburgh pirates",
  "reds":         "cincinnati reds",
  "rockies":      "colorado rockies",
  "diamondbacks": "arizona diamondbacks",
  "angels":       "los angeles angels",
  "athletics":    "oakland athletics",
  "mariners":     "seattle mariners",
  "rangers":      "texas rangers",
  "twins":        "minnesota twins",
  "tigers":       "detroit tigers",
  "royals":       "kansas city royals",
  "white sox":    "chicago white sox",
  "orioles":      "baltimore orioles",
  "rays":         "tampa bay rays",
};

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

  console.log(`[${nickname}] Looking for: "${fullName}" among ${events.length} games`);

  for (const event of events) {
    const eventName = (event.name || "").toLowerCase();
    const shortName = (event.shortName || "").toLowerCase();
    console.log(`  → ESPN has: ${event.name} (${event.status?.type?.description})`);

    if (eventName.includes(fullName) || shortName.includes(fullName)) return event;

    const words = fullName.split(" ");
    const lastWord = words[words.length - 1];
    if (lastWord.length > 4 && (eventName.includes(lastWord) || shortName.includes(lastWord))) return event;
  }
  return null;
}

// ---- BASEBALL SITUATION EXTRACTION -------------------------
function extractBaseballSituation(event) {
  const competition = event?.competitions?.[0];
  const status = competition?.status;
  if (!status) return null;

  const state = status?.type?.state;
  if (state !== "in") {
    console.log(`  → Not in progress (state: "${state}")`);
    return null;
  }

  const situation = competition?.situation;
  const inning = status?.period || 1;
  const outs = situation?.outs ?? null;
  const detail = status?.type?.shortDetail || "";
  const isTop = detail.toLowerCase().includes("top");
  const isBot = detail.toLowerCase().includes("bot");
  const halfInning = isTop ? "top" : isBot ? "bottom" : "top";

  console.log(`  → ${halfInning} ${inning}, Outs: ${outs}, Detail: "${detail}"`);

  return { inning, halfInning, outs, detail };
}

// ---- STATE & NOTIFICATION ----------------------------------
const gameState = {};

async function sendNotification(title, message) {
  console.log(`[NOTIFY] ${title} — ${message}`);
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      body: message,
      headers: {
        "Title": title,
        "Priority": "high",
        "Tags": "sports,baseball",
      },
    });
  } catch (err) {
    console.error("Notification failed:", err.message);
  }
}

function ordinal(n) {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

function checkBaseballSituation(gameId, nickname, sit) {
  const state = gameState[gameId];

  if (!state) {
    gameState[gameId] = {
      lastInning: sit.inning,
      lastHalfInning: sit.halfInning,
      lastOuts: sit.outs,
      isOnCommercial: false,
    };
    console.log(`[${nickname}] ✅ Tracking started — ${sit.halfInning} ${ordinal(sit.inning)}, ${sit.outs} outs`);
    return;
  }

  const halfInningChanged =
    sit.inning !== state.lastInning || sit.halfInning !== state.lastHalfInning;

  // Between half-innings: outs will be null or 3
  const isBreak = sit.outs === null || sit.outs >= 3;

  // Back live: half-inning just flipped and outs reset to 0 or 1
  const backLive = halfInningChanged && (sit.outs === 0 || sit.outs === 1);

  if (backLive && state.isOnCommercial) {
    const half = sit.halfInning === "top" ? "Top" : "Bottom";
    sendNotification(
      "⚾ Game is back live!",
      `${nickname} is back! ${half} of the ${ordinal(sit.inning)} is starting.`
    );
    console.log(`[${nickname}] ✅ BACK LIVE — ${sit.halfInning} ${ordinal(sit.inning)}`);
    state.isOnCommercial = false;
  } else if (isBreak && !state.isOnCommercial) {
    console.log(`[${nickname}] 📺 Commercial break — between half-innings`);
    state.isOnCommercial = true;
  } else if (!isBreak) {
    console.log(`[${nickname}] ▶ Live — ${sit.halfInning} ${ordinal(sit.inning)}, ${sit.outs} out(s)`);
    state.isOnCommercial = false;
  } else {
    console.log(`[${nickname}] 📺 Still on commercial...`);
  }

  state.lastInning = sit.inning;
  state.lastHalfInning = sit.halfInning;
  state.lastOuts = sit.outs;
}

// ---- GAMES TO WATCH ----------------------------------------
// Change these to whatever games you're watching!
const GAMES_TO_WATCH = [
  { nickname: "Phillies game", sport: "baseball/mlb", espnGameId: null },
  { nickname: "Rays game",   sport: "baseball/mlb", espnGameId: null },
];

// ---- MAIN POLL ---------------------------------------------
async function poll() {
  console.log("\n--- Poll:", new Date().toLocaleTimeString(), "---");

  for (const game of GAMES_TO_WATCH) {
    try {
      const events = await fetchLiveGames(game.sport);

      if (!game.espnGameId) {
        const event = findMatchingEvent(events, game.nickname);
        if (event) {
          game.espnGameId = event.id;
          console.log(`[${game.nickname}] 🔒 Locked: ${event.name}`);
        } else {
          console.log(`[${game.nickname}] Not found yet.`);
          continue;
        }
      }

      const event = events.find(e => e.id === game.espnGameId);
      if (!event) {
        console.log(`[${game.nickname}] Game ended or dropped.`);
        game.espnGameId = null;
        continue;
      }

      const sit = extractBaseballSituation(event);
      if (!sit) {
        console.log(`[${game.nickname}] Not currently in progress.`);
        continue;
      }

      checkBaseballSituation(game.espnGameId, game.nickname, sit);

    } catch (err) {
      console.error(`[${game.nickname}] Error:`, err.message);
    }
  }
}

// ---- START -------------------------------------------------
console.log("============================================");
console.log("  Commercial Break Detector — Baseball v3");
console.log("============================================");
console.log(`Watching: ${GAMES_TO_WATCH.map(g => g.nickname).join(", ")}`);
console.log(`Notifications → ntfy.sh/${NTFY_TOPIC}`);
console.log("--------------------------------------------");

poll();
setInterval(poll, POLL_INTERVAL_MS);
