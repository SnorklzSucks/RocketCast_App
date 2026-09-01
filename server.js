/*
 * Rocket Cast -- control server (free build)
 *
 * Everything in this file works without an account: the overlay registry and
 * static serving, Match Settings relay over Socket.IO, goal capture and
 * highlight reels, OBS WebSocket integration, LAN play, media storage and the
 * Stream Deck API.
 *
 * Accounts, billing, entitlements, the admin panel and the bracket live in
 * server-plus.js, which is not part of this build. When that file is absent
 * every hook below falls back to free behaviour -- see installRocketCastPlus.
 */
const net = require("net"), dgram = require("dgram"), os = require("os"), express = require("express"), http = require("http"), https = require("https"), {Server: Server} = require("socket.io"), {io: ioClient} = require("socket.io-client"), localtunnel = require("localtunnel"), WebSocket = require("ws"), fs = require("fs"), path = require("path"), crypto = require("crypto"), {spawn: spawn, spawnSync: spawnSync} = require("child_process"), multer = require("multer"), ffmpegStatic = require("ffmpeg-static"), compression = require("compression");

try {
  require("dotenv").config();
} catch {}





// Mutable: when another instance of this app is already running on this
// machine, these fall back to the next free port instead of crashing on
// EADDRINUSE (see the bindPortWithRetry-driven startup at the bottom of
// this file) -- that's what makes running multiple copies of Rocket Cast
// at once possible. Everything below that reads these does so at call
// time (inside functions, not at module-load time), so it naturally picks
// up the real bound port once startup finishes -- the one exception is
// webAppUrl/billingSuccessUrl/billingCancelUrl just below, which bake in
// whatever these are set to right now; that's fine in practice since a
// desktop install normally proxies /api/web/billing/* to the hosted web
// API rather than using these locally at all (see enableRemoteWebApiProxy).
let controlHttpPort = Number(process.env.PORT || process.env.RC_CONTROL_PORT || 3e3), mediaHttpPort = Number(process.env.RC_MEDIA_PORT || 3001), bracketHttpPort = Number(process.env.RC_BRACKET_PORT || 3002), ipcPort = Number(process.env.RC_IPC_PORT || 3101), resolveServerReady = null;



// Electron's main.js requires this file directly in-process (not as a
// separate child process), and needs to know the REAL ports once binding
// finishes before it can point any BrowserWindow at this server -- module
// .exports is set to this promise immediately (require() returns it
// synchronously, still pending), and it resolves once every listener below
// has either bound successfully or given up.
const serverReadyPromise = new Promise(resolve => {
  resolveServerReady = resolve;
});

module.exports = serverReadyPromise;

// True only for the standalone `node server.js` process Render actually
// runs as the public web service — RENDER is a var Render itself sets on
// every service, already relied on elsewhere in this file (see
// enableRemoteWebApiProxy/sessionCookieSecure) to tell that apart from a
// desktop install requiring this file in-process. Used below to keep the
// local-control API surface (match history, media storage, OBS/recording
// control, Stream Deck, LAN hosting) off the public deployment entirely —
// none of it means anything without a real desktop/OBS on the other end,
// and it has no business being reachable by an anonymous web visitor.
const isHostedWebDeployment = Boolean(process.env.RENDER),
// mediaIo (the standalone reel-player page, meant to be loadable as an OBS
// browser source from another machine on the LAN) needs cross-origin
// socket.io connections to work at all -- but `origin: true` reflects
// *any* Origin header, which lets an arbitrary third-party website opened
// in a viewer's browser silently open a socket to this server too. Only
// allow requests with no Origin (non-browser socket.io-client callers) or
// an Origin that's actually this app being loaded from somewhere on the
// LAN/tunnel -- a real cross-site page never matches either.
mediaIoCorsOrigin = (origin, callback) => {
  if (!origin) return void callback(null, !0);
  callback(null, /^https?:\/\/[^/]+:(\d+)$/.test(origin) || /\.loca\.lt$/i.test(origin));
};

const {PostHog: PostHog} = require("posthog-node"), app = express(), server = http.createServer(app), io = new Server(server, {
  maxHttpBufferSize: 1e8
}), mediaApp = express(), mediaServer = http.createServer(mediaApp), mediaIo = new Server(mediaServer, {
  cors: {
    origin: mediaIoCorsOrigin
  }
// A dedicated, minimal app/port for the Bracket overlay only (read-only:
// no auth, no mutation routes) -- so an OBS browser source pointed at it
// keeps working on a stable, predictable URL regardless of what the main
// control port happens to be bound to. Same CORS posture as mediaIo since
// it's the same kind of thing: a standalone page meant to be loadable as a
// browser source, possibly from another machine on the LAN.
}), bracketApp = express(), bracketServer = http.createServer(bracketApp), bracketIo = new Server(bracketServer, {
  cors: {
    origin: mediaIoCorsOrigin
  }
}), appPath = process.env.APP_PATH || __dirname, userDataPath = process.env.USER_DATA_PATH || path.join(appPath, ".userData"), analyticsStorePath = path.join(userDataPath, "analytics-events.json"), activeOverlayStorePath = path.join(userDataPath, "active-overlay.json"), mediaStorageConfigPath = path.join(userDataPath, "media-storage-config.json"), githubRepo = process.env.RC_GITHUB_REPO || "SnorklzSucks/RocketCast_App", authTokenTtlDays = Math.max(1, Number(process.env.RC_AUTH_TOKEN_TTL_DAYS || 30)), enableIpcBridge = "true" === String(process.env.RC_ENABLE_IPC_BRIDGE || (process.env.RENDER ? "false" : "true")).trim().toLowerCase(), disableRemoteWebApiProxy = "true" === String(process.env.RC_DISABLE_REMOTE_WEB_API_PROXY || "false").trim().toLowerCase(), authRateWindowMs = Math.max(3e4, Number(process.env.RC_AUTH_RATE_WINDOW_MS || 6e4)), authRateMaxAttempts = Math.max(3, Number(process.env.RC_AUTH_RATE_MAX_ATTEMPTS || 6));

const defaultMediaRootPath = path.join(userDataPath, "media");

function readMediaStorageOverridePath() {
  try {
    if (!fs.existsSync(mediaStorageConfigPath)) return "";
    const parsed = JSON.parse(fs.readFileSync(mediaStorageConfigPath, "utf8"));
    return String(parsed?.mediaRootPath || "").trim();
  } catch {
    return "";
  }
}

// mediaRootPath and its subfolders are `let`, not `const` -- unlike the
// other paths above, this one is user-changeable at runtime (see
// setMediaRootPath/the /api/media-storage routes below), and everything
// that reads them does so at call time inside functions/route handlers,
// so a change here takes effect immediately with no restart needed.
let mediaRootPath = readMediaStorageOverridePath() || defaultMediaRootPath, matchMediaRootPath = path.join(mediaRootPath, "matches"), captureBufferDir = path.join(mediaRootPath, "capture-buffer"), captureTempDir = path.join(mediaRootPath, "tmp");

for (const dir of [ mediaRootPath, matchMediaRootPath, captureBufferDir, captureTempDir ]) try {
  fs.mkdirSync(dir, {
    recursive: !0
  });
} catch {}

function setMediaRootPath(newRoot) {
  mediaRootPath = newRoot, matchMediaRootPath = path.join(mediaRootPath, "matches"), captureBufferDir = path.join(mediaRootPath, "capture-buffer"), captureTempDir = path.join(mediaRootPath, "tmp"),
  ensureDirSafe(mediaRootPath), ensureDirSafe(matchMediaRootPath), ensureDirSafe(captureBufferDir), ensureDirSafe(captureTempDir);
}

// express.static() locks in whatever root path it's given at the moment
// it's created -- mounting it once at module load would keep serving from
// the OLD folder forever after a location change. Re-creating the static
// handler fresh on every request is cheap and keeps /media always
// pointed at whatever mediaRootPath currently is, so switching storage
// location takes effect immediately with no server restart.
function serveCurrentMediaRoot(req, res, next) {
  express.static(mediaRootPath)(req, res, next);
}

// Only trust X-Forwarded-For when there's an actual reverse proxy in
// front of us to have set it (Render, exactly one hop). Trusting it
// unconditionally is how getRequestIp() used to let anyone spoof their
// rate-limit identity for free; not trusting it at all when we ARE behind
// Render would make every request look like it came from Render's own
// edge IP, which is just as broken the other way (one shared rate-limit
// bucket for every real visitor).
app.set("trust proxy", isHostedWebDeployment ? 1 : !1), mediaApp.set("trust proxy", isHostedWebDeployment ? 1 : !1),
console.log("📁 App Path:", appPath), console.log("📁 Public Dir:", path.join(appPath, "public")),
console.log("📁 Overlays Dir:", path.join(appPath, "overlays")), fs.mkdirSync(userDataPath, {
  recursive: !0
});

const posthogApiKey = String(process.env.POSTHOG_API_KEY || "").trim(), posthog = posthogApiKey ? new PostHog(posthogApiKey, {
  host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
  // Default flushAt is 20 -- events sit queued in memory until 20 pile up
  // or the flushInterval timer fires. On a host that can sleep/restart
  // between requests (Render's free tier does), that queue can vanish
  // before either condition is ever met, especially at low traffic. Flush
  // after every single event instead; this app's volume is nowhere near
  // enough for the extra HTTP calls to matter.
  flushAt: 1,
  flushInterval: 1e4
}) : null;

// --- Multi-seat "Servers" (LAN + internet host/guest) ----------------------
// One machine "hosts" (its own already-running server.js is the source of
// truth, same as always). Other machines "connect" as a guest: they
// discover the host by name — first over the LAN (UDP broadcast, near-
// instant), and if that finds nothing, by computing the same public tunnel
// URL the host derives from its own name+password and trying that instead,
// which works from anywhere with internet access, not just the same
// network. Either way, once found, the guest's own local server bridges
// itself transparently to the host — every /api/* call gets forwarded, and
// every socket.io event is relayed in both directions. The guest's own
// renderer (index.html) never knows the difference; it keeps talking to
// its own localhost server exactly as it always has, which is what makes
// this a drop-in feature instead of a rewrite of every fetch() call in the
// app.
//
// The tunnel is a real, public, internet-routable HTTPS URL (via the open
// -source localtunnel/loca.lt relay — no account, no infra of our own to
// run). That also means it's reachable by anyone who finds or guesses the
// URL, not just people on your network the way LAN-only access was — so
// unlike the LAN path, password verification here has to be a REAL access
// gate, not just a courtesy check a well-behaved guest happens to call:
// see the token issuance below and the "isRequestFromTunnel" guard on the
// HTTP and socket.io auth gates further down in this file.
const LAN_ANNOUNCE_PORT = 47632, guestTokenTtlMs = 432e5, activeGuestTokens = new Map, FREE_SERVER_SEAT_LIMIT = 4, lanServerState = {
  hosting: !1,
  hostName: "",
  hostPasswordHash: "",
  hostUserId: "",
  hostEmail: "",
  hostUsername: "",
  hostAuthToken: "",
  hostAnnounceTimer: null,
  hostAnnounceSocket: null,
  hostTunnel: null,
  hostTunnelUrl: "",
  hostTunnelStarting: !1,
  hostTunnelError: "",
  connectedGuestSeats: new Map,
  guestMode: !1,
  guestConnectedName: "",
  guestBaseUrl: "",
  guestSocket: null,
  guestConnected: !1,
  guestError: "",
  guestToken: "",
  // Whether THIS machine's own guest connection was made with an account
  // logged in. Anyone can join a server to watch, but only an
  // authenticated guest is allowed to relay changes (score overrides,
  // series resets, overlay switches, ...) up to the host -- see the
  // io.onAny relay-up gate and the guest-mode HTTP proxy gate below.
  guestAuthenticated: !1
};

function hashLanPassword(password) {
  const trimmed = String(password || "");
  return trimmed ? crypto.createHash("sha256").update(trimmed).digest("hex") : "";
}

// Plain === on two hex digests short-circuits on the first differing
// character, so how long a guess takes leaks how many leading characters
// it got right -- a real (if narrow) timing side-channel on the one
// password check anyone off-machine can hit before authenticating.
// crypto.timingSafeEqual always compares in constant time.
function secureStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8"), bufB = Buffer.from(String(b || ""), "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function issueGuestToken() {
  const token = crypto.randomBytes(24).toString("hex");
  return activeGuestTokens.set(token, Date.now() + guestTokenTtlMs), token;
}

function isValidGuestToken(token) {
  const key = String(token || "").trim();
  if (!key) return !1;
  const expiresAt = activeGuestTokens.get(key);
  return void 0 !== expiresAt && (Date.now() <= expiresAt || (activeGuestTokens.delete(key), !1));
}

// A request that arrived through the public tunnel carries the tunnel's
// own hostname (something.loca.lt) in its Host header — the host's own
// local UI never does, since it always talks to 127.0.0.1/localhost
// directly. That's what distinguishes "this came in from the internet" so
// the token gate only applies where it actually matters.
function isRequestFromTunnel(hostHeader) {
  return /\.loca\.lt$/i.test(String(hostHeader || "").split(":")[0]);
}

// The host's own local UI always talks to its own server over loopback
// (127.0.0.1/::1) — it's the same machine, same Electron window. Anything
// arriving from elsewhere on the connection itself is a real other seat.
// Note this alone doesn't catch tunnel traffic: localtunnel relays public
// requests to this process over a local TCP connection, so tunnel-forwarded
// requests also show up as loopback at the socket level — that's exactly
// why isRequestFromTunnel (Host header based) exists and is checked
// alongside this, not instead of it.
function isLoopbackAddress(address) {
  const value = String(address || "").trim();
  return "127.0.0.1" === value || "::1" === value || "::ffff:127.0.0.1" === value || "localhost" === value;
}

// True when a request/connection is a genuine other seat (LAN or internet)
// rather than the host's own local UI — combines both signals above so the
// password/token gate actually applies everywhere it needs to, not just to
// tunnel traffic like before.
function isGuestOriginRequest(hostHeader, remoteAddress) {
  return isRequestFromTunnel(hostHeader) || !isLoopbackAddress(remoteAddress);
}

// Deterministic so a guest can compute the exact same URL the host is
// using without any directory/lookup service in between — derived from
// name+password together (not name alone) so the subdomain itself isn't
// easily guessable from the server name shown on-screen.
function computeTunnelSubdomain(name, password) {
  const material = `${String(name || "").trim().toLowerCase()}|${String(password || "")}`;
  return `rc-${crypto.createHash("sha256").update(material).digest("hex").slice(0, 20)}`;
}

function stopHostingLanServer() {
  lanServerState.hosting = !1, lanServerState.hostName = "", lanServerState.hostPasswordHash = "",
  lanServerState.hostUserId = "", lanServerState.hostEmail = "", lanServerState.hostUsername = "", lanServerState.hostAuthToken = "",
  lanServerState.connectedGuestSeats.clear(),
  lanServerState.hostTunnelUrl = "", lanServerState.hostTunnelStarting = !1, lanServerState.hostTunnelError = "",
  lanServerState.hostAnnounceTimer && (clearInterval(lanServerState.hostAnnounceTimer), lanServerState.hostAnnounceTimer = null),
  lanServerState.hostAnnounceSocket && (
    (() => {
      try {
        lanServerState.hostAnnounceSocket.close();
      } catch {}
    })(),
    lanServerState.hostAnnounceSocket = null
  ),
  lanServerState.hostTunnel && (
    (() => {
      try {
        lanServerState.hostTunnel.close();
      } catch {}
    })(),
    lanServerState.hostTunnel = null
  ),
  activeGuestTokens.clear();
}

// The generic limited-broadcast address (255.255.255.255) isn't reliably
// routable on every machine — verified directly: on a machine with a VPN
// or virtual network adapter installed (Hamachi, OBS's virtual cam driver,
// etc. — common on streaming/production PCs), sending to it can fail with
// EHOSTUNREACH because the OS can't resolve which interface it belongs on.
// A subnet-directed broadcast (e.g. 10.0.0.255 for a 10.0.0.x/24 adapter)
// targets an actual interface directly and works far more reliably.
function getLanBroadcastAddresses() {
  const addresses = [];
  Object.values(os.networkInterfaces()).forEach(list => {
    (list || []).forEach(info => {
      if ("IPv4" !== info.family || info.internal || !info.netmask) return;
      const ipParts = info.address.split(".").map(Number), maskParts = info.netmask.split(".").map(Number);
      4 === ipParts.length && 4 === maskParts.length && addresses.push(ipParts.map((part, i) => (part | ~maskParts[i] & 255) & 255).join("."));
    });
  });
  return addresses.push("255.255.255.255"), Array.from(new Set(addresses));
}

async function startHostTunnel(name, password) {
  const expectedSubdomain = computeTunnelSubdomain(name, password);
  lanServerState.hostTunnelStarting = !0, lanServerState.hostTunnelError = "";
  try {
    const tunnel = await localtunnel({ port: controlHttpPort, subdomain: expectedSubdomain });
    if (!lanServerState.hosting || lanServerState.hostName !== name) return void (
      (() => {
        try {
          tunnel.close();
        } catch {}
      })()
    );
    const gotExpectedSubdomain = tunnel.url === `https://${expectedSubdomain}.loca.lt`;
    lanServerState.hostTunnel = tunnel, lanServerState.hostTunnelUrl = tunnel.url, lanServerState.hostTunnelStarting = !1,
    gotExpectedSubdomain || (lanServerState.hostTunnelError = "This name+password combination is already in use by another server right now. Connections from outside your network may fail. Pick a more unique name or password."),
    tunnel.on("close", () => {
      lanServerState.hosting && (lanServerState.hostTunnelUrl = "", lanServerState.hostTunnelError = "Public connection dropped. Restart hosting to try again.");
    }), tunnel.on("error", error => {
      lanServerState.hostTunnelError = String(error?.message || "Public tunnel error");
    });
  } catch (error) {
    lanServerState.hostTunnelStarting = !1, lanServerState.hostTunnelError = `Couldn't set up remote access: ${error?.message || "unknown error"}. Casters on your own network can still connect.`;
  }
}

function startHostingLanServer(name, password, hostIdentity = {}) {
  stopHostingLanServer();
  const safeName = String(name || "").trim();
  if (!safeName) throw new Error("Server name is required");
  if (safeName.length > 40) throw new Error("Server name is too long");
  const safePassword = String(password || "").trim();
  if (!safePassword) throw new Error("A password is required to host a server");
  lanServerState.hosting = !0, lanServerState.hostName = safeName, lanServerState.hostPasswordHash = hashLanPassword(safePassword),
  lanServerState.hostUserId = String(hostIdentity.userId || ""), lanServerState.hostEmail = String(hostIdentity.email || ""),
  lanServerState.hostUsername = String(hostIdentity.username || ""), lanServerState.hostAuthToken = String(hostIdentity.token || "");
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: !0 });
  sock.on("error", () => {}), sock.bind(() => {
    try {
      sock.setBroadcast(!0);
    } catch {}
  }), lanServerState.hostAnnounceSocket = sock;
  const announce = () => {
    if (!lanServerState.hosting) return;
    const payload = Buffer.from(JSON.stringify({
      type: "rocket-cast-announce",
      name: lanServerState.hostName,
      hasPassword: Boolean(lanServerState.hostPasswordHash),
      controlPort: controlHttpPort
    }));
    getLanBroadcastAddresses().forEach(address => {
      try {
        sock.send(payload, 0, payload.length, LAN_ANNOUNCE_PORT, address);
      } catch {}
    });
  };
  announce(), lanServerState.hostAnnounceTimer = setInterval(announce, 500),
  startHostTunnel(safeName, safePassword).catch(error => {
    lanServerState.hostTunnelStarting = !1, lanServerState.hostTunnelError = String(error?.message || "Couldn't set up remote access");
  });
}

function discoverLanServerByName(name, timeoutMs = 4e3) {
  return new Promise(resolve => {
    const target = String(name || "").trim().toLowerCase();
    let settled = !1;
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: !0 }), finish = result => {
      settled || (settled = !0, (() => {
        try {
          sock.close();
        } catch {}
      })(), resolve(result));
    };
    sock.on("message", (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString("utf8"));
        "rocket-cast-announce" === data?.type && String(data?.name || "").trim().toLowerCase() === target && finish({
          address: rinfo.address,
          controlPort: Number(data.controlPort) || 3e3,
          hasPassword: Boolean(data.hasPassword)
        });
      } catch {}
    }), sock.on("error", () => finish(null)), sock.bind(LAN_ANNOUNCE_PORT, () => {
      try {
        sock.setBroadcast(!0);
      } catch {}
    }), setTimeout(() => finish(null), timeoutMs);
  });
}

function disconnectFromLanServer() {
  lanServerState.guestSocket && (
    (() => {
      try {
        lanServerState.guestSocket.disconnect();
      } catch {}
    })(),
    lanServerState.guestSocket = null
  ), lanServerState.guestMode = !1, lanServerState.guestConnectedName = "", lanServerState.guestBaseUrl = "",
  lanServerState.guestConnected = !1, lanServerState.guestError = "", lanServerState.guestToken = "", lanServerState.guestAuthenticated = !1;
}

async function verifyLanServerPassword(baseUrl, password) {
  const res = await fetch(`${baseUrl}/api/lan-server/verify-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: password || "" })
  }), data = await res.json().catch(() => ({}));
  return { ok: res.ok && Boolean(data?.ok), token: data?.token || "" };
}

async function connectToLanServer(name, password, guestIdentity = {}) {
  disconnectFromLanServer();
  // Anyone can join to watch, no account required -- guestUsername is
  // whatever the caller resolved (their real account username if they're
  // logged in, otherwise blank, which the host displays as "Guest"). Only
  // an authenticated guest is allowed to relay changes up to the host; see
  // guestAuthenticated below and the relay/proxy gates on the host side.
  const safeName = String(name || "").trim(), guestUsername = String(guestIdentity.username || "").trim();
  if (!safeName) throw new Error("Server name is required");
  let baseUrl = "", guestToken = "";
  const foundOnLan = await discoverLanServerByName(safeName);
  if (foundOnLan) {
    baseUrl = `http://${foundOnLan.address}:${foundOnLan.controlPort}`;
    if (foundOnLan.hasPassword || String(password || "").trim()) {
      const verified = await verifyLanServerPassword(baseUrl, password).catch(() => ({ ok: !1 }));
      if (!verified.ok) throw new Error("Incorrect password");
      guestToken = verified.token;
    }
  }
  const usedRemoteFallback = !foundOnLan;
  if (usedRemoteFallback) {
    const tunnelUrl = `https://${computeTunnelSubdomain(safeName, password)}.loca.lt`;
    let verified;
    try {
      verified = await verifyLanServerPassword(tunnelUrl, password);
    } catch {
      throw new Error(`Couldn't find a server named "${safeName}". Checked your local network and the internet. Make sure the host is running and the name/password are exactly right.`);
    }
    if (!verified.ok) throw new Error("Incorrect password, or no server is currently hosting under that name.");
    baseUrl = tunnelUrl, guestToken = verified.token;
  }
  const guestSocket = ioClient(baseUrl, {
    reconnection: !0,
    transports: [ "websocket", "polling" ],
    auth: { token: guestToken || "", username: guestUsername }
  });
  lanServerState.guestSocket = guestSocket, lanServerState.guestMode = !0, lanServerState.guestConnectedName = safeName,
  lanServerState.guestBaseUrl = baseUrl, lanServerState.guestConnected = !1, lanServerState.guestError = "",
  lanServerState.guestToken = guestToken, lanServerState.guestAuthenticated = Boolean(guestIdentity.authenticated),
  guestSocket.on("connect", () => {
    lanServerState.guestConnected = !0, lanServerState.guestError = "";
  }), guestSocket.on("disconnect", () => {
    lanServerState.guestConnected = !1;
  }), guestSocket.on("connect_error", error => {
    lanServerState.guestError = String(error?.message || "Connection error");
  }), guestSocket.onAny((event, ...args) => {
    io.emit(event, ...args);
  });
  return { ok: !0, baseUrl: baseUrl, remote: usedRemoteFallback };
}
// -----------------------------------------------------------------------

const PRIVACY_POLICY_EFFECTIVE_DATE = "August 18, 2026";

// Single source of truth for the privacy policy: both the in-app modal
// (fetched by index.html) and the public /privacy page on the website
// render from this same function, so there's one place to edit instead of
// two copies quietly drifting apart. The few numbers that are actually
// enforced by code (session length, analytics retention, PBKDF2 cost)
// are interpolated from the real constants rather than hand-typed, so
// changing RC_AUTH_TOKEN_TTL_DAYS or PRIVACY_ANALYTICS_RETENTION_DAYS
// updates the published text automatically. Everything else -- what data
// gets collected, which vendors are used, how sharing/retention work --
// is prose describing actual architecture and still needs a human (or an
// explicit ask to Claude) to update it when that architecture changes;
// there's no way to safely auto-derive legal text from an arbitrary code
// diff, and this function deliberately doesn't try to.
function renderPrivacyPolicyContentHtml() {
  return `
    <p class="pp-meta">Effective ${PRIVACY_POLICY_EFFECTIVE_DATE} &middot; Applies to the Rocket Cast desktop application, RocketCast.net, and related services</p>

    <section>
      <h4>1. Information We Collect</h4>
      <p>Most information Rocket Cast reads from Rocket League, including live match state, player names, scores, and other game information, is processed locally on your computer. That information generally remains on your device unless you choose to use a feature that transmits it, such as hosting a LAN server, signing in to a Rocket Cast + account, or contacting us for support.</p>
      <p style="font-size:calc(12px * var(--font-scale));color:var(--muted)">Rocket Cast is an independent tool and is not affiliated with, sponsored by, or endorsed by Psyonix LLC or Epic Games. "Rocket League" is a trademark of Psyonix LLC.</p>
      <h5>Account information</h5>
      <p>If you create a Rocket Cast + account, we collect your email address, the username you choose, and a password credential used to authenticate your account. We do not store your password in plaintext -- passwords are processed using PBKDF2-HMAC-SHA512 with ${PBKDF2_ITERATIONS.toLocaleString()} iterations and a unique salt. We cannot recover your original password from the credential we store.</p>
      <h5>Payment and subscription information</h5>
      <p>Rocket Cast uses Stripe to process subscriptions. When you subscribe, payment information such as your card number, expiration date, and CVC is entered directly into Stripe's payment interface -- Rocket Cast does not receive or store your full payment-card number through its own servers. Stripe may provide Rocket Cast with information necessary to administer your subscription, such as a Stripe customer identifier, subscription identifier, subscription status, billing-related information, and transaction status. Stripe processes payment information under its own privacy policy.</p>
      <h5>Usage and device information</h5>
      <p>The Rocket Cast application may periodically send limited operational and usage information, such as whether the application was opened, is still running, or was closed. These events may include a randomly generated device identifier, operating-system platform, browser or application user-agent information, language, timezone, event type, and timestamp.</p>
      <p>The device identifier is persistent and therefore is <strong>pseudonymous rather than anonymous</strong>. Depending on the circumstances, it may be possible to associate this information with an account or person. We use this information primarily to understand application reliability, usage at an aggregate level, and crashes or other operational problems. We do not use this information to build advertising profiles.</p>
      <h5>Cookies and local storage</h5>
      <p>When you sign in to RocketCast.net, we use a session cookie called <code>rc_session</code>. The cookie is <code>HttpOnly</code>, used to maintain your authenticated session, and set to expire ${authTokenTtlDays} days after the login that created it. It is not used for behavioral advertising.</p>
      <p>RocketCast.net may also use browser local storage for preferences such as theme, layout, and keybindings. These preferences remain on your device unless you explicitly transmit them through a feature that does so. Our analytics technologies may use their own identifiers or storage mechanisms where enabled; those are used for product analytics rather than advertising.</p>
      <h5>Information that stays local</h5>
      <p>Unless you choose a feature that transmits it or send it to us for support, the following remains stored locally on your computer: overlay layouts, match history, recorded clips, keybinding configuration, and other Rocket Cast configuration files. We do not routinely receive or inspect this locally stored information. If you host a LAN server, information you choose to expose through that server may be accessible to devices or users you allow to connect.</p>
      <h5>Support information</h5>
      <p>If you contact Rocket Cast for support, we may receive the information you choose to provide, which may include your email address, account information, messages, screenshots, logs, or other technical information. We use support information to investigate and respond to your request and to improve the reliability and security of Rocket Cast.</p>
    </section>

    <section>
      <h4>2. How We Use Information</h4>
      <h5>Providing and securing the service</h5>
      <p>We use account information to create and maintain your account, authenticate you, maintain your signed-in session, send password-reset and account-verification messages, and protect accounts and services against unauthorized access. Where applicable privacy laws such as the GDPR apply, this processing may be based on the need to perform our contract with you.</p>
      <h5>Subscriptions and payments</h5>
      <p>We use information received from Stripe to establish and maintain your Rocket Cast + subscription, determine whether a subscription is active, canceled, or expired, process subscription-related account changes, and maintain appropriate transaction and accounting records. Where applicable, processing is based on performing our contract with you and complying with legal obligations.</p>
      <h5>Security and abuse prevention</h5>
      <p>We may process IP addresses, account information, device identifiers, and related technical information to detect, prevent, investigate, and respond to abuse, fraud, unauthorized access, and security incidents. Sensitive security-related actions, such as login, password reset, and administrative actions, may be rate-limited by IP address or other technical signals. Where applicable, this processing may be based on our legitimate interests in protecting Rocket Cast, our users, and our services.</p>
      <h5>Product analytics and reliability</h5>
      <p>We use limited usage and device information to understand how Rocket Cast is being used and whether the application is functioning correctly -- for example, to identify crashes, application failures, frequently used features, or technical problems. Analytics are intended for product and reliability purposes, not advertising. Where consent is required by applicable law for analytics, we will request that consent before using the applicable analytics technology; where consent is not required, analytics may be processed on another lawful basis permitted by applicable law.</p>
      <h5>Support</h5>
      <p>We use information you provide when contacting us to respond to support requests, investigate technical issues, and protect the security of our services. Where applicable, this processing is based on providing the support you requested and our legitimate interests in operating and securing Rocket Cast.</p>
      <h5>No AI training or advertising</h5>
      <p>We do not use information collected through Rocket Cast to train artificial-intelligence models. We do not operate behavioral advertising through Rocket Cast and do not use Rocket Cast information to build advertising profiles for third parties.</p>
    </section>

    <section>
      <h4>3. How We Share Information</h4>
      <p>We do not sell your personal information. We do not share personal information for cross-context behavioral advertising. We disclose information only as reasonably necessary to provide, secure, and operate Rocket Cast, including to service providers and vendors that process information on our behalf.</p>
      <table>
        <thead><tr><th>Service provider</th><th>Information involved</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>Stripe</td><td>Payment information entered directly into Stripe; account and subscription identifiers; billing and subscription information</td><td>Payment processing and subscription management</td></tr>
          <tr><td>Resend</td><td>Email address and one-time verification or password-reset code</td><td>Transactional email</td></tr>
          <tr><td>PostHog</td><td>Pseudonymous usage and device events</td><td>Product analytics and application reliability</td></tr>
          <tr><td>Have I Been Pwned</td><td>A limited portion of a SHA-1 password hash when password-breach checking is performed</td><td>Detecting whether a password has appeared in known data breaches</td></tr>
          <tr><td>Render</td><td>Account and application data stored by Rocket Cast</td><td>Hosting and infrastructure</td></tr>
        </tbody>
      </table>
      <p>Service providers may process information according to their own privacy policies and our instructions. We may also disclose information when reasonably necessary to comply with applicable law, regulation, legal process, or governmental request; protect the rights, property, safety, or security of Rocket Cast, our users, or the public; detect or investigate fraud, abuse, or security incidents; or enforce our agreements. We do not permit our service providers to use Rocket Cast information for unrelated advertising purposes.</p>
    </section>

    <section>
      <h4>4. Password-Breach Checking</h4>
      <p>Rocket Cast may check whether a selected password appears in known password breaches through Have I Been Pwned's password-checking service. When this feature is used, Rocket Cast does not send your password or the complete password hash to Have I Been Pwned -- instead, only the first five characters of a SHA-1 hash of the password are sent, as part of the service's password-checking mechanism.</p>
    </section>

    <section>
      <h4>5. Storage and Security</h4>
      <p>Rocket Cast uses reasonable technical and organizational measures designed to protect information against unauthorized access, loss, misuse, alteration, or disclosure, including HTTPS/TLS encryption for network communications, authenticated sessions, automatic session expiration, rate limiting for sensitive endpoints, password hashing rather than plaintext storage, and separate authentication requirements for administrative access. Administrative access is not automatically granted merely because someone has a normal Rocket Cast user account.</p>
      <p>No method of storage or transmission over the Internet is completely secure. We therefore cannot guarantee absolute security. If we experience a security incident involving personal information, we will investigate it and make any notifications required by applicable law, including notifications to regulators or affected individuals where required and within applicable legal deadlines.</p>
    </section>

    <section>
      <h4>6. Data Retention</h4>
      <p>We retain personal information only for as long as reasonably necessary for the purposes described in this policy, unless a longer period is required or permitted by law.</p>
      <p>The <code>rc_session</code> session expires ${authTokenTtlDays} days after the login that created it. Analytics events are retained for up to ${PRIVACY_ANALYTICS_RETENTION_DAYS} days, unless they must be retained longer for security, legal, or technical reasons.</p>
      <p>Account information is generally retained while your account remains active. When you request account deletion, it is processed immediately, subject to information that we are required or permitted to retain for legal, accounting, tax, fraud-prevention, dispute-resolution, or security requirements. Information contained in backups may remain for a limited period until those backups are routinely overwritten, subject to appropriate access controls.</p>
    </section>

    <section>
      <h4>7. Your Privacy Rights</h4>
      <p>Depending on where you live, you may have rights concerning your personal information, including rights to access, correct, request deletion of, request a copy or export of, object to certain processing of, restrict certain processing of, and withdraw consent for processing of your information, along with other rights provided by applicable privacy law. To make a privacy request, contact <a href="mailto:snorklzcasts@gmail.com">snorklzcasts@gmail.com</a>. We may need to verify your identity before completing certain requests, and will respond to valid requests within the time required by applicable law.</p>
      <h5>California residents</h5>
      <p>California law may provide additional rights concerning personal information, including rights to know, access, correct, delete, and receive certain information about our collection and disclosure practices. Rocket Cast does not sell personal information and does not share personal information for cross-context behavioral advertising. We do not discriminate against you for exercising privacy rights provided by applicable California law. To exercise California privacy rights, contact <a href="mailto:snorklzcasts@gmail.com">snorklzcasts@gmail.com</a>; we may ask for information reasonably necessary to verify your request. If applicable law provides a right to appeal a decision concerning a privacy request, we will provide information about that appeal process when we respond.</p>
    </section>

    <section>
      <h4>8. International Users and International Transfers</h4>
      <p>Rocket Cast is operated from the United States. Some Rocket Cast information is stored using infrastructure located in the European Union, including infrastructure located in Frankfurt, Germany. Information may also be accessed or processed from the United States and by service providers operating in other countries. Where personal information is transferred internationally, we use a transfer mechanism permitted by applicable law, which may include an applicable adequacy decision, an approved data-transfer framework, standard contractual clauses, or another lawful transfer mechanism.</p>
    </section>

    <section>
      <h4>9. Children's Privacy</h4>
      <p>Rocket Cast is not directed to children under 13, and we do not knowingly offer Rocket Cast accounts to children under 13. If we learn that we have collected personal information from a child under 13 in circumstances where applicable law requires us to obtain parental consent, we will take reasonable steps to delete that information. Some jurisdictions provide additional protections for minors, and we will comply with applicable age and consent requirements imposed by the laws that apply to our processing.</p>
    </section>

    <section>
      <h4>10. Changes to This Privacy Policy</h4>
      <p>We may update this Privacy Policy as Rocket Cast's services, technology, vendors, or legal obligations change. When we make a material change, we will update the effective date at the top of this policy and provide additional notice when required by applicable law.</p>
    </section>

    <section>
      <h4>11. Contact</h4>
      <p>For privacy questions, requests, or security concerns, contact Daniel Kindt / Rocket Cast, United States, at <a href="mailto:snorklzcasts@gmail.com">snorklzcasts@gmail.com</a>.</p>
    </section>
  `;
}

const TERMS_OF_SERVICE_EFFECTIVE_DATE = "August 24, 2026";

// Same single-source-of-truth approach as renderPrivacyPolicyContentHtml()
// above: the in-app modal and the public /terms page both render from
// this one function. This is a solid draft, not a substitute for an
// actual lawyer reviewing it -- the refund, liability, and governing-law
// sections in particular carry real weight and are worth a real review
// before they're ever tested.
function renderTermsOfServiceContentHtml() {
  return `
    <p class="pp-meta">Effective ${TERMS_OF_SERVICE_EFFECTIVE_DATE} &middot; Applies to the Rocket Cast desktop application, RocketCast.net, and related services</p>

    <section>
      <h4>1. Acceptance of Terms</h4>
      <p>These Terms of Service ("Terms") are an agreement between you and Daniel Kindt, operating as Rocket Cast ("Rocket Cast," "we," "us," or "our"), governing your use of the Rocket Cast desktop application, RocketCast.net, and related services (collectively, the "Service"). By downloading, installing, or using the Service, you agree to these Terms. If you do not agree, do not use the Service.</p>
      <p style="font-size:calc(12px * var(--font-scale));color:var(--muted)">Rocket Cast is an independent tool and is not affiliated with, sponsored by, or endorsed by Psyonix LLC or Epic Games. "Rocket League" is a trademark of Psyonix LLC.</p>
    </section>

    <section>
      <h4>2. The Service</h4>
      <p>Rocket Cast is a broadcast-overlay application for Rocket League. A free tier is available without an account for local use. Creating a Rocket Cast + account and subscribing unlocks additional features, described at the time of purchase and on RocketCast.net. We may add, change, or remove features at any time, including features available under a subscription, though we will not materially reduce what an active subscription includes without reasonable notice.</p>
    </section>

    <section>
      <h4>3. Accounts</h4>
      <p>You must provide an accurate email address and keep your account credentials confidential. You are responsible for all activity that occurs under your account. Notify us promptly at <a href="mailto:snorklzcasts@gmail.com">snorklzcasts@gmail.com</a> if you believe your account has been compromised. You must be at least 13 years old to create an account.</p>
    </section>

    <section>
      <h4>4. Subscriptions, Billing, and Cancellation</h4>
      <p>Rocket Cast + is billed on a recurring basis through Stripe at the price and interval shown at checkout. Your subscription renews automatically at the end of each billing period unless you cancel before it renews. You can cancel at any time from your account; canceling stops future renewals, and your Rocket Cast + access continues until the end of the billing period you already paid for.</p>
      <p>We do not provide prorated refunds for partial billing periods or unused time. If you believe you were charged in error, contact <a href="mailto:snorklzcasts@gmail.com">snorklzcasts@gmail.com</a> -- refund requests are reviewed case by case and are not guaranteed, except where applicable law requires a refund. Prices may change; we will give reasonable notice before a price change affects an active subscription's next renewal.</p>
    </section>

    <section>
      <h4>5. Acceptable Use</h4>
      <p>You agree not to:</p>
      <ul>
        <li>reverse engineer, decompile, or circumvent access controls on paid features of the Service;</li>
        <li>use the Service to transmit, host, or relay unlawful, infringing, or abusive content, including through the LAN/co-stream hosting feature;</li>
        <li>interfere with or disrupt the Service's infrastructure, including attempting to bypass rate limiting or authentication;</li>
        <li>use the Service to violate Rocket League's or any other third-party service's own terms; or</li>
        <li>resell, sublicense, or provide the Service to third parties as your own product.</li>
      </ul>
      <p>We may suspend or terminate access for a violation of this section.</p>
    </section>

    <section>
      <h4>6. Intellectual Property</h4>
      <p>Rocket Cast, its software, branding, and website content are owned by Daniel Kindt / Rocket Cast, except for third-party assets used under license. You retain ownership of overlay layouts, match data, and recorded clips you create using the Service. You grant us no rights to that content beyond what is necessary to operate the Service (for example, relaying it through a LAN co-stream session you choose to host).</p>
    </section>

    <section>
      <h4>7. Third-Party Services</h4>
      <p>The Service integrates with or links to third-party services, including Stripe (payments), OBS (broadcast software), VDO.Ninja (camera feeds), and Discord. Your use of those services is governed by their own terms, and we are not responsible for their availability or conduct.</p>
    </section>

    <section>
      <h4>8. Disclaimers</h4>
      <p>The Service is provided "as is" and "as available," without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement. We do not guarantee that live match data will always be accurate, that the Service will be uninterrupted or error-free, or that it will remain compatible with future versions of Rocket League.</p>
    </section>

    <section>
      <h4>9. Limitation of Liability</h4>
      <p>To the maximum extent permitted by law, Rocket Cast will not be liable for indirect, incidental, special, consequential, or punitive damages, or for lost profits, revenue, or data, arising from your use of the Service. Our total liability for any claim relating to the Service will not exceed the amount you paid us in the 12 months before the claim arose, or $50 if you have not paid us anything.</p>
    </section>

    <section>
      <h4>10. Termination</h4>
      <p>You may stop using the Service and delete your account at any time. We may suspend or terminate your access if you violate these Terms, or discontinue the Service (or a feature of it) with reasonable notice where practical. Sections that by their nature should survive termination -- including Intellectual Property, Disclaimers, and Limitation of Liability -- will survive.</p>
    </section>

    <section>
      <h4>11. Governing Law</h4>
      <p>These Terms are governed by the laws of the State of Alabama, United States, without regard to its conflict-of-law principles, except where applicable consumer-protection law requires otherwise.</p>
    </section>

    <section>
      <h4>12. Changes to These Terms</h4>
      <p>We may update these Terms as the Service changes. When we make a material change, we will update the effective date above and, where required by law, provide additional notice before it takes effect. Continued use of the Service after a change takes effect constitutes acceptance of the updated Terms.</p>
    </section>

    <section>
      <h4>13. Contact</h4>
      <p>Questions about these Terms: Daniel Kindt / Rocket Cast, United States, at <a href="mailto:snorklzcasts@gmail.com">snorklzcasts@gmail.com</a>.</p>
    </section>
  `;
}

function renderStandaloneReelPlayerHtml() {
  return `<!doctype html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width,initial-scale=1" />\n    <title>Rocket Cast Highlight Reels</title>\n    <style>\n        html, body {\n            margin: 0;\n            width: 100%;\n            height: 100%;\n            overflow: hidden;\n            background: transparent;\n        }\n\n        #reel-root {\n            position: fixed;\n            inset: 0;\n            opacity: 0;\n            transition: opacity 420ms ease;\n            background: transparent;\n        }\n\n        #reel-root.ready {\n            opacity: 1;\n        }\n\n        #reel-video {\n            position: absolute;\n            inset: 0;\n            width: 100%;\n            height: 100%;\n            object-fit: cover;\n            background: transparent;\n        }\n    </style>\n</head>\n<body>\n    <div id="reel-root">\n        <video id="reel-video" playsinline></video>\n    </div>\n\n    <script src="/socket.io/socket.io.js"><\/script>\n    <script>\n        (() => {\n            const root = document.getElementById('reel-root');\n            const video = document.getElementById('reel-video');\n            const mediaOrigin = 'http://localhost:${mediaHttpPort}';\n            let lastToken = '';\n            let hideTimer = null;\n\n            function normalizeMediaUrl(value) {\n                const raw = String(value || '').trim();\n                if (!raw) return '';\n                if (raw.startsWith('/media/')) return mediaOrigin + raw;\n                if (raw.startsWith('/')) return mediaOrigin + raw;\n\n                if (raw.startsWith('http://') || raw.startsWith('https://')) {\n                    try {\n                        const parsed = new URL(raw);\n                        if (parsed.pathname.startsWith('/media/')) {\n                            parsed.protocol = 'http:';\n                            parsed.hostname = 'localhost';\n                            parsed.port = String(${mediaHttpPort});\n                            return parsed.toString();\n                        }\n                        return raw;\n                    } catch {\n                        return raw;\n                    }\n                }\n\n                return mediaOrigin + '/media/' + raw;\n            }\n\n            function stopVideo(immediate = false) {\n                if (hideTimer) {\n                    clearTimeout(hideTimer);\n                    hideTimer = null;\n                }\n\n                if (!immediate) {\n                    root.classList.remove('ready');\n                    hideTimer = setTimeout(() => {\n                        video.pause();\n                        video.removeAttribute('src');\n                        video.load();\n                    }, 430);\n                    return;\n                }\n\n                root.classList.remove('ready');\n                video.pause();\n                video.removeAttribute('src');\n                video.load();\n            }\n\n            function playFromPayload(payload) {\n                const mediaUrl = normalizeMediaUrl(payload?.mediaUrl || payload?.mediaPath || '');\n                if (!mediaUrl) {\n                    return;\n                }\n\n                const matchId = String(payload?.matchId || '');\n                const playedAt = Number(payload?.playedAt || 0);\n                const token = matchId + '|' + playedAt + '|' + mediaUrl;\n                if (token && token === lastToken) {\n                    return;\n                }\n                lastToken = token;\n\n                stopVideo(true);\n                const cacheBust = mediaUrl.includes('?') ? '&' : '?';\n                video.src = mediaUrl + cacheBust + 't=' + Date.now();\n                video.currentTime = 0;\n                root.classList.remove('ready');\n\n                const reveal = () => {\n                    root.classList.add('ready');\n                    video.play().catch(() => {});\n                };\n\n                video.addEventListener('loadeddata', reveal, { once: true });\n                video.addEventListener('canplay', reveal, { once: true });\n            }\n\n            video.addEventListener('ended', () => {\n                stopVideo(false);\n            });\n\n            video.addEventListener('error', () => {\n                stopVideo(false);\n            });\n\n            const socket = io();\n            socket.on('highlight-reel-play', (payload) => {\n                playFromPayload(payload || {});\n            });\n        })();\n    <\/script>\n</body>\n</html>`;
}

posthog || console.log("PostHog disabled: POSTHOG_API_KEY not set."),
// gzip everything compressible (JSON API responses especially -- match
// history, admin account lists, and overlay/clip metadata all serialize to
// a lot of repetitive JSON). compression()'s default filter already skips
// content-types that are already compressed (video, images), so this
// doesn't waste CPU re-compressing clip/media bytes served from /media.
app.use(compression()), mediaApp.use(compression()),
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff"), res.setHeader("Referrer-Policy", "no-referrer"),
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Nothing in this app loads a script/style/font from any external host
  // (no CDN, no Google Fonts, no Stripe.js) -- everything is same-origin or
  // inline, so 'self' + 'unsafe-inline' costs nothing functionally while
  // still blocking the two things that actually matter if an XSS payload
  // ever lands: pulling in attacker-hosted JS, and framing/embedding
  // plugins. Kept out of script/style-src is any 'unsafe-eval', and
  // object-src/base-uri are locked down outright.
  // script-src/frame-src/connect-src/img-src each get one narrow addition
  // here: platform.twitter.com (and its syndication/image hosts) for the
  // official X/Twitter embed widget on the public landing page. Nothing
  // else gets widened.
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://platform.twitter.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://pbs.twimg.com https://abs.twimg.com; media-src 'self' blob:; connect-src 'self' ws: wss: https://cdn.syndication.twimg.com https://syndication.twitter.com; font-src 'self' data:; frame-src 'self' https://platform.twitter.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  const requestPath = decodeURIComponent(req.path || ""), pathParts = requestPath.split("/").filter(Boolean);
  "/browser-source" === requestPath || requestPath.startsWith("/overlays/") || pathParts.length > 0 && overlayRegistry?.has(pathParts[0]) ? res.setHeader("X-Frame-Options", "SAMEORIGIN") : res.setHeader("X-Frame-Options", "DENY"),
  "/api/web/billing/webhook" !== req.path ? /^\/api\/matches\/[^/]+\/clips\/[^/]+\/upload$/.test(String(req.path || "")) ? next() : express.json({
    limit: "100kb"
  })(req, res, next) : next();
// A generous, broad backstop -- 240 requests/min per IP across every /api
// route -- so nothing that can trigger server-side work (uploads, ffmpeg
// runs, DB writes, the remote proxy) is completely unthrottled, even ones
// that don't have their own tighter checkRateLimit() call below. Well above
// normal UI polling traffic; only kicks in for actual abuse/bugs.
}), app.use("/api", rateLimitMiddleware("api-global", {
  windowMs: 6e4,
  maxAttempts: 240
})), app.use((req, res, next) => {
  // Belt-and-suspenders on top of the guest-origin gate just below: the
  // public Render deployment of this exact file has no OBS, no local
  // media folder, and no match history of its own to protect — none of
  // the local-control API means anything there. Block it outright by name
  // instead of relying only on "isGuestOriginRequest" correctly treating
  // every hosted request as non-loopback.
  if (!isHostedWebDeployment) return next();
  const requestPath = req.path || "";
  // The landing page's download counter calls this one specifically --
  // it's a real public exception, not local-device control, so it needs
  // to stay reachable here same as /api/web/*.
  !requestPath.startsWith("/api/") || requestPath.startsWith("/api/web") || "/api/analytics/github-downloads" === requestPath ? next() : res.status(404).json({
    ok: !1,
    error: "Not found"
  });
}), app.use((req, res, next) => {
  // The real access gate for the local-control API: any request into
  // /api/* (other than the lan-server/web endpoints) that did NOT come from
  // this machine's own local UI — whether over the LAN, through the public
  // tunnel, or hitting a public deployment of this same server directly —
  // must carry a token proving it already passed password verification.
  //
  // This used to only apply "while lanServerState.hosting is true", on the
  // assumption that a stray non-loopback request only shows up during a
  // deliberate hosting session. That assumption was wrong: bindPortWithRetry
  // binds this HTTP server to every network interface (no host arg), all
  // the time, regardless of whether hosting was ever turned on — so anyone
  // on the same LAN/Wi-Fi as a running copy of the app, or anyone reaching
  // a standalone `node server.js` deployment of this file (e.g. on Render),
  // could previously hit /api/matches, /api/media-storage/settings,
  // /api/recording/obs/*, /api/streamdeck/* etc. directly, with zero auth,
  // any time — the password/token check was only ever a courtesy a
  // well-behaved guest happened to go through. The gate now applies to every
  // non-loopback caller unconditionally: it's only ever satisfied by an
  // active hosting session's guest token, so a device that isn't the app's
  // own local UI gets a flat 401 unless it actually authenticated as a
  // guest of an active, password-protected hosting session.
  const requestPath = req.path || "";
  if (!requestPath.startsWith("/api/") || requestPath.startsWith("/api/lan-server") || requestPath.startsWith("/api/web") || "/api/analytics/github-downloads" === requestPath) return next();
  if (!isGuestOriginRequest(req.headers?.host, req.socket?.remoteAddress)) return next();
  lanServerState.hosting && lanServerState.hostPasswordHash && isValidGuestToken(req.headers?.["x-rc-guest-token"]) ? next() : res.status(401).json({
    ok: !1,
    error: "Unauthorized"
  });
}), app.use(async (req, res, next) => {
  // Transparent guest-mode proxy: when connected as a guest to another
  // machine's server, every /api/* call this app would normally handle
  // itself gets forwarded to the host instead, and the host's response is
  // passed straight back. The renderer never knows the difference — same
  // relative fetch("/api/...") calls it always makes. /api/lan-server/*
  // stays local always (otherwise you could never disconnect), and
  // /api/web/* stays local too since premium/billing status is per-machine,
  // not something a guest should inherit from the host.
  if (!lanServerState.guestMode || !lanServerState.guestBaseUrl) return next();
  const requestPath = req.path || "";
  if (!requestPath.startsWith("/api/") || requestPath.startsWith("/api/lan-server") || requestPath.startsWith("/api/web") || "/api/analytics/github-downloads" === requestPath) return next();
  const method = String(req.method || "GET").toUpperCase();
  // Anyone can join to watch (GETs still proxy through freely), but only an
  // authenticated guest is allowed to send anything that changes shared
  // state on the host.
  if (![ "GET", "HEAD" ].includes(method) && !lanServerState.guestAuthenticated) return void res.status(403).json({
    ok: !1,
    error: "account-required",
    message: "Create an account to make changes while connected to someone else's server."
  });
  const targetUrl = `${lanServerState.guestBaseUrl}${requestPath}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
  try {
    const fetchOptions = { method: method, headers: {} };
    lanServerState.guestToken && (fetchOptions.headers["X-RC-Guest-Token"] = lanServerState.guestToken),
    [ "GET", "HEAD" ].includes(method) || (fetchOptions.headers["Content-Type"] = "application/json",
    fetchOptions.body = JSON.stringify(req.body && "object" == typeof req.body ? req.body : {}));
    const response = await fetch(targetUrl, fetchOptions), responseText = await response.text();
    res.status(response.status), res.set("content-type", String(response.headers.get("content-type") || "application/json")), res.send(responseText);
  } catch (error) {
    res.status(502).json({
      ok: !1,
      error: `Couldn't reach the hosting server: ${error?.message || "unknown error"}`
    });
  }
}), app.use(express.static(path.join(appPath, "public"))), app.use("/media", (req, res, next) => {
  if (mediaHttpPort !== controlHttpPort) {
    const queryIndex = String(req.originalUrl || "").indexOf("?"), querySuffix = queryIndex >= 0 ? String(req.originalUrl || "").slice(queryIndex) : "", target = `http://localhost:${mediaHttpPort}${req.path}${querySuffix}`;
    return void res.redirect(302, target);
  }
  next();
}, serveCurrentMediaRoot), mediaApp.use("/media", serveCurrentMediaRoot),
mediaApp.get([ "/", "/reel", "/reel-player" ], (req, res) => {
  res.type("html").send(renderStandaloneReelPlayerHtml());
}), app.get("/", (req, res) => {
  // loader.html is an OBS browser-source page (an iframe host driven by
  // socket events) -- nobody points OBS at the public internet deployment,
  // only at a local desktop install. On the hosted deployment, "/" is the
  // actual public-facing rocketcast.net homepage instead.
  res.sendFile(path.join(appPath, "public", isHostedWebDeployment ? "landing.html" : "loader.html"));
}), app.get("/control", (req, res) => {
  res.sendFile(path.join(appPath, "index.html"));
// Same design tokens as public/landing.html (not a separate look), built
// around the one shared renderPrivacyPolicyContentHtml() so this page and
// the in-app modal never show two different versions of the policy.
}), app.get("/privacy", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Privacy Policy - Rocket Cast</title>
<meta name="description" content="How Rocket Cast collects, uses, stores, and discloses information across the desktop app, RocketCast.net, and related services." />
<link rel="canonical" href="https://rocketcast.net/privacy" />
<link rel="icon" href="/build/RC.ico" type="image/x-icon" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Rocket Cast" />
<meta property="og:title" content="Privacy Policy - Rocket Cast" />
<meta property="og:description" content="How Rocket Cast collects, uses, stores, and discloses information." />
<meta name="twitter:card" content="summary" />
<style>
@font-face{font-family:Bourgeois;src:url('/fonts/Bourgeois-Bold.otf') format('opentype');font-weight:700;font-style:normal;font-display:swap}
@font-face{font-family:Bourgeois;src:url('/fonts/Bourgeois-Bold-Italic.ttf') format('truetype');font-weight:700;font-style:italic;font-display:swap}
:root{
  --font-brand:'Bourgeois','Segoe UI Variable','Trebuchet MS',Verdana,Tahoma,sans-serif;
  --font-scale:1;
  --bg:#0e1520;
  --text:#eaf1f8;
  --panel-bg:#141d2b;
  --panel-border:#26374f;
  --muted:#7f93ab;
  --panel-alt:#101724;
  --accent:#49a5df;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:"Segoe UI Variable","Trebuchet MS",Verdana,Tahoma,sans-serif;line-height:1.6;min-height:100vh}
a{color:var(--accent)}
.page{max-width:820px;margin:0 auto;padding:28px 20px 60px}
.container{background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:18px;padding:22px;margin-bottom:18px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand-lockup{display:flex;align-items:center;gap:14px;text-decoration:none}
.brand-mark{display:block;width:40px;height:40px;border-radius:11px;object-fit:cover;background:var(--panel-alt)}
.brand-lockup h1{margin:0;font-family:var(--font-brand);font-size:24px;line-height:1;letter-spacing:-.02em;font-weight:700;color:var(--text)}
.back-link{color:var(--muted);text-decoration:underline;text-underline-offset:2px;font-size:13px}
.back-link:hover{color:var(--text)}
h2{font-family:var(--font-brand);font-size:26px;margin:0 0 4px}
.pp-meta{color:var(--muted);font-size:13px;margin:0 0 22px}
section{margin-bottom:26px}
section:last-child{margin-bottom:0}
h4{font-family:var(--font-brand);font-size:17px;margin:0 0 10px}
h5{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:16px 0 6px}
p{margin:0 0 10px;font-size:14.5px}
code{background:var(--panel-alt);border:1px solid var(--panel-border);border-radius:4px;padding:1px 5px;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin:10px 0}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--panel-border);vertical-align:top}
th{color:var(--muted);font-weight:600}
</style>
</head>
<body>
  <div class="page">
    <div class="container">
      <div class="topbar">
        <a class="brand-lockup" href="/">
          <img class="brand-mark" src="/build/RC.ico" alt="Rocket Cast" />
          <h1>Rocket Cast</h1>
        </a>
        <span style="display:flex;gap:14px;align-items:center">
          <a class="back-link" href="/terms">Terms of Service</a>
          <a class="back-link" href="/">&larr; Back to rocketcast.net</a>
        </span>
      </div>
    </div>
    <div class="container">
      <h2>Privacy Policy</h2>
      ${renderPrivacyPolicyContentHtml()}
    </div>
  </div>
</body>
</html>`);
// Same shell as /privacy, same reasoning: one shared
// renderTermsOfServiceContentHtml() feeding both this page and the JSON
// endpoint the account/checkout flow can link out to.
}), app.get("/terms", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Terms of Service - Rocket Cast</title>
<meta name="description" content="The terms governing use of the Rocket Cast desktop application, RocketCast.net, and related services." />
<link rel="canonical" href="https://rocketcast.net/terms" />
<link rel="icon" href="/build/RC.ico" type="image/x-icon" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Rocket Cast" />
<meta property="og:title" content="Terms of Service - Rocket Cast" />
<meta property="og:description" content="The terms governing use of Rocket Cast." />
<meta name="twitter:card" content="summary" />
<style>
@font-face{font-family:Bourgeois;src:url('/fonts/Bourgeois-Bold.otf') format('opentype');font-weight:700;font-style:normal;font-display:swap}
@font-face{font-family:Bourgeois;src:url('/fonts/Bourgeois-Bold-Italic.ttf') format('truetype');font-weight:700;font-style:italic;font-display:swap}
:root{
  --font-brand:'Bourgeois','Segoe UI Variable','Trebuchet MS',Verdana,Tahoma,sans-serif;
  --font-scale:1;
  --bg:#0e1520;
  --text:#eaf1f8;
  --panel-bg:#141d2b;
  --panel-border:#26374f;
  --muted:#7f93ab;
  --panel-alt:#101724;
  --accent:#49a5df;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:"Segoe UI Variable","Trebuchet MS",Verdana,Tahoma,sans-serif;line-height:1.6;min-height:100vh}
a{color:var(--accent)}
.page{max-width:820px;margin:0 auto;padding:28px 20px 60px}
.container{background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:18px;padding:22px;margin-bottom:18px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand-lockup{display:flex;align-items:center;gap:14px;text-decoration:none}
.brand-mark{display:block;width:40px;height:40px;border-radius:11px;object-fit:cover;background:var(--panel-alt)}
.brand-lockup h1{margin:0;font-family:var(--font-brand);font-size:24px;line-height:1;letter-spacing:-.02em;font-weight:700;color:var(--text)}
.back-link{color:var(--muted);text-decoration:underline;text-underline-offset:2px;font-size:13px}
.back-link:hover{color:var(--text)}
h2{font-family:var(--font-brand);font-size:26px;margin:0 0 4px}
.pp-meta{color:var(--muted);font-size:13px;margin:0 0 22px}
section{margin-bottom:26px}
section:last-child{margin-bottom:0}
h4{font-family:var(--font-brand);font-size:17px;margin:0 0 10px}
h5{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:16px 0 6px}
p{margin:0 0 10px;font-size:14.5px}
ul{margin:0 0 10px;padding-left:20px;font-size:14.5px;line-height:1.7}
code{background:var(--panel-alt);border:1px solid var(--panel-border);border-radius:4px;padding:1px 5px;font-size:13px}
</style>
</head>
<body>
  <div class="page">
    <div class="container">
      <div class="topbar">
        <a class="brand-lockup" href="/">
          <img class="brand-mark" src="/build/RC.ico" alt="Rocket Cast" />
          <h1>Rocket Cast</h1>
        </a>
        <span style="display:flex;gap:14px;align-items:center">
          <a class="back-link" href="/privacy">Privacy Policy</a>
          <a class="back-link" href="/">&larr; Back to rocketcast.net</a>
        </span>
      </div>
    </div>
    <div class="container">
      <h2>Terms of Service</h2>
      ${renderTermsOfServiceContentHtml()}
    </div>
  </div>
</body>
</html>`);
}), app.get("/pricing", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Pricing - Rocket Cast</title>
<meta name="description" content="Rocket Cast pricing: a free tier, Rocket Cast+ at $5/month, and overlay packages for leagues, college programs, and orgs." />
<link rel="canonical" href="https://rocketcast.net/pricing" />
<link rel="icon" href="/build/RC.ico" type="image/x-icon" />
<meta name="robots" content="noindex,follow" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Rocket Cast" />
<meta property="og:title" content="Pricing - Rocket Cast" />
<meta property="og:description" content="Broadcast overlays and tools built for Rocket League productions." />
<meta name="twitter:card" content="summary" />
<style>
@font-face{font-family:Bourgeois;src:url('/fonts/Bourgeois-Bold.otf') format('opentype');font-weight:700;font-style:normal;font-display:swap}
@font-face{font-family:Bourgeois;src:url('/fonts/Bourgeois-Bold-Italic.ttf') format('truetype');font-weight:700;font-style:italic;font-display:swap}
:root{
  --font-brand:'Bourgeois','Segoe UI Variable','Trebuchet MS',Verdana,Tahoma,sans-serif;
  --bg:#0e1520;
  --text:#eaf1f8;
  --panel-bg:#141d2b;
  --panel-border:#26374f;
  --muted:#7f93ab;
  --panel-alt:#101724;
  --accent:#49a5df;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:"Segoe UI Variable","Trebuchet MS",Verdana,Tahoma,sans-serif;line-height:1.6;min-height:100vh}
a{color:var(--accent)}
.page{max-width:980px;margin:0 auto;padding:28px 20px 60px}
.container{background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:18px;padding:22px;margin-bottom:18px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand-lockup{display:flex;align-items:center;gap:14px;text-decoration:none}
.brand-mark{display:block;width:40px;height:40px;border-radius:11px;object-fit:cover;background:var(--panel-alt)}
.brand-lockup h1{margin:0;font-family:var(--font-brand);font-size:24px;line-height:1;letter-spacing:-.02em;font-weight:700;color:var(--text)}
.back-link{color:var(--muted);text-decoration:underline;text-underline-offset:2px;font-size:13px}
.back-link:hover{color:var(--text)}
h2{font-family:var(--font-brand);font-size:30px;margin:0 0 4px}
.lede{color:var(--muted);font-size:15px;margin:0}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px;font-weight:600}
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
.tier{background:var(--panel-alt);border:1px solid var(--panel-border);border-radius:14px;padding:18px;display:flex;flex-direction:column}
.tier.is-featured{border-color:var(--accent)}
.tier-name{font-family:var(--font-brand);font-size:19px;margin:0 0 2px}
.tier-price{font-family:var(--font-brand);font-size:26px;color:var(--accent);margin:0 0 2px;line-height:1.2}
.tier-note{color:var(--muted);font-size:13px;margin:0 0 14px}
.tier ul{list-style:none;margin:0;padding:0;flex:1}
.tier li{position:relative;padding-left:20px;margin-bottom:8px;font-size:14px}
.tier li::before{content:"";position:absolute;left:2px;top:8px;width:7px;height:7px;border-radius:50%;background:var(--accent)}
.tier li:last-child{margin-bottom:0}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}
.meta div{background:var(--panel-alt);border:1px solid var(--panel-border);border-radius:14px;padding:16px}
h4{font-family:var(--font-brand);font-size:16px;margin:0 0 6px}
p{margin:0 0 10px;font-size:14.5px}
p:last-child{margin-bottom:0}
.cta{text-align:center}
.cta h2{margin-bottom:8px}
@media (max-width:640px){
  h2{font-size:25px}
  .page{padding:20px 14px 44px}
}
</style>
</head>
<body>
  <div class="page">
    <div class="container">
      <div class="topbar">
        <a class="brand-lockup" href="/">
          <img class="brand-mark" src="/build/RC.ico" alt="Rocket Cast" />
          <h1>Rocket Cast</h1>
        </a>
        <span style="display:flex;gap:14px;align-items:center">
          <a class="back-link" href="/terms">Terms of Service</a>
          <a class="back-link" href="/">&larr; Back to rocketcast.net</a>
        </span>
      </div>
    </div>

    <div class="container">
      <h2>Pricing</h2>
      <p class="lede">Broadcast overlays and tools built for Rocket League productions.</p>
    </div>

    <div class="container">
      <h3>Ongoing</h3>
      <div class="tiers">
        <div class="tier">
          <p class="tier-name">Free Tier</p>
          <p class="tier-price">$0</p>
          <p class="tier-note">Get your stream looking clean and professional, no cost to start.</p>
          <ul>
            <li>Full overlay functionality with any custom overlay able to upload</li>
            <li>Standard broadcast overlay (main overlay, name plates, boost meter)</li>
            <li>Great for casters, small leagues, and first-time users</li>
          </ul>
        </div>
        <div class="tier is-featured">
          <p class="tier-name">Rocket Cast+</p>
          <p class="tier-price">$5<span style="font-size:15px;color:var(--muted)">/month</span></p>
          <p class="tier-note">Broadcast-oriented upgrades for any production, on top of any overlay package.</p>
          <ul>
            <li>Match history tracking</li>
            <li>Automatic highlight generator</li>
            <li>Custom animations and scene transitions</li>
            <li>Priority support</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="container">
      <h3>Overlay packages</h3>
      <div class="tiers">
        <div class="tier">
          <p class="tier-name">Standard Overlay Package</p>
          <p class="tier-price">$200&ndash;300</p>
          <p class="tier-note">Great for individual leagues, single-team streams, and standalone productions.</p>
          <ul>
            <li>Main overlay</li>
            <li>Win screen</li>
            <li>Stats wall</li>
          </ul>
        </div>
        <div class="tier">
          <p class="tier-name">School / CRL Program Package</p>
          <p class="tier-price">from $150<span style="font-size:15px;color:var(--muted)">/season</span></p>
          <p class="tier-note">Built for college esports programs and CRL broadcasts. Start free, upgrade anytime.</p>
          <ul>
            <li>CRL Overlay</li>
            <li>Full season broadcast support</li>
            <li>Custom Assets</li>
          </ul>
        </div>
        <div class="tier">
          <p class="tier-name">Custom Org Package</p>
          <p class="tier-price">from $450</p>
          <p class="tier-note">For orgs and multi-team brands that need more. Final pricing depends on scope, reach out for a quote tailored to your org.</p>
          <ul>
            <li>Multiple branded overlay sets</li>
            <li>Custom colors matched to your org's exact branding</li>
            <li>Name plates and boost meter</li>
            <li>Live, player-specific stats on lock-on</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="container">
      <h3>Payment &amp; timeline</h3>
      <div class="meta">
        <div>
          <h4>Payment</h4>
          <p>25% upfront to begin, remainder due on completion.</p>
        </div>
        <div>
          <h4>Timeline</h4>
          <p>Typically 1&ndash;2 weeks for a custom build, depending on how quickly branding assets (logos, hex codes) are provided.</p>
        </div>
      </div>
    </div>

    <div class="container cta">
      <h2>Get started</h2>
      <p>Interested in Rocket Cast for your team, league, or program? Reach out to <strong>Snorklz</strong> on Discord and let's talk about what fits best.</p>
    </div>
  </div>
</body>
</html>`);
}), app.use((req, res, next) => {
  // appPath is the whole project directory, and express.static(appPath)
  // below happily serves anything under it that isn't a dotfile -- which
  // was quietly publishing this app's own source (server.js, main.js,
  // preload.js), its entire node_modules tree, build/code-signing scripts,
  // internal docs, and — worst of all — rocket-cast-web.env, a plain-text
  // copy of this app's real production secrets (database URL, Stripe keys,
  // admin API key). That file isn't a dotfile, so Express's default
  // dotfile handling never protected it. Deny by name/prefix rather than
  // trying to enumerate everything that IS meant to be public (index.html,
  // renderer.js, style.css, overlays/**, build/**, public/** all still
  // need to keep working through the static handler below).
  // path.posix.normalize collapses any ../ segments (URL-encoded or not,
  // since decodeURIComponent already ran) before the checks below ever
  // see the path. Without this, a request like /build/..%2fserver.js
  // decodes to the string "/build/../server.js" -- which is not equal to
  // "/server.js" and does not start with "/node_modules/", so every
  // check below silently passed it through, and express.static happily
  // resolved the ../ itself and served the real file. Confirmed live:
  // that exact request was returning server.js, main.js, package.json,
  // the whole node_modules tree, scripts/, and docs/ before this fix.
  // Root-level scripts are denied by shape, not by name. The enumerated list
  // this used to be stopped covering new files the moment one was added --
  // server-plus.js, bracket-engine.js and startgg-import.js were all being
  // served in full. renderer.js is the one root script the control panel
  // actually loads, so it is the only exception.
  const requestPath = path.posix.normalize(decodeURIComponent(req.path || ""));
  if (/^\/[^/]+\.js$/i.test(requestPath) && "/renderer.js" !== requestPath) return void res.status(404).end();
  if ([ "/package.json", "/package-lock.json", "/rocket-cast-web.env", "/bug tracker.txt" ].includes(requestPath) ||
    [ "/node_modules/", "/scripts/", "/docs/", "/dist/" ].some(prefix => requestPath.startsWith(prefix)) ||
    /\.env(\.|$)/i.test(requestPath) || /\.(env|pem|key|p12|pfx)$/i.test(requestPath)) return void res.status(404).end();
  next();
}), app.use(express.static(appPath, {
  setHeaders: (res, filePath) => {
    filePath.endsWith(".html") && res.set("Content-Type", "text/html");
  }
}));

app.post("/api/lan-server/host", rateLimitMiddleware("lan-host", {
  windowMs: 6e4,
  maxAttempts: 10
}), async (req, res) => {
  try {
    const identity = await resolveAuthenticatedIdentity(req);
    if (!identity) return void res.status(401).json({
      ok: !1,
      error: "Log in to host a server"
    });
    if (lanServerState.guestMode) return void res.status(400).json({
      ok: !1,
      error: "Disconnect from the server you're connected to first"
    });
    if (!String(identity.user.username || "").trim()) return void res.status(400).json({
      ok: !1,
      error: "Set a username on your account before hosting a server"
    });
    startHostingLanServer(req.body?.name, req.body?.password, {
      userId: identity.user.id,
      email: identity.user.email,
      username: identity.user.username,
      token: identity.token
    }), res.json({
      ok: !0,
      name: lanServerState.hostName
    });
  } catch (error) {
    res.status(400).json({
      ok: !1,
      error: error?.message || "Failed to start hosting"
    });
  }
}), app.post("/api/lan-server/stop-hosting", (req, res) => {
  stopHostingLanServer(), res.json({ ok: !0 });
}), app.post("/api/lan-server/verify-password", rateLimitMiddleware("lan-verify-password", {
  windowMs: 3e5,
  maxAttempts: 10
}), (req, res) => {
  if (!lanServerState.hosting) return void res.status(404).json({
    ok: !1,
    error: "Not hosting"
  });
  const ok = secureStringEqual(hashLanPassword(req.body?.password), lanServerState.hostPasswordHash);
  res.json({
    ok: ok,
    // Passwords are mandatory for every hosted server now, so a successful
    // verification always issues a token here — this is the only path that
    // grants one, which is what the auth gates elsewhere check for.
    token: ok ? issueGuestToken() : ""
  });
}), app.post("/api/lan-server/connect", rateLimitMiddleware("lan-connect", {
  windowMs: 6e4,
  maxAttempts: 20
}), async (req, res) => {
  try {
    // Anyone can join a server to watch -- an account is only required to
    // make changes once connected (see the relay/proxy gates further down,
    // keyed off guestAuthenticated). Resolving identity here is best-effort:
    // if the caller is logged in, their real username follows them onto the
    // host's roster; if not, they show up as "Guest".
    const identity = await resolveAuthenticatedIdentity(req);
    if (lanServerState.hosting) return void res.status(400).json({
      ok: !1,
      error: "Stop hosting before connecting to another server"
    });
    const result = await connectToLanServer(req.body?.name, req.body?.password, {
      username: identity?.user?.username || "",
      authenticated: Boolean(identity)
    });
    res.json({
      ...result,
      authenticated: Boolean(identity)
    });
  } catch (error) {
    res.status(400).json({
      ok: !1,
      error: error?.message || "Failed to connect"
    });
  }
}), app.post("/api/lan-server/disconnect", (req, res) => {
  disconnectFromLanServer(), res.json({ ok: !0 });
}), app.get("/api/lan-server/status", async (req, res) => {
  let seatLimit = FREE_SERVER_SEAT_LIMIT;
  if (lanServerState.hosting) try {
    const entitlement = await resolveEntitlementForHost();
    "premium" === entitlement.entitlement && "active" === entitlement.status && (seatLimit = null);
  } catch {}
  res.json({
    ok: !0,
    hosting: lanServerState.hosting,
    hostName: lanServerState.hostName,
    hostHasPassword: Boolean(lanServerState.hostPasswordHash),
    hostTunnelUrl: lanServerState.hostTunnelUrl,
    hostTunnelStarting: lanServerState.hostTunnelStarting,
    hostTunnelError: lanServerState.hostTunnelError,
    connectedGuests: lanServerState.hosting ? Array.from(lanServerState.connectedGuestSeats.values()).map(seat => ({ username: seat.username })) : [],
    seatLimit: seatLimit,
    guestMode: lanServerState.guestMode,
    guestConnectedName: lanServerState.guestConnectedName,
    guestConnected: lanServerState.guestConnected,
    guestAuthenticated: lanServerState.guestAuthenticated,
    guestError: lanServerState.guestError
  });
}), app.get("/api/ports", (req, res) => {
  // index.html is served as a static file (not templated), so it can't
  // bake in the real ports at render time -- when this instance fell back
  // off the default ports (see bindPortWithRetry, for when another copy of
  // Rocket Cast is already running), the renderer fetches this once to
  // show accurate OBS browser-source instructions instead of always
  // saying localhost:3000/3001.
  res.json({ ok: !0, controlPort: controlHttpPort, mediaPort: mediaHttpPort, bracketPort: bracketHttpPort });
}), app.get("/api/media-storage/settings", (req, res) => {
  res.json({
    ok: !0,
    currentPath: mediaRootPath,
    defaultPath: defaultMediaRootPath,
    isCustom: path.resolve(mediaRootPath) !== path.resolve(defaultMediaRootPath)
  });
}), app.post("/api/media-storage/settings", rateLimitMiddleware("media-storage-change", {
  windowMs: 6e4,
  maxAttempts: 10
}), async (req, res) => {
  const requestedPath = String(req.body?.path || "").trim();
  if (!requestedPath) return void res.status(400).json({ ok: !1, error: "No folder was provided." });
  if (!path.isAbsolute(requestedPath)) return void res.status(400).json({ ok: !1, error: "Choose a folder using the picker rather than typing a path." });
  const resolvedTarget = path.resolve(requestedPath);
  if (resolvedTarget === path.resolve(mediaRootPath)) return void res.json({
    ok: !0,
    currentPath: mediaRootPath,
    message: "That's already the current media folder."
  });
  try {
    fs.mkdirSync(resolvedTarget, {
      recursive: !0
    }), fs.accessSync(resolvedTarget, fs.constants.W_OK);
  } catch (error) {
    return void res.status(400).json({
      ok: !1,
      error: `That folder isn't writable: ${error?.message || error}`
    });
  }
  const previousPath = mediaRootPath, moveExisting = Boolean(req.body?.moveExisting);
  if (moveExisting && fs.existsSync(previousPath) && path.resolve(previousPath) !== resolvedTarget) try {
    await fs.promises.cp(previousPath, resolvedTarget, {
      recursive: !0,
      force: !1,
      errorOnExist: !1
    }), await fs.promises.rm(previousPath, {
      recursive: !0,
      force: !0
    });
  } catch (error) {
    return void res.status(500).json({
      ok: !1,
      error: `Couldn't move existing files to the new folder: ${error?.message || error}`
    });
  }
  try {
    fs.writeFileSync(mediaStorageConfigPath, JSON.stringify({
      mediaRootPath: resolvedTarget
    }, null, 2));
  } catch (error) {
    return void res.status(500).json({
      ok: !1,
      error: `Couldn't save the new location: ${error?.message || error}`
    });
  }
  setMediaRootPath(resolvedTarget), res.json({
    ok: !0,
    currentPath: mediaRootPath,
    moved: moveExisting
  });
}), app.post("/api/media-storage/reset", rateLimitMiddleware("media-storage-change", {
  windowMs: 6e4,
  maxAttempts: 10
}), async (req, res) => {
  const resolvedTarget = path.resolve(defaultMediaRootPath);
  if (resolvedTarget === path.resolve(mediaRootPath)) return void res.json({
    ok: !0,
    currentPath: mediaRootPath,
    message: "Already using the default folder."
  });
  try {
    fs.mkdirSync(resolvedTarget, {
      recursive: !0
    });
  } catch (error) {
    return void res.status(500).json({
      ok: !1,
      error: error?.message || String(error)
    });
  }
  const previousPath = mediaRootPath, moveExisting = Boolean(req.body?.moveExisting);
  if (moveExisting && fs.existsSync(previousPath) && path.resolve(previousPath) !== resolvedTarget) try {
    await fs.promises.cp(previousPath, resolvedTarget, {
      recursive: !0,
      force: !1,
      errorOnExist: !1
    }), await fs.promises.rm(previousPath, {
      recursive: !0,
      force: !0
    });
  } catch (error) {
    return void res.status(500).json({
      ok: !1,
      error: `Couldn't move existing files back: ${error?.message || error}`
    });
  }
  try {
    fs.existsSync(mediaStorageConfigPath) && fs.rmSync(mediaStorageConfigPath, {
      force: !0
    });
  } catch {}
  setMediaRootPath(resolvedTarget), res.json({
    ok: !0,
    currentPath: mediaRootPath,
    moved: moveExisting
  });
});

const bundledOverlaysDir = path.join(appPath, "overlays"), customOverlaysDir = path.join(userDataPath, "overlays");

// bracketApp is read-only by design (see the bracketState comment near
// loadBracketStore) -- the only thing it serves besides the overlay's own
// files is a plain GET of the current bracket, so a browser source pointed
// at it can render without ever needing to reach the main control port.
bracketApp.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff"), res.setHeader("Referrer-Policy", "no-referrer"),
  res.setHeader("X-Frame-Options", "SAMEORIGIN"), res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"),
  next();
});

fs.mkdirSync(customOverlaysDir, {
  recursive: !0
});

let overlayRegistry = new Map, analyticsStore = {
  events: []
};









let activeOverlayPath = "";

const githubDownloadsCache = {
  data: null,
  cachedAt: 0
}, GITHUB_DOWNLOADS_CACHE_TTL_MS = 6e5, authRateLimiterStore = new Map;















function getRequestIp(req) {
  // req.ip does this correctly and safely once "trust proxy" is set below:
  // behind Render (exactly one hop) it resolves to the right-most
  // X-Forwarded-For entry — the one Render's own edge appended — ignoring
  // anything a client tried to prepend; with no trusted proxy (local
  // desktop/LAN) it's just the real TCP peer address, which a client can't
  // spoof via a header at all. This used to read X-Forwarded-For directly
  // and take the FIRST entry — the one part of that header a client fully
  // controls — which let anyone defeat every rate limit (login, password
  // reset, registration, admin routes, the LAN hosting password) just by
  // sending a different fake value on each request.
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function checkRateLimit(req, actionKey, identityValue = "", windowMs = authRateWindowMs, maxAttempts = authRateMaxAttempts) {
  const action = String(actionKey || "").trim().toLowerCase();
  if (!action) return {
    blocked: !1
  };
  const key = `${action}:${getRequestIp(req)}:${String(identityValue || "").trim().toLowerCase()}`, now = Date.now(), record = authRateLimiterStore.get(key);
  return !record || now > record.resetAt ? (authRateLimiterStore.set(key, {
    count: 1,
    resetAt: now + windowMs
  }), {
    blocked: !1
  }) : (record.count += 1, record.count > maxAttempts ? {
    blocked: !0,
    retryAfterSec: Math.max(1, Math.ceil((record.resetAt - now) / 1e3))
  } : {
    blocked: !1
  });
}

// Periodically forget rate-limit windows that have already expired --
// otherwise every distinct action+IP+identity combo this process has ever
// seen sits in this Map forever, which is its own slow, unbounded-memory-
// growth problem on a long-running server (the same class of issue as the
// in-memory auth mirror above, just for a different Map).
setInterval(() => {
  const now = Date.now();
  for (const [ key, record ] of authRateLimiterStore) now > record.resetAt && authRateLimiterStore.delete(key);
}, 3e5).unref?.();

// General-purpose request throttle for any route that doesn't already have
// its own tighter, action-specific checkRateLimit() call (the auth
// endpoints below keep those). Applied broadly rather than hand-tuned per
// route so nothing that can trigger real work on the server -- uploads,
// admin actions, checkout, LAN hosting, analytics ingestion -- is left
// completely unthrottled.
function rateLimitMiddleware(actionKey, {windowMs: windowMs = 6e4, maxAttempts: maxAttempts = 60, identity: identity = null} = {}) {
  return (req, res, next) => {
    const identityValue = "function" == typeof identity ? identity(req) : "", result = checkRateLimit(req, actionKey, identityValue, windowMs, maxAttempts);
    result.blocked ? (res.setHeader("Retry-After", String(result.retryAfterSec)), res.status(429).json({
      ok: !1,
      error: "Too many requests. Try again later."
    })) : next();
  };
}



































































// Named so the privacy policy's "PBKDF2-HMAC-SHA512 with 210,000
// iterations" claim is generated from this exact number rather than a
// second hand-typed copy that can silently drift out of sync.
const PBKDF2_ITERATIONS = 21e4;







function readJsonFileSafe(filePath, fallback) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf-8")) : fallback;
  } catch {
    return fallback;
  }
}











































































function loadAnalyticsStore() {
  try {
    if (!fs.existsSync(analyticsStorePath)) return;
    const parsed = JSON.parse(fs.readFileSync(analyticsStorePath, "utf-8"));
    Array.isArray(parsed?.events) && (analyticsStore.events = parsed.events);
  } catch (error) {
    console.log("Analytics store read error:", error.message);
  }
}

let analyticsSaveTimer = null;

function saveAnalyticsStore() {
  analyticsSaveTimer || (analyticsSaveTimer = setTimeout(() => {
    analyticsSaveTimer = null, fs.writeFile(analyticsStorePath, JSON.stringify(analyticsStore), "utf-8", error => {
      error && console.log("Analytics store write error:", error.message);
    });
  }, 3e4));
}

function toSafeText(value, fallback = "") {
  return String(value || "").trim() || fallback;
}

function toSafeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clampSeriesLength(value) {
  const parsed = Math.max(0, Math.min(15, Math.round(toSafeNumber(value, 7))));
  return 0 === parsed ? 0 : parsed % 2 == 0 ? parsed + 1 : parsed;
}

function normalizeTeamNameForKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 64);
}

function buildTeamKey(blueName, orangeName) {
  return [ normalizeTeamNameForKey(blueName), normalizeTeamNameForKey(orangeName) ].filter(Boolean).sort((a, b) => a.localeCompare(b)).join("__") || "blue__orange";
}

function buildMatchId(prefix = "match") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function ensureDirSafe(dirPath) {
  try {
    fs.mkdirSync(dirPath, {
      recursive: !0
    });
  } catch {}
}

















































































function getActiveOverlaySummary() {
  const pathValue = String(activeOverlayPath || "").trim();
  if (!pathValue) return {
    path: "",
    name: "",
    source: ""
  };
  let overlay = overlayRegistry.get(pathValue);
  return overlay || (refreshOverlayRegistry(), overlay = overlayRegistry.get(pathValue)), 
  {
    path: pathValue,
    name: overlay?.name || pathValue,
    source: overlay?.source || "unknown"
  };
}

function saveActiveOverlayPathStore() {
  try {
    const payload = {
      path: String(activeOverlayPath || "").trim(),
      updatedAt: Date.now()
    }, tempPath = `${activeOverlayStorePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf-8"), fs.renameSync(tempPath, activeOverlayStorePath);
  } catch (error) {
    console.log("Active overlay store write error:", error?.message || error);
  }
}

function loadActiveOverlayPathStore() {
  const loaded = readJsonFileSafe(activeOverlayStorePath, {
    path: "",
    updatedAt: 0
  }), persistedPath = String(loaded?.path || "").trim();
  persistedPath && setActiveOverlayPath(persistedPath);
}

// --- Bracket tab -----------------------------------------------------
// A single in-memory bracket (bracketState), persisted to bracket-data.json
// the same way active-overlay.json is: atomic tmp-file-then-rename writes,
// loaded once at startup. All the actual tournament-structure logic (round
// generation, seeding, winner/loser propagation, Swiss pairing, round-robin
// scheduling) lives in bracket-engine.js; this file just owns storage,
// HTTP routes, and pushing "bracket-updated" to whoever is watching the
// overlay (the main control-port socket AND the dedicated bracket-port
// socket, since the overlay may be loaded from either).















function renderBrowserSourceHtml(overlayPath) {
  const requested = String(overlayPath || "").trim();
  let overlay = requested ? overlayRegistry.get(requested) : null;
  if (!overlay && requested && (refreshOverlayRegistry(), overlay = overlayRegistry.get(requested)), 
  !overlay) {
    const active = getActiveOverlaySummary(), activePath = String(active.path || "").trim();
    activePath && (overlay = overlayRegistry.get(activePath) || null, overlay || (refreshOverlayRegistry(), 
    overlay = overlayRegistry.get(activePath) || null));
  }
  return `<!doctype html>\n<html lang="en">\n<head>\n    <meta charset="utf-8">\n    <meta name="viewport" content="width=device-width,initial-scale=1">\n    <title>Rocket Cast Browser Source</title>\n    <style>\n        html, body {\n            margin: 0;\n            width: 100%;\n            height: 100%;\n            overflow: hidden;\n            background: transparent;\n        }\n        #browser-source-root {\n            position: fixed;\n            inset: 0;\n            overflow: hidden;\n            background: transparent;\n        }\n        #browser-source-frame {\n            position: absolute;\n            inset: 0;\n            width: 100%;\n            height: 100%;\n            border: 0;\n            background: transparent;\n            pointer-events: none;\n        }\n    </style>\n</head>\n<body>\n    <div id="browser-source-root">\n        <iframe id="browser-source-frame" title="Rocket Cast Browser Source" src="${overlay?.path ? `/overlays/${overlay.path.split("/").map(segment => encodeURIComponent(segment)).join("/")}/overlay.html` : "about:blank"}"></iframe>\n    </div>\n    <script src="/socket.io/socket.io.js"><\/script>\n    <script>\n        (() => {\n            const frame = document.getElementById('browser-source-frame');\n            const socket = typeof io === 'function' ? io() : null;\n\n            function overlayUrlFromPath(pathValue) {\n                const normalized = String(pathValue || '').trim();\n                if (!normalized) return 'about:blank';\n                return new URL('/overlays/' + normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/') + '/overlay.html', window.location.origin).href;\n            }\n\n            async function syncOverlay() {\n                try {\n                    const response = await fetch('/api/overlays/active');\n                    if (!response.ok) return;\n                    const payload = await response.json();\n                    const pathValue = String(payload?.overlay?.path || '').trim();\n                    const nextSrc = overlayUrlFromPath(pathValue);\n                    if (frame && frame.src !== nextSrc) {\n                        frame.src = nextSrc;\n                    }\n                } catch {}\n            }\n\n            if (socket) {\n                socket.on('overlay-change', (payload) => {\n                    const nextSrc = overlayUrlFromPath(payload?.overlayName || '');\n                    if (frame && frame.src !== nextSrc) {\n                        frame.src = nextSrc;\n                    }\n                });\n            }\n\n            syncOverlay();\n            setInterval(syncOverlay, 2000);\n        })();\n    <\/script>\n</body>\n</html>`;
}

function setActiveOverlayPath(nextPath) {
  const normalized = String(nextPath || "").trim();
  if (!normalized) return activeOverlayPath = "", void saveActiveOverlayPathStore();
  let overlay = overlayRegistry.get(normalized);
  overlay || (refreshOverlayRegistry(), overlay = overlayRegistry.get(normalized)), 
  activeOverlayPath = overlay?.path || normalized, saveActiveOverlayPathStore();
}



























function winsNeeded(bestOf) {
  return Math.floor(clampSeriesLength(bestOf) / 2) + 1;
}

function normalizeSeriesStatus(value) {
  return "complete" === String(value || "").trim().toLowerCase() ? "complete" : "incomplete";
}

function currentSeriesLengthFromOverrides() {
  return clampSeriesLength(lastOverrides?.seriesLen || 7);
}

function resolveTeamNames() {
  return {
    blue: toSafeText(lastOverrides?.blueName, "Blue"),
    orange: toSafeText(lastOverrides?.orangeName, "Orange")
  };
}

function getStatePlayerList(state) {
  return Array.isArray(state?.Players) ? state.Players : [];
}

function isStateLikelyMatchData(state) {
  const players = getStatePlayerList(state);
  if (players.length < 2) return !1;
  const hasBlue = players.some(player => 0 === Number(player?.TeamNum)), hasOrange = players.some(player => 1 === Number(player?.TeamNum));
  if (!hasBlue || !hasOrange) return !1;
  const game = state?.Game || {};
  return !0 !== game?.bMatchEnded;
}







































// Same reasoning as PBKDF2_ITERATIONS above: named so the privacy policy's
// retention claim is generated from the actual enforced value.
const PRIVACY_ANALYTICS_RETENTION_DAYS = 90;

function pruneAnalyticsEvents() {
  const cutoff = Date.now() - PRIVACY_ANALYTICS_RETENTION_DAYS * 864e5;
  analyticsStore.events = analyticsStore.events.filter(event => Number.isFinite(Number(event?.timestamp)) && Number(event.timestamp) >= cutoff).slice(-5e4);
}

function normalizeClientId(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 120) : "anonymous";
}

function recordAnalyticsEvent(type, clientId, metadata = {}) {
  const eventType = String(type || "").trim().slice(0, 64);
  if (!eventType) return;
  const normalizedClientId = normalizeClientId(clientId), cleanMeta = metadata && "object" == typeof metadata ? Object.fromEntries(Object.entries(metadata).slice(0, 20).map(([key, value]) => [ String(key).slice(0, 64), String(value ?? "").slice(0, 256) ])) : {};
  analyticsStore.events.push({
    type: eventType,
    clientId: normalizedClientId,
    timestamp: Date.now(),
    metadata: cleanMeta
  }), posthog && posthog.capture({
    distinctId: normalizedClientId,
    event: eventType,
    properties: {
      ...cleanMeta,
      clientId: normalizedClientId
    }
  }), pruneAnalyticsEvents(), saveAnalyticsStore();
}

function buildLocalAnalyticsSummary() {
  const now = Date.now(), oneDayAgo = now - 864e5, thirtyDaysAgo = now - 2592e6, events = analyticsStore.events || [], events24h = events.filter(event => Number(event.timestamp) >= oneDayAgo), events30d = events.filter(event => Number(event.timestamp) >= thirtyDaysAgo), userEvents30d = events30d.filter(event => [ "app_open", "app_heartbeat", "app_close" ].includes(event.type)), userEvents24h = events24h.filter(event => [ "app_open", "app_heartbeat", "app_close" ].includes(event.type)), appOpen30d = events30d.filter(event => "app_open" === event.type).length, overlayLaunch30d = events30d.filter(event => "overlay_launch" === event.type).length, uniqueClients24h = new Set(userEvents24h.map(event => event.clientId)).size, uniqueClients30d = new Set(userEvents30d.map(event => event.clientId)).size, latestByClient = new Map;
  userEvents30d.forEach(event => {
    const current = latestByClient.get(event.clientId);
    (!current || Number(event.timestamp) > Number(current.timestamp)) && latestByClient.set(event.clientId, event);
  });
  const recentDevices = Array.from(latestByClient.entries()).map(([clientId, event]) => ({
    clientId: clientId,
    platform: event?.metadata?.platform || "unknown",
    userAgent: event?.metadata?.userAgent || "unknown",
    language: event?.metadata?.language || "unknown",
    timezone: event?.metadata?.timezone || "unknown",
    lastSeenAt: event?.timestamp || null
  })).sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0)).slice(0, 12);
  return {
    connectedClientsNow: io.engine.clientsCount,
    eventsTracked: events.length,
    events24h: events24h.length,
    appOpen30d: appOpen30d,
    overlayLaunch30d: overlayLaunch30d,
    uniqueClients24h: uniqueClients24h,
    uniqueClients30d: uniqueClients30d,
    lastEventAt: events.length ? events[events.length - 1].timestamp : null,
    recentDevices: recentDevices
  };
}

// GitHub 301s api.github.com/repos/<old-name> to the repo's real current
// location on a rename/transfer (this bit Rocket Cast for real: the repo
// this fetches moved to SnorklzSucks/RocketCast_App, and this function
// didn't follow the redirect -- it parsed GitHub's {"message":"Moved
// Permanently",...} body as if it were the actual response, which the
// caller's Array.isArray(releases) check then silently turned into "0
// releases" instead of an error anyone would notice. Following redirects
// here fixes this specific case AND stops it from silently recurring on
// the next rename.
function fetchJson(url, headers = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "User-Agent": "Rocket-Cast-Analytics",
        Accept: "application/vnd.github+json",
        ...headers
      }
    }, response => {
      if ([ 301, 302, 307, 308 ].includes(response.statusCode) && response.headers.location) {
        if (redirectsLeft <= 0) return void reject(new Error("Too many redirects"));
        response.resume();
        return void fetchJson(response.headers.location, headers, redirectsLeft - 1).then(resolve, reject);
      }
      let body = "";
      response.on("data", chunk => {
        body += chunk.toString();
      }), response.on("end", () => {
        if (response.statusCode && response.statusCode >= 400) reject(new Error(`HTTP ${response.statusCode}`)); else try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject), request.setTimeout(1e4, () => {
      request.destroy(new Error("Request timed out"));
    });
  });
}





function listOverlaysFromDirectory(baseDir, source) {
  if (!fs.existsSync(baseDir)) return [];
  const folders = fs.readdirSync(baseDir), overlays = [];
  return folders.forEach(folder => {
    const fullPath = path.join(baseDir, folder);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) return;
    const overlayFile = path.join(fullPath, "overlay.html");
    fs.existsSync(overlayFile) && overlays.push({
      name: folder,
      path: folder,
      source: source,
      directory: fullPath
    });
  }), overlays;
}

function listAllOverlays() {
  const bundled = listOverlaysFromDirectory(bundledOverlaysDir, "bundled"), custom = listOverlaysFromDirectory(customOverlaysDir, "custom"), usedPaths = new Set, merged = [];
  return bundled.sort((a, b) => a.name.localeCompare(b.name)).forEach(overlay => {
    usedPaths.add(overlay.path), merged.push(overlay);
  }), custom.sort((a, b) => a.name.localeCompare(b.name)).forEach(overlay => {
    let uniquePath = overlay.path, suffix = 2;
    for (;usedPaths.has(uniquePath); ) uniquePath = `${overlay.path}-${suffix}`, suffix += 1;
    usedPaths.add(uniquePath), merged.push({
      ...overlay,
      path: uniquePath
    });
  }), merged;
}

function refreshOverlayRegistry() {
  overlayRegistry = new Map, listAllOverlays().forEach(overlay => {
    overlayRegistry.set(overlay.path, overlay);
  }), console.log("✓ Overlay library refreshed:", Array.from(overlayRegistry.keys()));
}

function isStreamDeckRequestAuthorized(req) {
  return !0;
}

function resolveOverlayForStreamDeck(rawOverlayName) {
  const requested = String(rawOverlayName || "").trim();
  if (!requested) return null;
  let overlay = overlayRegistry.get(requested);
  return overlay || (refreshOverlayRegistry(), overlay = overlayRegistry.get(requested)), 
  overlay || null;
}

function emitStreamDeckOverlayChange(overlayName) {
  const overlay = resolveOverlayForStreamDeck(overlayName);
  if (!overlay) return {
    ok: !1,
    error: "Overlay was not found"
  };
  const payload = {
    overlayName: overlay.path,
    clientId: "streamdeck",
    overlaySource: overlay.source || "unknown"
  };
  return setActiveOverlayPath(overlay.path), io.emit("overlay-change", payload), recordAnalyticsEvent("overlay_launch", "streamdeck", {
    overlay: overlay.path,
    overlayName: overlay.name,
    overlaySource: overlay.source || "unknown"
  }), {
    ok: !0,
    overlay: {
      name: overlay.name,
      path: overlay.path,
      source: overlay.source
    }
  };
}

// ---------------------------------------------------------------- Rocket Cast +
// The paid half of the app ships as a separate module: accounts, billing,
// admin, the bracket, and the whole recording side (goal capture, highlight
// reels, OBS, match history). It is optional -- without it this runs as the
// free build and every hook below returns the free answer.
let rocketCastPlus = null;

function installRocketCastPlus() {
  try {
    // eslint-disable-next-line global-require
    const install = require("./server-plus.js");
    rocketCastPlus = install({
      app: app, bracketApp: bracketApp, bracketIo: bracketIo,
      bundledOverlaysDir: bundledOverlaysDir, buildMatchId: buildMatchId,
      buildTeamKey: buildTeamKey, checkRateLimit: checkRateLimit,
      clampSeriesLength: clampSeriesLength, controlHttpPort: controlHttpPort,
      crypto: crypto, currentSeriesLengthFromOverrides: currentSeriesLengthFromOverrides,
      ensureDirSafe: ensureDirSafe, spawn: spawn, spawnSync: spawnSync,
      disableRemoteWebApiProxy: disableRemoteWebApiProxy, express: express,
      ffmpegStatic: ffmpegStatic, fs: fs,
      getActiveOverlaySummary: getActiveOverlaySummary, io: io,
      isStateLikelyMatchData: isStateLikelyMatchData, lanServerState: lanServerState,
      mediaIo: mediaIo, multer: multer, normalizeSeriesStatus: normalizeSeriesStatus,
      path: path, PBKDF2_ITERATIONS: PBKDF2_ITERATIONS,
      rateLimitMiddleware: rateLimitMiddleware, readJsonFileSafe: readJsonFileSafe,
      resolveTeamNames: resolveTeamNames, toSafeNumber: toSafeNumber,
      toSafeText: toSafeText, authTokenTtlDays: authTokenTtlDays,
      userDataPath: userDataPath, winsNeeded: winsNeeded,
      // Read through getters: the media-storage settings and the port binder
      // move these at runtime, so a copy taken at install time would go stale.
      get mediaRootPath() { return mediaRootPath; },
      get matchMediaRootPath() { return matchMediaRootPath; },
      get captureBufferDir() { return captureBufferDir; },
      get captureTempDir() { return captureTempDir; },
      get mediaHttpPort() { return mediaHttpPort; },
      get lastSeriesResetAt() { return lastSeriesResetAt; },
      get rlReplayCalibrationStartAt() { return rlReplayCalibrationStartAt; }
    }) || null;
    console.log("✓ Rocket Cast + loaded");
  } catch (error) {
    if (error && "MODULE_NOT_FOUND" === error.code && /server-plus/.test(String(error.message))) {
      rocketCastPlus = null;   // free build, nothing to load
    } else {
      rocketCastPlus = null;
      console.log("Rocket Cast + failed to load, continuing as the free build:", error && error.message || error);
    }
  }
  // The bracket port only ever answers 404 in the free build; registered here
  // so the paid module's routes get a chance first.
  bracketApp.use((req, res) => {
    res.status(404).json({ ok: !1, error: "Not found" });
  });
}

// Hooks the free build shares with the paid one. Signing in, unlimited LAN
// seats and the whole recording side are Rocket Cast + features, so without
// the module there is no identity, the entitlement is free, and the goal
// capture / match history calls are no-ops.
const FREE_ENTITLEMENT = Object.freeze({ entitlement: "free", status: "inactive" });

async function resolveAuthenticatedIdentity(req) {
  return rocketCastPlus ? rocketCastPlus.resolveAuthenticatedIdentity(req) : null;
}

async function resolveEntitlementForHost() {
  return rocketCastPlus ? rocketCastPlus.resolveEntitlementForHost() : FREE_ENTITLEMENT;
}

function trackMatchHistoryFromPacket(packet) {
  rocketCastPlus && rocketCastPlus.trackMatchHistoryFromPacket(packet);
}

function startGoalCaptureBuffer() {
  rocketCastPlus && rocketCastPlus.startGoalCaptureBuffer();
}

function stopGoalCaptureBuffer() {
  rocketCastPlus && rocketCastPlus.stopGoalCaptureBuffer();
}

loadAnalyticsStore(), pruneAnalyticsEvents(), saveAnalyticsStore(), 
app.post("/api/analytics/event", (req, res) => {
  const body = req.body && "object" == typeof req.body ? req.body : {}, type = String(body.type || "").trim();
  type ? (recordAnalyticsEvent(type, body.clientId, body.metadata || {}), res.json({
    ok: !0
  })) : res.status(400).json({
    ok: !1,
    error: "Missing event type"
  });
}), app.get("/api/analytics/local", (req, res) => {
  res.json(buildLocalAnalyticsSummary());
}), installRocketCastPlus(), app.get("/api/analytics/github-downloads", async (req, res) => {
  // The landing page's download counter hits this on every page load --
  // without a cache, real traffic would mean a fresh GitHub API call per
  // visitor, which burns through GitHub's rate limit fast (60/hr
  // unauthenticated, 5000/hr with GITHUB_TOKEN) for a number that only
  // actually changes when someone downloads a release. 10 minutes is
  // plenty fresh for a counter, not a live ticker.
  const cached = githubDownloadsCache.data, cacheAge = Date.now() - githubDownloadsCache.cachedAt;
  if (cached && cacheAge < GITHUB_DOWNLOADS_CACHE_TTL_MS) return void res.json(cached);
  const token = process.env.GITHUB_TOKEN, headers = token ? {
    Authorization: `Bearer ${token}`
  } : {};
  try {
    const releases = await fetchJson(`https://api.github.com/repos/${githubRepo}/releases`, headers), list = Array.isArray(releases) ? releases : [], installerAssetRegex = /\.(exe|msi|dmg|pkg|appimage|deb|rpm|zip)$/i, normalized = list.map(release => {
      const assets = Array.isArray(release.assets) ? release.assets : [], downloads = assets.reduce((total, asset) => total + Number(asset?.download_count || 0), 0), installerDownloads = assets.filter(asset => installerAssetRegex.test(String(asset?.name || "")) && !String(asset?.name || "").toLowerCase().endsWith(".blockmap")).reduce((total, asset) => total + Number(asset?.download_count || 0), 0), setupExeDownloads = assets.filter(asset => "rocket.cast.setup.exe" === String(asset?.name || "").toLowerCase()).reduce((total, asset) => total + Number(asset?.download_count || 0), 0);
      return {
        name: release.name || release.tag_name || "Unknown release",
        tag: release.tag_name || "",
        publishedAt: release.published_at || null,
        downloads: downloads,
        installerDownloads: installerDownloads,
        setupExeDownloads: setupExeDownloads,
        assetCount: assets.length
      };
    }), totalDownloads = normalized.reduce((total, release) => total + release.downloads, 0), totalInstallerDownloads = normalized.reduce((total, release) => total + release.installerDownloads, 0), totalSetupExeDownloads = normalized.reduce((total, release) => total + release.setupExeDownloads, 0), payload = {
      repo: githubRepo,
      totalDownloads: totalDownloads,
      totalInstallerDownloads: totalInstallerDownloads,
      totalSetupExeDownloads: totalSetupExeDownloads,
      releaseCount: normalized.length,
      latestRelease: normalized[0] || null,
      releases: normalized,
      usersAvailable: !1,
      usersMessage: "GitHub Releases API does not expose downloader identities."
    };
    githubDownloadsCache.data = payload, githubDownloadsCache.cachedAt = Date.now(), res.json(payload);
  } catch (error) {
    // A stale cached count beats an error on a public-facing counter --
    // only fail outright if we've never successfully fetched at all.
    if (cached) return void res.json(cached);
    res.status(500).json({
      error: "Failed to fetch GitHub download metrics",
      details: error.message
    });
  }
}), app.get("/api/web/privacy-policy", (req, res) => {
  res.json({
    ok: !0,
    effectiveDate: PRIVACY_POLICY_EFFECTIVE_DATE,
    html: renderPrivacyPolicyContentHtml()
  });
}), app.get("/api/web/terms-of-service", (req, res) => {
  res.json({
    ok: !0,
    effectiveDate: TERMS_OF_SERVICE_EFFECTIVE_DATE,
    html: renderTermsOfServiceContentHtml()
  });
}), refreshOverlayRegistry(), loadActiveOverlayPathStore(), app.get("/api/overlays", (req, res) => {
  refreshOverlayRegistry();
  const overlays = Array.from(overlayRegistry.values()).map(overlay => ({
    name: overlay.name,
    path: overlay.path,
    source: overlay.source
  }));
  res.json(overlays);
}), app.get("/api/overlays/active", (req, res) => {
  const active = getActiveOverlaySummary();
  res.json({
    ok: !0,
    overlay: active.path ? active : null
  });
// --- Bracket tab -------------------------------------------------------
}), app.get("/browser-source", (req, res) => {
  const html = renderBrowserSourceHtml(String(req.query?.overlay || "").trim());
  res.type("html").send(html);
}), app.get("/api/streamdeck/actions", (req, res) => {
  if (!isStreamDeckRequestAuthorized(req)) return void res.status(403).json({
    ok: !1,
    error: "Unauthorized"
  });
  refreshOverlayRegistry();
  const actions = Array.from(overlayRegistry.values()).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))).map(overlay => ({
    title: `Overlay: ${overlay.name}`,
    method: "POST",
    url: `http://127.0.0.1:${controlHttpPort}/api/streamdeck/overlay`,
    headers: {},
    body: {
      overlayName: overlay.path
    }
  }));
  res.json({
    ok: !0,
    actions: actions
  });
}), app.post("/api/streamdeck/overlay", (req, res) => {
  if (!isStreamDeckRequestAuthorized(req)) return void res.status(403).json({
    ok: !1,
    error: "Unauthorized"
  });
  const overlayName = String(req.body?.overlayName || req.query?.overlayName || "").trim();
  if (!overlayName) return void res.status(400).json({
    ok: !1,
    error: "overlayName is required"
  });
  const result = emitStreamDeckOverlayChange(overlayName);
  result.ok ? res.json(result) : res.status(404).json(result);
}), app.get("/api/streamdeck/overlay", (req, res) => {
  if (!isStreamDeckRequestAuthorized(req)) return void res.status(403).json({
    ok: !1,
    error: "Unauthorized"
  });
  const overlayName = String(req.query?.overlayName || "").trim();
  if (!overlayName) return void res.status(400).json({
    ok: !1,
    error: "overlayName is required"
  });
  const result = emitStreamDeckOverlayChange(overlayName);
  result.ok ? res.json(result) : res.status(404).json(result);
});

// Read once and cache; re-read when the file changes so the detector can be
// iterated on without restarting the app.
let universalOverlayControlCache = { mtime: 0, tag: "" };

function readUniversalOverlayControl() {
  try {
    const file = path.join(appPath, "public", "universal-overlay-control.js");
    const mtime = fs.statSync(file).mtimeMs;
    if (universalOverlayControlCache.mtime !== mtime) {
      const source = fs.readFileSync(file, "utf8");
      universalOverlayControlCache = { mtime: mtime, tag: "<script>" + source + "<" + "/script>" };
    }
    return universalOverlayControlCache.tag;
  } catch {
    return "";
  }
}

app.use((req, res, next) => {
  const requestPath = decodeURIComponent(req.path || ""), pathParts = requestPath.split("/").filter(Boolean);
  if (!pathParts.length) return void next();
  const overlayName = pathParts[0];
  let overlay = overlayRegistry.get(overlayName);
  if (overlay || (refreshOverlayRegistry(), overlay = overlayRegistry.get(overlayName)), 
  !overlay) return void next();
  const overlayRoot = overlay.directory, universalHighlightReelBootstrap = `\n<script>\n(() => {\n    if (window.__RC_UNIVERSAL_REEL_INSTALLED__) return;\n    window.__RC_UNIVERSAL_REEL_INSTALLED__ = true;\n\n    const REEL_ORIGIN = 'http://localhost:${mediaHttpPort}';\n    const CONTROL_ORIGIN = 'http://localhost:${controlHttpPort}';\n    const LAYER_ID = 'rc-universal-highlight-reel-layer';\n    const VIDEO_ID = 'rc-universal-highlight-reel-video';\n    let hideTimer = null;\n    let lastToken = '';\n\n    function normalizeMediaUrl(value) {\n        const raw = String(value || '').trim();\n        if (!raw) return '';\n\n        if (raw.startsWith('/media/')) return REEL_ORIGIN + raw;\n        if (raw.startsWith('/')) return REEL_ORIGIN + raw;\n\n        if (raw.startsWith('http://') || raw.startsWith('https://')) {\n            try {\n                const parsed = new URL(raw);\n                if (parsed.pathname.startsWith('/media/')) {\n                    parsed.protocol = 'http:';\n                    parsed.hostname = 'localhost';\n                    parsed.port = String(${mediaHttpPort});\n                    return parsed.toString();\n                }\n                return raw;\n            } catch {\n                return raw;\n            }\n        }\n\n        return REEL_ORIGIN + '/media/' + raw;\n    }\n\n    function ensureLayer() {\n        let layer = document.getElementById(LAYER_ID);\n        let video = document.getElementById(VIDEO_ID);\n        if (layer && video) return { layer, video };\n\n        layer = document.createElement('div');\n        layer.id = LAYER_ID;\n        layer.style.position = 'fixed';\n        layer.style.inset = '0';\n        layer.style.background = 'transparent';\n        layer.style.opacity = '0';\n        layer.style.transition = 'opacity 420ms ease';\n        layer.style.display = 'none';\n        layer.style.zIndex = '2147483647';\n        layer.style.pointerEvents = 'none';\n\n        video = document.createElement('video');\n        video.id = VIDEO_ID;\n        video.playsInline = true;\n        video.style.position = 'absolute';\n        video.style.inset = '0';\n        video.style.width = '100%';\n        video.style.height = '100%';\n        video.style.objectFit = 'cover';\n        video.style.background = 'transparent';\n        video.addEventListener('ended', () => {\n            stopPlayback(false);\n        });\n        video.addEventListener('error', () => {\n            stopPlayback(false);\n        });\n\n        layer.appendChild(video);\n        document.body.appendChild(layer);\n        return { layer, video };\n    }\n\n    function stopPlayback(immediate = false) {\n        const refs = ensureLayer();\n        if (hideTimer) {\n            clearTimeout(hideTimer);\n            hideTimer = null;\n        }\n\n        if (!immediate) {\n            refs.layer.style.opacity = '0';\n            hideTimer = setTimeout(() => {\n                refs.video.pause();\n                refs.video.removeAttribute('src');\n                refs.video.load();\n                refs.layer.style.display = 'none';\n                refs.layer.style.opacity = '0';\n            }, 430);\n            return;\n        }\n\n        refs.video.pause();\n        refs.video.removeAttribute('src');\n        refs.video.load();\n        refs.layer.style.display = 'none';\n        refs.layer.style.opacity = '0';\n    }\n\n    function startPlayback(payload) {\n        if (typeof window.playHighlightReel === 'function') {\n            window.playHighlightReel(payload || {});\n            return;\n        }\n\n        const refs = ensureLayer();\n        const mediaUrl = normalizeMediaUrl(payload?.mediaUrl || payload?.mediaPath || '');\n        if (!mediaUrl) return;\n\n        stopPlayback(true);\n        const cacheBust = mediaUrl.includes('?') ? '&' : '?';\n        refs.video.src = mediaUrl + cacheBust + 't=' + Date.now();\n        refs.layer.style.display = 'block';\n        refs.layer.style.opacity = '0';\n        refs.video.currentTime = 0;\n\n        let revealed = false;\n        const reveal = () => {\n            if (revealed) return;\n            revealed = true;\n            refs.layer.style.opacity = '1';\n            refs.video.play().catch(() => {\n                stopPlayback(true);\n            });\n        };\n\n        refs.video.addEventListener('loadeddata', reveal, { once: true });\n        refs.video.addEventListener('canplay', reveal, { once: true });\n\n        // No duration-based auto-stop here; let the reel run full length.\n        // Playback stops naturally on the video 'ended' event.\n    }\n\n    function handleHighlightReelPlay(payload) {\n        const matchId = String(payload?.matchId || '');\n        const playedAt = Number(payload?.playedAt || 0);\n        const source = String(payload?.mediaUrl || payload?.mediaPath || '');\n        const token = matchId + '|' + playedAt + '|' + source;\n        if (token && token === lastToken) return;\n        lastToken = token;\n        startPlayback(payload || {});\n    }\n\n    function attachSocket(origin) {\n        if (typeof io !== 'function') return;\n        try {\n            const socket = origin ? io(origin) : io();\n            socket.on('highlight-reel-play', (payload) => {\n                handleHighlightReelPlay(payload || {});\n            });\n        } catch {}\n    }\n\n    attachSocket();\n    if (REEL_ORIGIN !== CONTROL_ORIGIN) {\n        attachSocket(REEL_ORIGIN);\n    }\n})();\n<\/script>`;
  if (1 === pathParts.length) {
    if (!requestPath.endsWith("/")) return void res.redirect(302, `${requestPath}/`);
    const overlayHtmlPath = path.join(overlayRoot, "overlay.html");
    try {
      let html = fs.readFileSync(overlayHtmlPath, "utf8");
      html.includes("__RC_UNIVERSAL_REEL_INSTALLED__") || (/<\/body>/i.test(html) ? html = html.replace(/<\/body>/i, `${universalHighlightReelBootstrap}\n</body>`) : html += `\n${universalHighlightReelBootstrap}\n`);
      // Universal element detection: lets the Match Settings toggles and the
      // live team name/colour fields drive overlays that were never written for
      // Rocket Cast. Overlays that handle overrides themselves detect that at
      // runtime and leave the page alone.
      const universalControlBootstrap = readUniversalOverlayControl();
      return universalControlBootstrap && !html.includes("__RC_UNIVERSAL_CONTROL_INSTALLED__") && (/<\/body>/i.test(html) ? html = html.replace(/<\/body>/i, `${universalControlBootstrap}
</body>`) : html += `
${universalControlBootstrap}
`),
      void res.type("html").send(html);
    } catch {
      res.sendFile(overlayHtmlPath);
    }
    return;
  }
  const targetPath = path.join(overlayRoot, ...pathParts.slice(1)), relative = path.relative(overlayRoot, targetPath);
  relative.startsWith("..") || path.isAbsolute(relative) ? res.status(400).send("Invalid path") : fs.existsSync(targetPath) ? res.sendFile(targetPath) : next();
// Catch-all, registered last so it only ever fires once nothing above
// matched. API callers (the app itself, browser fetches) still get a
// real JSON 404 -- only a human landing on a bad URL in a browser sees
// the branded page, so nothing that already parses error responses as
// JSON gets a surprise HTML body instead.
}), app.use((req, res) => {
  req.path.startsWith("/api/") ? res.status(404).json({ ok: !1, error: "Not found" }) : res.status(404).sendFile(path.join(appPath, "public", "404.html"));
});

// Binds with a fallback to the next port on EADDRINUSE instead of crashing
// -- this is what lets a second (or third...) copy of Rocket Cast run on
// the same machine at once instead of dying the moment it tries to bind
// a port the first instance already holds.
function bindPortWithRetry(serverInstance, desiredPort, {host: host, label: label, maxAttempts: maxAttempts = 20} = {}) {
  return new Promise(resolve => {
    let attempt = 0, candidatePort = desiredPort;
    const tryBind = () => {
      const onError = error => {
        serverInstance.removeListener("error", onError), "EADDRINUSE" === error?.code && attempt < maxAttempts ? (attempt++,
        candidatePort++, setTimeout(tryBind, 25)) : (console.log(`Failed to bind ${label || "server"} to any port near ${desiredPort}:`, error?.message || error),
        resolve(null));
      };
      serverInstance.once("error", onError);
      const onListening = () => {
        serverInstance.removeListener("error", onError), resolve(candidatePort);
      };
      host ? serverInstance.listen(candidatePort, host, onListening) : serverInstance.listen(candidatePort, onListening);
    };
    tryBind();
  });
}

(async () => {
  const boundControlPort = await bindPortWithRetry(server, controlHttpPort, { label: "control server" });
  if (!boundControlPort) return void resolveServerReady({ error: "Failed to bind control server to any port" });
  controlHttpPort = boundControlPort;
  console.log("🚀 Rocket Cast server running:"), console.log(`📺 Control + overlays: http://localhost:${controlHttpPort}`);
  if (mediaHttpPort === controlHttpPort) console.log(`🎬 Highlight reels/media share control port: http://localhost:${mediaHttpPort}/media`); else {
    const boundMediaPort = await bindPortWithRetry(mediaServer, mediaHttpPort, { label: "media server" });
    boundMediaPort ? (mediaHttpPort = boundMediaPort, console.log(`🎬 Highlight reels/media server: http://localhost:${mediaHttpPort}/media`)) : console.log("Media server did not start; highlight reels will be unavailable.");
  }
  const boundBracketPort = await bindPortWithRetry(bracketServer, bracketHttpPort, { label: "bracket overlay server" });
  boundBracketPort ? (bracketHttpPort = boundBracketPort, console.log(`🏆 Bracket overlay server: http://localhost:${bracketHttpPort}`)) : console.log("Bracket overlay server did not start; the Bracket tab overlay is still reachable through the control port.");
  startGoalCaptureBuffer(), mediaIo.on("connection", () => {
    console.log("🎬 Media socket client connected");
  }), process.on("exit", () => {
    stopGoalCaptureBuffer();
  // posthog.shutdown() is async (it flushes queued events over HTTP) and
  // "exit" listeners can't do async work at all -- Node's docs are explicit
  // that the event loop is already gone by then, so that flush attempt
  // never actually completed. SIGINT/SIGTERM fire earlier, while the loop
  // is still alive, so the flush is awaited there instead, before the
  // process actually terminates.
  }), process.on("SIGINT", async () => {
    stopGoalCaptureBuffer();
    try {
      await posthog?.shutdown();
    } catch {}
    process.exit(0);
  }), process.on("SIGTERM", async () => {
    stopGoalCaptureBuffer();
    try {
      await posthog?.shutdown();
    } catch {}
    process.exit(0);
  });
  if (enableIpcBridge) {
    const ipcBridgeServer = net.createServer(socket => {
      console.log("✓ Electron main process connected");
      let pendingBuffer = "";
      socket.on("data", buffer => {
        pendingBuffer += buffer.toString();
        const messages = pendingBuffer.split("\n");
        pendingBuffer = messages.pop() || "", messages.forEach(rawMessage => {
          const trimmed = rawMessage.trim();
          if (trimmed && (trimmed.startsWith("{") || trimmed.startsWith("["))) try {
            const command = JSON.parse(trimmed);
            if ("overlay-change" === command.type) return console.log("📡 Received overlay change:", command.overlayName),
            setActiveOverlayPath(command.overlayName), void io.emit("overlay-change", {
              overlayName: command.overlayName
            });
            "overlay-library-updated" === command.type && (refreshOverlayRegistry(), io.emit("overlays-updated", {
              overlays: Array.from(overlayRegistry.values()).map(overlay => ({
                name: overlay.name,
                path: overlay.path,
                source: overlay.source
              }))
            }));
          } catch (err) {
            console.log("IPC parse error:", err.message);
          }
        });
      }), socket.on("error", err => {
        console.log("IPC socket error:", err.message);
      }), socket.on("close", () => {
        console.log("✗ Electron main process disconnected");
      });
    }), boundIpcPort = await bindPortWithRetry(ipcBridgeServer, ipcPort, { host: "127.0.0.1", label: "IPC bridge" });
    boundIpcPort ? (ipcPort = boundIpcPort, console.log(`🔗 IPC server listening on port ${ipcPort}`)) : console.log("IPC bridge did not start; the desktop app's overlay-switch shortcuts may not sync.");
  } else console.log("IPC bridge disabled for web/cloud runtime.");
  resolveServerReady({ controlPort: controlHttpPort, mediaPort: mediaHttpPort, bracketPort: bracketHttpPort, ipcPort: enableIpcBridge ? ipcPort : null });
})();

let lastOverrides = {}, lastOverlayDetection = null, lastSeriesResetAt = 0, lastRlStatus = {
  connected: !1,
  endpoint: null,
  transport: null,
  lastError: null,
  lastEvent: null,
  lastPacketKeys: []
};

// Same access gate as the HTTP one above, applied to the socket.io
// handshake — now covers real LAN connections too, not just tunnel traffic
// (see isGuestOriginRequest). The guest side sends its token, and its
// already-authenticated account username, via the connection's `auth`
// payload (see connectToLanServer). Non-premium hosts are capped at
// FREE_SERVER_SEAT_LIMIT other seats; premium hosts are unlimited.
io.use(async (socket, next) => {
  if (!lanServerState.hosting || !lanServerState.hostPasswordHash) return next();
  if (!isGuestOriginRequest(socket.handshake?.headers?.host, socket.handshake?.address)) return next();
  if (!isValidGuestToken(socket.handshake?.auth?.token)) return next(new Error("Unauthorized"));
  if (lanServerState.connectedGuestSeats.size >= FREE_SERVER_SEAT_LIMIT) {
    let hostIsPremium = !1;
    try {
      const entitlement = await resolveEntitlementForHost();
      hostIsPremium = "premium" === entitlement.entitlement && "active" === entitlement.status;
    } catch {}
    if (!hostIsPremium) return next(new Error(`Server is full (${FREE_SERVER_SEAT_LIMIT} seat limit, the host needs Rocket Cast + for unlimited seats)`));
  }
  next();
}), io.on("connection", socket => {
  console.log("🌐 Browser connected"), recordAnalyticsEvent("panel_connected", socket.id, {
    transport: socket.conn?.transport?.name || "unknown"
  }), Object.keys(lastOverrides).length && socket.emit("overrides", lastOverrides), lastOverlayDetection && socket.emit("overlay-detection", lastOverlayDetection);
  const isGuestSeat = lanServerState.hosting && isGuestOriginRequest(socket.handshake?.headers?.host, socket.handshake?.address);
  isGuestSeat && lanServerState.connectedGuestSeats.set(socket.id, {
    username: String(socket.handshake?.auth?.username || "").trim() || "Guest",
    connectedAt: Date.now()
  }),
  // Guest-mode relay-up: whatever a locally-connected client emits (score
  // overrides, series resets, overlay switches, ...) also gets forwarded
  // to the host we're connected to, so it's processed there as the source
  // of truth and reflected back down to every seat, including this one.
  // Anyone can join to watch, but only an authenticated guest is allowed to
  // relay changes up -- an unauthenticated attempt is dropped and the
  // originating local client is told why via "account-required" so the
  // renderer can prompt for an account instead of it silently doing nothing.
  socket.onAny((event, ...args) => {
    if (!lanServerState.guestMode || !lanServerState.guestSocket || !lanServerState.guestSocket.connected) return;
    if (!lanServerState.guestAuthenticated) return void socket.emit("account-required", { action: event });
    try {
      lanServerState.guestSocket.emit(event, ...args);
    } catch {}
  }),
  socket.emit("rl-status", lastRlStatus), socket.on("overlay-detection", data => {
    lastOverlayDetection = data && "object" == typeof data ? data : null, socket.broadcast.emit("overlay-detection", lastOverlayDetection);
  }), socket.on("overrides", data => {
    lastOverrides = data, socket.broadcast.emit("overrides", data);
  }), socket.on("series-reset", payload => {
    const now = Date.now(), candidate = Number(payload?.at || 0);
    lastSeriesResetAt = Math.max(now, Number.isFinite(candidate) ? candidate : 0), io.emit("series-reset", {
      at: lastSeriesResetAt,
      reason: String(payload?.reason || "manual-reset")
    });
  }), socket.on("overlay-change", data => {
    console.log("📺 Socket.IO overlay change:", data.overlayName);
    const overlayName = String(data?.overlayName || "").trim();
    let overlay = overlayRegistry.get(overlayName);
    !overlay && overlayName && (refreshOverlayRegistry(), overlay = overlayRegistry.get(overlayName)),
    recordAnalyticsEvent("overlay_launch", data?.clientId || socket.id, {
      overlay: overlayName || "unknown",
      overlayName: overlay?.name || overlayName || "unknown",
      overlaySource: overlay?.source || "unknown"
    }), setActiveOverlayPath(overlay?.path || overlayName), io.emit("overlay-change", data);
  }), socket.on("disconnect", () => {
    lanServerState.connectedGuestSeats.delete(socket.id), recordAnalyticsEvent("panel_disconnected", socket.id, {});
  });
});

const rlReconnectMs = Number(process.env.RL_RECONNECT_MS || 1e3), rlEndpointsEnv = process.env.RL_ENDPOINTS, defaultRlEndpoints = [ "tcp://127.0.0.1:49123", "tcp://localhost:49123", "tcp://127.0.0.1:49122", "tcp://localhost:49122", "ws://127.0.0.1:49122", "ws://localhost:49122", "ws://127.0.0.1:49123", "ws://localhost:49123" ], rlEndpointStrings = rlEndpointsEnv ? rlEndpointsEnv.split(",").map(entry => entry.trim()).filter(Boolean) : defaultRlEndpoints, rlEndpoints = rlEndpointStrings.map(entry => {
  let urlText = entry;
  entry.includes("://") || (urlText = `tcp://${entry}`);
  try {
    const url = new URL(urlText), protocol = url.protocol.replace(":", ""), port = Number(url.port);
    return [ "tcp", "ws", "wss" ].includes(protocol) && url.hostname && Number.isInteger(port) ? {
      protocol: protocol,
      host: url.hostname,
      port: port,
      href: `${protocol}://${url.hostname}:${port}`
    } : null;
  } catch {
    return null;
  }
}).filter(Boolean);

let rlConnection = null, rlReconnectTimer = null, rlEndpointIndex = 0, rlGoodEndpointIndex = -1, rlPacketShapeLogged = !1, rlReplayCalibrationStartAt = 0, rlReplayFixedDurationMs = null;

function updateRocketLeagueStatus(patch) {
  lastRlStatus = {
    ...lastRlStatus,
    ...patch
  }, io.emit("rl-status", lastRlStatus);
}

function extractJsonObjects(bufferText) {
  const chunks = [];
  let depth = 0, inString = !1, isEscaped = !1, objectStart = -1;
  for (let index = 0; index < bufferText.length; index += 1) {
    const char = bufferText[index];
    if (inString) isEscaped ? isEscaped = !1 : "\\" === char ? isEscaped = !0 : '"' === char && (inString = !1); else if ('"' !== char) if ("{" !== char) {
      if ("}" === char) {
        if (0 === depth) continue;
        depth -= 1, 0 === depth && -1 !== objectStart && (chunks.push(bufferText.slice(objectStart, index + 1)), 
        objectStart = -1);
      }
    } else 0 === depth && (objectStart = index), depth += 1; else inString = !0;
  }
  return {
    chunks: chunks,
    remainder: depth > 0 && -1 !== objectStart ? bufferText.slice(objectStart) : ""
  };
}

function normalizePacket(packet) {
  if (!packet || "object" != typeof packet) return null;
  if (packet.Event || packet.event) {
    if ("string" == typeof packet.Data) try {
      packet.Data = JSON.parse(packet.Data);
    } catch {}
    return packet;
  }
  return packet.data && "object" == typeof packet.data ? {
    Event: packet.type || packet.event || "UpdateState",
    Data: packet.data
  } : {
    Event: "UpdateState",
    Data: packet
  };
}

function trackReplayTimingFromPacket(packet) {
  const eventName = String(packet?.Event || packet?.event || "").trim();
  if (eventName) if ("GoalReplayStart" !== eventName) {
    if ("GoalReplayEnd" === eventName) {
      if (rlReplayCalibrationStartAt <= 0) return void console.log("[ReplayTiming][Server] replay end received without a known start");
      const measuredReplayDurationMs = Date.now() - rlReplayCalibrationStartAt, measuredReplayDurationSeconds = Number((measuredReplayDurationMs / 1e3).toFixed(3));
      return console.log("[ReplayTiming][Server] replay end measured", {
        measuredReplayDurationMs: measuredReplayDurationMs,
        measuredReplayDurationSeconds: measuredReplayDurationSeconds
      }), null === rlReplayFixedDurationMs && measuredReplayDurationMs >= 1e3 && measuredReplayDurationMs <= 3e4 && (rlReplayFixedDurationMs = measuredReplayDurationMs, 
      console.log("[ReplayTiming][Server] calibration locked", {
        fixedReplayDurationMs: rlReplayFixedDurationMs,
        fixedReplayDurationSeconds: Number((rlReplayFixedDurationMs / 1e3).toFixed(3))
      })), void (rlReplayCalibrationStartAt = 0);
    }
    "MatchDestroyed" === eventName && (rlReplayCalibrationStartAt = 0);
  } else rlReplayCalibrationStartAt <= 0 && (rlReplayCalibrationStartAt = Date.now(), 
  console.log("[ReplayTiming][Server] replay start captured", {
    startedAt: rlReplayCalibrationStartAt,
    fixedReplayDurationMs: rlReplayFixedDurationMs
  }));
}

function tryEmitPacket(raw) {
  let parsed;
  if ("string" == typeof raw) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
  } else parsed = raw;
  const normalized = normalizePacket(parsed);
  normalized && (rlGoodEndpointIndex = rlEndpointIndex, trackReplayTimingFromPacket(normalized), 
  trackMatchHistoryFromPacket(normalized), rlPacketShapeLogged || (rlPacketShapeLogged = !0, 
  console.log("🎮 First Rocket League packet keys:", Object.keys(normalized.Data || normalized).join(", "))), 
  updateRocketLeagueStatus({
    connected: !0,
    lastError: null,
    lastEvent: normalized.Event || normalized.event || "UpdateState",
    lastPacketKeys: Object.keys(normalized.Data || normalized)
  }), io.emit("state", normalized));
}

function scheduleRocketLeagueReconnect() {
  rlReconnectTimer || (rlReconnectTimer = setTimeout(() => {
    rlReconnectTimer = null, connectToRocketLeague();
  }, rlReconnectMs));
}

function cleanupRocketLeagueConnection() {
  rlConnection && ("function" == typeof rlConnection.destroy ? rlConnection.destroy() : "function" == typeof rlConnection.close && rlConnection.close(), 
  rlConnection = null);
}

function connectViaTcp(endpoint) {
  let dataBuffer = "";
  const socket = net.createConnection({
    host: endpoint.host,
    port: endpoint.port
  });
  socket.on("connect", () => {
    console.log(`🎮 Connected to Rocket League via ${endpoint.href}`), updateRocketLeagueStatus({
      connected: !0,
      endpoint: endpoint.href,
      transport: "tcp",
      lastError: null
    });
  }), socket.on("data", buffer => {
    dataBuffer += buffer.toString();
    const extracted = extractJsonObjects(dataBuffer);
    extracted.chunks.forEach(chunk => {
      tryEmitPacket(chunk);
    }), dataBuffer = extracted.remainder;
  }), socket.on("error", err => {
    console.log(`🎮 Rocket League TCP error (${endpoint.href}):`, err.message), updateRocketLeagueStatus({
      connected: !1,
      endpoint: endpoint.href,
      transport: "tcp",
      lastError: err.message
    });
  }), socket.on("close", () => {
    console.log(`🎮 Rocket League TCP connection closed (${endpoint.href})`), rlConnection === socket && (updateRocketLeagueStatus({
      connected: !1,
      endpoint: endpoint.href,
      transport: "tcp"
    }), rlConnection = null, rlEndpointIndex = rlGoodEndpointIndex >= 0 ? rlGoodEndpointIndex : (rlEndpointIndex + 1) % rlEndpoints.length, 
    scheduleRocketLeagueReconnect());
  }), rlConnection = socket;
}

function connectViaWebSocket(endpoint) {
  const ws = new WebSocket(endpoint.href);
  ws.on("open", () => {
    console.log(`🎮 Connected to Rocket League via ${endpoint.href}`), updateRocketLeagueStatus({
      connected: !0,
      endpoint: endpoint.href,
      transport: endpoint.protocol,
      lastError: null
    });
  }), ws.on("message", message => {
    tryEmitPacket(Buffer.isBuffer(message) ? message.toString("utf8") : String(message));
  }), ws.on("error", err => {
    console.log(`🎮 Rocket League WebSocket error (${endpoint.href}):`, err.message), 
    updateRocketLeagueStatus({
      connected: !1,
      endpoint: endpoint.href,
      transport: endpoint.protocol,
      lastError: err.message
    });
  }), ws.on("close", () => {
    console.log(`🎮 Rocket League WebSocket closed (${endpoint.href})`), rlConnection === ws && (updateRocketLeagueStatus({
      connected: !1,
      endpoint: endpoint.href,
      transport: endpoint.protocol
    }), rlConnection = null, rlEndpointIndex = rlGoodEndpointIndex >= 0 ? rlGoodEndpointIndex : (rlEndpointIndex + 1) % rlEndpoints.length, 
    scheduleRocketLeagueReconnect());
  }), rlConnection = ws;
}

function connectToRocketLeague() {
  if (rlConnection) return;
  if (!rlEndpoints.length) return console.log("🎮 No Rocket League API endpoints configured"), 
  updateRocketLeagueStatus({
    connected: !1,
    endpoint: null,
    transport: null,
    lastError: "No Rocket League API endpoints configured"
  }), void scheduleRocketLeagueReconnect();
  cleanupRocketLeagueConnection();
  const endpoint = rlEndpoints[rlEndpointIndex];
  "tcp" !== endpoint.protocol ? connectViaWebSocket(endpoint) : connectViaTcp(endpoint);
}

connectToRocketLeague();

// A stray rejection or a throw on an async boundary would otherwise take the
// whole process down mid-broadcast. Log loudly and keep serving: a degraded
// overlay is recoverable, a dead server in the middle of a match is not.
process.on("unhandledRejection", reason => {
  console.error("[fatal-guard] unhandled promise rejection:", reason && reason.stack || reason);
});

process.on("uncaughtException", error => {
  console.error("[fatal-guard] uncaught exception:", error && error.stack || error);
});
