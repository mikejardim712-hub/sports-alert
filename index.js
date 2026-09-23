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
const POLL_MS = 5000;
const ESPN_RETRY = 2;
const SECRET_KEY = process.env.SECRET_KEY || "Lola";
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "b9f103fdac944282ba3f56a03c866606";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "3007ce1e51a74d08ad91800025b0ce6d";
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || "https://sports-alert-production.up.railway.app/spotify/callback";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const FINAL_GRACE_POLLS = 3;
// A quick timeout/mid-inning break stays a silent badge; if it runs this long
// without resolving, it's treated as a real break and eventually notifies.
const NHL_TIMEOUT_ESCALATE_MS = 90000;
const MID_INNING_ESCALATE_MS = 90000;

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
//  PUSH NOTIFICATION TOKEN STORE (favorite teams + conflict alerts)
// ============================================================
const PUSH_TOKENS_FILE = path.join("/tmp", "push_tokens.json");

function loadPushTokens() {
  try {
    if (fs.existsSync(PUSH_TOKENS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PUSH_TOKENS_FILE, "utf8"));
      console.log(`Loaded ${Object.keys(data).length} push token(s) from disk`);
      return data;
    }
  } catch (e) { console.error("Error loading push tokens:", e.message); }
  return {};
}

function savePushTokens() {
  try { fs.writeFileSync(PUSH_TOKENS_FILE, JSON.stringify(pushTokens, null, 2)); }
  catch (e) { console.error("Error saving push tokens:", e.message); }
}

const pushTokens = loadPushTokens(); // { expoPushToken: { favorites: [...], lastNotifiedDate: "YYYY-MM-DD" } }

// ============================================================
//  SESSION PERSISTENCE — survive Railway restarts/redeploys
//  Without this, any server restart silently kills every active
//  game-tracking session with no warning: notifications and
//  Spotify sync just stop, and the user has no idea why.
//  Only the "what to watch" setup is persisted, not moment-to-moment
//  tracking state (states/_sit) — that's cheap to re-initialize
//  quietly on the next poll after a restore.
// ============================================================
const SESSIONS_FILE = path.join("/tmp", "sessions.json");

function loadPersistedSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
      console.log(`Loaded ${Object.keys(data).length} persisted session(s) from disk`);
      return data;
    }
  } catch (e) { console.error("Error loading sessions:", e.message); }
  return {};
}

function saveSessions() {
  try {
    // Persist only what's needed to resume tracking, not live/ephemeral state
    const toSave = {};
    for (const [id, s] of Object.entries(sessions)) {
      toSave[id] = {
        ntfyTopic: s.ntfyTopic,
        pushToken: s.pushToken,
        spotifyEnabled: s.spotifyEnabled,
        expiresAt: s.expiresAt,
        games: s.games.map(g => ({ nickname: g.nickname, sport: g.sport }))
      };
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(toSave, null, 2));
  } catch (e) { console.error("Error saving sessions:", e.message); }
}

async function sendExpoPush(pushToken, title, body, attempt = 0) {
  try {
    const r = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ to: pushToken, title, body, sound: "default" })
    });
    const data = await r.json();
    const result = data?.data;
    if (result?.status === "error") {
      // Expo accepted the HTTP request but rejected the push itself (e.g. bad/expired token)
      console.error(`[push:${pushToken.slice(0, 20)}...] REJECTED — ${result.message || JSON.stringify(result)}`);
      return;
    }
    console.log(`[push:${pushToken.slice(0, 20)}...] sent — ${JSON.stringify(result || data)}`);
  } catch (e) {
    if (attempt < 2) {
      console.log(`[push] Send failed (${e.message}), retrying (${attempt + 1}/2)...`);
      await new Promise(res => setTimeout(res, 1500));
      return sendExpoPush(pushToken, title, body, attempt + 1);
    }
    console.error(`[push:${pushToken.slice(0, 20)}...] send FAILED after retries:`, e.message);
  }
}

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
  "miami fl":"miami hurricanes",
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
//  NCAA sports need an explicit "groups" param or ESPN silently
//  returns only a partial default slate — special/neutral-site
//  games (like international/Week 0 matchups) can be missing
//  entirely without it. Group IDs differ by sport:
//  football/college-football -> 80 (all FBS)
//  basketball/mens-college-basketball -> 50 (all Division I)
// ============================================================
async function fetchGames(sport, attempt = 0) {
  try {
    let params = "limit=100";
    if (sport === "football/college-football") params = "groups=80&limit=500"; // 80 = all FBS
    else if (sport === "basketball/mens-college-basketball") params = "groups=50&limit=500"; // 50 = all Division I
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard?${params}`);
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
  const isCollege = full.split(" ").length >= 2 && (
    NCAAF.includes(nick) || NCAAB.includes(nick) ||
    Object.values(TEAM_ALIASES).filter(v => v === full).length > 0 &&
    (full.includes("state") || full.includes("tar heels") || full.includes("wildcats") ||
     full.includes("bulldogs") || full.includes("tigers") || full.includes("aggies") ||
     full.includes("spartans") || full.includes("huskies") || full.includes("cardinal") ||
     full.includes("crimson") || full.includes("cougars") || full.includes("warriors") ||
     full.includes("longhorns") || full.includes("trojans") || full.includes("bruins"))
  );

  for (const e of events) {
    const n = (e.name || "").toLowerCase();
    const s = (e.shortName || "").toLowerCase();
    // Full-name match — always safe, try first
    if (n.includes(full) || s.includes(full)) return e;
  }

  // Mascot-only fallback — SKIP for college sports to avoid Spartans/Wildcats/etc collisions
  if (isCollege) return null;

  for (const e of events) {
    const n = (e.name || "").toLowerCase();
    const s = (e.shortName || "").toLowerCase();
    const last = full.split(" ").pop();
    if (last.length > 4 && (n.includes(last) || s.includes(last))) return e;
  }
  return null;
}

function ord(n) {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

// Extracts a quick-glance header (score, clock, period, down/distance,
// timeouts) from ESPN's summary-endpoint response, for the live plays screen.
// ESPN's summary shape varies by sport, so every field here is best-effort —
// each one is tried against several plausible locations and falls back to
// null rather than guessing, so a missing field just doesn't render instead
// of showing something wrong. Logs exactly which path matched (or dumps the
// real available keys when none did) so a live test tells us precisely what
// to fix, without another round of guessing.
function extractGameHeader(data, logTag) {
  const headerComp = data?.header?.competitions?.[0];
  const bareComp = data?.competitions?.[0]; // some sports/endpoints put situation here instead
  const competitors = headerComp?.competitors || bareComp?.competitors || [];
  const status = headerComp?.status || bareComp?.status;

  const score = competitors.length >= 2
    ? competitors
        .slice()
        .sort((a, b) => (a.homeAway === "away" ? -1 : 1)) // away first, then home — typical broadcast order
        .map(c => `${c.team?.abbreviation || c.team?.shortDisplayName || c.team?.displayName || ""} ${c.score ?? ""}`.trim())
        .join("  —  ")
    : null;

  const clock = status?.displayClock || null;
  const period = status?.period || null;
  const periodLabel = period ? ord(period) : null;
  console.log(`[header:${logTag}] score=${score ? `"${score}"` : "MISSING"} clock=${clock || "MISSING"} period=${period ?? "MISSING"}`);

  // Football-specific: down & distance — try several plausible locations
  const situationCandidates = [
    { path: "data.situation", obj: data?.situation },
    { path: "headerComp.situation", obj: headerComp?.situation },
    { path: "bareComp.situation", obj: bareComp?.situation },
    { path: "data.drives.current.situation", obj: data?.drives?.current?.situation },
  ];
  let downDistance = null, downDistanceSource = null;
  for (const c of situationCandidates) {
    if (!c.obj) continue;
    const val = c.obj.downDistanceText || c.obj.shortDownDistanceText;
    if (val) { downDistance = val; downDistanceSource = c.path; break; }
  }
  if (downDistance) {
    console.log(`[header:${logTag}] downDistance="${downDistance}" via ${downDistanceSource}`);
  } else {
    const availableKeys = situationCandidates.filter(c => c.obj).map(c => `${c.path}: [${Object.keys(c.obj).join(", ")}]`);
    console.log(`[header:${logTag}] downDistance MISSING. Available situation objects and their keys: ${availableKeys.length ? availableKeys.join(" | ") : "none found at all"}`);
  }

  // Timeouts remaining — field name/location varies by sport and isn't
  // consistently documented; try the most plausible spots.
  const homeTeam = competitors.find(c => c.homeAway === "home");
  const awayTeam = competitors.find(c => c.homeAway === "away");
  const situation = situationCandidates.find(c => c.obj)?.obj;
  const homeTimeouts = homeTeam?.timeouts ?? situation?.homeTimeouts ?? situation?.homeTeamTimeouts ?? null;
  const awayTimeouts = awayTeam?.timeouts ?? situation?.awayTimeouts ?? situation?.awayTeamTimeouts ?? null;
  const timeouts = (homeTimeouts != null && awayTimeouts != null)
    ? `${awayTeam?.team?.abbreviation || "Away"} ${awayTimeouts} — ${homeTeam?.team?.abbreviation || "Home"} ${homeTimeouts} timeouts`
    : null;
  if (timeouts) {
    console.log(`[header:${logTag}] timeouts="${timeouts}"`);
  } else {
    const teamKeys = competitors.map(c => `${c.homeAway}: [${Object.keys(c).join(", ")}]`);
    console.log(`[header:${logTag}] timeouts MISSING. Competitor object keys: ${teamKeys.join(" | ") || "no competitors found"}`);
  }
  return { score, clock, period, periodLabel, downDistance, timeouts };
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
    const isMidInning = detailLower.includes("mid"); // top->bottom of the SAME inning
    const isDelay = detailLower.includes("delay") || detailLower.includes("suspend") || detailLower.includes("postpone");
    const half = detailLower.includes("bot") ? "bottom" : "top";
    const label = isDelay ? "Game delayed" : isEnd ? `End of ${ord(inning)}` : isMidInning ? `Mid ${ord(inning)}` : `${half === "top" ? "Top" : "Bot"} ${ord(inning)}, ${outs ?? 0} outs`;
    return { sport: "mlb", inning, half, outs, isEnd: isEnd || isDelay, isDelay, isMidInning, isTimeout: isMidInning, detail, label };
  }
  if (sport === "basketball/nba" || sport === "basketball/mens-college-basketball") {
    const clock = status.displayClock || "0:00";
    const period = status.period || 1;
    const sportKey = sport === "basketball/nba" ? "nba" : "ncaab";
    const isHalftime = detailLower.includes("half") || detailLower.includes("ht");
    const isEndOfPeriod = detailLower.includes("end") || clock === "0:00";
    const isTimeout = detailLower.includes("timeout");
    const isReview = detailLower.includes("review") || detailLower.includes("challenge");
    const label = isHalftime ? "Halftime" : isEndOfPeriod ? `End of ${ord(period)}` : isTimeout ? `Timeout, ${ord(period)} ${sportKey === "ncaab" ? "half" : "qtr"}` : isReview ? `Under review, ${ord(period)} ${sportKey === "ncaab" ? "half" : "qtr"}` : `${ord(period)} ${sportKey === "ncaab" ? "half" : "qtr"}, ${clock}`;
    // Score is used as a fallback "definitely live" signal — if it changes
    // while we think the game is on break, that's undeniable proof the ball
    // was live, even if our clock/detail parsing missed the exact moment.
    const competitors = comp?.competitors || [];
    const score = competitors.length >= 2 ? competitors.map(c => c.score).join("-") : null;
    return { sport: sportKey, clock, period, isHalftime, isEndOfPeriod, isTimeout, isReview, detail, label, score };
  }
  if (sport === "football/nfl" || sport === "football/college-football") {
    const clock = status.displayClock || "0:00";
    const period = status.period || 1;
    const sportKey = sport === "football/nfl" ? "nfl" : "ncaaf";
    const isHalftime = detailLower.includes("half") || detailLower.includes("ht");
    const isEndOfPeriod = detailLower.includes("end") || clock === "0:00";
    const isTimeout = detailLower.includes("timeout");
    const isReview = detailLower.includes("review") || detailLower.includes("challenge");
    const label = isHalftime ? "Halftime" : isEndOfPeriod ? `End of ${ord(period)}` : isTimeout ? `Timeout, ${ord(period)} qtr` : isReview ? `Under review, ${ord(period)} qtr` : `${ord(period)} qtr, ${clock}`;
    return { sport: sportKey, clock, period, isHalftime, isEndOfPeriod, isTimeout, isReview, detail, label };
  }
  if (sport === "hockey/nhl") {
    const period = status.period || 1;
    const clock = status.displayClock || "0:00";
    const intermission = detailLower.includes("end") || detailLower.includes("intermission") || clock === "0:00";
    const isReview = detailLower.includes("review") || detailLower.includes("challenge");
    return { sport: "nhl", period, clock, intermission, isReview, label: `Period ${period}, ${clock}` };
  }
  if (sport === "soccer/fifa.world") {
    const clock = status.displayClock || "0:00";
    const period = status.period || 1;
    const isHalftime = detailLower.includes("ht") || detailLower.includes("half time") || detailLower.includes("halftime");
    const isETHalftime = period > 2 && (detailLower.includes("ht") || detailLower.includes("break"));
    const isReview = detailLower.includes("var") || detailLower.includes("review");
    const half = period === 1 ? "1st Half" : period === 2 ? "2nd Half" : period === 3 ? "ET 1st" : "ET 2nd";
    const label = (isHalftime || isETHalftime) ? "Halftime" : isReview ? `VAR review, ${half}` : `${half}, ${clock}`;
    return { sport: "soccer", period, clock, isHalftime: isHalftime || isETHalftime, isReview, detail, label };
  }
  return null;
}

// ============================================================
//  NOTIFICATIONS — Expo push (primary) with legacy ntfy fallback
// ============================================================
async function notify(identifier, title, body) {
  if (!identifier) { console.log("[notify] No identifier — skipping"); return; }

  // Expo push tokens look like "ExponentPushToken[...]"
  if (identifier.startsWith("ExponentPushToken")) {
    await sendExpoPush(identifier, title, body);
    console.log(`[push:${identifier.slice(0, 20)}...] FIRED: ${title} — ${body}`);
    return;
  }

  // Legacy ntfy topic (web version)
  try {
    await fetch(`https://ntfy.sh/${identifier}`, {
      method: "POST", body,
      headers: {
        "Title": title.replace(/[^\x00-\x7F]/g, "").trim(),
        "Priority": "high", "Tags": "sports,tv"
      }
    });
    console.log(`[ntfy:${identifier}] FIRED: ${title} — ${body}`);
  } catch (e) { console.error("ntfy fail:", e.message); }
}

// ============================================================
//  SESSION STORE
// ============================================================
const sessions = {};

// Restore any sessions that were active before a restart. Live tracking state
// (states/_sit) intentionally starts fresh — it'll quietly re-initialize on
// the very next poll rather than trying to guess what it missed.
(function restoreSessions() {
  const persisted = loadPersistedSessions();
  const now = Date.now();
  let restored = 0, expired = 0;
  for (const [id, s] of Object.entries(persisted)) {
    if (s.expiresAt && now > s.expiresAt) { expired++; continue; } // don't resurrect old sessions
    sessions[id] = {
      ntfyTopic: s.ntfyTopic,
      pushToken: s.pushToken,
      games: s.games.map(g => ({
        nickname: g.nickname, espnId: null, sport: g.sport,
        status: "searching", detail: "", fullName: "", _sit: null, missingCount: 0, searchMisses: 0
      })),
      states: {}, spotifyEnabled: s.spotifyEnabled, expiresAt: s.expiresAt
    };
    restored++;
  }
  if (restored || expired) console.log(`[restore] Resumed ${restored} session(s), skipped ${expired} already-expired`);
})();

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
    const now = Date.now();
    if (!state.initialized) {
      state.initialized = true;
      state.lastDetail = sit.detail;
      state.lastChangedAt = now;
      state.onCommercial = sit.isEnd;
      console.log(`[${key}] MLB tracking — ${sit.detail} commercial=${sit.isEnd}`);
      if (session.spotifyEnabled) applySpotifyNow(ntfyTopic, sit.isEnd);
      return;
    }
    if (sit.detail !== state.lastDetail) {
      console.log(`[${key}] MLB: "${state.lastDetail}" -> "${sit.detail}"`);
      if (sit.isEnd && !state.onCommercial) {
        // Full-inning break (bottom of an inning just ended) — always a real
        // break, instant, same as before.
        state.onCommercial = true;
        console.log(`[${key}] MLB: Commercial${sit.isDelay ? " (delay)" : ""}`);
      } else if (!sit.isEnd && !sit.isMidInning && state.onCommercial) {
        // Resuming play — whether this was a full-inning break or a mid-inning
        // break that had escalated below — fires the same way either way.
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${sit.half === "top" ? "Top" : "Bottom"} of the ${ord(sit.inning)} starting.`);

        state.onCommercial = false;
        console.log(`[${key}] MLB: BACK LIVE`);
      }
      state.lastDetail = sit.detail;
      state.lastChangedAt = now;
    } else if (sit.isMidInning && !state.onCommercial) {
      // Detail text unchanged, still showing "Mid Xth" — check if it's been
      // going long enough to treat as a real break rather than a quick pause.
      const frozen = now - state.lastChangedAt;
      if (frozen >= MID_INNING_ESCALATE_MS) {
        state.onCommercial = true;
        console.log(`[${key}] MLB: Mid-inning break escalated to real break after ${Math.round(frozen / 1000)}s`);
      } else {
        console.log(`[${key}] ${sit.label} — mid-inning, ${Math.round(frozen / 1000)}s / ${MID_INNING_ESCALATE_MS / 1000}s`);
      }
    } else {
      console.log(`[${key}] ${sit.label} — ${state.onCommercial ? "commercial" : "live"}`);
    }
  }

  // ---- NBA / NCAAB / NFL / NCAAF ----
  else if (["nba","nfl","ncaab","ncaaf"].includes(sit.sport)) {
    // Basketball timeouts are short (20-75s) so a slower threshold avoids false
    // positives on quick stoppages. Football stoppages long enough to freeze the
    // clock (40s+) are almost always a real commercial break, so we can react faster.
    const threshold = (sit.sport === "nba" || sit.sport === "ncaab") ? 110000 : 80000;
    const now = Date.now();
    // Only halftime/end-of-period count as an INSTANT real break — a plain
    // timeout might be quick and never actually cut to commercial, so it only
    // becomes a real break if the clock stays frozen long enough (below).
    const isBreakSignal = sit.isHalftime || sit.isEndOfPeriod;
    const isBasketball = sit.sport === "nba" || sit.sport === "ncaab";
    if (!state.initialized) {
      state.initialized = true;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastDetail = sit.detail;
      state.lastChangedAt = now;
      state.onCommercial = isBreakSignal || false;
      if (isBasketball) state.lastScore = sit.score;
      console.log(`[${key}] ${sit.sport.toUpperCase()} tracking — ${sit.label} commercial=${state.onCommercial}`);
      if (session.spotifyEnabled) applySpotifyNow(ntfyTopic, state.onCommercial);
      return;
    }

    // Fallback signal for basketball: if we think the game is on break but the
    // score just changed anyway, that's undeniable proof the ball was live —
    // catches transitions that happened entirely within a single poll gap and
    // were never directly observed (e.g. a timeout ending, one possession
    // happening, and another stoppage starting, all inside 5 seconds).
    if (isBasketball && state.onCommercial && sit.score && state.lastScore && sit.score !== state.lastScore) {
      notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — score is now ${sit.score}.`);

      state.onCommercial = false;
      state.lastScore = sit.score;
      state.lastDetail = sit.detail;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
      console.log(`[${key}] ${sit.sport.toUpperCase()}: BACK LIVE (score-change fallback — missed the direct transition, score now ${sit.score})`);
      return;
    }
    if (isBasketball) state.lastScore = sit.score;
    const periodJumped = sit.period !== state.lastPeriod;
    const clockMoved = sit.clock !== state.lastClock;
    const detailChanged = sit.detail !== state.lastDetail;

    if (detailChanged) {
      console.log(`[${key}] ${sit.sport.toUpperCase()}: "${state.lastDetail}" -> "${sit.detail}"`);
      if (isBreakSignal && !state.onCommercial) {
        state.onCommercial = true;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: Commercial (instant)`);
      } else if (!isBreakSignal && state.onCommercial) {
        // Detail text moving away from a break signal (e.g. "Timeout" clearing,
        // down/distance reappearing) is itself the resumption signal — don't
        // also wait for the clock to have already ticked, since that requires
        // an entire play to happen first and causes a real one-play lag.
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
      if (sit.isReview) {
        // Replay reviews/challenges can run 45-90s+ but rarely correspond to
        // a real commercial break — the broadcast usually just shows the
        // review live. Keep resetting the clock so review time never counts
        // toward the break threshold, no matter how long it runs.
        state.lastChangedAt = now;
        console.log(`[${key}] ${sit.label} — excluded from break threshold (under review)`);
      } else if (frozen >= threshold && !state.onCommercial) {
        // A quick timeout won't reach here (it resolves before the threshold).
        // One that drags on this long — timeout-labeled or not — is treated
        // as a real break, same as any other sustained frozen clock.
        state.onCommercial = true;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: Commercial (frozen ${Math.round(frozen / 1000)}s${sit.isTimeout ? ", started as timeout" : ""})`);
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
    const isExplicitTimeout = detailLower.includes("timeout");

    // Check intermission entry FIRST, before clock-moved logic — otherwise the
    // clock hitting 0:00 (which itself counts as "the clock moved") steals this
    // poll and delays intermission detection by a full extra cycle.
    if (sit.intermission && !state.onCommercial) {
      state.onCommercial = true;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
      console.log(`[${key}] NHL: Intermission (instant)`);
    } else if (periodChanged || clockMoved) {
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
      const frozen = now - state.lastChangedAt;
      if (sit.isReview) {
        // Reviews rarely go to commercial — never let this count toward a break
        state.lastChangedAt = now;
        console.log(`[${key}] ${sit.label} — excluded from break threshold (under review)`);
      } else if (isExplicitTimeout && !state.onCommercial && frozen >= NHL_TIMEOUT_ESCALATE_MS) {
        // A quick timeout resolves before this — only a sustained one escalates
        state.onCommercial = true;
        console.log(`[${key}] NHL: Timeout escalated to real break after ${Math.round(frozen / 1000)}s`);
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

  if (state.onCommercial) game.status = "commercial";
  else if (sit.isReview) game.status = "review";
  else if (sit.isTimeout) game.status = "timeout";
  else game.status = "live";

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
let pollInProgress = false;

async function pollAll() {
  // Guard against overlap: if a previous cycle is still running when the next
  // tick fires (e.g. many concurrent games/sessions), skip this tick instead
  // of stacking runs on top of each other.
  if (pollInProgress) {
    console.warn(`[pollAll] Previous cycle still running — skipping this tick to avoid overlap`);
    return;
  }
  pollInProgress = true;

  try {
    // Dedupe ESPN calls within a single cycle — if two games (even across
    // different sessions) are tracking the same sport, fetch it once and
    // share the result, instead of hitting ESPN once per game.
    const sportFetchCache = {};
    function getEventsForSport(sport) {
      if (!sportFetchCache[sport]) sportFetchCache[sport] = fetchGames(sport);
      return sportFetchCache[sport];
    }

    // Flatten every (session, game) that needs checking this cycle
    const tasks = [];
    let anyExpired = false;
    for (const [id, session] of Object.entries(sessions)) {
      if (session.expiresAt && Date.now() > session.expiresAt) {
        console.log(`[${id}] Session expired — stopping`);
        delete sessions[id];
        anyExpired = true;
        continue;
      }
      for (const game of session.games) tasks.push({ id, session, game });
    }
    if (anyExpired) saveSessions();

    // Process every game in parallel rather than one-at-a-time, so total
    // cycle time no longer scales with the number of games/sessions.
    await Promise.all(tasks.map(async ({ id, session, game }) => {
      try {
        if (!game.sport) game.sport = detectSport(game.nickname);
        const events = await getEventsForSport(game.sport);

        if (!game.espnId) {
          const event = findEvent(events, game.nickname);
          if (!event) {
            game.status = "not started"; game._sit = null;
            game.searchMisses = (game.searchMisses || 0) + 1;
            if (game.searchMisses === 1 || game.searchMisses % 4 === 0) {
              console.log(`[${game.nickname}] Still searching for a match in ${events.length} ${game.sport} events (attempt ${game.searchMisses})`);
            }
            return;
          }
          game.espnId = event.id; game.fullName = event.name; game.missingCount = 0; game.searchMisses = 0;
          console.log(`[${id}] Locked: "${event.name}" via endpoint=${game.sport}`);
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
          return;
        }

        game.missingCount = 0;

        const comp = event?.competitions?.[0];
        const status = comp?.status;
        const rawSit = comp?.situation;
        const espnState = status?.type?.state; // "pre" | "in" | "post"
        console.log(`[${game.nickname}] state=${espnState} detail="${status?.type?.shortDetail}" outs=${rawSit?.outs ?? "n/a"}`);

        if (espnState === "post") {
          // Game finished — ESPN keeps it listed (state=post) rather than
          // removing it, so check this directly instead of only relying on
          // the game disappearing from the scoreboard entirely.
          if (game.status !== "final") {
            game.status = "final"; game._sit = null;
            notify(session.ntfyTopic, "Game over!", `${game.fullName || game.nickname} is final. ${status?.type?.shortDetail || ""}`.trim());
            console.log(`[${game.nickname}] Game ended — ESPN reports final (${status?.type?.shortDetail || status?.type?.description || "no detail"})`);
          }
          return;
        }

        if (espnState === "pre") {
          game.status = "not started"; game._sit = null;
          return;
        }

        const sit = getSituation(event, game.sport);
        if (!sit) { game.status = "not started"; game._sit = null; return; }

        game._sit = sit; game.detail = sit.label;
        processGame(session, game);

      } catch (e) {
        console.error(`[${id}/${game.nickname}]`, e.message);
        game.status = "error";
      }
    }));
  } finally {
    pollInProgress = false;
  }
}

setInterval(pollAll, POLL_MS);
pollAll();

// ============================================================
//  SEASON CHECK — skip sports that aren't currently in season
// ============================================================
function isInSeason(sport) {
  const m = new Date().getMonth() + 1; // 1-12
  const y = new Date().getFullYear();
  switch (sport) {
    case "baseball/mlb": return m >= 3 && m <= 11;
    case "basketball/nba": return m >= 10 || m <= 6;
    case "football/nfl": return m >= 9 || m <= 1;
    case "hockey/nhl": return m >= 10 || m <= 6;
    case "football/college-football": return m >= 8 || m <= 1;
    case "basketball/mens-college-basketball": return m >= 11 || m <= 4;
    case "soccer/fifa.world": return y === 2026 && m >= 6 && m <= 7;
    default: return true;
  }
}

// ============================================================
//  CONFLICT DETECTION (shared by /schedule-check and daily push job)
// ============================================================
async function findScheduleConflicts(teams) {
  const results = [];
  const sportGroups = {};
  for (const t of teams) {
    const sport = detectSport(t.key);
    if (!isInSeason(sport)) {
      console.log(`[schedule-check] Skipping ${t.key} — ${sport} not in season`);
      continue;
    }
    if (!sportGroups[sport]) sportGroups[sport] = [];
    sportGroups[sport].push(t);
  }

  for (const [sport, teamList] of Object.entries(sportGroups)) {
    try {
      const events = await fetchGames(sport);
      for (const t of teamList) {
        const event = findEvent(events, t.key);
        if (event) {
          const comp = event?.competitions?.[0];
          const date = event?.date;
          const status = comp?.status?.type?.state;
          results.push({ key: t.key, sport: t.sport, name: event.name, date, status, eventId: event.id });
        }
      }
    } catch (e) {
      console.error(`[schedule-check] ${sport}:`, e.message);
    }
  }

  const conflicts = [];
  const todayStr = new Date().toISOString().split("T")[0];
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i], b = results[j];
      if (!a.date || !b.date) continue;
      // Skip if both teams are in the same game (playing each other)
      if (a.eventId && b.eventId && a.eventId === b.eventId) continue;
      // Also skip if game names match (same game, different alias)
      if (a.name && b.name && a.name === b.name) continue;
      // Only flag conflicts for games actually happening today
      const aDate = new Date(a.date).toISOString().split("T")[0];
      const bDate = new Date(b.date).toISOString().split("T")[0];
      if (aDate !== todayStr || bDate !== todayStr) continue;
      const diffMs = Math.abs(new Date(a.date).getTime() - new Date(b.date).getTime());
      const twoHours = 2 * 60 * 60 * 1000;
      if (diffMs <= twoHours && (a.status === "pre" || a.status === "in") && (b.status === "pre" || b.status === "in")) {
        conflicts.push({ teamA: a, teamB: b });
      }
    }
  }

  return { games: results, conflicts };
}

// ============================================================
//  DAILY PUSH NOTIFICATION JOB
//  Checks every registered user's favorites once per day,
//  sends a push if there's a same-day conflict.
// ============================================================
async function runDailyPushCheck() {
  const today = new Date().toISOString().split("T")[0]; // "YYYY-MM-DD"
  const tokens = Object.keys(pushTokens);
  if (tokens.length === 0) return;

  console.log(`[daily-push] Running check for ${tokens.length} user(s)`);

  for (const token of tokens) {
    const entry = pushTokens[token];
    if (entry.lastNotifiedDate === today) continue; // already notified today
    if (!entry.favorites || entry.favorites.length < 2) continue;

    try {
      const { conflicts } = await findScheduleConflicts(entry.favorites);
      if (conflicts.length > 0) {
        const c = conflicts[0];
        const timeA = new Date(c.teamA.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const timeB = new Date(c.teamB.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        await sendExpoPush(
          token,
          "Two of your teams play today!",
          `${c.teamA.name} (${timeA}) and ${c.teamB.name} (${timeB}) — open BackLive to track both.`
        );
        entry.lastNotifiedDate = today;
        savePushTokens();
      }
    } catch (e) {
      console.error(`[daily-push] error for token ${token.slice(0, 20)}...:`, e.message);
    }
  }
}

// Target 11am Eastern Time (handles EST/EDT automatically)
function scheduleNextCheck() {
  const now = new Date();

  // Get current time in Eastern timezone
  const easternNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const target = new Date(easternNow);
  target.setHours(11, 0, 0, 0);
  if (easternNow >= target) target.setDate(target.getDate() + 1); // tomorrow if past 11am today

  // Convert the Eastern target time back to a real timestamp by computing the offset
  const offsetMs = now.getTime() - easternNow.getTime();
  const targetUtc = new Date(target.getTime() + offsetMs);

  const msUntilTarget = targetUtc.getTime() - now.getTime();
  console.log(`[daily-push] Next 11am ET check in ${Math.round(msUntilTarget / 60000)} minutes`);

  setTimeout(() => {
    runDailyPushCheck();
    setInterval(runDailyPushCheck, 24 * 60 * 60 * 1000);
  }, Math.max(msUntilTarget, 0));
}

scheduleNextCheck();
// Safety net — also run shortly after startup in case server restarts mid-day
setTimeout(runDailyPushCheck, 30000);

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
    const { pushToken, ntfyTopic, games, gameSports, key } = body;
    const sessionId = pushToken || ntfyTopic;
    if (key !== SECRET_KEY) { jsonRes(res, 401, { error: "Unauthorized" }); return; }
    if (!sessionId || !games?.length) { jsonRes(res, 400, { error: "Missing pushToken/ntfyTopic or games" }); return; }
    const hasSpotify = !!spotifyTokens[sessionId] && games.length === 1;
    if (hasSpotify) {
      console.log(`[${sessionId}] Refreshing Spotify token at session start`);
      refreshSpotifyToken(sessionId);
    }

    // Sport map from UI tab IDs to ESPN endpoints
    const sportEndpointMap = {
      "mlb": "baseball/mlb",
      "nba": "basketball/nba",
      "nfl": "football/nfl",
      "nhl": "hockey/nhl",
      "ncaaf": "football/college-football",
      "ncaab": "basketball/mens-college-basketball",
      "soccer": "soccer/fifa.world",
    };

    sessions[sessionId] = {
      ntfyTopic: sessionId,
      pushToken: pushToken || null,
      games: games.map((n, i) => {
        const tag = gameSports?.[i];
        const mapped = tag ? sportEndpointMap[tag] : null;
        const finalSport = mapped || detectSport(n);
        if (!tag) {
          console.warn(`[${sessionId}] WARNING: "${n}" had no sport tag from the client — falling back to ambiguous detectSport() -> ${finalSport}. This can misidentify teams that exist in multiple sports (e.g. college football vs basketball).`);
        } else if (!mapped) {
          console.warn(`[${sessionId}] WARNING: "${n}" sent unrecognized sport tag "${tag}" — falling back to detectSport() -> ${finalSport}`);
        }
        return {
          nickname: n,
          espnId: null,
          sport: finalSport,
          status: "searching", detail: "", fullName: "", _sit: null, missingCount: 0, searchMisses: 0
        };
      }),
      states: {}, spotifyEnabled: hasSpotify,
      expiresAt: Date.now() + SESSION_TTL_MS
    };
    saveSessions();
    notify(sessionId, "BackLive is watching!", `Tracking: ${games.join(", ")} (auto-stops in 8h)`);
    console.log(`[${sessionId}] Started: ${games.join(", ")} sports=${JSON.stringify(gameSports)} spotify=${hasSpotify}`);
    jsonRes(res, 200, { ok: true, spotifyConnected: !!spotifyTokens[sessionId], spotifyEnabled: hasSpotify });
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

  // Pull-based only — the user has to actively request this, it is never
  // pushed. That's the whole point: no spoiler risk, since nothing shows up
  // unless you've chosen to look at this exact moment.
  if (req.method === "GET" && url.pathname === "/plays") {
    const id = url.searchParams.get("session");
    const gameKey = url.searchParams.get("game"); // which tracked game, if more than one
    const s = sessions[id];
    if (!s) { jsonRes(res, 404, { error: "No session" }); return; }
    const game = gameKey ? s.games.find(g => g.nickname === gameKey) : s.games[0];
    if (!game) { jsonRes(res, 404, { error: "Game not found in session" }); return; }
    if (!game.espnId) { jsonRes(res, 200, { plays: [], fullName: game.fullName, note: "Game not locked yet" }); return; }
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${game.sport}/summary?event=${game.espnId}`);
      if (!r.ok) throw new Error(`ESPN ${r.status}`);
      const data = await r.json();
      // ESPN's summary endpoint structures plays differently by sport — try a
      // flat "plays" array first (common for basketball/baseball/hockey/soccer),
      // fall back to football's drive-nested structure if that's empty.
      let rawPlays = Array.isArray(data.plays) ? data.plays : [];
      let playsSource = "data.plays (flat)";
      if (rawPlays.length === 0 && data.drives?.previous) {
        rawPlays = data.drives.previous.flatMap(d => d.plays || []);
        playsSource = "data.drives.previous[].plays (nested)";
      }
      const plays = rawPlays
        .map(p => ({
          text: p.text || p.shortText || "",
          clock: p.clock?.displayValue || null,
          period: p.period?.number || null,
          scoringPlay: !!p.scoringPlay
        }))
        .filter(p => p.text)
        .slice(-30)
        .reverse(); // most recent first
      console.log(`[plays:${game.nickname}] Found ${rawPlays.length} raw plays via ${playsSource}, ${plays.length} after filtering`);
      const header = extractGameHeader(data, game.nickname);
      jsonRes(res, 200, { plays, fullName: game.fullName, header });
    } catch (e) {
      console.error(`[plays] ${game.nickname}:`, e.message);
      jsonRes(res, 500, { error: e.message, plays: [] });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/stop") {
    const { ntfyTopic } = await readBody(req);
    delete sessions[ntfyTopic];
    saveSessions();
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

  if (req.method === "POST" && url.pathname === "/register-push") {
    const body = await readBody(req);
    const { pushToken, favorites } = body;
    if (!pushToken || !favorites) { jsonRes(res, 400, { error: "Missing pushToken or favorites" }); return; }
    pushTokens[pushToken] = {
      favorites,
      lastNotifiedDate: pushTokens[pushToken]?.lastNotifiedDate || null
    };
    savePushTokens();
    console.log(`[push] Registered token ${pushToken.slice(0, 20)}... with ${favorites.length} favorites`);
    jsonRes(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/schedule-check") {
    const body = await readBody(req);
    const { teams } = body;
    if (!teams?.length) { jsonRes(res, 400, { error: "Missing teams" }); return; }
    const result = await findScheduleConflicts(teams);
    jsonRes(res, 200, result);
    return;
  }

  jsonRes(res, 404, { error: "Not found" });

}).listen(PORT, () => {
  console.log(`BackLive v30 running on port ${PORT}`);
  console.log(`Poll: ${POLL_MS / 1000}s | Grace: ${FINAL_GRACE_POLLS} polls | ESPN retries: ${ESPN_RETRY}`);
  console.log(`Spotify tokens loaded: ${Object.keys(spotifyTokens).length}`);
});
