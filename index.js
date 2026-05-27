// ============================================================
//  COMMERCIAL BREAK DETECTOR — Multi-User Server v5
//  Accepts requests from the webpage to watch games per user
// ============================================================

const http = require("http");

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = 20_000;

// ============================================================
//  TEAM ALIASES
// ============================================================
const TEAM_ALIASES = {
  // MLB
  "angels":"los angeles angels","astros":"houston astros","athletics":"oakland athletics",
  "blue jays":"toronto blue jays","bluejays":"toronto blue jays","braves":"atlanta braves",
  "brewers":"milwaukee brewers","cardinals":"st. louis cardinals","cubs":"chicago cubs",
  "diamondbacks":"arizona diamondbacks","dbacks":"arizona diamondbacks","dodgers":"los angeles dodgers",
  "giants":"san francisco giants","guardians":"cleveland guardians","mariners":"seattle mariners",
  "marlins":"miami marlins","mets":"new york mets","nationals":"washington nationals",
  "orioles":"baltimore orioles","padres":"san diego padres","phillies":"philadelphia phillies",
  "pirates":"pittsburgh pirates","rangers":"texas rangers","rays":"tampa bay rays",
  "red sox":"boston red sox","redsox":"boston red sox","reds":"cincinnati reds",
  "rockies":"colorado rockies","royals":"kansas city royals","tigers":"detroit tigers",
  "twins":"minnesota twins","white sox":"chicago white sox","whitesox":"chicago white sox",
  "yankees":"new york yankees",
  // NBA
  "76ers":"philadelphia 76ers","sixers":"philadelphia 76ers","bucks":"milwaukee bucks",
  "bulls":"chicago bulls","cavaliers":"cleveland cavaliers","cavs":"cleveland cavaliers",
  "celtics":"boston celtics","clippers":"los angeles clippers","grizzlies":"memphis grizzlies",
  "hawks":"atlanta hawks","heat":"miami heat","hornets":"charlotte hornets","jazz":"utah jazz",
  "kings":"sacramento kings","knicks":"new york knicks","lakers":"los angeles lakers",
  "magic":"orlando magic","mavericks":"dallas mavericks","mavs":"dallas mavericks",
  "nets":"brooklyn nets","nuggets":"denver nuggets","pacers":"indiana pacers",
  "pelicans":"new orleans pelicans","pistons":"detroit pistons","raptors":"toronto raptors",
  "rockets":"houston rockets","spurs":"san antonio spurs","suns":"phoenix suns",
  "thunder":"oklahoma city thunder","timberwolves":"minnesota timberwolves","wolves":"minnesota timberwolves",
  "trail blazers":"portland trail blazers","blazers":"portland trail blazers",
  "warriors":"golden state warriors","wizards":"washington wizards",
  // NFL
  "49ers":"san francisco 49ers","bears":"chicago bears","bengals":"cincinnati bengals",
  "bills":"buffalo bills","broncos":"denver broncos","browns":"cleveland browns",
  "buccaneers":"tampa bay buccaneers","bucs":"tampa bay buccaneers","cardinals":"arizona cardinals",
  "chargers":"los angeles chargers","chiefs":"kansas city chiefs","colts":"indianapolis colts",
  "commanders":"washington commanders","cowboys":"dallas cowboys","dolphins":"miami dolphins",
  "eagles":"philadelphia eagles","falcons":"atlanta falcons","jaguars":"jacksonville jaguars",
  "jags":"jacksonville jaguars","jets":"new york jets","lions":"detroit lions",
  "packers":"green bay packers","panthers":"carolina panthers","patriots":"new england patriots",
  "pats":"new england patriots","raiders":"las vegas raiders","rams":"los angeles rams",
  "ravens":"baltimore ravens","saints":"new orleans saints","seahawks":"seattle seahawks",
  "steelers":"pittsburgh steelers","texans":"houston texans","titans":"tennessee titans",
  "vikings":"minnesota vikings",
  // NHL
  "avalanche":"colorado avalanche","avs":"colorado avalanche","blackhawks":"chicago blackhawks",
  "blue jackets":"columbus blue jackets","blues":"st. louis blues","bruins":"boston bruins",
  "canadiens":"montreal canadiens","habs":"montreal canadiens","canucks":"vancouver canucks",
  "capitals":"washington capitals","caps":"washington capitals","coyotes":"arizona coyotes",
  "devils":"new jersey devils","ducks":"anaheim ducks","flames":"calgary flames",
  "flyers":"philadelphia flyers","golden knights":"vegas golden knights","knights":"vegas golden knights",
  "hurricanes":"carolina hurricanes","canes":"carolina hurricanes","islanders":"new york islanders",
  "kraken":"seattle kraken","lightning":"tampa bay lightning","bolts":"tampa bay lightning",
  "maple leafs":"toronto maple leafs","leafs":"toronto maple leafs","oilers":"edmonton oilers",
  "penguins":"pittsburgh penguins","pens":"pittsburgh penguins","predators":"nashville predators",
  "preds":"nashville predators","red wings":"detroit red wings","sabres":"buffalo sabres",
  "senators":"ottawa senators","sens":"ottawa senators","sharks":"san jose sharks",
  "stars":"dallas stars","wild":"minnesota wild","winnipeg jets":"winnipeg jets",
};

const MLB_TEAMS  = ["angels","astros","athletics","blue jays","braves","brewers","cardinals","cubs","diamondbacks","dbacks","dodgers","giants","guardians","mariners","marlins","mets","nationals","orioles","padres","phillies","pirates","rangers","rays","red sox","reds","rockies","royals","tigers","twins","white sox","yankees"];
const NBA_TEAMS  = ["76ers","sixers","bucks","bulls","cavaliers","cavs","celtics","clippers","grizzlies","hawks","heat","hornets","jazz","kings","knicks","lakers","magic","mavericks","mavs","nets","nuggets","pacers","pelicans","pistons","raptors","rockets","spurs","suns","thunder","timberwolves","wolves","trail blazers","blazers","warriors","wizards"];
const NFL_TEAMS  = ["49ers","bears","bengals","bills","broncos","browns","buccaneers","bucs","chargers","chiefs","colts","commanders","cowboys","dolphins","eagles","falcons","jaguars","jags","jets","lions","packers","panthers","patriots","pats","raiders","rams","ravens","saints","seahawks","steelers","texans","titans","vikings"];
const NHL_TEAMS  = ["avalanche","avs","blackhawks","blue jackets","blues","bruins","canadiens","habs","canucks","capitals","caps","coyotes","devils","ducks","flames","flyers","golden knights","knights","hurricanes","canes","islanders","kraken","lightning","bolts","maple leafs","leafs","oilers","penguins","pens","predators","preds","red wings","sabres","senators","sens","sharks","stars","wild","winnipeg jets"];

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
  if (!res.ok) throw new Error(`ESPN error: ${res.status}`);
  const json = await res.json();
  return json.events || [];
}

function findMatchingEvent(events, nickname) {
  const nick = nickname.toLowerCase().replace(" game","").trim();
  const fullName = TEAM_ALIASES[nick] || nick;
  for (const event of events) {
    const name = (event.name || "").toLowerCase();
    const short = (event.shortName || "").toLowerCase();
    if (name.includes(fullName) || short.includes(fullName)) return event;
    const lastWord = fullName.split(" ").pop();
    if (lastWord.length > 4 && (name.includes(lastWord) || short.includes(lastWord))) return event;
  }
  return null;
}

// ============================================================
//  SITUATION EXTRACTORS
// ============================================================
function extractBaseball(event) {
  const comp = event?.competitions?.[0];
  const status = comp?.status;
  if (!status || status?.type?.state !== "in") return null;
  const sit = comp?.situation;
  const inning = status?.period || 1;
  const outs = sit?.outs ?? null;
  const detail = status?.type?.shortDetail || "";
  const halfInning = detail.toLowerCase().includes("bot") ? "bottom" : "top";
  return { sport:"mlb", inning, halfInning, outs };
}

function extractClock(event, sportKey) {
  const comp = event?.competitions?.[0];
  const status = comp?.status;
  if (!status || status?.type?.state !== "in") return null;
  return { sport: sportKey, clock: status.displayClock || "0:00", period: status.period || 1 };
}

function extractHockey(event) {
  const comp = event?.competitions?.[0];
  const status = comp?.status;
  if (!status || status?.type?.state !== "in") return null;
  const period = status.period || 1;
  const clock = status.displayClock || "0:00";
  const detail = (status?.type?.shortDetail || "").toLowerCase();
  const isIntermission = detail.includes("end") || detail.includes("intermission") || clock === "0:00";
  return { sport:"nhl", period, clock, isIntermission };
}

function extractSituation(event, sport) {
  if (sport === "baseball/mlb")   return extractBaseball(event);
  if (sport === "basketball/nba") return extractClock(event, "nba");
  if (sport === "football/nfl")   return extractClock(event, "nfl");
  if (sport === "hockey/nhl")     return extractHockey(event);
  return null;
}

// ============================================================
//  NOTIFICATIONS
// ============================================================
async function sendNotification(ntfyTopic, title, message) {
  try {
    await fetch(`https://ntfy.sh/${ntfyTopic}`, {
      method: "POST",
      body: message,
      headers: {
        "Title": title.replace(/[^\x00-\x7F]/g, "").trim(),
        "Priority": "high",
        "Tags": "sports,tv",
      },
    });
    console.log(`[ntfy:${ntfyTopic}] Sent: ${title}`);
  } catch (err) {
    console.error(`[ntfy:${ntfyTopic}] Failed:`, err.message);
  }
}

// ============================================================
//  PER-USER GAME STATE
//  sessions = { sessionId: { ntfyTopic, games: [...], gameStates: {} } }
// ============================================================
const sessions = {};

function ordinal(n) {
  if (n===1) return "1st"; if (n===2) return "2nd"; if (n===3) return "3rd"; return `${n}th`;
}

function checkBaseball(gs, nickname, sit, ntfyTopic) {
  if (!gs.last) {
    gs.last = { inning: sit.inning, halfInning: sit.halfInning, outs: sit.outs, isOnCommercial: false };
    return;
  }
  const s = gs.last;
  const halfChanged = sit.inning !== s.inning || sit.halfInning !== s.halfInning;
  const isBreak = sit.outs === null || sit.outs >= 3;
  const backLive = halfChanged && (sit.outs === 0 || sit.outs === 1);
  if (backLive && s.isOnCommercial) {
    const half = sit.halfInning === "top" ? "Top" : "Bottom";
    sendNotification(ntfyTopic, "Game is back!", `${nickname} is back — ${half} of the ${ordinal(sit.inning)} starting.`);
    s.isOnCommercial = false;
  } else if (isBreak && !s.isOnCommercial) {
    s.isOnCommercial = true;
  } else if (!isBreak) {
    s.isOnCommercial = false;
  }
  s.inning = sit.inning; s.halfInning = sit.halfInning; s.outs = sit.outs;
}

function checkClock(gs, nickname, sit, thresholdSec, emoji, ntfyTopic) {
  const now = new Date();
  if (!gs.last) {
    gs.last = { clock: sit.clock, changedAt: now, period: sit.period, isOnCommercial: false };
    return;
  }
  const s = gs.last;
  const changed = sit.clock !== s.clock || sit.period !== s.period;
  if (changed) {
    if (s.isOnCommercial) {
      sendNotification(ntfyTopic, "Game is back!", `${nickname} is back — ${ordinal(sit.period)} period, ${sit.clock} left.`);
    }
    s.isOnCommercial = false;
    s.clock = sit.clock; s.changedAt = now; s.period = sit.period;
  } else {
    const frozen = Math.floor((now - s.changedAt) / 1000);
    if (frozen >= thresholdSec && !s.isOnCommercial) s.isOnCommercial = true;
  }
}

function checkHockey(gs, nickname, sit, ntfyTopic) {
  if (!gs.last) {
    gs.last = { period: sit.period, isOnCommercial: sit.isIntermission };
    return;
  }
  const s = gs.last;
  const periodChanged = sit.period !== s.period;
  if (periodChanged && s.isOnCommercial) {
    sendNotification(ntfyTopic, "Game is back!", `${nickname} is back — ${ordinal(sit.period)} period starting.`);
    s.isOnCommercial = false;
  } else if (sit.isIntermission && !s.isOnCommercial) {
    s.isOnCommercial = true;
  } else if (!sit.isIntermission) {
    s.isOnCommercial = false;
  }
  s.period = sit.period;
}

function getGameStatus(gs, sit) {
  if (!gs.last) return "searching";
  if (gs.last.isOnCommercial) return "commercial";
  return "live";
}

// ============================================================
//  POLL — runs for all active sessions
// ============================================================
async function pollAll() {
  for (const [sessionId, session] of Object.entries(sessions)) {
    for (const game of session.games) {
      try {
        if (!game.sport) game.sport = detectSport(game.nickname);
        const events = await fetchLiveGames(game.sport);
        if (!game.espnGameId) {
          const event = findMatchingEvent(events, game.nickname);
          if (event) { game.espnGameId = event.id; game.fullName = event.name; }
          else { game.status = "not found"; continue; }
        }
        const event = events.find(e => e.id === game.espnGameId);
        if (!event) { game.status = "ended"; game.espnGameId = null; continue; }
        const sit = extractSituation(event, game.sport);
        if (!sit) { game.status = "not started"; continue; }
        const gsKey = `${sessionId}_${game.nickname}`;
        if (!session.gameStates[gsKey]) session.gameStates[gsKey] = {};
        const gs = session.gameStates[gsKey];
        if (sit.sport === "mlb") checkBaseball(gs, game.nickname, sit, session.ntfyTopic);
        if (sit.sport === "nba") checkClock(gs, game.nickname, sit, 120, "B-ball", session.ntfyTopic);
        if (sit.sport === "nfl") checkClock(gs, game.nickname, sit, 90, "Football", session.ntfyTopic);
        if (sit.sport === "nhl") checkHockey(gs, game.nickname, sit, session.ntfyTopic);
        game.status = gs.last?.isOnCommercial ? "commercial" : "live";
        game.detail = sit.sport === "mlb"
          ? `${sit.halfInning === "top" ? "Top" : "Bot"} ${ordinal(sit.inning)}, ${sit.outs ?? 3} outs`
          : sit.sport === "nhl"
          ? `Period ${sit.period}, ${sit.clock}`
          : `${ordinal(sit.period)}, ${sit.clock}`;
      } catch (err) {
        console.error(`[${sessionId}/${game.nickname}]`, err.message);
        game.status = "error";
      }
    }
  }
}

setInterval(pollAll, POLL_INTERVAL_MS);

// ============================================================
//  HTTP SERVER — handles requests from the webpage
// ============================================================
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { sendJSON(res, 200, {}); return; }

  const url = new URL(req.url, `http://localhost`);

  // POST /start — begin watching games for a user
  // Body: { ntfyTopic, games: ["Phillies", "Padres"] }
  if (req.method === "POST" && url.pathname === "/start") {
    const body = await readBody(req);
    const { ntfyTopic, games } = body;
    if (!ntfyTopic || !games || games.length === 0) {
      sendJSON(res, 400, { error: "ntfyTopic and games are required" }); return;
    }
    const sessionId = ntfyTopic; // use ntfyTopic as session key (unique per user)
    sessions[sessionId] = {
      ntfyTopic,
      games: games.map(name => ({ nickname: name, espnGameId: null, sport: null, status: "searching", detail: "" })),
      gameStates: {},
      startedAt: new Date().toISOString(),
    };
    await sendNotification(ntfyTopic, "BackLive started!", `Now watching: ${games.join(", ")}`);
    console.log(`[${sessionId}] Session started for: ${games.join(", ")}`);
    sendJSON(res, 200, { ok: true, sessionId, message: `Watching ${games.join(", ")}` });
    return;
  }

  // GET /status?session=TOPIC — get current game statuses
  if (req.method === "GET" && url.pathname === "/status") {
    const sessionId = url.searchParams.get("session");
    const session = sessions[sessionId];
    if (!session) { sendJSON(res, 404, { error: "Session not found" }); return; }
    sendJSON(res, 200, { games: session.games, startedAt: session.startedAt });
    return;
  }

  // POST /stop — stop watching
  if (req.method === "POST" && url.pathname === "/stop") {
    const body = await readBody(req);
    const { ntfyTopic } = body;
    if (sessions[ntfyTopic]) { delete sessions[ntfyTopic]; }
    sendJSON(res, 200, { ok: true });
    return;
  }

  sendJSON(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log("============================================");
  console.log("  BackLive Server — Multi-User v5");
  console.log(`  Listening on port ${PORT}`);
  console.log("============================================");
});
