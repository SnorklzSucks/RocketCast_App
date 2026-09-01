const {app: app, BrowserWindow: BrowserWindow, ipcMain: ipcMain, dialog: dialog, shell: shell, globalShortcut: globalShortcut, desktopCapturer: desktopCapturer, Menu: Menu} = require("electron"), fs = require("fs"), path = require("path"), os = require("os"), net = require("net"), {spawnSync: spawnSync} = require("child_process"), {autoUpdater: autoUpdater} = require("electron-updater"), log = require("electron-log");

let relaySocket, mainWindow = null, warmupWindow = null, browserSourceWindow = null, registeredGlobalKeybindAccelerators = [], relayConnectInFlight = !1;

// Filled in once server.js finishes binding (see startServer()) -- default
// to the usual ports so nothing throws if something reads these before
// startup completes, but every real use happens after that await.
let resolvedControlPort = Number(process.env.PORT || process.env.RC_CONTROL_PORT || 3e3), resolvedIpcPort = Number(process.env.RC_IPC_PORT || 3101);

const relayPendingCommands = [];

function verifyWindowsAuthenticodeSignature(executablePath) {
  const psScript = [ `$sig = Get-AuthenticodeSignature -FilePath '${String(executablePath || "").replace(/'/g, "''")}'`, "$obj = [pscustomobject]@{", "  Status = [string]$sig.Status", "  Subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { '' }", "  Thumbprint = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { '' }", "  HasSigner = [bool]($null -ne $sig.SignerCertificate)", "  StatusMessage = [string]$sig.StatusMessage", "  IsValid = [bool]([string]$sig.Status -eq 'Valid')", "}", "$obj | ConvertTo-Json -Compress" ].join("; "), result = spawnSync("powershell.exe", [ "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript ], {
    windowsHide: !0,
    encoding: "utf8"
  });
  if (result.error) return {
    ok: !1,
    error: result.error.message
  };
  if (0 !== result.status) return {
    ok: !1,
    error: String(result.stderr || "Unable to verify Authenticode signature").trim()
  };
  try {
    const parsed = JSON.parse(String(result.stdout || "{}").trim() || "{}"), status = String(parsed?.Status || "").trim(), subject = String(parsed?.Subject || "").trim(), expectedPublisher = String(process.env.RC_EXPECTED_SIGNER_SUBJECT || "").trim();
    return "Valid" !== status ? {
      ok: !1,
      error: `Signature status is ${status || "unknown"}`
    } : expectedPublisher && !subject.includes(expectedPublisher) ? {
      ok: !1,
      error: `Signer subject mismatch. Expected to include "${expectedPublisher}", got "${subject || "(empty)"}"`
    } : {
      ok: !0
    };
  } catch (error) {
    return {
      ok: !1,
      error: error?.message || "Failed to parse signature verification output"
    };
  }
}

function enforcePackagedRuntimeHardening() {
  if (!app.isPackaged) return !0;
  if ("true" === String(process.env.RC_DISABLE_RUNTIME_HARDENING || "").trim().toLowerCase()) return !0;
  const appPath = String(app.getAppPath() || "");
  if (!/\.asar$/i.test(appPath)) return dialog.showErrorBox("Rocket Cast Security Check Failed", "This build is not running from an ASAR package and has been blocked."),
  !1;
  return !0;
}

const BUILDER_METADATA_FILE = ".rc-builder.json", BUILDER_CANVAS = {
  width: 1920,
  height: 1080
}, BUILDER_SCENE_KEYS = [ "game", "replay", "postGame" ], BUILDER_ITEM_TYPES = new Set([ "team-name-blue", "team-name-orange", "abbr-block-blue", "abbr-block-orange", "logo-box-blue", "logo-box-orange", "score-blue", "score-orange", "clock", "series-bo", "series-text", "custom-text", "image", "solid-box", "circle", "spectated-player-card", "spectated-player-boost", "replay-scorer-name", "replay-ball-kph", "replay-assister-name", "player-card-blue-1", "player-card-blue-2", "player-card-blue-3", "player-card-orange-1", "player-card-orange-2", "player-card-orange-3" ]);

function getBundledOverlaysDir() {
  return path.join(app.getAppPath(), "overlays");
}

function getCustomOverlaysDir() {
  return path.join(app.getPath("userData"), "overlays");
}

function ensureCustomOverlaysDir() {
  const dir = getCustomOverlaysDir();
  return fs.mkdirSync(dir, {
    recursive: !0
  }), dir;
}

function getBuilderMetadataPath(projectDir) {
  return path.join(projectDir, ".rc-builder.json");
}

function resolveBuilderProjectDir(projectPath) {
  const safePath = String(projectPath || "").trim();
  if (!safePath || /[\\/]/.test(safePath)) throw new Error("Invalid builder project path");
  const customOverlaysDir = ensureCustomOverlaysDir(), projectDir = path.join(customOverlaysDir, safePath);
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new Error("Builder project was not found");
  return {
    projectDir: projectDir,
    projectPath: safePath
  };
}

function getDefaultBuilderLayout() {
  const gameItems = [ {
    id: "item-1",
    type: "team-name-blue",
    x: 540,
    y: 80,
    width: 300,
    height: 72
  }, {
    id: "item-2",
    type: "score-blue",
    x: 860,
    y: 80,
    width: 90,
    height: 72
  }, {
    id: "item-3",
    type: "clock",
    x: 965,
    y: 80,
    width: 140,
    height: 72
  }, {
    id: "item-4",
    type: "score-orange",
    x: 1120,
    y: 80,
    width: 90,
    height: 72
  }, {
    id: "item-5",
    type: "team-name-orange",
    x: 1225,
    y: 80,
    width: 300,
    height: 72
  } ];
  const defaultLayerGroups = () => [ {
    id: "layer-1",
    name: "Layer 1"
  } ];
  gameItems.forEach(item => {
    item.layerGroupId = "layer-1";
  });
  return {
    canvas: {
      ...BUILDER_CANVAS
    },
    stageTestBackgroundEnabled: !1,
    stageTestBackgroundSrc: "",
    transitionSrc: "",
    transitionDurationMs: 420,
    transitionIntroOffsetMs: 0,
    transitionExitOffsetMs: 0,
    activeScene: "game",
    scenes: {
      game: {
        items: gameItems,
        layerGroups: defaultLayerGroups()
      },
      replay: {
        items: [],
        layerGroups: defaultLayerGroups()
      },
      postGame: {
        items: [],
        layerGroups: defaultLayerGroups()
      }
    },
    items: gameItems
  };
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

function sanitizeLayerGroups(rawGroups) {
  const seenIds = new Set, cleaned = (Array.isArray(rawGroups) ? rawGroups : []).map((group, index) => ({
    id: String(group?.id || "").trim() || `layer-${index + 1}`,
    name: String(group?.name || "").trim().slice(0, 60) || `Layer ${index + 1}`
  })).filter(group => !seenIds.has(group.id) && (seenIds.add(group.id), !0));
  return cleaned.length ? cleaned : [ {
    id: "layer-1",
    name: "Layer 1"
  } ];
}

function sanitizeBuilderLayout(rawLayout) {
  const defaultLayout = getDefaultBuilderLayout(), normalizeHex = (value, fallback) => {
    const text = String(value || "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : fallback;
  }, readNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }, activeScene = (value = rawLayout?.activeScene, BUILDER_SCENE_KEYS.includes(String(value || "")) ? String(value) : "game");
  var value;
  const hasSceneMap = rawLayout?.scenes && "object" == typeof rawLayout.scenes, legacyItems = Array.isArray(rawLayout?.items) ? rawLayout.items : null, scenes = {};
  return BUILDER_SCENE_KEYS.forEach(sceneKey => {
    const layerGroups = sanitizeLayerGroups(Array.isArray(rawLayout?.scenes?.[sceneKey]?.layerGroups) ? rawLayout.scenes[sceneKey].layerGroups : defaultLayout.scenes[sceneKey].layerGroups), validLayerGroupIds = new Set(layerGroups.map(group => group.id)), fallbackLayerGroupId = layerGroups[0].id;
    const sourceItems = Array.isArray(rawLayout?.scenes?.[sceneKey]?.items) ? rawLayout.scenes[sceneKey].items : !hasSceneMap && "game" === sceneKey && Array.isArray(legacyItems) ? legacyItems : defaultLayout.scenes[sceneKey].items, items = (sourceItems => sourceItems.filter(item => BUILDER_ITEM_TYPES.has(item?.type)).slice(0, 100).map((item, index) => ({
      id: `item-${index + 1}`,
      type: item.type,
      layerGroupId: validLayerGroupIds.has(String(item.layerGroupId || "")) ? String(item.layerGroupId) : fallbackLayerGroupId,
      x: clampNumber(item.x, 0, -BUILDER_CANVAS.width, 2 * BUILDER_CANVAS.width),
      y: clampNumber(item.y, 0, -BUILDER_CANVAS.height, 2 * BUILDER_CANVAS.height),
      width: clampNumber(item.width, "spectated-player-boost" === item.type ? 130 : 140, 40, BUILDER_CANVAS.width),
      height: "spectated-player-boost" === item.type ? clampNumber(item.height, clampNumber(item.width, 130, 40, BUILDER_CANVAS.width), 40, BUILDER_CANVAS.height) : clampNumber(item.height, 70, "series-bo" === item.type ? 0 : 30, BUILDER_CANVAS.height),
      variant: String(item.variant || "BO7").toUpperCase(),
      fontSize: clampNumber(item.fontSize, 0, 0, 280),
      opacity: Math.min(1, Math.max(0, Number.isFinite(Number(item.opacity)) ? Number(item.opacity) : 1)),
      src: String(item.src || "").replace(/\\/g, "/"),
      zIndex: clampNumber(item.zIndex, index + 1, 1, 200),
      colorMode: [ "default", "team1", "team2", "scoringteam", "winningteam", "spectated", "custom" ].includes(String(item.colorMode || "").toLowerCase()) ? String(item.colorMode || "default").toLowerCase() : "default",
      color: normalizeHex(item.color, "#FFFFFF"),
      groupId: String(item.groupId || ""),
      fontFamily: String(item.fontFamily || "").trim(),
      fontSrc: String(item.fontSrc || "").replace(/\\/g, "/"),
      wheelArc: clampNumber(item.wheelArc, 100, 75, 100),
      wheelTextSize: clampNumber(item.wheelTextSize, 28, 8, 180),
      wheelThickness: clampNumber(item.wheelThickness, 18, 4, 40),
      boxRounded: !1 !== item.boxRounded,
      boRounded: Boolean(item.boRounded),
      boCornerRadius: clampNumber(item.boCornerRadius, 0, 0, 80),
      wheelBackgroundColorMode: [ "default", "team1", "team2", "custom" ].includes(String(item.wheelBackgroundColorMode || "").toLowerCase()) ? String(item.wheelBackgroundColorMode || "default").toLowerCase() : "default",
      wheelBackgroundColor: normalizeHex(item.wheelBackgroundColor, "#2A2A2A"),
      logoFallback: [ "rl", "abbr" ].includes(String(item.logoFallback || "").toLowerCase()) ? String(item.logoFallback || "rl").toLowerCase() : "rl",
      boostRounded: !1 !== item.boostRounded,
      boostCornerRadius: clampNumber(item.boostCornerRadius, 999, 0, 80),
      boostBarWidth: clampNumber(item.boostBarWidth, 100, 10, 100),
      boostBarHeight: clampNumber(item.boostBarHeight, 10, 1, 80),
      boostBackgroundColor: normalizeHex(item.boostBackgroundColor, "#333333"),
      specTopTextScale: clampNumber(item.specTopTextScale, 1, .5, 3),
      specStatsTextScale: clampNumber(item.specStatsTextScale, 1, .5, 3),
      specCardGap: clampNumber(item.specCardGap, 12, 0, 120),
      nameOffsetX: clampNumber(item.nameOffsetX, 0, -400, 400),
      nameOffsetY: clampNumber(item.nameOffsetY, 0, -400, 400),
      boostTextOffsetX: clampNumber(item.boostTextOffsetX, 0, -400, 400),
      boostTextOffsetY: clampNumber(item.boostTextOffsetY, 0, -400, 400),
      cornerRadius: clampNumber(item.cornerRadius, 6, 0, 80),
      rotation: clampNumber(item.rotation, 0, -180, 180),
      wheelTextOffsetX: readNumber(item.wheelTextOffsetX, 0),
      wheelTextOffsetY: readNumber(item.wheelTextOffsetY, 0),
      text: String(item.text || "Text"),
      textCaps: Boolean(item.textCaps),
      showName: !1 !== item.showName,
      showBoost: !1 !== item.showBoost,
      showBoostText: !1 !== item.showBoostText,
      trackGoals: Boolean(item.trackGoals),
      trackShots: Boolean(item.trackShots),
      trackSaves: Boolean(item.trackSaves),
      trackAssists: Boolean(item.trackAssists),
      trackDemos: Boolean(item.trackDemos)
    })).map(item => {
      if ("team-name-blue" !== item.type && "team-name-orange" !== item.type || "default" !== item.colorMode || (item.colorMode = "custom"), 
      "circle" === item.type || "spectated-player-boost" === item.type) {
        const clamped = clampNumber(Math.max(40, Number(item.width) || 40, Number(item.height) || 40), 130, 40, Math.min(BUILDER_CANVAS.width, BUILDER_CANVAS.height));
        item.width = clamped, item.height = clamped;
      }
      return item;
    }))(Array.isArray(sourceItems) ? sourceItems : []);
    scenes[sceneKey] = {
      items: items.length ? items : defaultLayout.scenes[sceneKey].items,
      layerGroups: items.length ? layerGroups : defaultLayout.scenes[sceneKey].layerGroups
    };
  }), {
    canvas: {
      ...BUILDER_CANVAS
    },
    stageTestBackgroundEnabled: Boolean(rawLayout?.stageTestBackgroundEnabled),
    stageTestBackgroundSrc: String(rawLayout?.stageTestBackgroundSrc || "").replace(/\\/g, "/"),
    transitionSrc: String(rawLayout?.transitionSrc || "").replace(/\\/g, "/"),
    transitionDurationMs: clampNumber(rawLayout?.transitionDurationMs, 420, 100, 5e3),
    transitionIntroOffsetMs: clampNumber(rawLayout?.transitionIntroOffsetMs, 0, -3e3, 3e3),
    transitionExitOffsetMs: clampNumber(rawLayout?.transitionExitOffsetMs, 0, -3e3, 3e3),
    activeScene: activeScene,
    scenes: scenes,
    items: scenes[activeScene].items
  };
}

function toSafeFolderName(rawName) {
  const safeName = sanitizeOverlayName(rawName);
  if (!safeName) throw new Error("Overlay name is not valid");
  return safeName;
}

function resolveUniqueOverlayFolder(baseName) {
  const customOverlaysDir = ensureCustomOverlaysDir(), bundledNames = new Set(listOverlaysFromDirectory(getBundledOverlaysDir(), "bundled").map(overlay => overlay.name.toLowerCase()));
  let candidate = baseName, suffix = 2;
  for (;bundledNames.has(candidate.toLowerCase()) || fs.existsSync(path.join(customOverlaysDir, candidate)); ) candidate = `${baseName}-${suffix}`, 
  suffix += 1;
  return candidate;
}

function getBuilderProjects() {
  const customOverlaysDir = ensureCustomOverlaysDir();
  return fs.readdirSync(customOverlaysDir).map(folderName => {
    const projectDir = path.join(customOverlaysDir, folderName);
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) return null;
    const metadataPath = getBuilderMetadataPath(projectDir);
    if (!fs.existsSync(metadataPath)) return null;
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      return {
        name: metadata?.name || folderName,
        path: folderName,
        updatedAt: metadata?.updatedAt || null,
        layout: sanitizeBuilderLayout(metadata?.layout)
      };
    } catch {
      return {
        name: folderName,
        path: folderName,
        updatedAt: null,
        layout: getDefaultBuilderLayout()
      };
    }
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

function generateBuilderOverlayHtml(projectName, layout, overlayPath, projectDir) {
  const safeName = String(projectName || "Rocket Cast Builder Overlay").replace(/</g, "&lt;").replace(/>/g, "&gt;"), overlayBase = `/${String(overlayPath || projectName || "").split("/").map(segment => encodeURIComponent(segment)).join("/")}`, normalizedLayout = sanitizeBuilderLayout(layout), sceneItems = {
    game: Array.isArray(normalizedLayout?.scenes?.game?.items) ? normalizedLayout.scenes.game.items : [],
    replay: Array.isArray(normalizedLayout?.scenes?.replay?.items) ? normalizedLayout.scenes.replay.items : [],
    postGame: Array.isArray(normalizedLayout?.scenes?.postGame?.items) ? normalizedLayout.scenes.postGame.items : []
  }, allItems = [ ...sceneItems.game, ...sceneItems.replay, ...sceneItems.postGame ], resolveOverlayAssetSrc = src => {
    const value = String(src || "").trim().replace(/\\/g, "/");
    return value ? /^(https?:|data:|blob:|\/)/i.test(value) ? value : `${overlayBase}/${value.replace(/^\/+/, "")}` : "";
  }, fontFaceCss = Array.from(new Map(allItems.filter(item => String(item.fontFamily || "").trim() && String(item.fontSrc || "").trim()).map(item => {
    const family = String(item.fontFamily || "").trim().replace(/["']/g, ""), src = (src => {
      const raw = String(src || "").trim().replace(/\\/g, "/");
      if (!raw) return "";
      if (/^(https?:|data:|blob:|\/)/i.test(raw)) return raw;
      if (projectDir) try {
        const relativeSrc = raw.replace(/^\/+/, ""), candidate = path.join(projectDir, relativeSrc), relative = path.relative(projectDir, candidate);
        if (!relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const encoded = fs.readFileSync(candidate).toString("base64");
          return `data:${(src => {
            const lower = String(src || "").toLowerCase();
            return lower.endsWith(".woff2") ? "font/woff2" : lower.endsWith(".woff") ? "font/woff" : lower.endsWith(".otf") ? "font/otf" : "font/ttf";
          })(raw)};base64,${encoded}`;
        }
      } catch {}
      return resolveOverlayAssetSrc(raw);
    })(String(item.fontSrc || "").trim().replace(/"/g, "&quot;"));
    return [ `${family}|${src}`, {
      family: family,
      src: src
    } ];
  })).values()).map(font => `@font-face{font-family:"${font.family}";src:url("${font.src}") format("${(src => {
    const lower = String(src || "").toLowerCase();
    return lower.endsWith(".woff2") ? "woff2" : lower.endsWith(".woff") ? "woff" : lower.endsWith(".otf") ? "opentype" : "truetype";
  })(font.src)}");font-display:swap;}`).join("\n        "), sceneMarkup = BUILDER_SCENE_KEYS.map(sceneKey => {
    return `<div class="overlay-scene ${"postGame" === sceneKey ? "post-game" : sceneKey}" data-scene="${sceneKey}">${items = sceneItems[sceneKey] || [], 
    items.map(item => {
      const element = function(item) {
        const type = item.type;
        if ("team-name-blue" === type) return '<div class="builder-item team-blue" data-item-role="team-name-blue">BLUE TEAM</div>';
        if ("team-name-orange" === type) return '<div class="builder-item team-orange" data-item-role="team-name-orange">ORANGE TEAM</div>';
        if ("abbr-block-blue" === type) return '<div class="builder-item team-blue" data-item-role="abbr-block-blue">BLU</div>';
        if ("abbr-block-orange" === type) return '<div class="builder-item team-orange" data-item-role="abbr-block-orange">ORA</div>';
        if ("logo-box-blue" === type) return `<div class="builder-item logo-box team-blue" data-item-role="logo-box-blue" data-logo-fallback="${[ "rl", "abbr" ].includes(String(item.logoFallback || "").toLowerCase()) ? String(item.logoFallback).toLowerCase() : "rl"}"><img class="team-logo-image" alt="Blue logo"><span class="team-logo-fallback-text">BLU</span></div>`;
        if ("logo-box-orange" === type) return `<div class="builder-item logo-box team-orange" data-item-role="logo-box-orange" data-logo-fallback="${[ "rl", "abbr" ].includes(String(item.logoFallback || "").toLowerCase()) ? String(item.logoFallback).toLowerCase() : "rl"}"><img class="team-logo-image" alt="Orange logo"><span class="team-logo-fallback-text">ORA</span></div>`;
        if ("score-blue" === type) return '<div class="builder-item score team-blue" data-item-role="score-blue">0</div>';
        if ("score-orange" === type) return '<div class="builder-item score team-orange" data-item-role="score-orange">0</div>';
        if ("clock" === type) return '<div class="builder-item clock" data-item-role="clock">5:00</div>';
        if ("series-bo" === type) {
          const boLabel = [ "BO0", "BO3", "BO5", "BO7" ].includes(String(item.variant || "").toUpperCase()) ? String(item.variant).toUpperCase() : "BO7";
          return `<div class="builder-item bo" data-item-role="series-bo" data-series-len="${"BO0" === boLabel ? 0 : "BO3" === boLabel ? 3 : "BO5" === boLabel ? 5 : 7}"><div class="bo-pips"></div></div>`;
        }
        if ("series-text" === type) return '<div class="builder-item series-text" data-item-role="series-text">SERIES TEXT</div>';
        if ("custom-text" === type) return `<div class="builder-item custom-text" data-item-role="custom-text">${String(item.text || "Text").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`;
        if ("replay-scorer-name" === type) return '<div class="builder-item custom-text" data-item-role="replay-scorer-name">SCORER NAME</div>';
        if ("replay-ball-kph" === type) return '<div class="builder-item custom-text" data-item-role="replay-ball-kph">0 KPH</div>';
        if ("replay-assister-name" === type) return '<div class="builder-item custom-text" data-item-role="replay-assister-name">ASSISTER NAME</div>';
        if ("image" === type) return `<img class="builder-image" data-item-role="image" src="${resolveOverlayAssetSrc(String(item.src || "").replace(/\\/g, "/").replace(/"/g, "&quot;"))}" alt="Overlay image">`;
        if ("solid-box" === type) return '<div class="builder-solid-box" data-item-role="solid-box"></div>';
        if ("circle" === type) return '<div class="builder-circle" data-item-role="circle"></div>';
        if ("spectated-player-card" === type) return '<div class="builder-item spectated-card" data-item-role="spectated-player-card">\n    <div class="spec-main">\n        <div class="spec-top-row"><span class="spec-name">SPECTATED PLAYER</span><span class="spec-boost-text">100</span></div>\n        <div class="spec-boost-track"><div class="spec-boost-fill" style="width:100%"></div></div>\n    </div>\n    <div class="spec-stats">\n            <span class="spec-stat" data-stat="goals">GOALS 0</span>\n            <span class="spec-stat" data-stat="shots">SHOTS 0</span>\n            <span class="spec-stat" data-stat="assists">ASSISTS 0</span>\n            <span class="spec-stat" data-stat="saves">SAVES 0</span>\n            <span class="spec-stat" data-stat="demos">DEMOS 0</span>\n    </div>\n</div>';
        if ("spectated-player-boost" === type) return `<div class="builder-item spectated-boost" data-item-role="spectated-player-boost">\n    <div class="spec-wheel"><div class="spec-wheel-fill"></div><span class="spec-wheel-value" style="transform:translate(${Number(item.wheelTextOffsetX) || 0}px, ${Number(item.wheelTextOffsetY) || 0}px) rotate(${-Math.max(-180, Math.min(180, Number(item.rotation) || 0))}deg)">100</span></div>\n</div>`;
        if (type.startsWith("player-card-")) {
          const segments = type.split("-"), team = "orange" === segments[2] ? "orange" : "blue", slot = [ "1", "2", "3" ].includes(segments[3]) ? segments[3] : "1";
          return `<div class="builder-item player-card team-${team}" data-item-role="${type}">\n  <div class="pc-top">\n    <span class="pc-name">${team.toUpperCase()} ${slot}</span>\n    <span class="pc-boost">100</span>\n  </div>\n  <div class="pc-boost-track"><div class="pc-boost-fill" style="width:100%"></div></div>\n</div>`;
        }
        return "";
      }(item);
      if (!element) return "";
      const styles = [ `left:${item.x}px`, `top:${item.y}px`, `width:${item.width}px`, `height:${item.height}px`, `z-index:${Math.max(1, Number(item.zIndex) || 1)}`, `transform:rotate(${Math.max(-180, Math.min(180, Number(item.rotation) || 0))}deg)`, "transform-origin:center center", `--wheel-arc:${Math.max(75, Math.min(100, Number(item.wheelArc) || 100))}`, `--bo-radius:${item.boRounded ? Math.max(0, Math.min(80, Number(item.boCornerRadius) || 0)) : 0}px`, `--boost-radius:${!1 === item.boostRounded ? 0 : 999}px`, `--boost-bar-width:${Math.max(10, Math.min(100, Number(item.boostBarWidth) || 100))}%`, `--boost-bar-height:${Math.max(1, Math.min(80, Number(item.boostBarHeight) || 10))}px`, `--spec-main-width:${Math.max(40, Number(item.width) || 0) * (Math.max(10, Math.min(100, Number(item.boostBarWidth) || 100)) / 100)}px`, `--boost-track-color:${/^#[0-9a-fA-F]{6}$/.test(String(item.boostBackgroundColor || "")) ? String(item.boostBackgroundColor).toUpperCase() : "#333333"}`, `--spec-top-text-scale:${Math.max(.5, Math.min(3, Number(item.specTopTextScale) || 1))}`, `--spec-stats-text-scale:${Math.max(.5, Math.min(3, Number(item.specStatsTextScale) || 1))}`, `--spec-card-gap:${Math.max(0, Math.min(120, Number(item.specCardGap) || 12))}px`, `--pc-name-offset-x:${Math.max(-400, Math.min(400, Number(item.nameOffsetX) || 0))}px`, `--pc-name-offset-y:${Math.max(-400, Math.min(400, Number(item.nameOffsetY) || 0))}px`, `--pc-boost-offset-x:${Math.max(-400, Math.min(400, Number(item.boostTextOffsetX) || 0))}px`, `--pc-boost-offset-y:${Math.max(-400, Math.min(400, Number(item.boostTextOffsetY) || 0))}px`, `--wheel-text-size:${Math.max(8, Math.min(180, Number(item.wheelTextSize) || 28))}px`, `--wheel-thickness:${Math.max(4, Math.min(40, Number(item.wheelThickness) || 18))}%`, `--box-radius:${!1 === item.boxRounded ? 0 : Math.max(0, Math.min(80, Number(item.cornerRadius) || 0))}px` ], defaultFontSize = [ "score-blue", "score-orange", "clock" ].includes(String(item.type || "")) ? 72 : 42;
      styles.push(`font-size:${Number(item.fontSize) > 0 ? Number(item.fontSize) : defaultFontSize}px`);
      const rawColorMode = String(item.colorMode || "default").toLowerCase(), colorMode = "team-name-blue" !== item.type && "team-name-orange" !== item.type || "default" !== rawColorMode ? rawColorMode : "custom", customColor = /^#[0-9a-fA-F]{6}$/.test(String(item.color || "")) ? String(item.color).toUpperCase() : "#FFFFFF";
      if ("spectated-player-boost" === item.type) {
        const wheelBgMode = String(item.wheelBackgroundColorMode || colorMode || "default").toLowerCase(), wheelBgCustom = /^#[0-9a-fA-F]{6}$/.test(String(item.wheelBackgroundColor || "")) ? String(item.wheelBackgroundColor).toUpperCase() : "#2A2A2A";
        "team1" === wheelBgMode ? styles.push("--wheel-bg-color:var(--blue-color)") : "team2" === wheelBgMode ? styles.push("--wheel-bg-color:var(--orange-color)") : "custom" === wheelBgMode && styles.push(`--wheel-bg-color:${wheelBgCustom}`);
      } else "team1" === colorMode ? (styles.push("color:var(--blue-color)"), styles.push("--item-color:var(--blue-color)")) : "team2" === colorMode ? (styles.push("color:var(--orange-color)"), 
      styles.push("--item-color:var(--orange-color)")) : "scoringteam" === colorMode ? (styles.push("color:var(--scoring-team-color, var(--blue-color))"), 
      styles.push("--item-color:var(--scoring-team-color, var(--blue-color))")) : "winningteam" === colorMode ? (styles.push("color:var(--winning-team-color, #ffffff)"), 
      styles.push("--item-color:var(--winning-team-color, #ffffff)")) : "spectated" === colorMode ? (styles.push("color:#FFFFFF"), 
      styles.push("--item-color:#FFFFFF")) : "custom" === colorMode && (styles.push(`color:${customColor}`), 
      styles.push(`--item-color:${customColor}`));
      if (String(item.fontFamily || "").trim()) {
        const safeFamily = String(item.fontFamily).replace(/["']/g, "").trim();
        styles.push(`font-family:'${safeFamily}','Segoe UI',Tahoma,Arial,sans-serif`);
      }
      const attrs = [ `data-color-mode="${colorMode}"`, `data-color-custom="${customColor}"`, `data-group-id="${String(item.groupId || "").replace(/"/g, "&quot;")}"`, `data-show-name="${!1 === item.showName ? "0" : "1"}"`, `data-show-boost="${!1 === item.showBoost ? "0" : "1"}"`, `data-show-boost-text="${!1 === item.showBoostText ? "0" : "1"}"`, `data-text-caps="${!1 === item.textCaps ? "0" : "1"}"`, `data-track-goals="${item.trackGoals ? "1" : "0"}"`, `data-track-shots="${item.trackShots ? "1" : "0"}"`, `data-track-saves="${item.trackSaves ? "1" : "0"}"`, `data-track-assists="${item.trackAssists ? "1" : "0"}"`, `data-track-demos="${item.trackDemos ? "1" : "0"}"` ].join(" ");
      return Number.isFinite(Number(item.opacity)) && styles.push(`opacity:${Math.max(0, Math.min(1, Number(item.opacity))).toFixed(2)}`), 
      `<div class="overlay-node" ${attrs} style="${styles.join(";")};">${element}</div>`;
    }).join("\n      ")}</div>`;
    var items;
  }).join("\n            "), transitionAssetSrc = resolveOverlayAssetSrc(String(normalizedLayout?.transitionSrc || "").replace(/\\/g, "/")), transitionDurationMs = Math.max(100, Math.min(5e3, Number(normalizedLayout?.transitionDurationMs) || 420)), transitionIntroOffsetMs = Math.max(-3e3, Math.min(3e3, Number(normalizedLayout?.transitionIntroOffsetMs) || 0));
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>${safeName}</title>\n    <script src="/socket.io/socket.io.js"><\/script>\n    <style>\n        :root {\n            --blue-color: #21afd7;\n            --orange-color: #fd5b00;\n            --scoring-team-color: var(--blue-color);\n            --winning-team-color: #ffffff;\n        }\n\n        ${fontFaceCss}\n\n        html, body {\n            margin: 0;\n            width: 1920px;\n            height: 1080px;\n            overflow: hidden;\n            background: transparent;\n            font-family: "Segoe UI", Tahoma, Arial, sans-serif;\n            color: #ffffff;\n        }\n\n        #overlay-root {\n            position: relative;\n            width: 100%;\n            height: 100%;\n            pointer-events: none;\n        }\n\n        #scene-transition-layer {\n            position: absolute;\n            inset: 0;\n            display: none;\n            opacity: 1;\n            pointer-events: none;\n            z-index: 5000;\n            background: transparent;\n        }\n\n        #scene-transition-layer video {\n            width: 100%;\n            height: 100%;\n            object-fit: cover;\n            display: block;\n            background: transparent;\n        }\n\n        .overlay-scene {\n            position: absolute;\n            inset: 0;\n            opacity: 0;\n            visibility: hidden;\n            transition: opacity 260ms ease;\n            pointer-events: none;\n        }\n\n        .overlay-scene.active {\n            opacity: 1;\n            visibility: visible;\n        }\n\n        .overlay-scene.post-game {\n            transition-duration: 380ms;\n        }\n\n        .overlay-node {\n            position: absolute;\n            display: flex;\n            align-items: center;\n            justify-content: center;\n            box-sizing: border-box;\n            overflow: visible;\n        }\n\n        .builder-item {\n            width: 100%;\n            height: 100%;\n            display: flex;\n            align-items: center;\n            justify-content: center;\n            background: transparent;\n            border: none;\n            border-radius: 0;\n            text-transform: uppercase;\n            letter-spacing: 0.04em;\n            text-shadow: none;\n            text-align: center;\n            font-weight: 700;\n            white-space: nowrap;\n            overflow: hidden;\n            text-overflow: ellipsis;\n            padding: 0;\n            line-height: 1;\n        }\n\n        .builder-item.score,\n        .builder-item.clock {\n            font-size: inherit;\n            font-weight: 800;\n            letter-spacing: 0;\n            justify-content: center;\n            line-height: 1;\n            overflow: visible;\n        }\n\n        .builder-item.score {\n            color: #ffffff !important;\n        }\n\n        .builder-item.bo {\n            display: flex;\n            align-items: center;\n            justify-content: center;\n            padding: 0;\n            border-radius: 0;\n            background: transparent;\n        }\n\n        .bo-pips {\n            width: 100%;\n            height: 100%;\n            display: grid;\n            grid-template-columns: repeat(var(--bo-count, 7), 1fr);\n            gap: 4px;\n            align-items: stretch;\n        }\n\n        .bo-pip {\n            border-radius: var(--bo-radius, 0px);\n            background: var(--item-color, rgba(255, 255, 255, 0.35));\n        }\n\n        .bo-pip.blue-win {\n            background: var(--blue-color);\n            box-shadow: none;\n        }\n\n        .bo-pip.orange-win {\n            background: var(--orange-color);\n            box-shadow: none;\n        }\n\n        .builder-image {\n            width: 100%;\n            height: 100%;\n            object-fit: contain;\n            display: block;\n        }\n\n        .overlay-node img {\n            pointer-events: none;\n        }\n\n        .builder-item:not(.score):not(.clock) {\n            font-size: inherit;\n            justify-content: center;\n        }\n\n        .overlay-node[data-text-caps="0"] .builder-item {\n            text-transform: none !important;\n        }\n\n        .overlay-node[data-text-caps="1"] .builder-item {\n            text-transform: uppercase !important;\n        }\n\n        .builder-item.team-blue:not(.player-card):not(.score),\n        .builder-item.team-orange:not(.player-card):not(.score) {\n            display: flex;\n            align-items: center;\n            justify-content: center;\n            width: 100%;\n            height: 100%;\n            padding: 0;\n            box-sizing: border-box;\n            overflow: hidden;\n            text-overflow: ellipsis;\n        }\n\n        .builder-item.player-card {\n            padding: 0;\n            display: flex;\n            flex-direction: column;\n            justify-content: center;\n            gap: 5px;\n            text-transform: none;\n            letter-spacing: 0;\n            overflow: visible;\n        }\n\n        .builder-item.logo-box {\n            width: 100%;\n            height: 100%;\n            display: flex;\n            align-items: center;\n            justify-content: center;\n            overflow: hidden;\n            text-transform: uppercase;\n            letter-spacing: 0.08em;\n            font-weight: 900;\n            color: #fff;\n            position: relative;\n        }\n\n        .builder-item.logo-box .team-logo-image {\n            width: 100%;\n            height: 100%;\n            object-fit: contain;\n            display: none;\n            padding: 6px;\n        }\n\n        .builder-item.logo-box .team-logo-fallback-text {\n            display: inline-flex;\n            align-items: center;\n            justify-content: center;\n            width: 100%;\n            height: 100%;\n            font-size: calc(0.58em);\n            font-weight: 900;\n            letter-spacing: 0.08em;\n        }\n\n        .builder-solid-box {\n            position: absolute;\n            top: 0;\n            right: -1px;\n            bottom: 0;\n            left: 0;\n            display: block;\n            box-sizing: border-box;\n            background: var(--item-color, rgba(255, 255, 255, 0.5));\n            border-radius: var(--box-radius, 6px);\n        }\n\n        .builder-circle {\n            width: 100%;\n            height: 100%;\n            border-radius: 50%;\n            background: var(--item-color, rgba(255,255,255,0.5));\n        }\n\n        .builder-item.spectated-card {\n            display: grid;\n            grid-template-columns: var(--spec-main-width, minmax(0, 1fr)) auto;\n            align-items: center;\n            gap: var(--spec-card-gap, 12px);\n            text-transform: none;\n            letter-spacing: 0;\n            overflow: visible;\n        }\n\n        .spec-main {\n            width: 100%;\n            max-width: none;\n            min-width: 0;\n            display: grid;\n            grid-template-rows: auto auto;\n            gap: 5px;\n            align-items: center;\n            justify-self: start;\n        }\n\n        .spec-top-row {\n            text-align: left;\n            width: 100%;\n            min-width: 0;\n            display: grid;\n            grid-template-columns: minmax(0, 1fr) auto;\n            gap: 8px;\n            align-items: center;\n            justify-self: start;\n        }\n\n        .spec-name {\n            font-size: calc(0.66em * var(--spec-top-text-scale, 1));\n            font-weight: 800;\n            line-height: 1.15;\n            min-width: 0;\n            overflow: hidden;\n            text-overflow: ellipsis;\n            white-space: nowrap;\n            color: var(--item-color, #fff);\n            text-align: left;\n            justify-self: start;\n            transform: translate(var(--pc-name-offset-x, 0px), var(--pc-name-offset-y, 0px));\n        }\n\n        .spec-boost-text {\n            font-size: calc(0.52em * var(--spec-top-text-scale, 1));\n            font-weight: 900;\n            line-height: 1;\n            color: var(--item-color, #fff);\n            text-align: right;\n            justify-self: end;\n            transform: translate(var(--pc-boost-offset-x, 0px), var(--pc-boost-offset-y, 0px));\n        }\n\n        .spec-boost-track {\n            grid-column: 1 / -1;\n            width: 100%;\n            height: var(--boost-bar-height, max(6px, 0.24em));\n            border-radius: var(--boost-radius, 999px);\n            background: var(--boost-track-color, rgba(255, 255, 255, 0.2));\n            overflow: hidden;\n            justify-self: start;\n        }\n\n        .spec-boost-fill {\n            height: 100%;\n            background: var(--item-color, #fff);\n            border-radius: inherit;\n        }\n\n        .spec-stats {\n            display: flex;\n            flex-direction: row;\n            align-items: center;\n            justify-content: center;\n            gap: 8px;\n            font-size: calc(0.28em * var(--spec-stats-text-scale, 1));\n            font-weight: 700;\n            text-transform: uppercase;\n            color: var(--item-color, #fff);\n            white-space: nowrap;\n        }\n\n        .builder-item.spectated-boost {\n            display: flex;\n            align-items: center;\n            justify-content: center;\n            background: transparent;\n        }\n\n        .spec-wheel {\n            width: 100%;\n            height: 100%;\n            border-radius: 50%;\n            position: relative;\n            display: grid;\n            place-items: center;\n            filter: drop-shadow(0 2px 8px rgba(0,0,0,0.5));\n        }\n\n        .spec-wheel-fill {\n            position: absolute;\n            inset: 0;\n            border-radius: 50%;\n            background: conic-gradient(\n                from -130deg,\n                var(--item-color, #ffffff) calc((var(--boost, 100) / 100) * var(--wheel-arc, 100) * 1%),\n                var(--wheel-bg-color, rgba(255,255,255,0.16)) 0 calc(var(--wheel-arc, 100) * 1%),\n                transparent calc(var(--wheel-arc, 100) * 1%)\n            );\n            -webkit-mask: radial-gradient(circle at center, transparent calc(78% - var(--wheel-thickness, 18%)), #000 calc(80% - var(--wheel-thickness, 18%)));\n            mask: radial-gradient(circle at center, transparent calc(78% - var(--wheel-thickness, 18%)), #000 calc(80% - var(--wheel-thickness, 18%)));\n        }\n\n        .spec-wheel-value {\n            font-size: var(--wheel-text-size, calc(0.66em));\n            font-weight: 900;\n            color: #fff;\n            text-shadow: none;\n            position: relative;\n            z-index: 2;\n            transform-origin: center center;\n            line-height: 1;\n        }\n\n        .pc-top {\n            width: 100%;\n            display: grid;\n            line-height: 1.15;\n            grid-template-columns: 1fr auto;\n            gap: 8px;\n            align-items: center;\n        }\n\n        .pc-name {\n            font-size: calc(0.43em);\n            font-weight: 700;\n            line-height: 1.15;\n            color: #fff;\n            white-space: nowrap;\n            overflow: hidden;\n            text-overflow: ellipsis;\n            text-align: left;\n            transform: translate(var(--pc-name-offset-x, 0px), var(--pc-name-offset-y, 0px));\n        }\n\n        .pc-boost {\n            font-size: calc(0.48em);\n            font-weight: 800;\n            line-height: 1;\n            color: #fff;\n            transform: translate(var(--pc-boost-offset-x, 0px), var(--pc-boost-offset-y, 0px));\n        }\n\n        .builder-item.player-card.team-orange .pc-top {\n            grid-template-columns: auto 1fr;\n        }\n\n        .builder-item.player-card.team-orange .pc-name {\n            grid-column: 2;\n            text-align: right;\n        }\n\n        .builder-item.player-card.team-orange .pc-boost {\n            grid-column: 1;\n            justify-self: start;\n        }\n\n        .pc-boost-track {\n            width: min(100%, var(--boost-bar-width, 100%));\n            height: var(--boost-bar-height, max(6px, 0.24em));\n            border-radius: var(--boost-radius, 999px);\n            background: var(--boost-track-color, rgba(255, 255, 255, 0.18));\n            overflow: hidden;\n        }\n\n        .pc-boost-fill {\n            height: 100%;\n            width: 0%;\n            border-radius: inherit;\n            background: var(--item-color, #fff);\n        }\n\n        .overlay-node[data-show-name="0"] .pc-name,\n        .overlay-node[data-show-name="0"] .spec-name {\n            display: none;\n        }\n\n        .overlay-node[data-show-boost="0"] .pc-boost-track,\n        .overlay-node[data-show-boost="0"] .spec-boost-track {\n            display: none;\n        }\n\n        .overlay-node[data-show-boost-text="0"] .pc-boost,\n        .overlay-node[data-show-boost-text="0"] .spec-boost-text {\n            display: none;\n        }\n\n        .overlay-node[data-track-goals="0"] .spec-stat[data-stat="goals"],\n        .overlay-node[data-track-shots="0"] .spec-stat[data-stat="shots"],\n        .overlay-node[data-track-saves="0"] .spec-stat[data-stat="saves"],\n        .overlay-node[data-track-assists="0"] .spec-stat[data-stat="assists"],\n        .overlay-node[data-track-demos="0"] .spec-stat[data-stat="demos"] {\n            display: none;\n        }\n\n        .team-blue {\n            color: var(--item-color, var(--blue-color));\n        }\n\n        .team-orange {\n            color: var(--item-color, var(--orange-color));\n        }\n\n        body.rc-hide-scoreboard [data-item-role="team-name-blue"],\n        body.rc-hide-scoreboard [data-item-role="team-name-orange"],\n        body.rc-hide-scoreboard [data-item-role="abbr-block-blue"],\n        body.rc-hide-scoreboard [data-item-role="abbr-block-orange"],\n        body.rc-hide-scoreboard [data-item-role="logo-box-blue"],\n        body.rc-hide-scoreboard [data-item-role="logo-box-orange"],\n        body.rc-hide-scoreboard [data-item-role="score-blue"],\n        body.rc-hide-scoreboard [data-item-role="score-orange"],\n        body.rc-hide-scoreboard [data-item-role="clock"],\n        body.rc-hide-scoreboard [data-item-role="series-bo"],\n        body.rc-hide-scoreboard [data-item-role="series-text"] {\n            display: none !important;\n        }\n\n        body.rc-hide-boost-wheel [data-item-role="spectated-player-boost"] {\n            display: none !important;\n        }\n\n        body.rc-hide-bottom-player-card [data-item-role="spectated-player-card"] {\n            display: none !important;\n        }\n\n        body.rc-hide-side-player-cards [data-item-role^="player-card-"] {\n            display: none !important;\n        }\n    </style>\n</head>\n<body>\n    <div id="overlay-root">\n        <div id="scene-transition-layer"><video id="scene-transition-video" muted playsinline preload="auto"></video></div>\n        ${sceneMarkup}\n    </div>\n\n    <script>\n        const socket = io();\n        let overrides = {};\n        const overlayTransition = {\n            src: ${JSON.stringify(transitionAssetSrc || "")},\n            switchDelayMs: ${Number(transitionDurationMs)},\n            introOffsetMs: ${Number(transitionIntroOffsetMs)}\n        };\n\n        const gameState = {\n            blueName: "BLUE TEAM",\n            orangeName: "ORANGE TEAM",\n            blueScore: 0,\n            orangeScore: 0,\n            blueWins: 0,\n            orangeWins: 0,\n            spectatedTeam: 0,\n            lastScoringTeam: 0,\n            replayScorerName: "SCORER NAME",\n            replayAssisterName: "ASSISTER NAME",\n            replayHasAssister: true,\n            replayBallKph: "0 KPH",\n            timeSeconds: 300,\n            overtime: false\n        };\n        let currentScene = "game";\n        let replayIntroTimer = null;\n        let replaySessionActive = false;\n        let replaySequenceId = 0;\n        let replayExitHandledSequenceId = -1;\n        let replayStartedAt = 0;\n        const FIXED_REPLAY_DURATION_MS = 10686;\n        let fixedReplayDurationMs = FIXED_REPLAY_DURATION_MS;\n        let transitionPlaying = false;\n        let lastReplayEndHandledAt = 0;\n        const REPLAY_END_DEDUPE_MS = 2500;\n        const EXPECTED_REPLAY_POV_SWITCH_LEAD_MS = 3000;\n\n        function playSceneTransition() {\n            if (!overlayTransition.src) {\n                return false;\n            }\n\n            if (transitionPlaying) {\n                return false;\n            }\n\n            const layer = document.getElementById('scene-transition-layer');\n            const video = document.getElementById('scene-transition-video');\n            if (!layer || !video) {\n                return false;\n            }\n\n            layer.style.display = 'block';\n            if (video.src !== overlayTransition.src) {\n                video.src = overlayTransition.src;\n            }\n\n            const hideLayer = () => {\n                layer.style.display = 'none';\n                transitionPlaying = false;\n                video.removeEventListener('ended', hideLayer);\n                video.removeEventListener('error', hideLayer);\n            };\n            video.addEventListener('ended', hideLayer);\n            video.addEventListener('error', hideLayer);\n\n            transitionPlaying = true;\n            video.pause();\n            video.currentTime = 0;\n            const playPromise = video.play();\n            if (playPromise && typeof playPromise.catch === 'function') {\n                playPromise.catch(() => {\n                    // Ignore autoplay rejections in browser source contexts.\n                    transitionPlaying = false;\n                });\n            }\n\n            return true;\n        }\n\n        function scheduleReplayIntroTransitionFromGoal() {\n            if (!overlayTransition.src) {\n                return;\n            }\n\n            if (replayIntroTimer) {\n                clearTimeout(replayIntroTimer);\n                replayIntroTimer = null;\n            }\n\n            const desiredDelay = EXPECTED_REPLAY_POV_SWITCH_LEAD_MS + Number(overlayTransition.introOffsetMs || 0);\n            const delay = Math.max(0, desiredDelay);\n            replayIntroTimer = setTimeout(() => {\n                replayIntroTimer = null;\n                playSceneTransition();\n            }, delay);\n        }\n\n        function applyOverlayScene(nextScene) {\n            currentScene = nextScene;\n            document.querySelectorAll('.overlay-scene').forEach((sceneNode) => {\n                sceneNode.classList.toggle('active', String(sceneNode.getAttribute('data-scene') || '') === nextScene);\n            });\n        }\n\n        function setOverlayScene(sceneKey) {\n            const nextScene = ["game", "replay", "postGame"].includes(String(sceneKey || "")) ? String(sceneKey) : "game";\n            if (nextScene === currentScene && document.querySelector('.overlay-scene.active')) {\n                return;\n            }\n            applyOverlayScene(nextScene);\n        }\n\n        function abbreviationFallback(value, fallbackText) {\n            const text = String(value || "").trim();\n            return text || fallbackText;\n        }\n\n        function computedAbbreviation(rawText, fallbackText) {\n            const text = String(rawText || "").trim();\n            if (!text) {\n                return String(fallbackText || "").trim().toUpperCase();\n            }\n\n            const words = text.split(/s+/).filter(Boolean);\n            if (words.length >= 2) {\n                return words.slice(0, 3).map((word) => word[0]).join("").toUpperCase();\n            }\n\n            return text.slice(0, 3).toUpperCase();\n        }\n\n        function fitTextToWidth(element) {\n            if (!element) {\n                return;\n            }\n\n            const computed = window.getComputedStyle(element);\n            const fallbackSize = Number.parseFloat(computed.fontSize) || 16;\n            const baseSize = Number.parseFloat(element.dataset.baseFontSize || "") || fallbackSize;\n            element.dataset.baseFontSize = String(baseSize);\n            element.style.fontSize = baseSize + "px";\n\n            const parent = element.parentElement;\n            if (!parent) {\n                return;\n            }\n\n            const availableWidth = Math.max(0, parent.clientWidth);\n            if (!availableWidth) {\n                return;\n            }\n\n            let nextSize = baseSize;\n            while (element.scrollWidth > availableWidth && nextSize > 10) {\n                nextSize -= 1;\n                element.style.fontSize = nextSize + "px";\n            }\n        }\n\n        function formatClock(seconds, isOvertime) {\n            if (isOvertime) {\n                return "OT";\n            }\n\n            const safeSeconds = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(Number(seconds))) : 0;\n            const mins = Math.floor(safeSeconds / 60);\n            const secs = safeSeconds % 60;\n            return mins + ":" + String(secs).padStart(2, "0");\n        }\n\n        function setPlayerCardRoleVisibility(role, isVisible) {\n            document.querySelectorAll('[data-item-role="' + role + '"]').forEach((cardNode) => {\n                const sceneNode = cardNode.closest('.overlay-scene');\n                const overlayNode = cardNode.closest('.overlay-node');\n                const targets = [cardNode];\n                if (overlayNode) {\n                    targets.push(overlayNode);\n                }\n                const groupId = String((overlayNode?.dataset?.groupId) || cardNode.dataset.groupId || '').trim();\n\n                if (sceneNode && groupId) {\n                    sceneNode.querySelectorAll('.overlay-node').forEach((node) => {\n                        if (String(node.dataset.groupId || '').trim() === groupId) {\n                            targets.push(node);\n                        }\n                    });\n                }\n\n                const uniqueTargets = Array.from(new Set(targets));\n                uniqueTargets.forEach((node) => {\n                    node.style.display = isVisible ? '' : 'none';\n                });\n            });\n        }\n\n        function hasPlayerSlotData(player) {\n            if (!player || typeof player !== 'object') {\n                return false;\n            }\n\n            return String(player.Name || '').trim().length > 0;\n        }\n\n        function hasSpectatedPlayerData(targetPlayerName) {\n            return String(targetPlayerName || '').trim().length > 0;\n        }\n\n        function syncPlayerCardSlotVisibility(bluePlayers, orangePlayers) {\n            for (let slot = 1; slot <= 3; slot += 1) {\n                const hasBluePlayer = hasPlayerSlotData(bluePlayers[slot - 1]);\n                const hasOrangePlayer = hasPlayerSlotData(orangePlayers[slot - 1]);\n                setPlayerCardRoleVisibility('player-card-blue-' + slot, hasBluePlayer);\n                setPlayerCardRoleVisibility('player-card-orange-' + slot, hasOrangePlayer);\n            }\n        }\n\n        function syncSpectatedVisibility(targetPlayerName) {\n            const visible = hasSpectatedPlayerData(targetPlayerName);\n            setPlayerCardRoleVisibility('spectated-player-card', visible);\n            setPlayerCardRoleVisibility('spectated-player-boost', visible);\n        }\n\n        function updateView() {\n            const nodeCapsEnabled = (element) => {\n                const node = element?.closest('.overlay-node');\n                return node?.dataset?.textCaps !== '0';\n            };\n            const applyCaps = (element, value) => nodeCapsEnabled(element) ? String(value || '').toUpperCase() : String(value || '');\n\n            const blueName = abbreviationFallback(overrides.blueName, gameState.blueName);\n            const orangeName = abbreviationFallback(overrides.orangeName, gameState.orangeName);\n            const blueScore = gameState.blueScore;\n            const orangeScore = gameState.orangeScore;\n            const spectatedColor = Number(gameState.spectatedTeam) === 1 ? 'var(--orange-color)' : 'var(--blue-color)';\n            const blueAbbr = abbreviationFallback(overrides.blueAbbr, computedAbbreviation(blueName, 'BLU'));\n            const orangeAbbr = abbreviationFallback(overrides.orangeAbbr, computedAbbreviation(orangeName, 'ORA'));\n            const blueLogo = String(overrides.blueLogo || '').trim();\n            const orangeLogo = String(overrides.orangeLogo || '').trim();\n            const scoringTeamColor = Number(gameState.lastScoringTeam) === 1 ? 'var(--orange-color)' : 'var(--blue-color)';\n            const winningTeamColor = gameState.blueScore > gameState.orangeScore\n                ? 'var(--blue-color)'\n                : (gameState.orangeScore > gameState.blueScore ? 'var(--orange-color)' : '#FFFFFF');\n            const replayScorerName = String(gameState.replayScorerName || 'SCORER NAME').trim() || 'SCORER NAME';\n            const replayAssisterName = String(gameState.replayAssisterName || 'ASSISTER NAME').trim() || 'ASSISTER NAME';\n            const replayBallKph = String(gameState.replayBallKph || '0 KPH').trim() || '0 KPH';\n\n            document.documentElement.style.setProperty('--scoring-team-color', scoringTeamColor);\n            document.documentElement.style.setProperty('--winning-team-color', winningTeamColor);\n\n            document.body.classList.toggle('rc-hide-scoreboard', Boolean(overrides.hideScoreboard));\n            document.body.classList.toggle('rc-hide-boost-wheel', Boolean(overrides.hideBoostWheel));\n            document.body.classList.toggle('rc-hide-bottom-player-card', Boolean(overrides.hideBottomPlayerCard));\n            document.body.classList.toggle('rc-hide-side-player-cards', Boolean(overrides.hideSidePlayerCards));\n\n            document.querySelectorAll('.overlay-node[data-color-mode="spectated"]').forEach((node) => {\n                node.style.color = spectatedColor;\n                node.style.setProperty('--item-color', spectatedColor);\n            });\n\n            document.querySelectorAll('[data-item-role="team-name-blue"]').forEach((el) => {\n                el.textContent = nodeCapsEnabled(el) ? blueName.toUpperCase() : blueName;\n                fitTextToWidth(el);\n            });\n\n            document.querySelectorAll('[data-item-role="team-name-orange"]').forEach((el) => {\n                el.textContent = nodeCapsEnabled(el) ? orangeName.toUpperCase() : orangeName;\n                fitTextToWidth(el);\n            });\n\n            document.querySelectorAll('[data-item-role="abbr-block-blue"]').forEach((el) => {\n                el.textContent = applyCaps(el, blueAbbr);\n                fitTextToWidth(el);\n            });\n\n            document.querySelectorAll('[data-item-role="abbr-block-orange"]').forEach((el) => {\n                el.textContent = applyCaps(el, orangeAbbr);\n                fitTextToWidth(el);\n            });\n\n            document.querySelectorAll('[data-item-role="logo-box-blue"]').forEach((el) => {\n                const imageEl = el.querySelector('.team-logo-image');\n                const textEl = el.querySelector('.team-logo-fallback-text');\n                const fallbackMode = String(el.getAttribute('data-logo-fallback') || 'rl').toLowerCase() === 'abbr' ? 'abbr' : 'rl';\n\n                if (blueLogo) {\n                    if (imageEl) {\n                        imageEl.src = blueLogo;\n                        imageEl.style.display = 'block';\n                    }\n                    if (textEl) {\n                        textEl.style.display = 'none';\n                    }\n                } else if (fallbackMode === 'abbr') {\n                    if (imageEl) {\n                        imageEl.removeAttribute('src');\n                        imageEl.style.display = 'none';\n                    }\n                    if (textEl) {\n                        textEl.textContent = applyCaps(el, blueAbbr);\n                        textEl.style.display = 'inline-flex';\n                    }\n                } else {\n                    if (imageEl) {\n                        imageEl.src = '/build/rl.png';\n                        imageEl.style.display = 'block';\n                    }\n                    if (textEl) {\n                        textEl.style.display = 'none';\n                    }\n                }\n            });\n\n            document.querySelectorAll('[data-item-role="logo-box-orange"]').forEach((el) => {\n                const imageEl = el.querySelector('.team-logo-image');\n                const textEl = el.querySelector('.team-logo-fallback-text');\n                const fallbackMode = String(el.getAttribute('data-logo-fallback') || 'rl').toLowerCase() === 'abbr' ? 'abbr' : 'rl';\n\n                if (orangeLogo) {\n                    if (imageEl) {\n                        imageEl.src = orangeLogo;\n                        imageEl.style.display = 'block';\n                    }\n                    if (textEl) {\n                        textEl.style.display = 'none';\n                    }\n                } else if (fallbackMode === 'abbr') {\n                    if (imageEl) {\n                        imageEl.removeAttribute('src');\n                        imageEl.style.display = 'none';\n                    }\n                    if (textEl) {\n                        textEl.textContent = applyCaps(el, orangeAbbr);\n                        textEl.style.display = 'inline-flex';\n                    }\n                } else {\n                    if (imageEl) {\n                        imageEl.src = '/build/rl.png';\n                        imageEl.style.display = 'block';\n                    }\n                    if (textEl) {\n                        textEl.style.display = 'none';\n                    }\n                }\n            });\n\n            document.querySelectorAll('[data-item-role="score-blue"]').forEach((el) => {\n                el.textContent = String(blueScore);\n            });\n\n            document.querySelectorAll('[data-item-role="score-orange"]').forEach((el) => {\n                el.textContent = String(orangeScore);\n            });\n\n            document.querySelectorAll('[data-item-role="clock"]').forEach((el) => {\n                el.textContent = formatClock(gameState.timeSeconds, gameState.overtime);\n            });\n\n            document.querySelectorAll('[data-item-role="replay-scorer-name"]').forEach((el) => {\n                el.textContent = nodeCapsEnabled(el) ? replayScorerName.toUpperCase() : replayScorerName;\n                fitTextToWidth(el);\n            });\n\n            document.querySelectorAll('[data-item-role="replay-assister-name"]').forEach((el) => {\n                el.textContent = nodeCapsEnabled(el) ? replayAssisterName.toUpperCase() : replayAssisterName;\n                fitTextToWidth(el);\n            });\n            setPlayerCardRoleVisibility('replay-assister-name', Boolean(gameState.replayHasAssister));\n\n            document.querySelectorAll('[data-item-role="replay-ball-kph"]').forEach((el) => {\n                el.textContent = nodeCapsEnabled(el) ? replayBallKph.toUpperCase() : replayBallKph;\n                fitTextToWidth(el);\n            });\n\n            const seriesText = String(overrides.headerText || '').trim() || 'SERIES TEXT';\n            document.querySelectorAll('[data-item-role="series-text"]').forEach((el) => {\n                el.textContent = nodeCapsEnabled(el) ? seriesText.toUpperCase() : seriesText;\n                fitTextToWidth(el);\n            });\n\n            const parseSeriesLength = (value) => {\n                if ([0, 3, 5, 7].includes(Number(value))) {\n                    return Number(value);\n                }\n                const text = String(value || '').trim().toUpperCase();\n                if (/^BO(?:0|3|5|7)$/.test(text)) {\n                    return Number(text.slice(2));\n                }\n                return null;\n            };\n\n            const seriesLen = parseSeriesLength(overrides.seriesLen);\n            document.querySelectorAll('[data-item-role="series-bo"]').forEach((el) => {\n                const blueWins = Number.isFinite(Number(overrides.blueWins)) ? Number(overrides.blueWins) : Number(gameState.blueWins || 0);\n                const orangeWins = Number.isFinite(Number(overrides.orangeWins)) ? Number(overrides.orangeWins) : Number(gameState.orangeWins || 0);\n                const dataLen = Number(el.getAttribute('data-series-len') || 7);\n                const safeLen = [0, 3, 5, 7].includes(seriesLen) ? seriesLen : ([0, 3, 5, 7].includes(dataLen) ? dataLen : 7);\n                const pipsRoot = el.querySelector('.bo-pips');\n                if (!pipsRoot) return;\n\n                pipsRoot.style.setProperty('--bo-count', String(safeLen));\n                pipsRoot.innerHTML = '';\n\n                const blueSafe = Math.max(0, Math.min(safeLen, Math.floor(blueWins)));\n                const orangeSafe = Math.max(0, Math.min(safeLen, Math.floor(orangeWins)));\n\n                for (let index = 0; index < safeLen; index += 1) {\n                    const pip = document.createElement('span');\n                    pip.className = 'bo-pip';\n                    if (index < blueSafe) {\n                        pip.classList.add('blue-win');\n                    } else if (index >= safeLen - orangeSafe) {\n                        pip.classList.add('orange-win');\n                    }\n                    pipsRoot.appendChild(pip);\n                }\n            });\n\n            if (overrides.blueColor) {\n                document.documentElement.style.setProperty("--blue-color", overrides.blueColor);\n            }\n\n            if (overrides.orangeColor) {\n                document.documentElement.style.setProperty("--orange-color", overrides.orangeColor);\n            }\n        }\n\n        function readGoalValue(source, paths) {\n            for (const path of paths) {\n                const segments = String(path || '').split('.').filter(Boolean);\n                let cursor = source;\n                let found = true;\n                for (const segment of segments) {\n                    if (cursor && typeof cursor === 'object' && Object.prototype.hasOwnProperty.call(cursor, segment)) {\n                        cursor = cursor[segment];\n                    } else {\n                        found = false;\n                        break;\n                    }\n                }\n                if (found && cursor !== undefined && cursor !== null && String(cursor).trim() !== '') {\n                    return cursor;\n                }\n            }\n            return null;\n        }\n\n        function parseReplayTeamNum(goalData) {\n            const value = readGoalValue(goalData, [\n                'TeamNum',\n                'teamNum',\n                'ScoringTeam',\n                'scoringTeam',\n                'Team',\n                'team',\n                'Scorer.TeamNum',\n                'scorer.teamNum',\n                'Goal.TeamNum',\n                'goal.teamNum'\n            ]);\n            const parsed = Number(value);\n            if (parsed === 0 || parsed === 1) {\n                return parsed;\n            }\n            return null;\n        }\n\n        function formatReplayBallSpeed(goalData) {\n            const speedValue = readGoalValue(goalData, [\n                'GoalSpeed',\n                'goalSpeed',\n                'BallSpeedKph',\n                'ballSpeedKph',\n                'ShotSpeedKph',\n                'shotSpeedKph',\n                'ShotSpeed',\n                'shotSpeed',\n                'Speed',\n                'speed'\n            ]);\n            const parsed = Number(speedValue);\n            if (!Number.isFinite(parsed)) {\n                return '0 KPH';\n            }\n            return String(Math.max(0, Math.round(parsed))) + ' KPH';\n        }\n\n        function parseReplayAssister(goalData) {\n            const rawAssister = readGoalValue(goalData, [\n                'Assister.Name',\n                'assister.name',\n                'Assister',\n                'assister',\n                'Assist.Name',\n                'assist.name'\n            ]);\n\n            if (rawAssister && typeof rawAssister === 'object') {\n                const nameFromObject = String(rawAssister.Name || rawAssister.name || '').trim();\n                return {\n                    hasAssister: Boolean(nameFromObject),\n                    assisterName: nameFromObject\n                };\n            }\n\n            const text = String(rawAssister || '').trim();\n            const normalized = text.toLowerCase();\n            const hasAssister = Boolean(text) && !['none', 'null', 'n/a', 'na'].includes(normalized);\n            return {\n                hasAssister,\n                assisterName: hasAssister ? text : ''\n            };\n        }\n\n        function readReplayName(goalData, possiblePaths, fallbackText) {\n            const value = readGoalValue(goalData, possiblePaths);\n            const text = String(value || '').trim();\n            return text || fallbackText;\n        }\n\n        socket.on("overrides", (data) => {\n            if (!data || typeof data !== "object") {\n                return;\n            }\n\n            overrides = {\n                ...overrides,\n                ...data\n            };\n\n            updateView();\n        });\n\n        socket.on("state", (packet) => {\n            const eventName = packet?.Event || packet?.event || "";\n            const data = packet?.Data || packet?.data || {};\n\n            if (eventName === "GoalScored") {\n                const teamNum = parseReplayTeamNum(data);\n                if (teamNum === 0 || teamNum === 1) {\n                    gameState.lastScoringTeam = teamNum;\n                }\n                gameState.replayScorerName = readReplayName(data, [\n                    'Scorer.Name',\n                    'scorer.name',\n                    'Player.Name',\n                    'player.name',\n                    'Shooter.Name',\n                    'shooter.name',\n                    'Name',\n                    'name'\n                ], 'SCORER NAME');\n                const replayAssister = parseReplayAssister(data);\n                gameState.replayHasAssister = replayAssister.hasAssister;\n                gameState.replayAssisterName = replayAssister.hasAssister ? replayAssister.assisterName : '';\n                gameState.replayBallKph = formatReplayBallSpeed(data);\n                updateView();\n                if (replaySessionActive || currentScene === "replay") {\n                    return;\n                }\n                scheduleReplayIntroTransitionFromGoal();\n                return;\n            }\n\n            if (eventName === "GoalReplayStart") {\n                if (replaySessionActive) {\n                    return;\n                }\n                replaySessionActive = true;\n                replaySequenceId += 1;\n                replayExitHandledSequenceId = -1;\n                replayStartedAt = Date.now();\n                console.log('[ReplayTiming] replay started', {\n                    sequenceId: replaySequenceId,\n                    startedAt: replayStartedAt,\n                    fixedReplayDurationMs\n                });\n                if (replayIntroTimer) {\n                    clearTimeout(replayIntroTimer);\n                    replayIntroTimer = null;\n                }\n                setOverlayScene("replay");\n                return;\n            }\n\n            if (eventName === "GoalReplayEnd") {\n                const now = Date.now();\n                if ((now - lastReplayEndHandledAt) < REPLAY_END_DEDUPE_MS) {\n                    console.log('[ReplayTiming] GoalReplayEnd ignored by dedupe', {\n                        now,\n                        lastReplayEndHandledAt,\n                        dedupeWindowMs: REPLAY_END_DEDUPE_MS\n                    });\n                    return;\n                }\n                lastReplayEndHandledAt = now;\n\n                if (!replaySessionActive) {\n                    return;\n                }\n                if (replayExitHandledSequenceId === replaySequenceId) {\n                    return;\n                }\n                replayExitHandledSequenceId = replaySequenceId;\n                replaySessionActive = false;\n                if (replayStartedAt > 0) {\n                    const measuredReplayDurationMs = now - replayStartedAt;\n                    const measuredReplayDurationSeconds = Number((measuredReplayDurationMs / 1000).toFixed(3));\n                    console.log('[ReplayTiming] replay ended', {\n                        sequenceId: replaySequenceId,\n                        measuredReplayDurationMs,\n                        measuredReplayDurationSeconds,\n                        fixedReplayDurationMs\n                    });\n                }\n                replayStartedAt = 0;\n                setOverlayScene("game");\n                return;\n            }\n\n            if (eventName === "MatchEnded") {\n                setOverlayScene("postGame");\n                updateView();\n                return;\n            }\n\n            if (eventName === "MatchDestroyed") {\n                replaySessionActive = false;\n                if (replayIntroTimer) {\n                    clearTimeout(replayIntroTimer);\n                    replayIntroTimer = null;\n                }\n                replayExitHandledSequenceId = -1;\n                replayStartedAt = 0;\n                transitionPlaying = false;\n                lastReplayEndHandledAt = 0;\n                gameState.lastScoringTeam = 0;\n                gameState.replayScorerName = 'SCORER NAME';\n                gameState.replayAssisterName = 'ASSISTER NAME';\n                gameState.replayHasAssister = true;\n                gameState.replayBallKph = '0 KPH';\n                gameState.blueScore = 0;\n                gameState.orangeScore = 0;\n                gameState.blueWins = 0;\n                gameState.orangeWins = 0;\n                gameState.spectatedTeam = 0;\n                gameState.timeSeconds = 300;\n                gameState.overtime = false;\n                syncPlayerCardSlotVisibility([], []);\n                syncSpectatedVisibility('');\n                setOverlayScene("game");\n                updateView();\n                return;\n            }\n\n            if (eventName !== "UpdateState") {\n                return;\n            }\n\n            const game = data?.Game || {};\n            const teams = Array.isArray(game?.Teams) ? game.Teams : [];\n            const targetName = String(game?.Target?.Name || '').trim();\n            const previousBlueScore = gameState.blueScore;\n            const previousOrangeScore = gameState.orangeScore;\n\n            teams.forEach((team) => {\n                if (team?.TeamNum === 0) {\n                    gameState.blueName = abbreviationFallback(team?.Name, "BLUE TEAM");\n                    gameState.blueScore = Number.isFinite(Number(team?.Score)) ? Number(team.Score) : 0;\n                    gameState.blueWins = Number.isFinite(Number(team?.SeriesWins))\n                        ? Number(team.SeriesWins)\n                        : (Number.isFinite(Number(team?.MatchWins)) ? Number(team.MatchWins) : gameState.blueWins);\n                }\n\n                if (team?.TeamNum === 1) {\n                    gameState.orangeName = abbreviationFallback(team?.Name, "ORANGE TEAM");\n                    gameState.orangeScore = Number.isFinite(Number(team?.Score)) ? Number(team.Score) : 0;\n                    gameState.orangeWins = Number.isFinite(Number(team?.SeriesWins))\n                        ? Number(team.SeriesWins)\n                        : (Number.isFinite(Number(team?.MatchWins)) ? Number(team.MatchWins) : gameState.orangeWins);\n                }\n            });\n\n            gameState.timeSeconds = Number.isFinite(Number(game?.TimeSeconds)) ? Number(game.TimeSeconds) : gameState.timeSeconds;\n            gameState.overtime = Boolean(game?.bOvertime);\n\n            if (gameState.blueScore > previousBlueScore) {\n                gameState.lastScoringTeam = 0;\n            } else if (gameState.orangeScore > previousOrangeScore) {\n                gameState.lastScoringTeam = 1;\n            }\n\n            const players = Array.isArray(data?.Players) ? data.Players : [];\n            const bluePlayers = players\n                .filter((player) => Number(player?.TeamNum) === 0)\n                .sort((a, b) => String(a?.Name || "").localeCompare(String(b?.Name || "")));\n            const orangePlayers = players\n                .filter((player) => Number(player?.TeamNum) === 1)\n                .sort((a, b) => String(a?.Name || "").localeCompare(String(b?.Name || "")));\n\n            syncPlayerCardSlotVisibility(bluePlayers, orangePlayers);\n\n            const spectated = targetName\n                ? (players.find((player) => String(player?.Name || '').trim().toLowerCase() === targetName.toLowerCase()) || null)\n                : null;\n\n            if (spectated) {\n                const specTeamBlue = Number(spectated?.TeamNum) === 0;\n                const specColor = specTeamBlue ? "var(--blue-color)" : "var(--orange-color)";\n                gameState.spectatedTeam = specTeamBlue ? 0 : 1;\n                const specName = String(spectated?.Name || "SPECTATED PLAYER");\n                const specBoost = Number.isFinite(Number(spectated?.Boost)) ? Math.max(0, Math.min(100, Number(spectated.Boost))) : 0;\n\n                document.querySelectorAll('[data-item-role="spectated-player-card"]').forEach((card) => {\n                    const nameEl = card.querySelector('.spec-name');\n                    const boostTextEl = card.querySelector('.spec-boost-text');\n                    const boostFillEl = card.querySelector('.spec-boost-fill');\n                    const goalsEl = card.querySelector('.spec-stat[data-stat="goals"]');\n                    const shotsEl = card.querySelector('.spec-stat[data-stat="shots"]');\n                    const assistsEl = card.querySelector('.spec-stat[data-stat="assists"]');\n                    const savesEl = card.querySelector('.spec-stat[data-stat="saves"]');\n                    const demosEl = card.querySelector('.spec-stat[data-stat="demos"]');\n                    const node = card.closest('.overlay-node');\n                    const colorMode = String(node?.dataset?.colorMode || 'default').toLowerCase();\n                    const colorCustom = String(node?.dataset?.colorCustom || '').trim();\n                    const scoringTeamColor = Number(gameState.lastScoringTeam) === 1 ? 'var(--orange-color)' : 'var(--blue-color)';\n                    const winningTeamColor = gameState.blueScore > gameState.orangeScore\n                        ? 'var(--blue-color)'\n                        : (gameState.orangeScore > gameState.blueScore ? 'var(--orange-color)' : '#FFFFFF');\n                    const useColor = colorMode === 'custom'\n                        ? (/^#[0-9a-fA-F]{6}$/.test(colorCustom) ? colorCustom : '#FFFFFF')\n                        : (colorMode === 'scoringteam'\n                            ? scoringTeamColor\n                            : (colorMode === 'winningteam'\n                                ? winningTeamColor\n                                : ((colorMode === 'team1' || colorMode === 'team2' || colorMode === 'spectated') ? specColor : '#FFFFFF')));\n                    if (nameEl) nameEl.textContent = specName;\n                    if (boostTextEl) boostTextEl.textContent = String(Math.round(specBoost));\n                    if (boostFillEl) boostFillEl.style.width = specBoost + '%';\n                    if (goalsEl) goalsEl.textContent = 'GOALS ' + String(Number.isFinite(Number(spectated?.Goals)) ? Number(spectated.Goals) : 0);\n                    if (shotsEl) shotsEl.textContent = 'SHOTS ' + String(Number.isFinite(Number(spectated?.Shots)) ? Number(spectated.Shots) : 0);\n                    if (assistsEl) assistsEl.textContent = 'ASSISTS ' + String(Number.isFinite(Number(spectated?.Assists)) ? Number(spectated.Assists) : 0);\n                    if (savesEl) savesEl.textContent = 'SAVES ' + String(Number.isFinite(Number(spectated?.Saves)) ? Number(spectated.Saves) : 0);\n                    if (demosEl) demosEl.textContent = 'DEMOS ' + String(Number.isFinite(Number(spectated?.Demos)) ? Number(spectated.Demos) : 0);\n                    card.style.setProperty('--item-color', useColor);\n                });\n\n                document.querySelectorAll('[data-item-role="spectated-player-boost"]').forEach((card) => {\n                    const fill = card.querySelector('.spec-wheel-fill');\n                    const value = card.querySelector('.spec-wheel-value');\n                    if (value) value.textContent = String(Math.round(specBoost));\n                    if (fill) fill.style.setProperty('--boost', String(specBoost));\n                    card.style.setProperty('--item-color', specColor);\n                });\n            } else {\n                gameState.spectatedTeam = 0;\n            }\n\n            syncSpectatedVisibility(targetName);\n\n            for (let slot = 1; slot <= 3; slot += 1) {\n                const blue = bluePlayers[slot - 1] || null;\n                const orange = orangePlayers[slot - 1] || null;\n                const hasBluePlayer = hasPlayerSlotData(blue);\n                const hasOrangePlayer = hasPlayerSlotData(orange);\n\n                if (!hasBluePlayer && !hasOrangePlayer) {\n                    continue;\n                }\n\n                if (hasBluePlayer) {\n                    document.querySelectorAll('[data-item-role="player-card-blue-' + slot + '"]').forEach((card) => {\n                        const nameEl = card.querySelector('.pc-name');\n                        const boostEl = card.querySelector('.pc-boost');\n                        const fillEl = card.querySelector('.pc-boost-fill');\n                        const boost = Number.isFinite(Number(blue?.Boost)) ? Math.max(0, Math.min(100, Number(blue.Boost))) : 0;\n                        if (nameEl) nameEl.textContent = String(blue?.Name || ('BLUE ' + slot));\n                        if (boostEl) boostEl.textContent = String(Math.round(boost));\n                        if (fillEl) fillEl.style.width = boost + '%';\n                    });\n                }\n\n                if (hasOrangePlayer) {\n                    document.querySelectorAll('[data-item-role="player-card-orange-' + slot + '"]').forEach((card) => {\n                        const nameEl = card.querySelector('.pc-name');\n                        const boostEl = card.querySelector('.pc-boost');\n                        const fillEl = card.querySelector('.pc-boost-fill');\n                        const boost = Number.isFinite(Number(orange?.Boost)) ? Math.max(0, Math.min(100, Number(orange.Boost))) : 0;\n                        if (nameEl) nameEl.textContent = String(orange?.Name || ('ORANGE ' + slot));\n                        if (boostEl) boostEl.textContent = String(Math.round(boost));\n                        if (fillEl) fillEl.style.width = boost + '%';\n                    });\n                }\n            }\n\n            updateView();\n        });\n\n        syncPlayerCardSlotVisibility([], []);\n        syncSpectatedVisibility('');\n        setOverlayScene("game");\n        updateView();\n    <\/script>\n</body>\n</html>`;
}

function sanitizeOverlayName(rawName) {
  return String(rawName || "").trim().replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function listOverlaysFromDirectory(baseDir, source) {
  if (!fs.existsSync(baseDir)) return [];
  const folders = fs.readdirSync(baseDir), overlays = [];
  for (const folder of folders) {
    const overlayDir = path.join(baseDir, folder), overlayHtml = path.join(overlayDir, "overlay.html");
    fs.statSync(overlayDir).isDirectory() && fs.existsSync(overlayHtml) && overlays.push({
      name: folder,
      path: folder,
      folderName: folder,
      source: source
    });
  }
  return overlays;
}

function listAllOverlays() {
  const bundled = listOverlaysFromDirectory(getBundledOverlaysDir(), "bundled"), custom = listOverlaysFromDirectory(getCustomOverlaysDir(), "custom"), usedPaths = new Set, result = [];
  return bundled.sort((a, b) => a.name.localeCompare(b.name)).forEach(overlay => {
    usedPaths.add(overlay.path), result.push(overlay);
  }), custom.sort((a, b) => a.name.localeCompare(b.name)).forEach(overlay => {
    let uniquePath = overlay.path, suffix = 2;
    for (;usedPaths.has(uniquePath); ) uniquePath = `${overlay.path}-${suffix}`, suffix += 1;
    usedPaths.add(uniquePath), result.push({
      ...overlay,
      path: uniquePath
    });
  }), result;
}

function resolveCustomOverlayFolderByUiPath(overlayPath) {
  const entry = listAllOverlays().find(overlay => overlay.path === String(overlayPath || ""));
  if (!entry || "custom" !== entry.source) return null;
  const folderName = entry.folderName || entry.name, fullPath = path.join(getCustomOverlaysDir(), folderName);
  return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory() ? {
    folderName: folderName,
    fullPath: fullPath
  } : null;
}

function notifyOverlayLibraryUpdated() {
  relaySocket && relaySocket.writable && relaySocket.write(JSON.stringify({
    type: "overlay-library-updated"
  }) + "\n");
}

function importOverlayDirectory(selectedDir) {
  const overlayFile = path.join(selectedDir, "overlay.html");
  if (!fs.existsSync(overlayFile)) throw new Error("Selected folder must contain overlay.html");
  const customOverlaysDir = getCustomOverlaysDir();
  fs.mkdirSync(customOverlaysDir, {
    recursive: !0
  });
  const baseName = sanitizeOverlayName(path.basename(selectedDir));
  if (!baseName) throw new Error("Overlay folder name is not valid");
  let targetName = baseName, suffix = 2;
  for (listOverlaysFromDirectory(getBundledOverlaysDir(), "bundled").some(overlay => overlay.name.toLowerCase() === targetName.toLowerCase()) && (targetName = `${baseName}-custom`); fs.existsSync(path.join(customOverlaysDir, targetName)) || listOverlaysFromDirectory(getBundledOverlaysDir(), "bundled").some(overlay => overlay.name.toLowerCase() === targetName.toLowerCase()); ) targetName = `${baseName}-${suffix}`, 
  suffix += 1;
  const targetDir = path.join(customOverlaysDir, targetName);
  return fs.cpSync(selectedDir, targetDir, {
    recursive: !0
  }), {
    name: targetName,
    path: targetName,
    source: "custom"
  };
}

// Async: server.js is require()'d directly in-process (not spawned as a
// separate process) and now binds its ports with a fallback instead of
// crashing on EADDRINUSE, so a second copy of the app can run at the same
// time -- but that means the real ports aren't known until server.js's own
// startup promise resolves, which this awaits before anything (the
// windows, the relay connection) tries to use them.
async function startServer() {
  try {
    const appPath = app.getAppPath();
    process.env.APP_PATH = appPath, process.env.USER_DATA_PATH = app.getPath("userData");
    const logPath = path.join(app.getPath("userData"), "rocket-cast-main.log"), logStream = fs.createWriteStream(logPath, {
      flags: "a"
    });
    for (const method of [ "log", "warn", "error" ]) {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        const line = args.map(value => {
          if (value instanceof Error) return value.stack || value.message;
          if ("string" == typeof value) return value;
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        }).join(" ");
        logStream.write(`[${(new Date).toISOString()}] [${method}] ${line}\n`), original(...args);
      };
    }
    const serverInfo = await require("./server.js");
    if (serverInfo?.error) return console.error("server.js failed to start:", serverInfo.error), !1;
    serverInfo?.controlPort && (resolvedControlPort = serverInfo.controlPort), serverInfo?.ipcPort && (resolvedIpcPort = serverInfo.ipcPort),
    setTimeout(() => {
      connectToRelay();
    }, 1e3);
    return !0;
  } catch (err) {
    return console.error("Failed to start server:", err), !1;
  }
}

function connectToRelay() {
  relaySocket && relaySocket.writable || relayConnectInFlight || (relayConnectInFlight = !0,
  relaySocket = net.createConnection({
    host: "127.0.0.1",
    port: resolvedIpcPort
  }), relaySocket.on("connect", () => {
    for (relayConnectInFlight = !1, console.log("✓ Main process connected to relay for emitting events"); relayPendingCommands.length && relaySocket && relaySocket.writable; ) {
      const nextCommand = relayPendingCommands.shift();
      relaySocket.write(nextCommand + "\n");
    }
  }), relaySocket.on("error", err => {
    relayConnectInFlight = !1, console.log("Relay emit connection error:", err.message);
  }), relaySocket.on("close", () => {
    relayConnectInFlight = !1;
  }));
}

function createMainWindow() {
  const appPath = app.getAppPath(), forceWelcome = process.argv.includes("--show-welcome");
  return mainWindow && !mainWindow.isDestroyed() || (mainWindow = new BrowserWindow({
    title: "Rocket Cast",
    width: 900,
    height: 840,
    autoHideMenuBar: !0,
    webPreferences: {
      preload: path.join(appPath, "preload.js")
    }
  }), mainWindow.setMenuBarVisibility(!1), mainWindow.setMenu(null), mainWindow.on("closed", () => {
    mainWindow = null, app.isQuitting || (app.isQuitting = !0, app.quit());
  }), mainWindow.webContents.on("will-prevent-unload", event => {
    0 === dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      buttons: [ "Leave", "Stay" ],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved changes",
      message: "You have unsaved changes in the Overlay Builder.",
      detail: "If you leave now, those changes will be lost."
    }) && event.preventDefault();
  }), mainWindow.loadURL(`http://127.0.0.1:${resolvedControlPort}/control` + (forceWelcome ? "?showWelcome=1" : ""))),
  mainWindow;
}

function createWarmupWindow() {
  warmupWindow && !warmupWindow.isDestroyed() || (warmupWindow = new BrowserWindow({
    show: !1,
    width: 1,
    height: 1,
    useContentSize: !0,
    skipTaskbar: !0,
    webPreferences: {
      backgroundThrottling: !1,
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !0
    }
  }), warmupWindow.on("closed", () => {
    warmupWindow = null;
  }), warmupWindow.webContents.once("did-finish-load", () => {
    warmupWindow && !warmupWindow.isDestroyed() && setTimeout(() => {
      warmupWindow && !warmupWindow.isDestroyed() && warmupWindow.close();
    }, 0);
  }), warmupWindow.loadURL(`http://127.0.0.1:${resolvedControlPort}`));
}

function createBrowserSourceWindow() {
  if (browserSourceWindow && !browserSourceWindow.isDestroyed()) return;
  const appPath = app.getAppPath();
  browserSourceWindow = new BrowserWindow({
    title: "Rocket Cast Browser Source",
    width: 1920,
    height: 1080,
    x: -2e3,
    y: 0,
    frame: !1,
    transparent: !0,
    resizable: !1,
    movable: !1,
    focusable: !1,
    skipTaskbar: !0,
    show: !1,
    paintWhenInitiallyHidden: !0,
    webPreferences: {
      preload: path.join(appPath, "preload.js"),
      backgroundThrottling: !1,
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !0
    }
  });
  try {
    browserSourceWindow.setIgnoreMouseEvents(!0, {
      forward: !1
    });
  } catch {}
  browserSourceWindow.on("closed", () => {
    browserSourceWindow = null;
  }), browserSourceWindow.loadURL(`http://127.0.0.1:${resolvedControlPort}/browser-source`);
}

// Keybinds are intentionally simple: Electron's globalShortcut is the only
// mechanism (needed so a combo works while OBS/the game has focus, not just
// Rocket Cast), and a match sends straight to the main window's renderer,
// which decides synchronously whether to ignore it (e.g. a text field is
// focused) — no round-trip back into the page to ask first. That earlier
// round-trip (an async executeJavaScript before every send) was pure added
// latency on every keypress for no real benefit.
function normalizeAccelerator(rawCombo) {
  const combo = String(rawCombo || "").trim();
  if (!combo) return "";
  const parts = combo.split("+").map(part => String(part || "").trim()).filter(Boolean);
  if (!parts.length) return "";
  const modifiers = [];
  let key = "";
  parts.forEach(part => {
    const lower = part.toLowerCase();
    if ("ctrl" === lower || "control" === lower || "cmdorctrl" === lower || "commandorcontrol" === lower) return void (modifiers.includes("CommandOrControl") || modifiers.push("CommandOrControl"));
    if ("alt" === lower || "option" === lower) return void (modifiers.includes("Alt") || modifiers.push("Alt"));
    if ("shift" === lower) return void (modifiers.includes("Shift") || modifiers.push("Shift"));
    if ("meta" === lower || "cmd" === lower || "command" === lower || "super" === lower) return void (modifiers.includes("Super") || modifiers.push("Super"));
    key || (key = { space: "Space", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right" }[lower] || (1 === part.length || /^f\d{1,2}$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)));
  });
  // A global shortcut with no modifier steals that key from every other
  // app system-wide, including normal typing — never allow that.
  return key && modifiers.length ? [ ...modifiers, key ].join("+") : "";
}

function clearRegisteredGlobalKeybinds() {
  registeredGlobalKeybindAccelerators.forEach(accelerator => {
    try {
      globalShortcut.unregister(accelerator);
    } catch {}
  }), registeredGlobalKeybindAccelerators = [];
}

function registerGlobalKeybindsFromMap(keybindMap) {
  if (clearRegisteredGlobalKeybinds(), !keybindMap || "object" != typeof keybindMap) return {
    ok: !0,
    registered: [],
    failed: []
  };
  const registrations = [], failures = [], seenAccelerators = new Map;
  Object.entries(keybindMap).forEach(([actionId, combo]) => {
    const rawCombo = String(combo || "").trim();
    if (!rawCombo) return;
    const accelerator = normalizeAccelerator(combo);
    if (!accelerator) return void failures.push({
      actionId: actionId,
      combo: rawCombo,
      reason: "unrecognized"
    });
    if (seenAccelerators.has(accelerator)) return void failures.push({
      actionId: actionId,
      combo: rawCombo,
      reason: "duplicate",
      conflictsWith: seenAccelerators.get(accelerator)
    });
    try {
      const ok = globalShortcut.register(accelerator, () => {
        mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send("global-keybind-action", { actionId: actionId });
      });
      ok ? (seenAccelerators.set(accelerator, actionId), registeredGlobalKeybindAccelerators.push(accelerator),
      registrations.push({
        actionId: actionId,
        accelerator: accelerator
      })) : (log.warn(`Keybind registration failed (likely already in use by another application): ${actionId} -> ${accelerator}`),
      failures.push({
        actionId: actionId,
        combo: rawCombo,
        reason: "in-use"
      }));
    } catch (error) {
      log.warn(`Keybind registration threw for ${actionId} -> ${accelerator}: ${error?.message || error}`),
      failures.push({
        actionId: actionId,
        combo: rawCombo,
        reason: "error"
      });
    }
  });
  return {
    ok: !0,
    registered: registrations,
    failed: failures
  };
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  // Downloads happen silently in the background as soon as an update is
  // found -- the only prompt the user sees is once it's actually ready to
  // install (see "update-downloaded" below).
  autoUpdater.logger = log, autoUpdater.autoDownload = !0, autoUpdater.autoInstallOnAppQuit = !0,
  autoUpdater.allowPrerelease = !1, autoUpdater.on("checking-for-update", () => {
    console.log("Updater: checking for update");
  }), autoUpdater.on("update-available", info => {
    console.log("Updater: update available, downloading in background", info?.version || "unknown");
  }), autoUpdater.on("update-not-available", () => {
    console.log("Updater: no update available");
  }), autoUpdater.on("error", err => {
    console.log("Updater error:", err?.message || err);
  }), autoUpdater.on("update-downloaded", async info => {
    0 === (await dialog.showMessageBox({
      type: "info",
      buttons: [ "Install now", "Later" ],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Rocket Cast ${info?.version || ""} is ready to install.`
    })).response && autoUpdater.quitAndInstall();
  });
  const runBackgroundUpdateCheck = async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      console.log("Background update check failed:", err?.message || err);
    }
  };
  setTimeout(runBackgroundUpdateCheck, 5e3);
  const updateInterval = setInterval(runBackgroundUpdateCheck, 36e5);
  updateInterval.unref?.();
}

ipcMain.handle("check-for-updates", async () => {
  if (!app.isPackaged) return {
    ok: !0,
    available: !1,
    message: "Update checks are only available in packaged builds"
  };
  try {
    const currentVersion = app.getVersion(), result = await autoUpdater.checkForUpdates(), updateVersion = result?.updateInfo?.version || "", available = Boolean(updateVersion) && updateVersion !== currentVersion;
    return log.info(`Updater: check-for-updates currentVersion=${currentVersion} foundVersion=${updateVersion || "(none)"} available=${available}`),
    {
      ok: !0,
      available: available,
      version: available ? updateVersion : currentVersion,
      message: available ? `Version ${updateVersion} is available and downloading now. You'll get a prompt to install once it's ready.` : updateVersion ? `You're on the latest version! (v${currentVersion}, latest published: v${updateVersion})` : `You're on the latest version! (v${currentVersion}, no release info returned)`
    };
  } catch (err) {
    return {
      ok: !1,
      message: err?.message || "Failed to check for updates"
    };
  }
}), ipcMain.handle("get-app-version", async () => ({
  ok: !0,
  version: app.getVersion()
})), ipcMain.handle("open-external-url", async (event, rawUrl) => {
  const url = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) return {
    ok: !1,
    error: "Invalid URL"
  };
  try {
    return await shell.openExternal(url), {
      ok: !0
    };
  } catch (error) {
    return {
      ok: !1,
      error: error?.message || "Unable to open link"
    };
  }
}), ipcMain.handle("get-overlays", () => listAllOverlays()), ipcMain.handle("list-capture-sources", async (event, options = {}) => {
  const allowedTypes = (Array.isArray(options?.types) ? options.types : [ "window" ]).filter(type => "window" === type || "screen" === type), types = allowedTypes.length ? allowedTypes : [ "window" ];
  return (await desktopCapturer.getSources({
    types: types,
    thumbnailSize: {
      width: 0,
      height: 0
    },
    fetchWindowIcons: !0
  })).map(source => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id || "",
    appIconDataUrl: source.appIcon && "function" == typeof source.appIcon.toDataURL ? source.appIcon.toDataURL() : ""
  }));
}), ipcMain.handle("import-overlay-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select an overlay folder",
    properties: [ "openDirectory" ]
  });
  if (result.canceled || !result.filePaths?.length) return {
    canceled: !0
  };
  try {
    const importedOverlay = importOverlayDirectory(result.filePaths[0]);
    return notifyOverlayLibraryUpdated(), {
      canceled: !1,
      overlay: importedOverlay
    };
  } catch (err) {
    return {
      canceled: !1,
      error: err?.message || "Failed to import overlay"
    };
  }
}), ipcMain.handle("pick-media-storage-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a folder for match clips & highlight reels",
    properties: [ "openDirectory", "createDirectory" ]
  });
  return result.canceled || !result.filePaths?.length ? {
    canceled: !0
  } : {
    canceled: !1,
    path: result.filePaths[0]
  };
}), ipcMain.handle("open-custom-overlays-folder", async () => {
  const customOverlaysDir = ensureCustomOverlaysDir(), openError = await shell.openPath(customOverlaysDir);
  return openError ? {
    ok: !1,
    error: openError,
    path: customOverlaysDir
  } : {
    ok: !0,
    path: customOverlaysDir
  };
}), ipcMain.handle("list-builder-projects", () => getBuilderProjects()), ipcMain.handle("pick-builder-project", async () => {
  const customOverlaysDir = ensureCustomOverlaysDir(), result = await dialog.showOpenDialog({
    title: "Choose Builder Overlay Folder",
    defaultPath: customOverlaysDir,
    properties: [ "openDirectory" ]
  });
  if (result.canceled || !result.filePaths?.length) return {
    canceled: !0
  };
  const selectedPath = result.filePaths[0], selectedName = path.basename(selectedPath), metadataPath = getBuilderMetadataPath(selectedPath);
  if (!fs.existsSync(metadataPath)) return {
    canceled: !1,
    error: "Selected folder is not a Builder project"
  };
  const chosen = getBuilderProjects().find(project => project.path === selectedName);
  return chosen ? {
    canceled: !1,
    project: chosen
  } : {
    canceled: !1,
    error: "Selected project could not be loaded"
  };
}), ipcMain.handle("upload-builder-image", async (event, payload) => {
  const {projectDir: projectDir, projectPath: projectPath} = resolveBuilderProjectDir(payload?.path), result = await dialog.showOpenDialog({
    title: "Choose Image",
    properties: [ "openFile" ],
    filters: [ {
      name: "Images",
      extensions: [ "png", "jpg", "jpeg", "gif", "webp", "svg" ]
    } ]
  });
  if (result.canceled || !result.filePaths?.length) return {
    canceled: !0
  };
  const sourceFile = result.filePaths[0], ext = path.extname(sourceFile).toLowerCase(), safeExt = ext || ".png", targetDir = path.join(projectDir, "assets");
  fs.mkdirSync(targetDir, {
    recursive: !0
  });
  const fileName = `${sanitizeOverlayName(path.basename(sourceFile, ext)) || "image"}-${Date.now()}${safeExt}`, targetFile = path.join(targetDir, fileName);
  return fs.copyFileSync(sourceFile, targetFile), {
    canceled: !1,
    src: `assets/${fileName}`,
    projectPath: projectPath
  };
}), ipcMain.handle("upload-builder-transition", async (event, payload) => {
  const {projectDir: projectDir, projectPath: projectPath} = resolveBuilderProjectDir(payload?.path), result = await dialog.showOpenDialog({
    title: "Choose Transition Video",
    properties: [ "openFile" ],
    filters: [ {
      name: "Video",
      extensions: [ "webm", "mp4", "mov", "m4v" ]
    } ]
  });
  if (result.canceled || !result.filePaths?.length) return {
    canceled: !0
  };
  const sourceFile = result.filePaths[0], ext = path.extname(sourceFile).toLowerCase(), safeExt = ext || ".webm", targetDir = path.join(projectDir, "assets", "transitions");
  fs.mkdirSync(targetDir, {
    recursive: !0
  });
  const fileName = `${sanitizeOverlayName(path.basename(sourceFile, ext)) || "transition"}-${Date.now()}${safeExt}`, targetFile = path.join(targetDir, fileName);
  return fs.copyFileSync(sourceFile, targetFile), {
    canceled: !1,
    src: `assets/transitions/${fileName}`,
    projectPath: projectPath
  };
}), ipcMain.handle("upload-builder-font", async (event, payload) => {
  const {projectDir: projectDir, projectPath: projectPath} = resolveBuilderProjectDir(payload?.path), result = await dialog.showOpenDialog({
    title: "Choose Font",
    properties: [ "openFile" ],
    filters: [ {
      name: "Fonts",
      extensions: [ "ttf", "otf", "woff", "woff2" ]
    } ]
  });
  if (result.canceled || !result.filePaths?.length) return {
    canceled: !0
  };
  const sourceFile = result.filePaths[0], ext = path.extname(sourceFile).toLowerCase(), safeExt = ext || ".ttf", targetDir = path.join(projectDir, "assets", "fonts");
  fs.mkdirSync(targetDir, {
    recursive: !0
  });
  const baseName = sanitizeOverlayName(path.basename(sourceFile, ext)) || "font", fileName = `${baseName}-${Date.now()}${safeExt}`, targetFile = path.join(targetDir, fileName);
  return fs.copyFileSync(sourceFile, targetFile), {
    canceled: !1,
    family: baseName.replace(/[-_]/g, " ").trim() || "Custom Font",
    src: `assets/fonts/${fileName}`,
    projectPath: projectPath
  };
}), ipcMain.handle("create-builder-project", (event, rawName) => {
  const projectFolder = resolveUniqueOverlayFolder(toSafeFolderName(rawName)), customOverlaysDir = ensureCustomOverlaysDir(), projectDir = path.join(customOverlaysDir, projectFolder), nowIso = (new Date).toISOString(), layout = getDefaultBuilderLayout();
  return fs.mkdirSync(projectDir, {
    recursive: !0
  }), fs.writeFileSync(getBuilderMetadataPath(projectDir), JSON.stringify({
    name: projectFolder,
    createdAt: nowIso,
    updatedAt: nowIso,
    layout: layout
  }, null, 2), "utf-8"), fs.writeFileSync(path.join(projectDir, "overlay.html"), generateBuilderOverlayHtml(projectFolder, layout, projectFolder, projectDir), "utf-8"), 
  notifyOverlayLibraryUpdated(), {
    name: projectFolder,
    path: projectFolder,
    layout: layout
  };
}), ipcMain.handle("save-builder-project", (event, payload) => {
  const {projectPath: projectPath, projectDir: projectDir} = resolveBuilderProjectDir(payload?.path), metadataPath = getBuilderMetadataPath(projectDir), existing = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, "utf-8")) : {}, layout = sanitizeBuilderLayout(payload?.layout), nowIso = (new Date).toISOString(), projectName = existing?.name || projectPath;
  return fs.writeFileSync(metadataPath, JSON.stringify({
    name: projectName,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    layout: layout
  }, null, 2), "utf-8"), fs.writeFileSync(path.join(projectDir, "overlay.html"), generateBuilderOverlayHtml(projectName, layout, projectPath, projectDir), "utf-8"), 
  notifyOverlayLibraryUpdated(), {
    ok: !0,
    name: projectName,
    path: projectPath,
    layout: layout
  };
}), ipcMain.handle("launch-overlay", (event, overlayName) => {
  const command = JSON.stringify({
    type: "overlay-change",
    overlayName: overlayName
  });
  return relaySocket && relaySocket.writable ? relaySocket.write(command + "\n") : (relayPendingCommands.push(command), 
  console.log("Relay not connected, reconnecting..."), connectToRelay()), console.log("🎯 Emitted overlay change:", overlayName), 
  {
    ok: !0
  };
}), ipcMain.handle("set-global-keybinds", (event, keybindMap) => registerGlobalKeybindsFromMap(keybindMap));

const RL_STATS_INI_FILENAMES = [ "DefaultStatsAPI.ini", "TAStatsAPI.ini" ], RL_STATS_INI_RELATIVE_PATH = [ "Documents", "My Games", "Rocket League", "TAGame", "Config" ], RL_MIN_PACKET_SEND_RATE = 120;

function buildRlStatsConfigCandidateDirs() {
  const dirs = [], seen = new Set, addCandidate = homeDir => {
    homeDir && [ path.join(homeDir, ...RL_STATS_INI_RELATIVE_PATH), path.join(homeDir, "OneDrive", ...RL_STATS_INI_RELATIVE_PATH) ].forEach(dir => {
      seen.has(dir) || (seen.add(dir), dirs.push(dir));
    });
  };
  addCandidate(os.homedir());
  try {
    const usersRoot = path.dirname(os.homedir());
    fs.readdirSync(usersRoot, {
      withFileTypes: !0
    }).forEach(entry => {
      entry.isDirectory() && addCandidate(path.join(usersRoot, entry.name));
    });
  } catch {}
  return dirs;
}

function findRocketLeagueStatsIniFile() {
  for (const dir of buildRlStatsConfigCandidateDirs()) for (const filename of RL_STATS_INI_FILENAMES) {
    const fullPath = path.join(dir, filename);
    try {
      if (fs.statSync(fullPath).isFile()) return fullPath;
    } catch {}
  }
  return null;
}

function ensureRocketLeaguePacketSendRate(filePath) {
  const content = fs.readFileSync(filePath, "utf8"), lineMatch = content.match(/^([ \t]*PacketSendRate[ \t]*=[ \t]*)(\S*)([ \t]*)$/im), previousValue = lineMatch ? Number(lineMatch[2]) : null;
  if (lineMatch && Number.isFinite(previousValue) && previousValue >= RL_MIN_PACKET_SEND_RATE) return {
    changed: !1,
    previousValue: previousValue
  };
  let updated;
  return updated = lineMatch ? content.replace(/^([ \t]*PacketSendRate[ \t]*=[ \t]*)(\S*)([ \t]*)$/im, "$1120$3") : content + (content.length && !content.endsWith("\n") ? "\n" : "") + "PacketSendRate=120\n", 
  fs.writeFileSync(filePath, updated, "utf8"), {
    changed: !0,
    previousValue: previousValue
  };
}

ipcMain.handle("check-rl-stats-config", async () => {
  try {
    const filePath = findRocketLeagueStatsIniFile();
    if (!filePath) return {
      ok: !0,
      found: !1
    };
    const result = ensureRocketLeaguePacketSendRate(filePath);
    return {
      ok: !0,
      found: !0,
      path: filePath,
      changed: result.changed,
      previousValue: result.previousValue
    };
  } catch (error) {
    return {
      ok: !1,
      error: error.message
    };
  }
}), app.whenReady().then(async () => {
  if (Menu.setApplicationMenu(null), !enforcePackagedRuntimeHardening()) return void app.exit(1);
  // Windows can't load anything until server.js has actually finished
  // binding its ports (see startServer()/resolvedControlPort above) -- this
  // wait is what makes a second running copy of the app come up correctly
  // on its own fallback port instead of a blank window pointed at :3000.
  await startServer(), createWarmupWindow(), createBrowserSourceWindow(), createMainWindow(), setupAutoUpdater();
}), app.on("before-quit", () => {
  app.isQuitting = !0, clearRegisteredGlobalKeybinds(), globalShortcut.unregisterAll(), 
  mainWindow && !mainWindow.isDestroyed() && mainWindow.destroy(), warmupWindow && !warmupWindow.isDestroyed() && warmupWindow.destroy(), 
  browserSourceWindow && !browserSourceWindow.isDestroyed() && browserSourceWindow.destroy(), 
  relaySocket && relaySocket.destroy();
}), app.on("window-all-closed", () => {
  app.isQuitting || (app.isQuitting = !0, app.quit());
}), ipcMain.handle("delete-custom-overlay", async (event, overlayPath) => {
  const resolved = resolveCustomOverlayFolderByUiPath(overlayPath);
  if (!resolved) return {
    ok: !1,
    error: "Selected overlay could not be deleted"
  };
  try {
    return fs.rmSync(resolved.fullPath, {
      recursive: !0,
      force: !0
    }), notifyOverlayLibraryUpdated(), {
      ok: !0,
      name: resolved.folderName
    };
  } catch (err) {
    return {
      ok: !1,
      error: err?.message || "Failed to delete overlay"
    };
  }
});