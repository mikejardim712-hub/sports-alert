// ============================================================
//  BACKLIVE SERVER v16 — Bulletproof Spotify + all fixes
//  - Proactive token refresh every 45 min
//  - Immediate refresh on session start
//  - Race condition eliminated
//  - Grace period for false game-over
//  - 15s polling, instant detection, ESPN retry
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const POLL_MS = 15000;
const ESPN_RETRY = 2;
const SECRET_KEY = process.env.SECRET_KEY || "Lola";
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "b9f103fdac944282ba3f56a03c866606";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "3007ce1e51a74d08ad91800025b0ce6d";
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || "https://sports-alert-production.up.railway.app/spotify/callback";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const FINAL_GRACE_POLLS = 3;

// ============================================================
//  PERSISTENT TOKEN STORE
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
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(spotifyTokens, null, 2)); }
  catch (e) { console.error("Error saving tokens:", e.message); }
}

const spotifyTokens = loadTokens();

// ============================================================
//  SPOTIFY — bulletproof token management
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
      if (data.refresh_token) tokens.refreshToken = data.refresh_token; // update if rotated
      saveTokens();
      console.log(`[spotify:${ntfyTopic}] Token refreshed — valid for ${data.expires_in}s`);
      return data.access_token;
    } else {
      console.error(`[spotify:${ntfyTopic}] Refresh failed:`, JSON.stringify(data));
    }
  } catch (e) { console.error(`[spotify:${ntfyTopic}] Refresh error:`, e.message); }
  return null;
}

async function getSpotifyToken(ntfyTopic) {
  const tokens = spotifyTokens[ntfyTopic];
  if (!tokens) return null;
  // Refresh if expiring within 3 minutes
  if (Date.now() > (tokens.expiresAt - 180000)) {
    return await refreshSpotifyToken(ntfyTopic);
  }
  return tokens.accessToken;
}

// Proactive background refresh every 45 minutes for all connected users
setInterval(async () => {
  const topics = Object.keys(spotifyTokens);
  if (topics.length === 0) return;
  console.log(`[spotify] Proactive refresh for ${topics.length} user(s)`);
  for (const topic of topics) {
    await refreshSpotifyToken(topic);
  }
}, 45 * 60 * 1000);

async function spotifyAction(ntfyTopic, action) {
  // action = "pause" or "play"
  const token = await getSpotifyToken(ntfyTopic);
  if (!token) {
    console.log(`[spotify:${ntfyTopic}] No token — skipping ${action}`);
    return;
  }
  try {
    const r = await fetch(`https://api.spotify.com/v1/me/player/${action}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (r.status === 204) {
      console.log(`[spotify:${ntfyTopic}] ${action} — success`);
    } else if (r.status === 401) {
      // Token was rejected — force refresh and retry once
      console.log(`[spotify:${ntfyTopic}] 401 on ${action} — force refreshing token`);
      const newToken = await refreshSpotifyToken(ntfyTopic);
      if (newToken) {
        const retry = await fetch(`https://api.spotify.com/v1/me/player/${action}`, {
          method: "PUT",
          headers: { "Authorization": `Bearer ${newToken}` }
        });
        console.log(`[spotify:${ntfyTopic}] ${action} retry — status ${retry.status}`);
      }
    } else if (r.status === 404) {
      console.log(`[spotify:${ntfyTopic}] No active device for ${action} — user may not have Spotify open`);
    } else if (r.status === 403) {
      console.log(`[spotify:${ntfyTopic}] ${action} forbidden — may need premium`);
    } else {
      console.log(`[spotify:${ntfyTopic}] ${action} — status ${r.status}`);
    }
  } catch (e) { console.error(`[spotify:${ntfyTopic}] ${action} error:`, e.message); }
}

function spotifyPause(ntfyTopic) { return spotifyAction(ntfyTopic, "pause"); }
function spotifyResume(ntfyTopic) { return spotifyAction(ntfyTopic, "play"); }

function applySpotifyNow(ntfyTopic, onCommercial) {
  if (onCommercial) spotifyResume(ntfyTopic);
  else spotifyPause(ntfyTopic);
}

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
  // NCAAF
  "alabama":"alabama crimson tide","crimson tide":"alabama crimson tide",
  "georgia bulldogs":"georgia bulldogs","buckeyes":"ohio state buckeyes",
  "ohio state":"ohio state buckeyes","wolverines":"michigan wolverines",
  "michigan":"michigan wolverines","clemson":"clemson tigers","lsu":"lsu tigers",
  "florida state":"florida state seminoles","seminoles":"florida state seminoles",
  "notre dame":"notre dame fighting irish","fighting irish":"notre dame fighting irish",
  "oklahoma":"oklahoma sooners","sooners":"oklahoma sooners",
  "texas longhorns":"texas longhorns","longhorns":"texas longhorns",
  "penn state":"penn state nittany lions","nittany lions":"penn state nittany lions",
  "oregon":"oregon ducks","usc":"usc trojans","trojans":"usc trojans",
  "florida":"florida gators","gators":"florida gators",
  "tennessee":"tennessee volunteers","vols":"tennessee volunteers",
  "auburn":"auburn tigers","razorbacks":"arkansas razorbacks","arkansas":"arkansas razorbacks",
  "ole miss":"ole miss rebels","rebels":"ole miss rebels",
  "gamecocks":"south carolina gamecocks","south carolina":"south carolina gamecocks",
  "missouri":"missouri tigers","vanderbilt":"vanderbilt commodores","commodores":"vanderbilt commodores",
  "kentucky":"kentucky wildcats","aggies":"texas a&m aggies","texas am":"texas a&m aggies",
  "badgers":"wisconsin badgers","wisconsin":"wisconsin badgers",
  "hawkeyes":"iowa hawkeyes","iowa":"iowa hawkeyes",
  "cornhuskers":"nebraska cornhuskers","nebraska":"nebraska cornhuskers",
  "illini":"illinois fighting illini","illinois":"illinois fighting illini",
  "hoosiers":"indiana hoosiers","indiana":"indiana hoosiers",
  "boilermakers":"purdue boilermakers","purdue":"purdue boilermakers",
  "northwestern":"northwestern wildcats","rutgers":"rutgers scarlet knights",
  "scarlet knights":"rutgers scarlet knights","terps":"maryland terrapins","maryland":"maryland terrapins",
  "spartans":"michigan state spartans","michigan state":"michigan state spartans",
  "oklahoma state":"oklahoma state cowboys","baylor":"baylor bears",
  "horned frogs":"tcu horned frogs","tcu":"tcu horned frogs",
  "kansas state":"kansas state wildcats","cyclones":"iowa state cyclones","iowa state":"iowa state cyclones",
  "mountaineers":"west virginia mountaineers","west virginia":"west virginia mountaineers",
  "jayhawks":"kansas jayhawks","kansas":"kansas jayhawks",
  "red raiders":"texas tech red raiders","texas tech":"texas tech red raiders",
  "buffs":"colorado buffaloes","colorado":"colorado buffaloes",
  "utes":"utah utes","utah":"utah utes",
  "huskies":"washington huskies","washington":"washington huskies",
  "sun devils":"arizona state sun devils","arizona state":"arizona state sun devils",
  "arizona":"arizona wildcats","stanford":"stanford cardinal","cardinal":"stanford cardinal",
  "golden bears":"california golden bears","cal":"california golden bears",
  "bruins":"ucla bruins","ucla":"ucla bruins",
  "pitt":"pittsburgh panthers","pittsburgh":"pittsburgh panthers",
  "bc eagles":"boston college eagles","boston college":"boston college eagles",
  "blue devils":"duke blue devils","duke":"duke blue devils",
  "tar heels":"north carolina tar heels","north carolina":"north carolina tar heels","unc":"north carolina tar heels",
  "wolfpack":"nc state wolfpack","nc state":"nc state wolfpack",
  "cavaliers":"virginia cavaliers","virginia":"virginia cavaliers",
  "hokies":"virginia tech hokies","virginia tech":"virginia tech hokies",
  "yellow jackets":"georgia tech yellow jackets","georgia tech":"georgia tech yellow jackets",
  "demon deacons":"wake forest demon deacons","wake forest":"wake forest demon deacons",
  "orange":"syracuse orange","syracuse":"syracuse orange",
  "louisville":"louisville cardinals","army":"army black knights","navy":"navy midshipmen","byu":"byu cougars",
  // NCAAB
  "gonzaga":"gonzaga bulldogs","zags":"gonzaga bulldogs",
  "villanova":"villanova wildcats","nova":"villanova wildcats",
  "uconn":"connecticut huskies","connecticut":"connecticut huskies",
  "xavier":"xavier musketeers","musketeers":"xavier musketeers",
  "creighton":"creighton bluejays","marquette":"marquette golden eagles",
  "seton hall":"seton hall pirates","providence":"providence friars","friars":"providence friars",
  "st johns":"st. john's red storm","red storm":"st. john's red storm",
  "butler":"butler bulldogs","dayton":"dayton flyers",
  "saint mary's":"saint mary's gaels","gaels":"saint mary's gaels",
  "memphis":"memphis tigers","houston":"houston cougars","cougars":"houston cougars",
  "wichita state":"wichita state shockers","shockers":"wichita state shockers",
  "cincinnati":"cincinnati bearcats","bearcats":"cincinnati bearcats",
  "merrimack":"merrimack warriors","merrimack warriors":"merrimack warriors",
  // Soccer / World Cup 2026 — confirmed 48 teams only
  "usa":"united states","united states":"united states","usmnt":"united states",
  "mexico":"mexico","canada":"canada","panama":"panama",
  "curacao":"curacao","curaçao":"curacao","haiti":"haiti",
  "japan":"japan","iran":"iran","south korea":"south korea","korea":"south korea",
  "australia":"australia","saudi arabia":"saudi arabia","qatar":"qatar",
  "uzbekistan":"uzbekistan","jordan":"jordan","iraq":"iraq",
  "morocco":"morocco","senegal":"senegal","egypt":"egypt","algeria":"algeria",
  "tunisia":"tunisia","south africa":"south africa","cape verde":"cabo verde",
  "cabo verde":"cabo verde","ghana":"ghana","ivory coast":"ivory coast",
  "dr congo":"dr congo","congo":"dr congo",
  "argentina":"argentina","brazil":"brazil","uruguay":"uruguay",
  "colombia":"colombia","ecuador":"ecuador","paraguay":"paraguay",
  "new zealand":"new zealand",
  "england":"england","france":"france","croatia":"croatia","norway":"norway",
  "portugal":"portugal","germany":"germany","netherlands":"netherlands","holland":"netherlands",
  "switzerland":"switzerland","scotland":"scotland","spain":"spain","austria":"austria",
  "belgium":"belgium","bosnia":"bosnia and herzegovina","bosnia and herzegovina":"bosnia and herzegovina",
  "sweden":"sweden","turkey":"turkey","turkiye":"turkey","czechia":"czechia",
  "czech republic":"czechia",
};

const MLB    = ["angels","astros","athletics","blue jays","braves","brewers","cardinals","cubs","diamondbacks","dbacks","dodgers","giants","guardians","mariners","marlins","mets","nationals","orioles","padres","phillies","pirates","rangers","rays","red sox","reds","rockies","royals","tigers","twins","white sox","yankees"];
const NBA    = ["76ers","sixers","bucks","bulls","cavaliers","cavs","celtics","clippers","grizzlies","hawks","heat","hornets","jazz","kings","knicks","lakers","magic","mavericks","mavs","nets","nuggets","pacers","pelicans","pistons","raptors","rockets","spurs","suns","thunder","timberwolves","wolves","trail blazers","blazers","warriors","wizards"];
const NFL    = ["49ers","bears","bengals","bills","broncos","browns","buccaneers","bucs","chargers","chiefs","colts","commanders","cowboys","dolphins","eagles","falcons","giants","jaguars","jets","lions","packers","panthers","patriots","pats","raiders","rams","ravens","saints","seahawks","steelers","texans","titans","vikings"];
const NHL    = ["avalanche","avs","blackhawks","blue jackets","blues","bruins","canadiens","habs","canucks","capitals","caps","coyotes","devils","ducks","flames","flyers","golden knights","knights","hurricanes","canes","islanders","kraken","lightning","bolts","maple leafs","leafs","oilers","penguins","pens","predators","preds","red wings","sabres","senators","sens","sharks","stars","wild","winnipeg jets","florida panthers","new york rangers"];
const NCAAF  = ["alabama","crimson tide","georgia bulldogs","buckeyes","ohio state","wolverines","michigan","clemson","lsu","florida state","seminoles","notre dame","fighting irish","oklahoma","sooners","longhorns","penn state","nittany lions","oregon","usc","trojans","gators","florida","vols","tennessee","auburn","razorbacks","arkansas","ole miss","rebels","gamecocks","south carolina","missouri","vanderbilt","commodores","kentucky","aggies","badgers","wisconsin","hawkeyes","iowa","cornhuskers","nebraska","illini","illinois","hoosiers","indiana","boilermakers","purdue","northwestern","rutgers","scarlet knights","maryland","terps","spartans","michigan state","oklahoma state","baylor","horned frogs","tcu","kansas state","cyclones","iowa state","mountaineers","west virginia","jayhawks","kansas","red raiders","texas tech","buffs","colorado","utes","utah","huskies","washington","sun devils","arizona state","stanford","cardinal","golden bears","cal","bruins","ucla","pitt","pittsburgh","bc eagles","boston college","blue devils","duke","tar heels","unc","wolfpack","nc state","cavaliers","virginia","hokies","virginia tech","yellow jackets","georgia tech","demon deacons","wake forest","orange","syracuse","louisville","army","navy","byu"];
const NCAAB  = ["gonzaga","zags","villanova","nova","uconn","connecticut","xavier","musketeers","creighton","marquette","seton hall","providence","friars","st johns","red storm","butler","dayton","saint mary's","gaels","memphis","cougars","houston","shockers","wichita state","bearcats","cincinnati","merrimack","merrimack warriors"];
const SOCCER = ["usa","united states","usmnt","mexico","canada","panama","curacao","haiti","japan","iran","south korea","korea","australia","saudi arabia","qatar","uzbekistan","jordan","iraq","morocco","senegal","egypt","algeria","tunisia","south africa","cape verde","cabo verde","ghana","ivory coast","dr congo","congo","argentina","brazil","uruguay","colombia","ecuador","paraguay","new zealand","england","france","croatia","norway","portugal","germany","netherlands","holland","switzerland","scotland","spain","austria","belgium","bosnia","sweden","turkey","turkiye","czechia"];

function detectSport(n) {
  n = n.toLowerCase();
  if (n.includes("ncaaf") || NCAAF.some(t => n.includes(t))) return "football/college-football";
  if (n.includes("ncaab") || NCAAB.some(t => n.includes(t))) return "basketball/mens-college-basketball";
  if (MLB.some(t => n.includes(t))) return "baseball/mlb";
  if (NBA.some(t => n.includes(t))) return "basketball/nba";
  if (NFL.some(t => n.includes(t))) return "football/nfl";
  if (NHL.some(t => n.includes(t))) return "hockey/nhl";
  if (SOCCER.some(t => n.includes(t))) return "soccer/fifa.world";
  return "baseball/mlb";
}

// ============================================================
//  ESPN API WITH RETRY
// ============================================================
async function fetchGames(sport, attempt = 0) {
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard?limit=100`);
    if (!r.ok) throw new Error(`ESPN ${r.status}`);
    return (await r.json()).events || [];
  } catch (e) {
    if (attempt < ESPN_RETRY) {
      console.log(`[ESPN] Retry ${attempt + 1} for ${sport}`);
      await new Promise(res => setTimeout(res, 2000));
      return fetchGames(sport, attempt + 1);
    }
    throw e;
  }
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

  const detail = status?.type?.shortDetail || "";
  const detailLower = detail.toLowerCase();

  if (sport === "baseball/mlb") {
    const sit = comp?.situation;
    const inning = status?.period || 1;
    const outs = (sit && sit.outs != null) ? sit.outs : null;
    const isEnd = detailLower.includes("end");
    const isDelay = detailLower.includes("delay") || detailLower.includes("suspend") || detailLower.includes("postpone");
    const half = detailLower.includes("bot") ? "bottom" : "top";
    const label = isDelay ? "Game delayed" : isEnd ? `End of ${ord(inning)}` : `${half === "top" ? "Top" : "Bot"} ${ord(inning)}, ${outs ?? 0} outs`;
    return { sport: "mlb", inning, half, outs, isEnd: isEnd || isDelay, isDelay, detail, label };
  }
  if (sport === "basketball/nba" || sport === "basketball/mens-college-basketball") {
    const clock = status.displayClock || "0:00";
    const period = status.period || 1;
    const sportKey = sport === "basketball/nba" ? "nba" : "ncaab";
    const isHalftime = detailLower.includes("half") || detailLower.includes("ht");
    const isEndOfPeriod = detailLower.includes("end") || clock === "0:00";
    const label = isHalftime ? "Halftime" : isEndOfPeriod ? `End of ${ord(period)}` : `${ord(period)} ${sportKey === "ncaab" ? "half" : "qtr"}, ${clock}`;
    return { sport: sportKey, clock, period, isHalftime, isEndOfPeriod, detail, label };
  }
  if (sport === "football/nfl" || sport === "football/college-football") {
    const clock = status.displayClock || "0:00";
    const period = status.period || 1;
    const sportKey = sport === "football/nfl" ? "nfl" : "ncaaf";
    const isHalftime = detailLower.includes("half") || detailLower.includes("ht");
    const isEndOfPeriod = detailLower.includes("end") || clock === "0:00";
    const label = isHalftime ? "Halftime" : isEndOfPeriod ? `End of ${ord(period)}` : `${ord(period)} qtr, ${clock}`;
    return { sport: sportKey, clock, period, isHalftime, isEndOfPeriod, detail, label };
  }
  if (sport === "hockey/nhl") {
    const period = status.period || 1;
    const clock = status.displayClock || "0:00";
    const intermission = detailLower.includes("end") || detailLower.includes("intermission") || clock === "0:00";
    return { sport: "nhl", period, clock, intermission, label: `Period ${period}, ${clock}` };
  }
  if (sport === "soccer/fifa.world") {
    const clock = status.displayClock || "0:00";
    const period = status.period || 1;
    const isHalftime = detailLower.includes("ht") || detailLower.includes("half time") || detailLower.includes("halftime");
    const isETHalftime = period > 2 && (detailLower.includes("ht") || detailLower.includes("break"));
    const half = period === 1 ? "1st Half" : period === 2 ? "2nd Half" : period === 3 ? "ET 1st" : "ET 2nd";
    const label = (isHalftime || isETHalftime) ? "Halftime" : `${half}, ${clock}`;
    return { sport: "soccer", period, clock, isHalftime: isHalftime || isETHalftime, detail, label };
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
    console.log(`[ntfy:${topic}] FIRED: ${title} — ${body}`);
  } catch (e) { console.error("ntfy fail:", e.message); }
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
      console.log(`[${key}] MLB tracking — ${sit.detail} commercial=${sit.isEnd}`);
      if (session.spotifyEnabled) applySpotifyNow(ntfyTopic, sit.isEnd);
      return;
    }
    if (sit.detail !== state.lastDetail) {
      console.log(`[${key}] MLB: "${state.lastDetail}" -> "${sit.detail}"`);
      if (sit.isEnd && !state.onCommercial) {
        state.onCommercial = true;
        console.log(`[${key}] MLB: Commercial${sit.isDelay ? " (delay)" : ""}`);
      } else if (!sit.isEnd && state.onCommercial) {
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${sit.half === "top" ? "Top" : "Bottom"} of the ${ord(sit.inning)} starting.`);
        state.onCommercial = false;
        console.log(`[${key}] MLB: BACK LIVE`);
      }
      state.lastDetail = sit.detail;
    } else {
      console.log(`[${key}] ${sit.label} — ${state.onCommercial ? "commercial" : "live"}`);
    }
  }

  // ---- NBA / NCAAB / NFL / NCAAF ----
  else if (["nba","nfl","ncaab","ncaaf"].includes(sit.sport)) {
    const threshold = (sit.sport === "nba" || sit.sport === "ncaab") ? 110000 : 80000;
    const now = Date.now();
    if (!state.initialized) {
      state.initialized = true;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastDetail = sit.detail;
      state.lastChangedAt = now;
      state.onCommercial = sit.isHalftime || sit.isEndOfPeriod || false;
      console.log(`[${key}] ${sit.sport.toUpperCase()} tracking — ${sit.label} commercial=${state.onCommercial}`);
      if (session.spotifyEnabled) applySpotifyNow(ntfyTopic, state.onCommercial);
      return;
    }
    const periodJumped = sit.period !== state.lastPeriod;
    const clockMoved = sit.clock !== state.lastClock;
    const detailChanged = sit.detail !== state.lastDetail;

    if (detailChanged) {
      console.log(`[${key}] ${sit.sport.toUpperCase()}: "${state.lastDetail}" -> "${sit.detail}"`);
      if ((sit.isHalftime || sit.isEndOfPeriod) && !state.onCommercial) {
        state.onCommercial = true;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: Commercial (instant)`);
      } else if (!sit.isHalftime && !sit.isEndOfPeriod && state.onCommercial && (clockMoved || periodJumped)) {
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${ord(sit.period)}, ${sit.clock} left.`);
        state.onCommercial = false;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: BACK LIVE (instant)`);
      }
      state.lastDetail = sit.detail;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
    } else if (clockMoved || periodJumped) {
      if (state.onCommercial) {
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${ord(sit.period)}, ${sit.clock} left.`);
        state.onCommercial = false;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: BACK LIVE`);
      }
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
      console.log(`[${key}] ${sit.label}`);
    } else {
      const frozen = now - state.lastChangedAt;
      if (frozen >= threshold && !state.onCommercial) {
        state.onCommercial = true;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: Commercial (frozen ${Math.round(frozen / 1000)}s)`);
      } else {
        console.log(`[${key}] ${sit.label} frozen ${Math.round(frozen / 1000)}s / ${threshold / 1000}s`);
      }
    }
  }

  // ---- NHL ----
  else if (sit.sport === "nhl") {
    const now = Date.now();

    if (!state.initialized) {
      state.initialized = true;
      state.lastPeriod = sit.period;
      state.lastClock = sit.clock;
      state.lastChangedAt = now;
      state.onCommercial = sit.intermission;
      console.log(`[${key}] NHL tracking — Period ${sit.period}, ${sit.clock} (detail: "${sit.detail}") intermission=${sit.intermission}`);
      if (session.spotifyEnabled) applySpotifyNow(ntfyTopic, sit.intermission);
      return;
    }

    const periodChanged = sit.period !== state.lastPeriod;
    const clockMoved = sit.clock !== state.lastClock;
    const detailLower = (sit.detail || "").toLowerCase();

    // Only treat as commercial if ESPN explicitly says "timeout"
    // Reviews, challenges, penalties etc. are excluded to avoid false positives
    const isExplicitTimeout = detailLower.includes("timeout");

    if (periodChanged || clockMoved) {
      if (state.onCommercial) {
        const msg = periodChanged
          ? `${game.fullName || game.nickname} is back — ${ord(sit.period)} period starting.`
          : `${game.fullName || game.nickname} is back live — ${sit.clock} left in the ${ord(sit.period)}.`;
        notify(ntfyTopic, "Game is back!", msg);
        console.log(`[${key}] NHL: BACK LIVE`);
      }
      state.onCommercial = false;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
      console.log(`[${key}] ${sit.label} (detail: "${sit.detail}")`);
    } else {
      if (sit.intermission && !state.onCommercial) {
        state.onCommercial = true;
        console.log(`[${key}] NHL: Intermission`);
      } else if (isExplicitTimeout && !state.onCommercial) {
        state.onCommercial = true;
        console.log(`[${key}] NHL: Timeout detected — "${sit.detail}"`);
      } else {
        console.log(`[${key}] ${sit.label} (detail: "${sit.detail}") — no trigger`);
      }
    }
  }

  // ---- SOCCER ----
  else if (sit.sport === "soccer") {
    if (!state.initialized) {
      state.initialized = true;
      state.lastDetail = sit.detail;
      state.lastPeriod = sit.period;
      state.onCommercial = sit.isHalftime;
      console.log(`[${key}] Soccer tracking — ${sit.label} halftime=${sit.isHalftime}`);
      if (session.spotifyEnabled) applySpotifyNow(ntfyTopic, sit.isHalftime);
      return;
    }
    const changed = sit.detail !== state.lastDetail || sit.period !== state.lastPeriod;
    if (changed) {
      console.log(`[${key}] Soccer: "${state.lastDetail}" -> "${sit.detail}"`);
      if (sit.isHalftime && !state.onCommercial) {
        state.onCommercial = true;
        console.log(`[${key}] Soccer: Halftime`);
      } else if (!sit.isHalftime && state.onCommercial) {
        const halfLabel = sit.period === 2 ? "2nd half" : sit.period >= 3 ? "extra time" : "2nd half";
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${halfLabel} starting!`);
        state.onCommercial = false;
        console.log(`[${key}] Soccer: BACK LIVE`);
      }
      state.lastDetail = sit.detail;
      state.lastPeriod = sit.period;
    } else {
      console.log(`[${key}] ${sit.label} — ${state.onCommercial ? "halftime" : "live"}`);
    }
  }

  game.status = state.onCommercial ? "commercial" : "live";

  // ---- SPOTIFY transition detection ----
  if (session.spotifyEnabled) {
    if (!wasOnCommercial && state.onCommercial) {
      console.log(`[${key}] Spotify: resuming music (game went to break)`);
      spotifyResume(ntfyTopic);
    } else if (wasOnCommercial && !state.onCommercial) {
      console.log(`[${key}] Spotify: pausing music (game came back live)`);
      spotifyPause(ntfyTopic);
    }
  }
}

// ============================================================
//  MAIN POLL
// ============================================================
async function pollAll() {
  for (const [id, session] of Object.entries(sessions)) {
    if (session.expiresAt && Date.now() > session.expiresAt) {
      console.log(`[${id}] Session expired — stopping`);
      delete sessions[id];
      continue;
    }
    for (const game of session.games) {
      try {
        if (!game.sport) game.sport = detectSport(game.nickname);
        const events = await fetchGames(game.sport);

        if (!game.espnId) {
          const event = findEvent(events, game.nickname);
          if (!event) { game.status = "not started"; game._sit = null; continue; }
          game.espnId = event.id; game.fullName = event.name; game.missingCount = 0;
          console.log(`[${id}] Locked: ${event.name}`);
        }

        const event = events.find(e => e.id === game.espnId);
        if (!event) {
          game.missingCount = (game.missingCount || 0) + 1;
          console.log(`[${game.nickname}] Not in scoreboard (${game.missingCount}/${FINAL_GRACE_POLLS})`);
          if (game.missingCount >= FINAL_GRACE_POLLS) {
            game.status = "final"; game._sit = null; game.espnId = null; game.missingCount = 0;
            notify(session.ntfyTopic, "Game over!", `${game.fullName || game.nickname} is final.`);
            console.log(`[${game.nickname}] Game ended (confirmed after ${FINAL_GRACE_POLLS} polls)`);
          }
          continue;
        }

        game.missingCount = 0;

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
    const hasSpotify = !!spotifyTokens[ntfyTopic] && games.length === 1;
    // Proactively refresh Spotify token at session start
    if (hasSpotify) {
      console.log(`[${ntfyTopic}] Refreshing Spotify token at session start`);
      refreshSpotifyToken(ntfyTopic);
    }
    sessions[ntfyTopic] = {
      ntfyTopic,
      games: games.map(n => ({ nickname: n, espnId: null, sport: null, status: "searching", detail: "", fullName: "", _sit: null, missingCount: 0 })),
      states: {}, spotifyEnabled: hasSpotify,
      expiresAt: Date.now() + SESSION_TTL_MS
    };
    notify(ntfyTopic, "BackLive is watching!", `Tracking: ${games.join(", ")} (auto-stops in 8h)`);
    console.log(`[${ntfyTopic}] Started: ${games.join(", ")} spotify=${hasSpotify}`);
    jsonRes(res, 200, { ok: true, spotifyConnected: !!spotifyTokens[ntfyTopic], spotifyEnabled: hasSpotify });
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    const id = url.searchParams.get("session");
    const s = sessions[id];
    if (!s) { jsonRes(res, 404, { error: "No session" }); return; }
    jsonRes(res, 200, {
      games: s.games.map(g => ({ nickname: g.nickname, fullName: g.fullName, status: g.status, detail: g.detail })),
      spotifyConnected: !!spotifyTokens[id], spotifyEnabled: s.spotifyEnabled, expiresAt: s.expiresAt
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
    const platform = url.searchParams.get("platform") || "web";
    const stateValue = `${ntfyTopic}|${platform}`;
    const params = new URLSearchParams({
      response_type: "code", client_id: SPOTIFY_CLIENT_ID,
      scope: "user-modify-playback-state user-read-playback-state",
      redirect_uri: SPOTIFY_REDIRECT_URI, state: stateValue
    });
    res.writeHead(302, { "Location": `https://accounts.spotify.com/authorize?${params}` });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/spotify/callback") {
    const code = url.searchParams.get("code");
    const stateRaw = url.searchParams.get("state") || "";
    const [ntfyTopic, platform] = stateRaw.split("|");
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
          accessToken: data.access_token, refreshToken: data.refresh_token,
          expiresAt: Date.now() + (data.expires_in * 1000)
        };
        saveTokens();
        if (sessions[ntfyTopic]) sessions[ntfyTopic].spotifyEnabled = true;
        console.log(`[spotify:${ntfyTopic}] Connected & saved (platform=${platform || "web"})`);
        const redirectUrl = platform === "app"
          ? "backliveapp3://spotify-connected"
          : `https://backlive.netlify.app?spotify=connected&session=${encodeURIComponent(ntfyTopic)}`;
        res.writeHead(302, { "Location": redirectUrl });
        res.end();
      } else { jsonRes(res, 400, { error: "Spotify auth failed", details: data }); }
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
  console.log(`BackLive v19 running on port ${PORT}`);
  console.log(`Poll: ${POLL_MS / 1000}s | Grace: ${FINAL_GRACE_POLLS} polls | ESPN retries: ${ESPN_RETRY}`);
  console.log(`Spotify tokens loaded: ${Object.keys(spotifyTokens).length}`);
});
