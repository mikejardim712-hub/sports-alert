// ============================================================
//  BACKLIVE SERVER v10 — Persistent Spotify tokens
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const POLL_MS = 25000;
const SECRET_KEY = process.env.SECRET_KEY || "Lola";
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "b9f103fdac944282ba3f56a03c866606";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "3007ce1e51a74d08ad91800025b0ce6d";
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || "https://sports-alert-production.up.railway.app/spotify/callback";

// ============================================================
//  PERSISTENT TOKEN STORE
//  Saves to /tmp/spotify_tokens.json so tokens survive restarts
// ============================================================
const TOKENS_FILE = path.join("/tmp", "spotify_tokens.json");

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
      console.log(`Loaded ${Object.keys(data).length} Spotify token(s) from disk`);
      return data;
    }
  } catch (e) { console.error("Error loading tokens:", e.message); }
  return {};
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(spotifyTokens, null, 2));
  } catch (e) { console.error("Error saving tokens:", e.message); }
}

const spotifyTokens = loadTokens();

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
  "vikings":"minnesota vikings","new york giants":"new york giants",
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
  "florida panthers":"florida panthers","new york rangers":"new york rangers",
  // World Cup / Soccer
  "usa":"united states","united states":"united states","usmnt":"united states",
  "mexico":"mexico","canada":"canada","argentina":"argentina","brazil":"brazil",
  "france":"france","england":"england","spain":"spain","portugal":"portugal",
  "germany":"germany","netherlands":"netherlands","holland":"netherlands",
  "belgium":"belgium","croatia":"croatia","uruguay":"uruguay","switzerland":"switzerland",
  "denmark":"denmark","japan":"japan","south korea":"south korea","korea":"south korea",
  "morocco":"morocco","senegal":"senegal","australia":"australia","poland":"poland",
  "serbia":"serbia","ecuador":"ecuador","cameroon":"cameroon","ghana":"ghana",
  "tunisia":"tunisia","iran":"iran","saudi arabia":"saudi arabia","qatar":"qatar",
  "costa rica":"costa rica","panama":"panama","wales":"wales","albania":"albania",
  "slovenia":"slovenia","slovakia":"slovakia","georgia":"georgia","turkey":"turkey",
  "colombia":"colombia","venezuela":"venezuela","bolivia":"bolivia","chile":"chile",
  "peru":"peru","paraguay":"paraguay","honduras":"honduras","uzbekistan":"uzbekistan",
  "jordan":"jordan","cabo verde":"cabo verde","curacao":"curacao","austria":"austria",
  "ukraine":"ukraine","nigeria":"nigeria","egypt":"egypt","ivory coast":"ivory coast",
  "mali":"mali","south africa":"south africa","new zealand":"new zealand",
  "jamaica":"jamaica","guatemala":"guatemala","el salvador":"el salvador",
};

const MLB = ["angels","astros","athletics","blue jays","braves","brewers","cardinals","cubs","diamondbacks","dbacks","dodgers","giants","guardians","mariners","marlins","mets","nationals","orioles","padres","phillies","pirates","rangers","rays","red sox","reds","rockies","royals","tigers","twins","white sox","yankees"];
const NBA = ["76ers","sixers","bucks","bulls","cavaliers","cavs","celtics","clippers","grizzlies","hawks","heat","hornets","jazz","kings","knicks","lakers","magic","mavericks","mavs","nets","nuggets","pacers","pelicans","pistons","raptors","rockets","spurs","suns","thunder","timberwolves","wolves","trail blazers","blazers","warriors","wizards"];
const NFL = ["49ers","bears","bengals","bills","broncos","browns","buccaneers","bucs","chargers","chiefs","colts","commanders","cowboys","dolphins","eagles","falcons","giants","jaguars","jets","lions","packers","panthers","patriots","pats","raiders","rams","ravens","saints","seahawks","steelers","texans","titans","vikings"];
const NHL = ["avalanche","avs","blackhawks","blue jackets","blues","bruins","canadiens","habs","canucks","capitals","caps","coyotes","devils","ducks","flames","flyers","golden knights","knights","hurricanes","canes","islanders","kraken","lightning","bolts","maple leafs","leafs","oilers","penguins","pens","predators","preds","red wings","sabres","senators","sens","sharks","stars","wild","winnipeg jets","florida panthers","new york rangers"];
const SOCCER = ["usa","united states","usmnt","mexico","canada","argentina","brazil","france","england","spain","portugal","germany","netherlands","holland","belgium","croatia","uruguay","switzerland","denmark","japan","south korea","korea","morocco","senegal","australia","poland","serbia","ecuador","cameroon","ghana","tunisia","iran","saudi arabia","qatar","costa rica","panama","wales","albania","slovenia","slovakia","georgia","turkey","colombia","venezuela","bolivia","chile","peru","paraguay","honduras","uzbekistan","jordan","cabo verde","curacao","austria","ukraine","nigeria","egypt","ivory coast","mali","south africa","new zealand","jamaica","guatemala","el salvador"];

function detectSport(n) {
  n = n.toLowerCase();
  if (MLB.some(t => n.includes(t))) return "baseball/mlb";
  if (NBA.some(t => n.includes(t))) return "basketball/nba";
  if (NFL.some(t => n.includes(t))) return "football/nfl";
  if (NHL.some(t => n.includes(t))) return "hockey/nhl";
  if (SOCCER.some(t => n.includes(t))) return "soccer/fifa.world";
  return "baseball/mlb";
}

// ============================================================
//  ESPN API
// ============================================================
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
//  SITUATION EXTRACTORS
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
    const isEnd = detail.toLowerCase().includes("end");
    const half = detail.toLowerCase().includes("bot") ? "bottom" : "top";
    const label = isEnd ? `End of ${ord(inning)}` : `${half === "top" ? "Top" : "Bot"} ${ord(inning)}, ${outs ?? 0} outs`;
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
  if (sport === "soccer/fifa.world") {
    const clock = status.displayClock || "0:00";
    const period = status.period || 1;
    const detail = status?.type?.shortDetail || "";
    const isHalftime = detail.toLowerCase().includes("ht") || detail.toLowerCase().includes("half time") || detail.toLowerCase().includes("halftime");
    const half = period <= 1 ? "1st Half" : period === 2 ? "2nd Half" : `Extra Time`;
    const label = isHalftime ? "Halftime" : `${half}, ${clock}`;
    return { sport: "soccer", period, clock, isHalftime, detail, label };
  }
  return null;
}

// ============================================================
//  NOTIFICATIONS
// ============================================================
async function notify(topic, title, body) {
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST", body,
      headers: {
        "Title": title.replace(/[^\x00-\x7F]/g, "").trim(),
        "Priority": "high", "Tags": "sports,tv"
      }
    });
    console.log(`[ntfy:${topic}] ${title}`);
  } catch (e) { console.error("ntfy fail:", e.message); }
}

// ============================================================
//  SPOTIFY
// ============================================================
async function refreshSpotifyToken(ntfyTopic) {
  const tokens = spotifyTokens[ntfyTopic];
  if (!tokens?.refreshToken) return null;
  try {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken })
    });
    const data = await r.json();
    if (data.access_token) {
      tokens.accessToken = data.access_token;
      tokens.expiresAt = Date.now() + (data.expires_in * 1000);
      saveTokens(); // persist after refresh
      return data.access_token;
    }
  } catch (e) { console.error("Spotify refresh error:", e.message); }
  return null;
}

async function getSpotifyToken(ntfyTopic) {
  const tokens = spotifyTokens[ntfyTopic];
  if (!tokens) return null;
  if (Date.now() > (tokens.expiresAt - 60000)) return await refreshSpotifyToken(ntfyTopic);
  return tokens.accessToken;
}

async function spotifyPause(ntfyTopic) {
  const token = await getSpotifyToken(ntfyTopic);
  if (!token) return;
  try {
    await fetch("https://api.spotify.com/v1/me/player/pause", {
      method: "PUT", headers: { "Authorization": `Bearer ${token}` }
    });
    console.log(`[spotify:${ntfyTopic}] Paused`);
  } catch (e) { console.error("Spotify pause:", e.message); }
}

async function spotifyResume(ntfyTopic) {
  const token = await getSpotifyToken(ntfyTopic);
  if (!token) return;
  try {
    await fetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT", headers: { "Authorization": `Bearer ${token}` }
    });
    console.log(`[spotify:${ntfyTopic}] Resumed`);
  } catch (e) { console.error("Spotify resume:", e.message); }
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

  const wasOnCommercial = state.onCommercial;

  // ---- MLB ----
  if (sit.sport === "mlb") {
    if (!state.initialized) {
      state.initialized = true;
      state.lastDetail = sit.detail;
      state.onCommercial = sit.isEnd;
      console.log(`[${key}] Tracking — ${sit.detail}`);
      return;
    }
    if (sit.detail !== state.lastDetail) {
      console.log(`[${key}] "${state.lastDetail}" -> "${sit.detail}"`);
      if (sit.isEnd && !state.onCommercial) {
        state.onCommercial = true;
        console.log(`[${key}] Commercial`);
      } else if (!sit.isEnd && state.onCommercial) {
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${sit.half === "top" ? "Top" : "Bottom"} of the ${ord(sit.inning)} starting.`);
        state.onCommercial = false;
        console.log(`[${key}] BACK LIVE`);
      }
      state.lastDetail = sit.detail;
    } else {
      console.log(`[${key}] ${sit.label} — ${state.onCommercial ? "commercial" : "live"}`);
    }
  }

  // ---- NBA / NFL ----
  else if (sit.sport === "nba" || sit.sport === "nfl") {
    const threshold = sit.sport === "nba" ? 120000 : 90000;
    const now = Date.now();
    if (!state.initialized) {
      state.initialized = true;
      state.lastClock = sit.clock; state.lastPeriod = sit.period;
      state.lastChangedAt = now; state.onCommercial = false;
      console.log(`[${key}] Tracking — ${sit.label}`);
      return;
    }
    const clockMoved = sit.clock !== state.lastClock || sit.period !== state.lastPeriod;
    if (clockMoved) {
      if (state.onCommercial) {
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${ord(sit.period)}, ${sit.clock} left.`);
        console.log(`[${key}] BACK LIVE`);
      }
      state.onCommercial = false;
      state.lastClock = sit.clock; state.lastPeriod = sit.period; state.lastChangedAt = now;
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

  // ---- NHL ----
  else if (sit.sport === "nhl") {
    if (!state.initialized) {
      state.initialized = true;
      state.lastPeriod = sit.period; state.onCommercial = sit.intermission;
      console.log(`[${key}] Tracking — Period ${sit.period}`);
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

  // ---- SOCCER / WORLD CUP ----
  else if (sit.sport === "soccer") {
    if (!state.initialized) {
      state.initialized = true;
      state.lastDetail = sit.detail; state.lastPeriod = sit.period;
      state.onCommercial = sit.isHalftime;
      console.log(`[${key}] Tracking — ${sit.label}`);
      return;
    }
    const changed = sit.detail !== state.lastDetail || sit.period !== state.lastPeriod;
    if (changed) {
      console.log(`[${key}] "${state.lastDetail}" -> "${sit.detail}"`);
      if (sit.isHalftime && !state.onCommercial) {
        state.onCommercial = true;
        console.log(`[${key}] Halftime`);
      } else if (!sit.isHalftime && state.onCommercial) {
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — 2nd half starting!`);
        state.onCommercial = false;
        console.log(`[${key}] BACK LIVE`);
      }
      state.lastDetail = sit.detail; state.lastPeriod = sit.period;
    } else {
      console.log(`[${key}] ${sit.label} — ${state.onCommercial ? "halftime" : "live"}`);
    }
  }

  game.status = state.onCommercial ? "commercial" : "live";

  // ---- SPOTIFY ----
  if (session.spotifyEnabled) {
    if (!wasOnCommercial && state.onCommercial) {
      // just went to break — resume music
      spotifyResume(ntfyTopic);
    } else if (wasOnCommercial && !state.onCommercial) {
      // just came back live — pause music
      spotifyPause(ntfyTopic);
    }
  }
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
          game.espnId = event.id; game.fullName = event.name;
          console.log(`[${id}] Locked: ${event.name}`);
        }
        const event = events.find(e => e.id === game.espnId);
        if (!event) {
          game.status = "final"; game._sit = null; game.espnId = null;
          notify(session.ntfyTopic, "Game over!", `${game.fullName || game.nickname} is final.`);
          console.log(`[${game.nickname}] Game ended`);
          continue;
        }
        const comp = event?.competitions?.[0];
        const status = comp?.status;
        const rawSit = comp?.situation;
        console.log(`[${game.nickname}] state=${status?.type?.state} detail="${status?.type?.shortDetail}" outs=${rawSit?.outs ?? "n/a"}`);
        const sit = getSituation(event, game.sport);
        if (!sit) { game.status = "not started"; game._sit = null; continue; }
        game._sit = sit; game.detail = sit.label;
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
    const body = await readBody(req);
    const { ntfyTopic, games, key } = body;
    if (key !== SECRET_KEY) { jsonRes(res, 401, { error: "Unauthorized" }); return; }
    if (!ntfyTopic || !games?.length) { jsonRes(res, 400, { error: "Missing ntfyTopic or games" }); return; }
    const hasSpotify = !!spotifyTokens[ntfyTopic];
    sessions[ntfyTopic] = {
      ntfyTopic,
      games: games.map(n => ({ nickname: n, espnId: null, sport: null, status: "searching", detail: "", fullName: "", _sit: null })),
      states: {},
      spotifyEnabled: hasSpotify
    };
    notify(ntfyTopic, "BackLive is watching!", `Tracking: ${games.join(", ")}`);
    console.log(`[${ntfyTopic}] Started: ${games.join(", ")} spotify=${hasSpotify}`);
    jsonRes(res, 200, { ok: true, spotifyConnected: hasSpotify });
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    const id = url.searchParams.get("session");
    const s = sessions[id];
    if (!s) { jsonRes(res, 404, { error: "No session" }); return; }
    jsonRes(res, 200, {
      games: s.games.map(g => ({ nickname: g.nickname, fullName: g.fullName, status: g.status, detail: g.detail })),
      spotifyConnected: !!spotifyTokens[id]
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/stop") {
    const { ntfyTopic } = await readBody(req);
    delete sessions[ntfyTopic];
    jsonRes(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/spotify/login") {
    const ntfyTopic = url.searchParams.get("session");
    const params = new URLSearchParams({
      response_type: "code", client_id: SPOTIFY_CLIENT_ID,
      scope: "user-modify-playback-state user-read-playback-state",
      redirect_uri: SPOTIFY_REDIRECT_URI, state: ntfyTopic
    });
    res.writeHead(302, { "Location": `https://accounts.spotify.com/authorize?${params}` });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/spotify/callback") {
    const code = url.searchParams.get("code");
    const ntfyTopic = url.searchParams.get("state");
    if (!code || !ntfyTopic) { jsonRes(res, 400, { error: "Missing code or state" }); return; }
    try {
      const r = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: SPOTIFY_REDIRECT_URI })
      });
      const data = await r.json();
      if (data.access_token) {
        spotifyTokens[ntfyTopic] = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + (data.expires_in * 1000)
        };
        saveTokens(); // persist to disk
        if (sessions[ntfyTopic]) sessions[ntfyTopic].spotifyEnabled = true;
        console.log(`[spotify:${ntfyTopic}] Connected & saved`);
        res.writeHead(302, { "Location": `https://backlive.netlify.app?spotify=connected&session=${encodeURIComponent(ntfyTopic)}` });
        res.end();
      } else {
        jsonRes(res, 400, { error: "Spotify auth failed", details: data });
      }
    } catch (e) { jsonRes(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === "GET" && url.pathname === "/spotify/status") {
    const id = url.searchParams.get("session");
    jsonRes(res, 200, { connected: !!spotifyTokens[id] });
    return;
  }

  jsonRes(res, 404, { error: "Not found" });

}).listen(PORT, () => {
  console.log(`BackLive v10 running on port ${PORT}`);
  console.log(`Spotify tokens loaded: ${Object.keys(spotifyTokens).length}`);
});
