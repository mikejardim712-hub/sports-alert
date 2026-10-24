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
// These are now all used purely as fallback safety nets — play-by-play-based
// detection (checked elsewhere) catches the vast majority of breaks instantly
// or near-instantly; these only matter when that data isn't available.
const MID_INNING_ESCALATE_MS = 90000;

// Real-world break lengths, by sport, backed by actual published rules or
// measured data rather than guesses:
//
// MLB — published pace-of-play rules. Timer starts at the 3rd out (same
// moment our code detects), and the rules explicitly forbid the first pitch
// more than 5s before the timer ends, specifically to guarantee the
// broadcast is back from commercial by then.
//   local 2:15, national 2:40, playoff 3:10
//
// NHL — "TV timeouts" are a distinct, rule-governed break (not the rare
// 30-60s team timeout): ~2 minutes, triggered at the first stoppage after
// the 14:00/10:00/6:00 marks each period, never after a goal/icing/power
// play. No evidence found of a playoff-specific difference.
//   120s, regular season and playoff alike
//
// NBA — full timeout is 75-100s on the court, but actual measured data (a
// real regression analysis of game-length data, not just the on-paper
// timeout rule) shows the real broadcast impact is closer to 2:06 in the
// regular season and about 30s longer in the playoffs.
//   regular 126s, playoff 156s
//
// NCAAB — a genuinely different structure from the NBA, not a smaller
// version of it: scheduled "media timeouts" at the first dead ball under
// 16/12/8/4 minutes of each half, independent of whether either team called
// a timeout. Multiple sources document these at 60-75s in the regular
// season — meaningfully shorter than the NBA's real figure above. The NCAA
// tournament extends coverage (the first timeout in BOTH halves becomes a
// full media timeout, not just the second half, per NCAA tournament rules)
// and is widely documented by frustrated viewers as running noticeably
// longer — no single exact tournament figure found, so this is a reasonable
// estimate of that documented lengthening rather than as precisely sourced
// as the 75s regular-season number.
//
// NFL — ad inventory agreements cap breaks at 2:20; no strong evidence of a
// playoff-specific difference (one source says length doesn't change
// significantly, another says playoff breaks are "sometimes" longer).
//   140s, regular season and playoff alike
//
// NCAAF — college TV timeouts run distinctly longer than the NFL's capped
// structure (no equivalent 2-minute-20 cap, described as "ruining games 3
// minutes at a time"). Kept separate from NFL rather than sharing one value.
//   180s
const BREAK_LENGTHS_MS = {
  mlb: { local: 135000, national: 160000, playoff: 190000 },
  nhl: { regular: 120000, playoff: 120000 },
  nba: { regular: 126000, playoff: 156000 },
  ncaab: { regular: 75000, playoff: 110000 },
  nfl: { regular: 140000, playoff: 140000 },
  ncaaf: { regular: 180000, playoff: 180000 },
};

// Networks that broadcast nationally — anything else found in ESPN's
// broadcast data is treated as a local/regional feed. Only matters for MLB,
// where local-vs-national is the real factor (the other sports' thresholds
// above depend on season type, not broadcast reach).
const NATIONAL_NETWORKS = ["ESPN", "ESPN2", "FOX", "FS1", "TBS", "ABC", "NBC", "CBS", "MLB Network", "NBA TV", "NFL Network", "Apple TV+", "Roku", "Peacock", "Amazon"];

function isNationalBroadcast(event) {
  const broadcasts = event?.competitions?.[0]?.broadcasts || [];
  const names = broadcasts.flatMap(b => b.names || []);
  return names.some(n => NATIONAL_NETWORKS.some(nat => n.toUpperCase().includes(nat.toUpperCase())));
}

function isPostseason(event) {
  return event?.season?.type === 3; // ESPN: 1=pre, 2=regular, 3=postseason
}

function mlbBreakLengthMs(event) {
  if (isPostseason(event)) return BREAK_LENGTHS_MS.mlb.playoff;
  return isNationalBroadcast(event) ? BREAK_LENGTHS_MS.mlb.national : BREAK_LENGTHS_MS.mlb.local;
}

// For NBA/NCAAB/NFL/NCAAF/NHL — only season type matters per the research
// above, not broadcast reach, so this is simpler than the MLB version.
function breakLengthMs(sportKey, event) {
  const lengths = BREAK_LENGTHS_MS[sportKey];
  if (!lengths) return 120000;
  return isPostseason(event) ? lengths.playoff : lengths.regular;
}

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

async function spotifyAction(ntfyTopic, action, method = "PUT") {
  // action = "pause", "play", "next", or "previous"
  const token = await getSpotifyToken(ntfyTopic);
  if (!token) {
    console.log(`[spotify:${ntfyTopic}] No token — skipping ${action}`);
    return;
  }
  try {
    const r = await fetch(`https://api.spotify.com/v1/me/player/${action}`, {
      method,
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
          method,
          headers: { "Authorization": `Bearer ${newToken}` }
        });
        console.log(`[spotify:${ntfyTopic}] ${action} retry — status ${retry.status}`);
      }
    } else if (r.status === 404) {
      if (action === "play") {
        // No active device — Spotify app may be open but idle. Look for an
        // available (inactive) device and explicitly start playback there.
        console.log(`[spotify:${ntfyTopic}] No active device for play — checking for an available device`);
        try {
          const devicesR = await fetch("https://api.spotify.com/v1/me/player/devices", {
            headers: { "Authorization": `Bearer ${token}` }
          });
          const devicesData = await devicesR.json();
          const devices = devicesData.devices || [];
          const device = devices.find(d => !d.is_restricted) || devices[0];
          if (device) {
            const retry = await fetch("https://api.spotify.com/v1/me/player/play", {
              method: "PUT",
              headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ device_id: device.id })
            });
            console.log(`[spotify:${ntfyTopic}] play retry on device "${device.name}" — status ${retry.status}`);
          } else {
            console.log(`[spotify:${ntfyTopic}] No available devices found at all — Spotify app is likely fully closed`);
          }
        } catch (e) {
          console.error(`[spotify:${ntfyTopic}] device lookup error:`, e.message);
        }
      } else {
        console.log(`[spotify:${ntfyTopic}] No active device for ${action} — user may not have Spotify open`);
      }
    } else if (r.status === 403) {
      console.log(`[spotify:${ntfyTopic}] ${action} forbidden — may need premium`);
    } else {
      console.log(`[spotify:${ntfyTopic}] ${action} — status ${r.status}`);
    }
  } catch (e) { console.error(`[spotify:${ntfyTopic}] ${action} error:`, e.message); }
}

function spotifyPause(ntfyTopic) { return spotifyAction(ntfyTopic, "pause", "PUT"); }
function spotifyResume(ntfyTopic) { return spotifyAction(ntfyTopic, "play", "PUT"); }
function spotifyNext(ntfyTopic) { return spotifyAction(ntfyTopic, "next", "POST"); }
function spotifyPrevious(ntfyTopic) { return spotifyAction(ntfyTopic, "previous", "POST"); }

// Fetches what's currently playing — used for the "now playing" mini player.
// Read-only, no side effects, safe to poll periodically.
async function getCurrentlyPlaying(ntfyTopic) {
  const token = await getSpotifyToken(ntfyTopic);
  if (!token) return { connected: false };
  try {
    const r = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (r.status === 204) return { connected: true, isPlaying: false, track: null }; // nothing playing
    if (r.status === 401) {
      const newToken = await refreshSpotifyToken(ntfyTopic);
      if (!newToken) return { connected: false };
      const retry = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
        headers: { "Authorization": `Bearer ${newToken}` }
      });
      if (retry.status === 204 || !retry.ok) return { connected: true, isPlaying: false, track: null };
      return parseCurrentlyPlaying(await retry.json());
    }
    if (!r.ok) return { connected: true, isPlaying: false, track: null };
    return parseCurrentlyPlaying(await r.json());
  } catch (e) {
    console.error(`[spotify:${ntfyTopic}] now-playing error:`, e.message);
    return { connected: false };
  }
}

function parseCurrentlyPlaying(data) {
  if (!data || !data.item) return { connected: true, isPlaying: false, track: null };
  return {
    connected: true,
    isPlaying: !!data.is_playing,
    track: {
      name: data.item.name,
      artist: (data.item.artists || []).map(a => a.name).join(", "),
      album: data.item.album?.name || null,
      albumArt: data.item.album?.images?.[0]?.url || null,
      progressMs: data.progress_ms || 0,
      durationMs: data.item.duration_ms || 0
    }
  };
}

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
};

const MLB    = ["angels","astros","athletics","blue jays","braves","brewers","cardinals","cubs","diamondbacks","dbacks","dodgers","giants","guardians","mariners","marlins","mets","nationals","orioles","padres","phillies","pirates","rangers","rays","red sox","reds","rockies","royals","tigers","twins","white sox","yankees"];
const NBA    = ["76ers","sixers","bucks","bulls","cavaliers","cavs","celtics","clippers","grizzlies","hawks","heat","hornets","jazz","kings","knicks","lakers","magic","mavericks","mavs","nets","nuggets","pacers","pelicans","pistons","raptors","rockets","spurs","suns","thunder","timberwolves","wolves","trail blazers","blazers","warriors","wizards"];
const NFL    = ["49ers","bears","bengals","bills","broncos","browns","buccaneers","bucs","chargers","chiefs","colts","commanders","cowboys","dolphins","eagles","falcons","giants","jaguars","jets","lions","packers","panthers","patriots","pats","raiders","rams","ravens","saints","seahawks","steelers","texans","titans","vikings"];
const NHL    = ["avalanche","avs","blackhawks","blue jackets","blues","bruins","canadiens","habs","canucks","capitals","caps","coyotes","devils","ducks","flames","flyers","golden knights","knights","hurricanes","canes","islanders","kraken","lightning","bolts","maple leafs","leafs","oilers","penguins","pens","predators","preds","red wings","sabres","senators","sens","sharks","stars","wild","winnipeg jets","florida panthers","new york rangers"];
const NCAAF  = ["alabama","crimson tide","georgia bulldogs","buckeyes","ohio state","wolverines","michigan","clemson","lsu","florida state","seminoles","notre dame","fighting irish","oklahoma","sooners","longhorns","penn state","nittany lions","oregon","usc","trojans","gators","florida","vols","tennessee","auburn","razorbacks","arkansas","ole miss","rebels","gamecocks","south carolina","missouri","vanderbilt","commodores","kentucky","aggies","badgers","wisconsin","hawkeyes","iowa","cornhuskers","nebraska","illini","illinois","hoosiers","indiana","boilermakers","purdue","northwestern","rutgers","scarlet knights","maryland","terps","spartans","michigan state","oklahoma state","baylor","horned frogs","tcu","kansas state","cyclones","iowa state","mountaineers","west virginia","jayhawks","kansas","red raiders","texas tech","buffs","colorado","utes","utah","huskies","washington","sun devils","arizona state","stanford","cardinal","golden bears","cal","bruins","ucla","pitt","pittsburgh","bc eagles","boston college","blue devils","duke","tar heels","unc","wolfpack","nc state","cavaliers","virginia","hokies","virginia tech","yellow jackets","georgia tech","demon deacons","wake forest","orange","syracuse","louisville","army","navy","byu"];
const NCAAB  = ["gonzaga","zags","villanova","nova","uconn","connecticut","xavier","musketeers","creighton","marquette","seton hall","providence","friars","st johns","red storm","butler","dayton","saint mary's","gaels","memphis","cougars","houston","shockers","wichita state","bearcats","cincinnati","merrimack","merrimack warriors"];

function detectSport(n) {
  n = n.toLowerCase();
  if (n.includes("ncaaf") || NCAAF.some(t => n.includes(t))) return "football/college-football";
  if (n.includes("ncaab") || NCAAB.some(t => n.includes(t))) return "basketball/mens-college-basketball";
  if (MLB.some(t => n.includes(t))) return "baseball/mlb";
  if (NBA.some(t => n.includes(t))) return "basketball/nba";
  if (NFL.some(t => n.includes(t))) return "football/nfl";
  if (NHL.some(t => n.includes(t))) return "hockey/nhl";
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

// MLB's own official Stats API (statsapi.mlb.com) updates after every single
// pitch — far more granular than ESPN's inning-level status. Used here as a
// faster confirmation signal layered on top of the broadcast-aware delay
// above: if MLB's own feed shows a pitch has actually been thrown, we don't
// need to wait out the rest of the delay. Every call here is wrapped so any
// failure (API down, shape changed, team not found) just means we fall back
// to the delay timer — this never blocks or breaks existing MLB tracking.
const mlbGamePkCache = {}; // nickname -> { gamePk, fetchedAt }
const MLB_GAMEPK_CACHE_MS = 6 * 60 * 60 * 1000; // a day's games don't change

async function findMlbGamePk(nickname) {
  const cached = mlbGamePkCache[nickname];
  if (cached && Date.now() - cached.fetchedAt < MLB_GAMEPK_CACHE_MS) return cached.gamePk;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}`);
    if (!r.ok) return null;
    const data = await r.json();
    const games = (data.dates || []).flatMap(d => d.games || []);
    const nick = nickname.toLowerCase().replace(/ game$/, "").trim();
    const full = TEAM_ALIASES[nick] || nick;
    const match = games.find(g => {
      const home = (g.teams?.home?.team?.name || "").toLowerCase();
      const away = (g.teams?.away?.team?.name || "").toLowerCase();
      return home.includes(full) || away.includes(full) || full.includes(home.split(" ").pop()) || full.includes(away.split(" ").pop());
    });
    if (!match) return null;
    mlbGamePkCache[nickname] = { gamePk: match.gamePk, fetchedAt: Date.now() };
    return match.gamePk;
  } catch {
    return null;
  }
}

// Returns an identity string for the current at-bat's pitch activity. If this
// changes between checks, a real pitch was thrown — the most precise "has
// play resumed" signal available for MLB.
async function getMlbPitchActivity(gamePk) {
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
    if (!r.ok) return null;
    const data = await r.json();
    const current = data?.liveData?.plays?.currentPlay;
    if (!current) return null;
    return `${current.about?.atBatIndex ?? "?"}:${current.playEvents?.length ?? 0}`;
  } catch {
    return null;
  }
}

// NHL's own official API (api-web.nhle.com) — used here purely as a parallel,
// redundant signal alongside ESPN's play-by-play, not a replacement. NHL's
// existing detection already works via ESPN + clock movement; this just adds
// a second independent source that might occasionally confirm a new play a
// poll cycle earlier. Same fail-safe design — any error just means this
// check contributes nothing that poll, never blocks anything.
const nhlGameIdCache = {};
const NHL_GAMEID_CACHE_MS = 6 * 60 * 60 * 1000;

async function findNhlGameId(nickname) {
  const cached = nhlGameIdCache[nickname];
  if (cached && Date.now() - cached.fetchedAt < NHL_GAMEID_CACHE_MS) return cached.gameId;
  try {
    const r = await fetch(`https://api-web.nhle.com/v1/score/now`);
    if (!r.ok) return null;
    const data = await r.json();
    const games = data.games || [];
    const nick = nickname.toLowerCase().replace(/ game$/, "").trim();
    const full = TEAM_ALIASES[nick] || nick;
    const match = games.find(g => {
      const home = (g.homeTeam?.name?.default || "").toLowerCase();
      const away = (g.awayTeam?.name?.default || "").toLowerCase();
      return home.includes(full) || away.includes(full) || full.includes(home.split(" ").pop()) || full.includes(away.split(" ").pop());
    });
    if (!match) return null;
    nhlGameIdCache[nickname] = { gameId: match.id, fetchedAt: Date.now() };
    return match.id;
  } catch {
    return null;
  }
}

async function getNhlLatestPlayText(gameId) {
  try {
    const r = await fetch(`https://api-web.nhle.com/v1/gamecenter/${gameId}/play-by-play`);
    if (!r.ok) return null;
    const data = await r.json();
    const plays = data.plays || [];
    if (!plays.length) return null;
    const latest = plays[plays.length - 1];
    return (latest?.typeDescKey || "").toLowerCase() || null;
  } catch {
    return null;
  }
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
function extractGameHeader(data, logTag, sport) {
  const headerComp = data?.header?.competitions?.[0];
  const bareComp = data?.competitions?.[0]; // some sports/endpoints put situation here instead
  const competitors = headerComp?.competitors || bareComp?.competitors || [];
  const status = headerComp?.status || bareComp?.status;
  const isBaseball = sport === "baseball/mlb";

  const score = competitors.length >= 2
    ? competitors
        .slice()
        .sort((a, b) => (a.homeAway === "away" ? -1 : 1)) // away first, then home — typical broadcast order
        .map(c => `${c.team?.abbreviation || c.team?.shortDisplayName || c.team?.displayName || ""} ${c.score ?? ""}`.trim())
        .join("  —  ")
    : null;

  // Baseball has no real countdown clock — ESPN just reports a static "0:00",
  // which is meaningless to show. Skip it entirely for that sport.
  const clock = isBaseball ? null : (status?.displayClock || null);
  const period = status?.period || null;
  // For baseball, prefer the fuller "Top 7th"/"Bot 7th" text over a bare
  // ordinal, since inning half matters and a plain "7th" is ambiguous.
  const shortDetail = status?.type?.shortDetail || "";
  let periodLabel = null, periodLabelSource = null;
  if (isBaseball) {
    if (shortDetail) {
      periodLabel = shortDetail;
      periodLabelSource = "status.type.shortDetail";
    } else {
      // Fallback: try to build "Top/Bot Xth" from a structured half-inning
      // flag, if shortDetail wasn't available on this data path.
      const situationForHalf = data?.situation || headerComp?.situation || bareComp?.situation;
      const isTop = situationForHalf?.isTopInning;
      if (isTop != null && period) {
        periodLabel = `${isTop ? "Top" : "Bot"} ${ord(period)}`;
        periodLabelSource = "situation.isTopInning";
      } else if (period) {
        periodLabel = ord(period); // last resort — no half-inning info found anywhere
        periodLabelSource = "ord(period) only, no half-inning source found";
      }
    }
    console.log(`[header:${logTag}] periodLabel="${periodLabel}" via ${periodLabelSource} (raw shortDetail="${shortDetail}")`);
  } else {
    periodLabel = period ? ord(period) : null;
  }
  console.log(`[header:${logTag}] score=${score ? `"${score}"` : "MISSING"} clock=${clock ?? "N/A (baseball)"} period=${periodLabel ?? "MISSING"}`);

  let downDistance = null, timeouts = null, outsText = null, basesText = null;

  if (isBaseball) {
    // Outs and baserunners — best-effort field names based on common ESPN
    // convention, logged either way so a live test tells us definitively.
    const situationCandidates = [
      { path: "data.situation", obj: data?.situation },
      { path: "headerComp.situation", obj: headerComp?.situation },
      { path: "bareComp.situation", obj: bareComp?.situation },
    ];
    const bSit = situationCandidates.find(c => c.obj)?.obj;
    if (bSit && bSit.outs != null) {
      outsText = `${bSit.outs} out${bSit.outs === 1 ? "" : "s"}`;
      console.log(`[header:${logTag}] outs="${outsText}"`);
    } else {
      console.log(`[header:${logTag}] outs MISSING. Situation keys: ${bSit ? Object.keys(bSit).join(", ") : "no situation object found"}`);
    }
    if (bSit && (bSit.onFirst != null || bSit.onSecond != null || bSit.onThird != null)) {
      const runners = [];
      if (bSit.onFirst) runners.push("1st");
      if (bSit.onSecond) runners.push("2nd");
      if (bSit.onThird) runners.push("3rd");
      basesText = runners.length === 0 ? "Bases empty"
        : runners.length === 1 ? `Runner on ${runners[0]}`
        : `Runners on ${runners.join(", ")}`;
      console.log(`[header:${logTag}] bases="${basesText}"`);
    } else {
      console.log(`[header:${logTag}] baserunner fields MISSING. Situation keys: ${bSit ? Object.keys(bSit).join(", ") : "no situation object found"}`);
    }
  } else {
    // Football-specific: down & distance — try several plausible locations
    const situationCandidates = [
      { path: "data.situation", obj: data?.situation },
      { path: "headerComp.situation", obj: headerComp?.situation },
      { path: "bareComp.situation", obj: bareComp?.situation },
      { path: "data.drives.current.situation", obj: data?.drives?.current?.situation },
    ];
    let downDistanceSource = null;
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
    timeouts = (homeTimeouts != null && awayTimeouts != null)
      ? `${awayTeam?.team?.abbreviation || "Away"} ${awayTimeouts} — ${homeTeam?.team?.abbreviation || "Home"} ${homeTimeouts} timeouts`
      : null;
    if (timeouts) {
      console.log(`[header:${logTag}] timeouts="${timeouts}"`);
    } else {
      const teamKeys = competitors.map(c => `${c.homeAway}: [${Object.keys(c).join(", ")}]`);
      console.log(`[header:${logTag}] timeouts MISSING. Competitor object keys: ${teamKeys.join(" | ") || "no competitors found"}`);
    }
  }

  return { score, clock, period, periodLabel, downDistance, timeouts, outsText, basesText };
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
    // NCAAB-only: media timeouts are scheduled at the first dead ball UNDER
    // 16/12/8/4 minutes of each half — not a maybe, like an NBA timeout, but
    // a guaranteed real break by rule. "Under" means any time after crossing
    // that threshold (until the next one), not just near the exact mark —
    // e.g. a stoppage at 15:40 still counts for the 16:00 marker, it's just
    // whenever the first whistle happens to land after the clock crosses it.
    const isNcaabMediaTimeoutMark = sportKey === "ncaab" && isTimeout && (() => {
      const m = clock.match(/^(\d+):(\d+)$/);
      if (!m) return false;
      const totalSec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      const marks = [16, 12, 8, 4].map(x => x * 60); // [960, 720, 480, 240]
      return marks.some((mark, i) => {
        const nextLower = marks[i + 1] ?? 0; // 4:00's zone runs down to 0:00
        return totalSec <= mark && totalSec > nextLower;
      });
    })();
    const label = isHalftime ? "Halftime" : isEndOfPeriod ? `End of ${ord(period)}` : isTimeout ? `Timeout, ${ord(period)} ${sportKey === "ncaab" ? "half" : "qtr"}` : isReview ? `Under review, ${ord(period)} ${sportKey === "ncaab" ? "half" : "qtr"}` : `${ord(period)} ${sportKey === "ncaab" ? "half" : "qtr"}, ${clock}`;
    // Score is used as a fallback "definitely live" signal — if it changes
    // while we think the game is on break, that's undeniable proof the ball
    // was live, even if our clock/detail parsing missed the exact moment.
    const competitors = comp?.competitors || [];
    const score = competitors.length >= 2 ? competitors.map(c => c.score).join("-") : null;
    return { sport: sportKey, clock, period, isHalftime, isEndOfPeriod, isTimeout, isNcaabMediaTimeoutMark, isReview, detail, label, score };
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

async function processGame(session, game) {
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
      // Broader guess for the one-time startup Spotify sync — a visible
      // mid-inning break counts too, even though it's not yet confirmed as
      // a real commercial for badge/notification purposes.
      if (session.spotifyEnabled) applySpotifyNow(ntfyTopic, sit.isEnd || sit.isMidInning);
      return;
    }
    if (sit.detail !== state.lastDetail) {
      console.log(`[${key}] MLB: "${state.lastDetail}" -> "${sit.detail}"`);
      if (sit.isEnd && !state.onCommercial) {
        // Full-inning break (bottom of an inning just ended) — always a real
        // break, instant.
        state.onCommercial = true;
        state.backLivePendingSince = null;
        console.log(`[${key}] MLB: Commercial${sit.isDelay ? " (delay)" : ""}`);
      } else if (!sit.isEnd && !sit.isMidInning && state.onCommercial && !state.backLivePendingSince) {
        // ESPN's data just flipped to the new half-inning — wait for MLB's
        // real published break length (local/national/playoff) before
        // notifying, rather than an arbitrary guess.
        state.backLivePendingSince = now;
        state.mlbPitchBaseline = null;
        const delay = game.mlbBreakMs || MLB_BREAK_MS.local;
        console.log(`[${key}] MLB: "${sit.label}" — inning switched, notifying in ${Math.round(delay / 1000)}s`);
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
    } else if (state.backLivePendingSince) {
      // Inning already switched. Fast path: check MLB's own official feed
      // for actual pitch activity — if a pitch has really been thrown, that's
      // more precise than any delay estimate, so fire immediately. Falls
      // back to waiting out the broadcast-aware delay if the MLB API can't
      // be reached or the game can't be matched there.
      if (!game.mlbGamePk) game.mlbGamePk = await findMlbGamePk(game.nickname);
      if (game.mlbGamePk) {
        const activity = await getMlbPitchActivity(game.mlbGamePk);
        if (activity) {
          if (!state.mlbPitchBaseline) {
            state.mlbPitchBaseline = activity;
          } else if (activity !== state.mlbPitchBaseline) {
            notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${sit.half === "top" ? "Top" : "Bottom"} of the ${ord(sit.inning)}, ${sit.outs ?? 0} outs.`);
            state.onCommercial = false;
            state.backLivePendingSince = null;
            state.mlbPitchBaseline = null;
            console.log(`[${key}] MLB: BACK LIVE (confirmed via MLB Stats API pitch activity)`);
            return;
          }
        }
      }

      const pendingFor = now - state.backLivePendingSince;
      const delay = game.mlbBreakMs || MLB_BREAK_MS.local;
      if (pendingFor >= delay) {
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${sit.half === "top" ? "Top" : "Bottom"} of the ${ord(sit.inning)}, ${sit.outs ?? 0} outs.`);
        state.onCommercial = false;
        state.backLivePendingSince = null;
        state.mlbPitchBaseline = null;
        console.log(`[${key}] MLB: BACK LIVE (${Math.round(pendingFor / 1000)}s after inning switch, fallback delay)`);
      } else {
        console.log(`[${key}] ${sit.label} — notifying in ${Math.round((delay - pendingFor) / 1000)}s (fallback)`);
      }
    } else {
      console.log(`[${key}] ${sit.label} — ${state.onCommercial ? "commercial" : "live"}`);
    }
  }

  // ---- NBA / NCAAB / NFL / NCAAF ----
  else if (["nba","nfl","ncaab","ncaaf"].includes(sit.sport)) {
    // Real measured/published break lengths per sport (see BREAK_LENGTHS_MS),
    // season-aware (playoff games run longer, backed by real data for NBA).
    // This is a fallback safety net — play-by-play detection elsewhere
    // catches the vast majority of breaks before this ever matters.
    const threshold = game.breakThresholdMs || 120000;
    const now = Date.now();
    // Halftime/end-of-period are INSTANT real breaks. A plain timeout might
    // be quick and never actually cut to commercial, so normally it only
    // becomes a real break if the clock stays frozen long enough (below) —
    // except an NCAAB media timeout mark, which is a scheduled, guaranteed
    // break by rule, not a maybe, so it's treated as instant too.
    const isBreakSignal = sit.isHalftime || sit.isEndOfPeriod || sit.isNcaabMediaTimeoutMark;
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
      // For the one-time startup Spotify sync specifically, use a more
      // permissive guess than the badge/notification logic — if you're
      // already mid-timeout or under review right when you start watching,
      // treat that as "probably not live right now" rather than defaulting
      // to live and incorrectly pausing music that should be playing.
      const spotifyInitialGuess = isBreakSignal || sit.isTimeout || sit.isReview;
      if (session.spotifyEnabled) applySpotifyNow(ntfyTopic, spotifyInitialGuess);
      return;
    }

    // Fallback signal for basketball: if we think the game is on break but the
    // score just changed anyway, that's undeniable proof the ball was live —
    // catches transitions that happened entirely within a single poll gap and
    // were never directly observed (e.g. a timeout ending, one possession
    // happening, and another stoppage starting, all inside 5 seconds).
    if (isBasketball && state.onCommercial && sit.score && state.lastScore && sit.score !== state.lastScore) {
      notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${ord(sit.period)}, ${sit.clock} left.`);

      state.onCommercial = false;
      state.playAtBreakStart = null;
      state.lastScore = sit.score;
      state.lastDetail = sit.detail;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
      console.log(`[${key}] ${sit.sport.toUpperCase()}: BACK LIVE (score-change fallback — missed the direct transition, score now ${sit.score})`);
      return;
    }
    if (isBasketball) state.lastScore = sit.score;

    const pbpSport = sit.sport === "ncaab" ? "basketball/mens-college-basketball"
      : sit.sport === "nba" ? "basketball/nba"
      : sit.sport === "ncaaf" ? "football/college-football" : "football/nfl";

    // Play-by-play is ground truth here. Entering a break (timeout) just
    // acknowledges the break silently — no notification. Exiting only fires
    // once a genuine new play shows up, and "genuine" excludes anything that
    // is itself another break-related entry (a second timeout call, a sub
    // made during the stoppage) — those don't mean the ball is live.
    if (state.onCommercial) {
      const text = await getLatestPlayText(pbpSport, game.espnId);
      if (text) {
        if (!state.playAtBreakStart) {
          state.playAtBreakStart = text;
        } else if (text !== state.playAtBreakStart) {
          if (isBreakRelatedPlayText(text)) {
            // Another break-related entry (e.g. a second timeout call) —
            // update what we're comparing against, but still not live.
            state.playAtBreakStart = text;
          } else {
            notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${ord(sit.period)}, ${sit.clock} left.`);

            state.onCommercial = false;
            state.playAtBreakStart = null;
            state.lastDetail = sit.detail;
            state.lastClock = sit.clock;
            state.lastPeriod = sit.period;
            state.lastChangedAt = now;
            console.log(`[${key}] ${sit.sport.toUpperCase()}: BACK LIVE (confirmed via new play)`);
            return;
          }
        }
      }
    } else {
      const text = await getLatestPlayText(pbpSport, game.espnId);
      if (text && text.includes("timeout")) {
        state.onCommercial = true;
        state.lastDetail = sit.detail;
        state.lastClock = sit.clock;
        state.lastPeriod = sit.period;
        state.lastChangedAt = now;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: Commercial (timeout)`);
        return;
      }
    }

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
        state.playAtBreakStart = null;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: BACK LIVE (instant)`);
      }
      state.lastDetail = sit.detail;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
    } else if (clockMoved || periodJumped) {
      // A clock or period change alone doesn't prove play resumed — hitting
      // 0:00 to END a period, or the period ticking over WHILE still in a
      // break state, is itself a break signal, not a return from one. Only
      // treat this as "back live" if the new state isn't a break signal.
      if (isBreakSignal && !state.onCommercial) {
        state.onCommercial = true;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: Commercial (clock/period change into break)`);
      } else if (!isBreakSignal && state.onCommercial) {
        notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${ord(sit.period)}, ${sit.clock} left.`);

        state.onCommercial = false;
        state.playAtBreakStart = null;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: BACK LIVE`);
      }
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
      console.log(`[${key}] ${sit.label}`);
    } else {
      const frozen = now - state.lastChangedAt;
      if (sit.clock === "0:00" && !state.onCommercial && (await getLatestPlayText(pbpSport, game.espnId) || "").includes("end of")) {
        // Clock sitting at 0:00 and play-by-play already shows the period
        // ended — unlike a timeout, this is never a false alarm, so trust it
        // instantly rather than waiting for the status text field to catch up.
        state.onCommercial = true;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: Commercial (confirmed via play-by-play period-end)`);
      } else if (sit.isReview) {
        // Replay reviews/challenges can run 45-90s+ but rarely correspond to
        // a real commercial break — the broadcast usually just shows the
        // review live. Keep resetting the clock so review time never counts
        // toward the break threshold, no matter how long it runs.
        state.lastChangedAt = now;
        console.log(`[${key}] ${sit.label} — excluded from break threshold (under review)`);
      } else if (frozen >= threshold && !state.onCommercial) {
        // Ultimate safety net — only reached if play-by-play never confirmed
        // a timeout (network hiccup, parsing issue, etc.) but the clock has
        // stayed frozen long enough that something's clearly happening.
        state.onCommercial = true;
        console.log(`[${key}] ${sit.sport.toUpperCase()}: Commercial (frozen ${Math.round(frozen / 1000)}s, play-by-play never confirmed)`);
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
      // Broader guess for the one-time startup Spotify sync — a currently
      // visible timeout or review counts too, even though those aren't yet
      // confirmed as a real break for badge/notification purposes.
      const nhlInitDetailLower = (sit.detail || "").toLowerCase();
      const spotifyInitialGuess = sit.intermission || sit.isReview || nhlInitDetailLower.includes("timeout");
      if (session.spotifyEnabled) applySpotifyNow(ntfyTopic, spotifyInitialGuess);
      return;
    }

    const periodChanged = sit.period !== state.lastPeriod;
    const clockMoved = sit.clock !== state.lastClock;
    const detailLower = (sit.detail || "").toLowerCase();
    const isExplicitTimeout = detailLower.includes("timeout");

    // Checked in priority order: NHL's own official API first (clean,
    // structured event-type codes are inherently more reliable to parse
    // correctly than ESPN's free-text play descriptions), then ESPN as a
    // fallback — kept rather than removed, so a change to NHL's API shape
    // can never silently break detection entirely.
    if (state.onCommercial) {
      if (!game.nhlGameId) game.nhlGameId = await findNhlGameId(game.nickname);
      let confirmedByNhl = false;
      if (game.nhlGameId) {
        const nhlText = await getNhlLatestPlayText(game.nhlGameId);
        if (nhlText) {
          const isBreakCode = nhlText.includes("stoppage") || nhlText.includes("timeout") || nhlText.includes("end");
          if (!state.nhlOfficialBaseline) {
            state.nhlOfficialBaseline = nhlText;
          } else if (nhlText !== state.nhlOfficialBaseline && !isBreakCode) {
            notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${ord(sit.period)}, ${sit.clock} left.`);
            state.onCommercial = false;
            state.playAtBreakStart = null;
            state.nhlOfficialBaseline = null;
            state.lastClock = sit.clock;
            state.lastPeriod = sit.period;
            state.lastChangedAt = now;
            console.log(`[${key}] NHL: BACK LIVE (confirmed via NHL official API)`);
            return;
          } else if (nhlText !== state.nhlOfficialBaseline) {
            state.nhlOfficialBaseline = nhlText;
          }
          confirmedByNhl = true; // NHL's API is reachable and gave us a real answer this poll
        }
      }

      // Fallback to ESPN's play-by-play only if NHL's own API couldn't be
      // reached or matched this poll — not run redundantly every time.
      if (!confirmedByNhl) {
        const text = await getLatestPlayText("hockey/nhl", game.espnId);
        if (text) {
          if (!state.playAtBreakStart) {
            state.playAtBreakStart = text;
          } else if (text !== state.playAtBreakStart) {
            if (isBreakRelatedPlayText(text)) {
              state.playAtBreakStart = text;
            } else {
              notify(ntfyTopic, "Game is back!", `${game.fullName || game.nickname} is back — ${ord(sit.period)}, ${sit.clock} left.`);
              state.onCommercial = false;
              state.playAtBreakStart = null;
              state.lastClock = sit.clock;
              state.lastPeriod = sit.period;
              state.lastChangedAt = now;
              console.log(`[${key}] NHL: BACK LIVE (confirmed via ESPN fallback)`);
              return;
            }
          }
        }
      }
    }

    // Check intermission entry FIRST, before clock-moved logic — otherwise the
    // clock hitting 0:00 (which itself counts as "the clock moved") steals this
    // poll and delays intermission detection by a full extra cycle.
    if (sit.intermission && !state.onCommercial) {
      state.onCommercial = true;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
      console.log(`[${key}] NHL: Intermission (instant)`);
    } else if (!state.onCommercial && (await getLatestPlayText("hockey/nhl", game.espnId) || "").includes("timeout")) {
      state.onCommercial = true;
      state.lastClock = sit.clock;
      state.lastPeriod = sit.period;
      state.lastChangedAt = now;
      console.log(`[${key}] NHL: Commercial (timeout)`);
    } else if (periodChanged || clockMoved) {
      if (state.onCommercial) {
        const msg = periodChanged
          ? `${game.fullName || game.nickname} is back — ${ord(sit.period)} period starting.`
          : `${game.fullName || game.nickname} is back live — ${sit.clock} left in the ${ord(sit.period)}.`;
        notify(ntfyTopic, "Game is back!", msg);

        console.log(`[${key}] NHL: BACK LIVE`);
      }
      state.onCommercial = false;
      state.playAtBreakStart = null;
      state.nhlOfficialBaseline = null;
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
      } else if (isExplicitTimeout && !state.onCommercial && frozen >= (game.breakThresholdMs || BREAK_LENGTHS_MS.nhl.regular)) {
        // Ultimate safety net if play-by-play never confirmed it. Real NHL TV
        // timeouts run ~2 minutes (see BREAK_LENGTHS_MS) — distinct from the
        // rare 30-60s team timeout, but far more common and what this is for.
        state.onCommercial = true;
        console.log(`[${key}] NHL: Commercial (frozen ${Math.round(frozen / 1000)}s, play-by-play never confirmed)`);
      } else {
        console.log(`[${key}] ${sit.label} (detail: "${sit.detail}") — no trigger`);
      }
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

    // Beyond reacting to transitions WE detect, periodically verify Spotify's
    // actual playback state matches what it should be right now. Catches the
    // case where you start playing music mid-game with no break/live
    // transition having just happened — without this, it would sit out of
    // sync until the next real transition, which could be minutes away.
    // Throttled to avoid hammering Spotify's API every single poll.
    const nowTs = Date.now();
    const SPOTIFY_CHECK_INTERVAL_MS = 15000;
    if (!state.lastSpotifyCheckAt || nowTs - state.lastSpotifyCheckAt >= SPOTIFY_CHECK_INTERVAL_MS) {
      state.lastSpotifyCheckAt = nowTs;
      const desiredPlaying = state.onCommercial; // should play during a break, pause while live
      getCurrentlyPlaying(ntfyTopic).then(info => {
        if (!info.connected) return;
        if (info.isPlaying !== desiredPlaying) {
          console.log(`[${key}] Spotify: correcting out-of-sync playback (isPlaying=${info.isPlaying}, should be ${desiredPlaying})`);
          if (desiredPlaying) spotifyResume(ntfyTopic);
          else spotifyPause(ntfyTopic);
        }
      }).catch(() => {});
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
        if (game.sport === "baseball/mlb") game.mlbBreakMs = mlbBreakLengthMs(event);
        else if (game.sport === "basketball/nba") game.breakThresholdMs = breakLengthMs("nba", event);
        else if (game.sport === "basketball/mens-college-basketball") game.breakThresholdMs = breakLengthMs("ncaab", event);
        else if (game.sport === "football/nfl") game.breakThresholdMs = breakLengthMs("nfl", event);
        else if (game.sport === "football/college-football") game.breakThresholdMs = breakLengthMs("ncaaf", event);
        else if (game.sport === "hockey/nhl") game.breakThresholdMs = breakLengthMs("nhl", event);

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
        await processGame(session, game);

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
  switch (sport) {
    case "baseball/mlb": return m >= 3 && m <= 11;
    case "basketball/nba": return m >= 10 || m <= 6;
    case "football/nfl": return m >= 9 || m <= 1;
    case "hockey/nhl": return m >= 9 || m <= 6;
    case "football/college-football": return m >= 8 || m <= 1;
    case "basketball/mens-college-basketball": return m >= 11 || m <= 4;
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

// Target 9am Eastern Time (handles EST/EDT automatically). A date guard
// ensures redeploys/restarts never re-trigger a check that already ran
// today — without it, every backend redeploy would fire an extra check.
let lastDailyCheckDateStr = null;

function todayEasternDateStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function runDailyPushCheckOnce() {
  const today = todayEasternDateStr();
  if (lastDailyCheckDateStr === today) {
    console.log(`[daily-push] Already ran today (${today}) — skipping (likely a redeploy)`);
    return;
  }
  lastDailyCheckDateStr = today;
  runDailyPushCheck();
}

function scheduleNextCheck() {
  const now = new Date();

  // Get current time in Eastern timezone
  const easternNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const target = new Date(easternNow);
  target.setHours(9, 0, 0, 0);
  if (easternNow >= target) target.setDate(target.getDate() + 1); // tomorrow if past 9am today

  // Convert the Eastern target time back to a real timestamp by computing the offset
  const offsetMs = now.getTime() - easternNow.getTime();
  const targetUtc = new Date(target.getTime() + offsetMs);

  const msUntilTarget = targetUtc.getTime() - now.getTime();
  console.log(`[daily-push] Next 9am ET check in ${Math.round(msUntilTarget / 60000)} minutes`);

  setTimeout(() => {
    runDailyPushCheckOnce();
    setInterval(runDailyPushCheckOnce, 24 * 60 * 60 * 1000);
  }, Math.max(msUntilTarget, 0));
}

scheduleNextCheck();
// Safety net for a restart that happens mid-day, after 9am has already
// passed — only fires if today's check genuinely hasn't run yet, so a
// routine redeploy (common during active development) never re-triggers it.
setTimeout(() => {
  const easternHour = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' }).format(new Date()),
    10
  ) % 24;
  if (easternHour >= 9) runDailyPushCheckOnce();
}, 30000);

// ============================================================
//  HTTP SERVER
// ============================================================
// Sport-appropriate word for a play's period — baseball uses innings, hockey
// uses periods, football/NBA use quarters, college basketball uses halves.
function periodWordForSport(sport) {
  switch (sport) {
    case "baseball/mlb": return "Inning";
    case "hockey/nhl": return "Period";
    case "football/nfl": case "football/college-football": return "Qtr";
    case "basketball/nba": return "Qtr";
    case "basketball/mens-college-basketball": return "Half";
    default: return "Period";
  }
}

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

// Shared cache for ESPN's per-game summary endpoint (used by /plays). If two
// people are watching the same game and polling around the same time, the
// second request reuses the first's fresh result instead of re-fetching from
// ESPN. Cheap insurance against duplicate load if more people ever use this.
const espnSummaryCache = {};
const SUMMARY_CACHE_MS = 5000;

// Checks the most recent play-by-play entry for a given keyword (e.g.
// "timeout", "end of"). This is a real confirmed event from ESPN's stats
// crew, rather than an inference from a frozen clock or status text — much
// faster to trust than waiting out a threshold. Returns false (not true) on
// any fetch/parse issue so a hiccup here never blocks existing fallbacks.
// Returns a stable identifier for the single most recent play, so callers
// can detect "a new play has happened" even when the clock and status text
// don't change (e.g. a kickoff touchback — the game clock doesn't run on a
// dead-ball touchback, but the play itself is still proof the ball is live).
// Returns the lowercased text so callers can both compare identity AND check
// content (needed to tell a real play apart from an incidental break-related
// entry — a second timeout call, a substitution — that happens while the
// game is still dead). Returns null on any fetch/parse issue.
async function getLatestPlayText(sport, espnId) {
  try {
    const data = await fetchGameSummaryCached(sport, espnId);
    const rawPlays = Array.isArray(data.plays) ? data.plays : (Array.isArray(data?.plays?.items) ? data.plays.items : []);
    if (!rawPlays.length) return null;
    const latest = rawPlays[rawPlays.length - 1];
    return (latest?.text || latest?.shortText || null)?.toLowerCase() || null;
  } catch {
    return null;
  }
}

// A play-by-play entry that itself describes a break (a timeout call, a
// period ending) isn't proof the ball is live, even if it's a "new" entry
// since the break started — it's just another break-related event, not a
// resuming play (e.g. a TV timeout logged separately right after a team
// timeout, or a substitution made during a stoppage).
function isBreakRelatedPlayText(text) {
  return text.includes("timeout") || text.includes("end of");
}

async function fetchGameSummaryCached(sport, espnId) {
  const key = `${sport}:${espnId}`;
  const cached = espnSummaryCache[key];
  const now = Date.now();
  if (cached && now - cached.fetchedAt < SUMMARY_CACHE_MS) {
    return cached.data;
  }
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/summary?event=${espnId}`);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  const data = await r.json();
  espnSummaryCache[key] = { data, fetchedAt: now };
  return data;
}

// Prune entries for games no one has asked about in a while, so this doesn't
// grow forever across a long-running server (finished games, old sessions).
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(espnSummaryCache)) {
    if (now - espnSummaryCache[key].fetchedAt > 10 * 60 * 1000) delete espnSummaryCache[key];
  }
}, 5 * 60 * 1000);

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
      const data = await fetchGameSummaryCached(game.sport, game.espnId);
      // ESPN's summary endpoint structures plays differently by sport — try a
      // flat "plays" array first (common for basketball/baseball/hockey/soccer),
      // fall back to football's drive-nested structure if that's empty.
      let rawPlays = Array.isArray(data.plays) ? data.plays : [];
      let playsSource = "data.plays (flat)";
      if (rawPlays.length === 0 && data.drives?.previous) {
        rawPlays = data.drives.previous.flatMap(d => d.plays || []);
        playsSource = "data.drives.previous[].plays (nested)";
      }
      const periodWord = periodWordForSport(game.sport);
      const plays = rawPlays
        .map(p => ({
          text: p.text || p.shortText || "",
          clock: p.clock?.displayValue || null,
          period: p.period?.number || null,
          periodWord,
          scoringPlay: !!p.scoringPlay
        }))
        .filter(p => p.text)
        .slice(-30)
        .reverse(); // most recent first
      console.log(`[plays:${game.nickname}] Found ${rawPlays.length} raw plays via ${playsSource}, ${plays.length} after filtering`);
      const header = extractGameHeader(data, game.nickname, game.sport);
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
          ? "backliveapp4://spotify-connected"
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

  if (req.method === "POST" && url.pathname === "/spotify/disconnect") {
    const { session: id } = await readBody(req);
    if (!id) { jsonRes(res, 400, { error: "Missing session" }); return; }
    delete spotifyTokens[id];
    saveTokens();
    if (sessions[id]) sessions[id].spotifyEnabled = false;
    console.log(`[spotify:${id}] Disconnected by user`);
    jsonRes(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/spotify/now-playing") {
    const id = url.searchParams.get("session");
    if (!id || !spotifyTokens[id]) { jsonRes(res, 200, { connected: false }); return; }
    const info = await getCurrentlyPlaying(id);
    jsonRes(res, 200, info);
    return;
  }

  if (req.method === "POST" && url.pathname === "/spotify/control") {
    const { session: id, action } = await readBody(req);
    if (!id || !spotifyTokens[id]) { jsonRes(res, 400, { error: "Not connected" }); return; }
    if (action === "pause") await spotifyPause(id);
    else if (action === "play") await spotifyResume(id);
    else if (action === "next") await spotifyNext(id);
    else if (action === "previous") await spotifyPrevious(id);
    else { jsonRes(res, 400, { error: "Unknown action" }); return; }
    jsonRes(res, 200, { ok: true });
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
