// ============================================================
//  BACKLIVE SERVER v7 — Fixed MLB "End" detection
// ============================================================
 
const http = require("http");
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || "Lola";
const POLL_MS = 25000;
 
const TEAM_ALIASES = {
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
  "vikings":"minnesota vikings","new york giants":"new york giants",
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
  "florida panthers":"florida panthers","new york rangers":"new york rangers",
};
 
const MLB = ["angels","astros","athletics","blue jays","braves","brewers","cardinals","cubs","diamondbacks","dbacks","dodgers","giants","guardians","mariners","marlins","mets","nationals","orioles","padres","phillies","pirates","rangers","rays","red sox","reds","rockies","royals","tigers","twins","white sox","yankees"];
const NBA = ["76ers","sixers","bucks","bulls","cavaliers","cavs","celtics","clippers","grizzlies","hawks","heat","hornets","jazz","kings","knicks","lakers","magic","mavericks","mavs","nets","nuggets","pacers","pelicans","pistons","raptors","rockets","spurs","suns","thunder","timberwolves","wolves","trail blazers","blazers","warriors","wizards"];
const NFL = ["49ers","bears","bengals","bills","broncos","browns","buccaneers","bucs","chargers","chiefs","colts","commanders","cowboys","dolphins","eagles","falcons","giants","jaguars","jets","lions","packers","panthers","patriots","pats","raiders","rams","ravens","saints","seahawks","steelers","texans","titans","vikings"];
const NHL = ["avalanche","avs","blackhawks","blue jackets","blues","bruins","canadiens","habs","canucks","capitals","caps","coyotes","devils","ducks","flames","flyers","golden knights","knights","hurricanes","canes","islanders","kraken","lightning","bolts","maple leafs","leafs","oilers","penguins","pens","predators","preds","red wings","sabres","senators","sens","sharks","stars","wild","winnipeg jets","florida panthers","new york rangers"];
 
function detectSport(n) {
  n = n.toLowerCase();
  if (MLB.some(t => n.includes(t))) return "baseball/mlb";
  if (NBA.some(t => n.includes(t))) return "basketball/nba";
  if (NFL.some(t => n.includes(t))) return "football/nfl";
  if (NHL.some(t => n.includes(t))) return "hockey/nhl";
  return "baseball/mlb";
}
 
async function fetchGames(sport) {
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard?limit=100`);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return (await r.json()).events || [];
}
 
function findEvent(events, nickname) {
  const nick = nickname.toLowerCase().replace(/ game$/, "").trim();
  const full = TEAM_ALIASES[nick] || nick;
  for (const e of events) {
    const n = (e.name || "").toLowerCase();
    const s = (e.shortName || "").toLowerCase();
    if (n.includes(full) || s.includes(full)) return e;
    const last = full.split(" ").pop();
    if (last.length > 4 && (n.includes(last) || s.includes(last))) return e;
  }
  return null;
}
 
function ord(n) {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}
 
// ============================================================
//  SITUATION EXTRACTOR
// ============================================================
function getSituation(event, sport) {
  const comp = event?.competitions?.[0];
  const status = comp?.status;
  if (!status || status?.type?.state !== "in") return null;
 
  if (sport === "baseball/mlb") {
    const sit = comp?.situation;
    const inning = status?.period || 1;
    const outs = (sit && sit.outs != null) ? sit.outs : null;
    const detail = status?.type?.shortDetail || "";
    const detailLower = detail.toLowerCase();
    const isEnd = detailLower.includes("end");
    const half = detailLower.includes("bot") ? "bottom" : "top";
    const label = isEnd
      ? `End of ${ord(inning)}`
      : `${half === "top" ? "Top" : "Bot"} ${ord(inning)}, ${outs ?? 0} outs`;
    return { sport: "mlb", inning, half, outs, isEnd, detail, label };
  }
 
  if (sport === "basketball/nba") {
    const clock = status.displayClock || "0:00";
    const period = status.period || 1;
    return { sport: "nba", clock, period, label: `${ord(period)} qtr, ${clock}` };
  }
 
  if (sport === "football/nfl") {
    const clock = status.displayClock || "0:00";
    const period = status.period || 1;
    return { sport: "nfl", clock, period, label: `${ord(period)} qtr, ${clock}` };
  }
 
  if (sport === "hockey/nhl") {
    const period = status.period || 1;
    const clock = status.displayClock || "0:00";
    const detail = (status?.type?.shortDetail || "").toLowerCase();
    const intermission = detail.includes("end") || detail.includes("intermission") || clock === "0:00";
    return { sport: "nhl", period, clock, intermission, label: `Period ${period}, ${clock}` };
  }
 
  return null;
}
 
// ============================================================
//  NOTIFICATIONS
// ============================================================
async function notify(topic, title, body) {
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      body,
      headers: {
        "Title": title.replace(/[^\x00-\x7F]/g, "").trim(),
        "Priority": "high",
        "Tags": "sports,tv"
      }
    });
    console.log(`[ntfy:${topic}] ${title}`);
  } catch (e) {
    console.error("ntfy fail:", e.message);
  }
}
 
// ============================================================
//  SESSION STORE
// ============================================================
const sessions = {};
 
function processGame(session, game) {
  const { ntfyTopic } = session;
  const key = game.nickname;
  if (!session.states[key]) session.states[key] = { initialized: false, onCommercial: false };
  const state = session.states[key];
  const sit = game._sit;
  if (!sit) return;
 
  // ---- BASEBALL: uses "End Xth" detail as commercial signal ----
  if (sit.sport === "mlb") {
    if (!state.initialized) {
      state.initialized = true;
      state.lastDetail = sit.detail;
      state.onCommercial = sit.isEnd;
      console.log(`[${key}] Tracking started — ${sit.detail}, commercial=${sit.isEnd}`);
      return;
    }
 
    const detailChanged = sit.detail !== state.lastDetail;
    if (detailChanged) {
      console.log(`[${key}] "${state.lastDetail}" -> "${sit.detail}"`);
      if (sit.isEnd && !state.onCommercial) {
        // Inning just ended — commercial break
        state.onCommercial = true;
        console.log(`[${key}] Commercial started`);
      } else if (!sit.isEnd && state.onCommercial) {
        // New half inning — game is back!
        const half = sit.half === "top" ? "Top" : "Bottom";
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${half} of the ${ord(sit.inning)} starting.`);
        state.onCommercial = false;
        console.log(`[${key}] BACK LIVE`);
      }
      state.lastDetail = sit.detail;
    } else {
      console.log(`[${key}] ${sit.label} — ${state.onCommercial ? "commercial" : "live"}`);
    }
  }
 
  // ---- NBA / NFL: frozen clock detection ----
  else if (sit.sport === "nba" || sit.sport === "nfl") {
    const threshold = sit.sport === "nba" ? 120000 : 90000;
    const now = Date.now();
    if (!state.initialized) {
      state.initialized = true;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
      state.onCommercial = false;
      console.log(`[${key}] Tracking started — ${sit.label}`);
      return;
    }
    const clockMoved = sit.clock !== state.lastClock || sit.period !== state.lastPeriod;
    if (clockMoved) {
      if (state.onCommercial) {
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${ord(sit.period)}, ${sit.clock} left.`);
        console.log(`[${key}] BACK LIVE`);
      }
      state.onCommercial = false;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
      console.log(`[${key}] ${sit.label}`);
    } else {
      const frozen = now - state.lastChangedAt;
      if (frozen >= threshold && !state.onCommercial) {
        state.onCommercial = true;
        console.log(`[${key}] Commercial (frozen ${Math.round(frozen / 1000)}s)`);
      } else {
        console.log(`[${key}] ${sit.label} frozen ${Math.round(frozen / 1000)}s`);
      }
    }
  }
 
  // ---- NHL: between periods ----
  else if (sit.sport === "nhl") {
    if (!state.initialized) {
      state.initialized = true;
      state.lastPeriod = sit.period;
      state.onCommercial = sit.intermission;
      console.log(`[${key}] Tracking started — Period ${sit.period}, intermission=${sit.intermission}`);
      return;
    }
    const periodChanged = sit.period !== state.lastPeriod;
    if (periodChanged && state.onCommercial) {
      notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${ord(sit.period)} period starting.`);
      state.onCommercial = false;
      console.log(`[${key}] BACK LIVE`);
    } else if (sit.intermission && !state.onCommercial) {
      state.onCommercial = true;
      console.log(`[${key}] Intermission`);
    } else if (!sit.intermission) {
      state.onCommercial = false;
      console.log(`[${key}] ${sit.label}`);
    }
    state.lastPeriod = sit.period;
  }
 
  game.status = state.onCommercial ? "commercial" : "live";
}
 
// ============================================================
//  MAIN POLL
// ============================================================
async function pollAll() {
  for (const [id, session] of Object.entries(sessions)) {
    for (const game of session.games) {
      try {
        if (!game.sport) game.sport = detectSport(game.nickname);
        const events = await fetchGames(game.sport);
 
        if (!game.espnId) {
          const event = findEvent(events, game.nickname);
          if (!event) { game.status = "not started"; game._sit = null; continue; }
          game.espnId = event.id;
          game.fullName = event.name;
          console.log(`[${id}] Locked: ${event.name}`);
        }
 
        const event = events.find(e => e.id === game.espnId);
        if (!event) {
          game.status = "final"; game._sit = null; game.espnId = null;
          console.log(`[${game.nickname}] Game ended`);
          continue;
        }
 
        const comp = event?.competitions?.[0];
        const status = comp?.status;
        const rawSit = comp?.situation;
        console.log(`[${game.nickname}] state=${status?.type?.state} detail="${status?.type?.shortDetail}" outs=${rawSit?.outs ?? "none"}`);
 
        const sit = getSituation(event, game.sport);
        if (!sit) { game.status = "not started"; game._sit = null; continue; }
 
        game._sit = sit;
        game.detail = sit.label;
        processGame(session, game);
 
      } catch (e) {
        console.error(`[${id}/${game.nickname}]`, e.message);
        game.status = "error";
      }
    }
  }
}
 
setInterval(pollAll, POLL_MS);
pollAll();
 
// ============================================================
//  HTTP SERVER
// ============================================================
function jsonRes(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(data));
}
 
function readBody(req) {
  return new Promise(res => {
    let d = "";
    req.on("data", c => d += c);
    req.on("end", () => { try { res(JSON.parse(d)); } catch { res({}); } });
  });
}
 
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { jsonRes(res, 200, {}); return; }
 
  if (req.method === "POST" && url.pathname === "/start") {
    const { ntfyTopic, games, key } = await readBody(req);
if (key !== SECRET_KEY) { jsonRes(res, 401, { error: "Unauthorized" }); return; }
    if (!ntfyTopic || !games?.length) { jsonRes(res, 400, { error: "Missing ntfyTopic or games" }); return; }
    sessions[ntfyTopic] = {
      ntfyTopic,
      games: games.map(n => ({ nickname: n, espnId: null, sport: null, status: "searching", detail: "", fullName: "", _sit: null })),
      states: {}
    };
    notify(ntfyTopic, "BackLive is watching!", `Tracking: ${games.join(", ")}`);
    console.log(`[${ntfyTopic}] Started: ${games.join(", ")}`);
    jsonRes(res, 200, { ok: true });
    return;
  }
 
  if (req.method === "GET" && url.pathname === "/status") {
    const id = url.searchParams.get("session");
    const s = sessions[id];
    if (!s) { jsonRes(res, 404, { error: "No session" }); return; }
    jsonRes(res, 200, { games: s.games.map(g => ({ nickname: g.nickname, fullName: g.fullName, status: g.status, detail: g.detail })) });
    return;
  }
 
  if (req.method === "POST" && url.pathname === "/stop") {
    const { ntfyTopic } = await readBody(req);
    delete sessions[ntfyTopic];
    jsonRes(res, 200, { ok: true });
    return;
  }
 
  jsonRes(res, 404, { error: "Not found" });
 
}).listen(PORT, () => {
  console.log(`BackLive v7 running on port ${PORT}`);
});
 
