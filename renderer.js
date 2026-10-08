(() => {
  const TEAM_FIELDS = [ "blue-name", "orange-name", "blue-abbr", "orange-abbr", "blue-color", "orange-color", "series-length", "blue-wins", "orange-wins", "header-text", "header-text-full" ];
  const OVERLAY_ELEMENT_TOGGLES = [ { id: "overlay-toggle-scoreboard", key: "hideScoreboard" }, { id: "overlay-toggle-boost-wheel", key: "hideBoostWheel" }, { id: "overlay-toggle-bottom-player-card", key: "hideBottomPlayerCard" }, { id: "overlay-toggle-side-player-cards", key: "hideSidePlayerCards" } ];
  // Simple on/off camera options: saved per machine and sent to the overlay.
  const CAMERA_OPTION_TOGGLES = [ { id: "camera-disable-bottom", key: "disableBottomCams", storageKey: "cameraDisableBottom" }, { id: "camera-hide-names", key: "hideCameraNames", storageKey: "cameraHideNames" } ];
  const DEFAULT_BASE_COLORS = { name: "", blue: "#21afd7", orange: "#fd5b00" };
  let socket = null, pendingOverrideSync = !1, inputPublishQueued = !1, cameraPremiumEnabled = !1;
  function getElement(id) {
    return document.getElementById(id);
  }
  function setValue(id, value) {
    const element = getElement(id);
    element && (element.value = value);
  }
  function setChecked(id, checked) {
    const element = getElement(id);
    element && (element.checked = !!checked);
  }
  function isOverlayElementVisible(id) {
    const element = getElement(id);
    return !element || element.checked;
  }
  function persistOverlayElementToggles() {
    const payload = {};
    OVERLAY_ELEMENT_TOGGLES.forEach(({id: id, key: key}) => {
      payload[key] = !isOverlayElementVisible(id);
    }), localStorage.setItem("overlayElementToggles", JSON.stringify(payload));
  }
  function persistFormValues() {
    const payload = {};
    TEAM_FIELDS.forEach(fieldId => {
      payload[fieldId] = String(getElement(fieldId)?.value || "");
    }), localStorage.setItem("matchForm", JSON.stringify(payload));
  }
  // Base colours: the chosen preset is applied when picked, remembered across
  // restarts, and is what Reset Team Data puts the colours back to.
  function readColorPresets() {
    try {
      const list = JSON.parse(localStorage.getItem("colorPresets") || "[]");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  function getBaseColors() {
    const name = localStorage.getItem("baseColorPreset") || "";
    return name && readColorPresets().find(preset => preset.name === name) || DEFAULT_BASE_COLORS;
  }
  function renderColorPresetSelect() {
    const select = getElement("color-preset-select");
    select && (select.innerHTML = '<option value="">Default (blue / orange)</option>' + readColorPresets().map(preset => `<option value="${escapeHtml(preset.name)}">${escapeHtml(preset.name)}</option>`).join(""),
    select.value = getBaseColors().name);
  }
  function toInt(value, fallback = 0) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function renderLogoPreview(previewId, dataUrl, altText) {
    const preview = getElement(previewId);
    preview && (preview.innerHTML = dataUrl ? `<img src="${dataUrl}" alt="${altText}">` : "");
  }
  function showToast(message, isError = !1, undoFn = null) {
    const toast = document.createElement("div");
    toast.className = "rc-toast " + (isError ? "rc-toast--error" : "rc-toast--ok");
    const text = document.createElement("span");
    text.textContent = message, toast.appendChild(text);
    const dismiss = () => {
      toast.classList.add("rc-toast--hide"), setTimeout(() => toast.remove(), 300);
    };
    if ("function" == typeof undoFn) {
      const undoBtn = document.createElement("button");
      undoBtn.type = "button", undoBtn.className = "rc-toast-undo", undoBtn.textContent = "Undo", 
      undoBtn.addEventListener("click", () => {
        undoFn(), dismiss();
      }), toast.appendChild(undoBtn);
    }
    document.body.appendChild(toast), "function" == typeof window.stackToastElement && window.stackToastElement(toast), 
    setTimeout(dismiss, "function" == typeof undoFn ? 6e3 : 2e3);
  }
  function isRelayConnected() {
    return Boolean(socket && socket.connected);
  }
  function requireConnectedRelay(action) {
    return "function" != typeof action ? isRelayConnected() : (action(), !!isRelayConnected() || (pendingOverrideSync = !0, 
    showToast("Relay disconnected. Changes will sync when reconnected.", !0), !1));
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function normalizeCameraFeed(feed, index) {
    const raw = feed && "object" == typeof feed ? feed : {};
    return {
      id: String(raw.id || `camera-${index + 1}`),
      url: String(raw.url || "").trim(),
      team: String(raw.team || "team1").toLowerCase(),
      player: String(raw.player || "").trim()
    };
  }
  function normalizeCameraFeeds(feeds) {
    return (Array.isArray(feeds) ? feeds : []).map((feed, index) => normalizeCameraFeed(feed, index));
  }
  // Always 4 fixed slots per team. Cameras saved by the old free-form list
  // (any count, no player) fill each team's slots in the order they were added.
  function toCameraSlots(feeds) {
    const list = normalizeCameraFeeds(feeds);
    return [ "team1", "team2" ].flatMap(team => {
      const own = list.filter(feed => feed.team === team);
      return [ 0, 1, 2, 3 ].map(i => ({
        id: `${team}-${i + 1}`,
        team: team,
        url: own[i]?.url || "",
        player: own[i]?.player || ""
      }));
    });
  }
  function persistCameraFeeds(feeds) {
    const slots = toCameraSlots(feeds);
    return localStorage.setItem("cameraFeeds", JSON.stringify(slots)), slots;
  }
  function getCameraFeedsFromDom() {
    const container = getElement("camera-list");
    return container ? Array.from(container.querySelectorAll("[data-camera-row]")).map((row, index) => normalizeCameraFeed({
      id: row.dataset.cameraId,
      team: row.dataset.cameraTeam,
      url: String(row.querySelector("[data-camera-url]")?.value || "").trim(),
      player: String(row.querySelector("[data-camera-player]")?.value || "").trim()
    }, index)) : [];
  }
  function cameraSlotLabel(feed) {
    return `${"team2" === feed.team ? "Orange" : "Blue"} Camera ${feed.id.split("-")[1] || ""}`;
  }
  function renderCameraPreview(feeds) {
    const preview = getElement("camera-preview");
    if (!preview) return;
    const cameraFeeds = normalizeCameraFeeds(feeds).filter(feed => feed.url);
    cameraFeeds.length ? preview.innerHTML = cameraFeeds.map(feed => `\n                <div style="flex:1;min-width:200px;max-width:100%;padding:10px;border:1px solid var(--panel-border);border-radius:10px;background:var(--panel-bg);margin:8px;display:flex;flex-direction:column;gap:6px;">\n                    <div style="font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.08em;">${escapeHtml(cameraSlotLabel(feed))}</div>\n                    <div style="font-size:11px;color:var(--muted);">${escapeHtml(feed.player || "No player assigned")}</div>\n                    <div style="flex:1;min-height:120px;border-radius:8px;overflow:hidden;background:#000;">\n                        <iframe src="${escapeHtml(feed.url)}" allow="camera; microphone; autoplay; clipboard-write; encrypted-media" style="width:100%;height:100%;border:0;background:#000;"></iframe>\n                    </div>\n                </div>\n            `).join("") : preview.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);">No cameras added yet.</div>';
  }
  function renderCameraFeedsUI(feeds = []) {
    const container = getElement("camera-list");
    if (!container) return;
    const slots = persistCameraFeeds(feeds), inputStyle = "width:100%;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--input-text);";
    container.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;">${[ "team1", "team2" ].map(team => `\n            <div>\n                <div style="font-weight:700;margin-bottom:6px;">${"team2" === team ? "Orange (right)" : "Blue (left)"}</div>\n                ${slots.filter(feed => feed.team === team).map(feed => `\n                <div data-camera-row data-camera-id="${escapeHtml(feed.id)}" data-camera-team="${team}" style="display:grid;grid-template-columns:auto 1.3fr 1fr;gap:8px;align-items:center;margin-bottom:8px;padding:8px 10px;border:1px solid var(--panel-border);border-radius:10px;background:var(--panel-bg);">\n                    <span style="font-weight:700;color:var(--muted);">${escapeHtml(feed.id.split("-")[1])}</span>\n                    <input data-camera-url type="text" value="${escapeHtml(feed.url)}" placeholder="VDO.Ninja link" style="${inputStyle}">\n                    <input data-camera-player type="text" list="camera-players-${team}" value="${escapeHtml(feed.player)}" placeholder="Epic ID or username" style="${inputStyle}">\n                </div>`).join("")}\n            </div>`).join("")}</div>`, 
    renderCameraPreview(slots);
  }
  function publishOverrides() {
    isRelayConnected() ? (pendingOverrideSync = !1, socket.emit("overrides", {
      blueName: String(getElement("blue-name")?.value || ""),
      orangeName: String(getElement("orange-name")?.value || ""),
      blueAbbr: String(getElement("blue-abbr")?.value || "").toUpperCase(),
      orangeAbbr: String(getElement("orange-abbr")?.value || "").toUpperCase(),
      blueColor: String(getElement("blue-color")?.value || "#21afd7"),
      orangeColor: String(getElement("orange-color")?.value || "#fd5b00"),
      seriesLen: toInt(getElement("series-length")?.value, 7),
      blueWins: toInt(getElement("blue-wins")?.value),
      orangeWins: toInt(getElement("orange-wins")?.value),
      headerText: String(getElement("header-text")?.value || ""),
      headerTextFull: String(getElement("header-text-full")?.value || ""),
      blueLogo: localStorage.getItem("blueLogo") || "",
      orangeLogo: localStorage.getItem("orangeLogo") || "",
      teamsSwapped: "true" === localStorage.getItem("teamsSwapped"),
      cameras: cameraPremiumEnabled ? getCameraFeedsFromDom() : [],
      onlyShowScoringTeamCamera: cameraPremiumEnabled && !0 === getElement("camera-only-score")?.checked,
      matchReplayMode: !0 === getElement("overlay-toggle-match-replay-mode")?.checked,
      ...Object.fromEntries(CAMERA_OPTION_TOGGLES.map(({id: id, key: key}) => [ key, !0 === getElement(id)?.checked ])),
      hideScoreboard: !isOverlayElementVisible("overlay-toggle-scoreboard"),
      hideBoostWheel: !isOverlayElementVisible("overlay-toggle-boost-wheel"),
      hideBottomPlayerCard: !isOverlayElementVisible("overlay-toggle-bottom-player-card"),
      hideSidePlayerCards: !isOverlayElementVisible("overlay-toggle-side-player-cards"),
      // RLCS (and any other hand-built overlay using this same convention)
      // reads show*/visibility fields instead of the hide* fields above --
      // sending both means one set of switches drives every overlay type
      // without needing to know which convention the loaded overlay uses.
      showHud: isOverlayElementVisible("overlay-toggle-scoreboard"),
      showBoostWheel: isOverlayElementVisible("overlay-toggle-boost-wheel"),
      showPlayerCard: isOverlayElementVisible("overlay-toggle-bottom-player-card"),
      showNameplates: isOverlayElementVisible("overlay-toggle-side-player-cards")
    })) : pendingOverrideSync = !0;
  }
  function applyIncomingOverrides(data) {
    var leftFeeds, rightFeeds;
    if (data && "object" == typeof data && (void 0 !== data.blueName && setValue("blue-name", data.blueName), 
    void 0 !== data.orangeName && setValue("orange-name", data.orangeName), void 0 !== data.blueAbbr && setValue("blue-abbr", data.blueAbbr), 
    void 0 !== data.orangeAbbr && setValue("orange-abbr", data.orangeAbbr), void 0 !== data.blueColor && setValue("blue-color", data.blueColor), 
    void 0 !== data.orangeColor && setValue("orange-color", data.orangeColor), void 0 !== data.seriesLen && setValue("series-length", String(data.seriesLen)), 
    void 0 !== data.blueWins && setValue("blue-wins", String(data.blueWins)), void 0 !== data.orangeWins && setValue("orange-wins", String(data.orangeWins)), 
    void 0 !== data.headerText && setValue("header-text", data.headerText), void 0 !== data.headerTextFull && setValue("header-text-full", data.headerTextFull), 
    void 0 !== data.cameras && (leftFeeds = data.cameras, rightFeeds = getCameraFeedsFromDom(), 
    JSON.stringify(toCameraSlots(leftFeeds)) !== JSON.stringify(toCameraSlots(rightFeeds))) && renderCameraFeedsUI(data.cameras), 
    void 0 !== data.onlyShowScoringTeamCamera)) {
      const checkbox = getElement("camera-only-score");
      checkbox && (checkbox.checked = !!data.onlyShowScoringTeamCamera), localStorage.setItem("cameraOnlyScore", checkbox?.checked ? "true" : "false");
    }
    data && "object" == typeof data && CAMERA_OPTION_TOGGLES.forEach(({id: id, key: key, storageKey: storageKey}) => {
      const checkbox = getElement(id);
      void 0 !== data[key] && checkbox && (checkbox.checked = !!data[key], localStorage.setItem(storageKey, checkbox.checked ? "true" : "false"));
    });
    if (data && "object" == typeof data && void 0 !== data.matchReplayMode) {
      const checkbox = getElement("overlay-toggle-match-replay-mode");
      checkbox && (checkbox.checked = !!data.matchReplayMode), localStorage.setItem("matchReplayMode", checkbox?.checked ? "true" : "false");
    }
    if (!data || "object" != typeof data) return;
    let togglesChanged = !1;
    OVERLAY_ELEMENT_TOGGLES.forEach(({id: id, key: key}) => {
      void 0 !== data[key] && (setChecked(id, !data[key]), togglesChanged = !0);
    }), togglesChanged && persistOverlayElementToggles();
  }
  function setCameraOnlyScorePremiumEnabled(isEnabled) {
    const checkbox = getElement("camera-only-score"), note = getElement("camera-only-score-note");
    checkbox && (checkbox.disabled = !isEnabled, note && (note.textContent = isEnabled ? "This applies the replay camera only to the scoring team." : "Premium required to enable this feature."), 
    !isEnabled && checkbox.checked && (checkbox.checked = !1, localStorage.setItem("cameraOnlyScore", "false"), 
    publishOverrides()));
  }
  function setCameraFeaturePremiumEnabled(isEnabled) {
    cameraPremiumEnabled = Boolean(isEnabled);
    const cameraList = getElement("camera-list");
    cameraList && (cameraList.querySelectorAll("input, select, button").forEach(element => {
      element.disabled = !cameraPremiumEnabled;
    }), cameraList.style.opacity = cameraPremiumEnabled ? "1" : "0.55", cameraList.style.pointerEvents = cameraPremiumEnabled ? "auto" : "none"), 
    cameraPremiumEnabled || (setCameraOnlyScorePremiumEnabled(!1), 
    publishOverrides());
  }
  function handleLogoFile(file, previewId, storageKey, altText) {
    if (!file) return;
    if (!/^image\//.test(file.type)) return void showToast("Please choose an image file", !0);
    const reader = new FileReader;
    reader.onload = loadEvent => {
      const dataUrl = loadEvent.target?.result;
      "string" == typeof dataUrl && (localStorage.setItem(storageKey, dataUrl), renderLogoPreview(previewId, dataUrl, altText), 
      publishOverrides());
    }, reader.readAsDataURL(file);
  }
  function bindLogoUpload(inputId, previewId, storageKey, altText) {
    const input = getElement(inputId);
    input && input.addEventListener("change", event => {
      handleLogoFile(event.target?.files?.[0], previewId, storageKey, altText);
    });
  }
  function bindLogoDropZone(previewId, inputId, storageKey, altText) {
    const zone = getElement(previewId), input = getElement(inputId);
    zone && (zone.addEventListener("click", () => input && input.click()), [ "dragenter", "dragover" ].forEach(evt => zone.addEventListener(evt, event => {
      event.preventDefault(), event.stopPropagation(), zone.classList.add("logo-drop-active");
    })), [ "dragleave", "dragend" ].forEach(evt => zone.addEventListener(evt, event => {
      event.preventDefault(), event.stopPropagation(), zone.classList.remove("logo-drop-active");
    })), zone.addEventListener("drop", event => {
      event.preventDefault(), event.stopPropagation(), zone.classList.remove("logo-drop-active"), 
      handleLogoFile(event.dataTransfer?.files?.[0], previewId, storageKey, altText);
    }));
  }



  function connectSocket() {
    if ("undefined" == typeof io) return console.log("Socket.IO not loaded yet, retrying..."), 
    void setTimeout(connectSocket, 500);
    const existingSocket = window.__rocketCastSocket, canReuseSharedSocket = Boolean(existingSocket && "function" == typeof existingSocket.on && "function" == typeof existingSocket.emit && "object" == typeof existingSocket.io);
    socket = canReuseSharedSocket ? existingSocket : io(), window.__rocketCastSocket = socket, 
    socket.on("connect", () => {
      publishOverrides();
    }), socket.on("disconnect", () => {
      pendingOverrideSync = !0;
    }), socket.on("connect_error", () => {
      pendingOverrideSync = !0;
    }), socket.on("overrides", applyIncomingOverrides);
  }
  function initializeControlSync() {
    renderLogoPreview("blue-logo-preview", localStorage.getItem("blueLogo"), "Blue logo"), 
    renderLogoPreview("orange-logo-preview", localStorage.getItem("orangeLogo"), "Orange logo"), 
    bindLogoUpload("blue-logo-file", "blue-logo-preview", "blueLogo", "Blue logo"), 
    bindLogoUpload("orange-logo-file", "orange-logo-preview", "orangeLogo", "Orange logo"), 
    bindLogoDropZone("blue-logo-preview", "blue-logo-file", "blueLogo", "Blue logo"), 
    bindLogoDropZone("orange-logo-preview", "orange-logo-file", "orangeLogo", "Orange logo"), 
    [ {
      nameId: "blue-name",
      abbrId: "blue-abbr"
    }, {
      nameId: "orange-name",
      abbrId: "orange-abbr"
    } ].forEach(({nameId: nameId, abbrId: abbrId}) => {
      const nameInput = getElement(nameId), abbrInput = getElement(abbrId);
      nameInput && abbrInput && nameInput.addEventListener("input", event => {
        var teamName;
        abbrInput.value = (teamName = event.target?.value, String(teamName || "").trim().slice(0, 3).toUpperCase());
      });
    }), function() {
      function snapshotFields(ids) {
        const snap = {};
        return ids.forEach(id => {
          const el = getElement(id);
          snap[id] = el ? el.value : void 0;
        }), snap;
      }
      function restoreFields(snap) {
        Object.keys(snap).forEach(id => {
          void 0 !== snap[id] && setValue(id, snap[id]);
        });
      }
      function swapTeamSides() {
        const swapFieldValues = (leftId, rightId) => {
          const left = getElement(leftId), right = getElement(rightId);
          if (!left || !right) return;
          const temp = left.value;
          left.value = right.value, right.value = temp;
        };
        swapFieldValues("blue-name", "orange-name"), swapFieldValues("blue-abbr", "orange-abbr"), 
        swapFieldValues("blue-wins", "orange-wins");
        const blueLogo = localStorage.getItem("blueLogo"), orangeLogo = localStorage.getItem("orangeLogo");
        orangeLogo ? localStorage.setItem("blueLogo", orangeLogo) : localStorage.removeItem("blueLogo"), 
        blueLogo ? localStorage.setItem("orangeLogo", blueLogo) : localStorage.removeItem("orangeLogo"), 
        renderLogoPreview("blue-logo-preview", orangeLogo, "Blue logo"), renderLogoPreview("orange-logo-preview", blueLogo, "Orange logo"),
        persistFormValues(), publishOverrides();
      }
      const resetSeriesButton = getElement("reset-series-btn");
      resetSeriesButton && resetSeriesButton.addEventListener("click", () => {
        requireConnectedRelay(() => {
          const snap = snapshotFields([ "blue-wins", "orange-wins" ]);
          setValue("blue-wins", "0"), setValue("orange-wins", "0"), socket.emit("series-reset", {
            at: Date.now(),
            reason: "reset-series-button"
          }), persistFormValues(), publishOverrides(), showToast("Series score reset", !1, () => {
            restoreFields(snap), persistFormValues(), publishOverrides(), showToast("Series score restored");
          });
        });
      });
      const switchTeamsButton = getElement("switch-teams-btn");
      switchTeamsButton && switchTeamsButton.addEventListener("click", () => {
        requireConnectedRelay(() => {
          swapTeamSides(), showToast("Teams switched (logos swapped)", !1, () => {
            swapTeamSides(), showToast("Teams switched back");
          });
        });
      });
      const resetDataButton = getElement("reset-data-btn");
      resetDataButton && resetDataButton.addEventListener("click", () => {
        requireConnectedRelay(() => {
          const snap = snapshotFields([ "blue-name", "blue-abbr", "blue-wins", "orange-name", "orange-abbr", "orange-wins", "blue-color", "orange-color", "header-text", "header-text-full", "series-length" ]), blueLogo = localStorage.getItem("blueLogo"), orangeLogo = localStorage.getItem("orangeLogo");
          setValue("blue-name", ""), setValue("blue-abbr", ""), setValue("blue-wins", "0"), 
          setValue("orange-name", ""), setValue("orange-abbr", ""), setValue("orange-wins", "0"), 
          setValue("blue-color", getBaseColors().blue), setValue("orange-color", getBaseColors().orange), setValue("header-text", ""), 
          setValue("header-text-full", ""), setValue("series-length", "7"), localStorage.removeItem("blueLogo"), 
          localStorage.removeItem("orangeLogo"), renderLogoPreview("blue-logo-preview", "", "Blue logo"),
          renderLogoPreview("orange-logo-preview", "", "Orange logo"), persistFormValues(), publishOverrides(),
          showToast("Team data reset", !1, () => {
            restoreFields(snap), blueLogo && localStorage.setItem("blueLogo", blueLogo), orangeLogo && localStorage.setItem("orangeLogo", orangeLogo),
            renderLogoPreview("blue-logo-preview", blueLogo, "Blue logo"), renderLogoPreview("orange-logo-preview", orangeLogo, "Orange logo"),
            persistFormValues(), publishOverrides(), showToast("Team data restored");
          });
        });
      });
    }(), function() {
      (() => {
        const raw = localStorage.getItem("matchForm");
        if (raw) try {
          const parsed = JSON.parse(raw);
          TEAM_FIELDS.forEach(fieldId => {
            Object.prototype.hasOwnProperty.call(parsed || {}, fieldId) && setValue(fieldId, String(parsed[fieldId] || ""));
          });
        } catch {}
      })(), TEAM_FIELDS.forEach(fieldId => {
        const element = getElement(fieldId);
        element && (element.addEventListener("input", persistFormValues), element.addEventListener("input", () => {
          inputPublishQueued || (inputPublishQueued = !0, queueMicrotask(() => {
            inputPublishQueued = !1, publishOverrides();
          }));
        }), element.addEventListener("change", () => {
          persistFormValues(), publishOverrides();
        }));
      });
      const onlyScoreCheckbox = getElement("camera-only-score");
      onlyScoreCheckbox && (onlyScoreCheckbox.checked = "true" === localStorage.getItem("cameraOnlyScore"),
      onlyScoreCheckbox.addEventListener("change", () => {
        if (onlyScoreCheckbox.disabled) return onlyScoreCheckbox.checked = !1, void localStorage.setItem("cameraOnlyScore", "false");
        localStorage.setItem("cameraOnlyScore", onlyScoreCheckbox.checked ? "true" : "false"),
        publishOverrides();
      }));
      CAMERA_OPTION_TOGGLES.forEach(({id: id, storageKey: storageKey}) => {
        const checkbox = getElement(id);
        checkbox && (checkbox.checked = "true" === localStorage.getItem(storageKey), checkbox.addEventListener("change", () => {
          localStorage.setItem(storageKey, checkbox.checked ? "true" : "false"), publishOverrides();
        }));
      }), renderColorPresetSelect(), getElement("color-preset-select")?.addEventListener("change", event => {
        localStorage.setItem("baseColorPreset", event.target.value);
        const base = getBaseColors();
        setValue("blue-color", base.blue), setValue("orange-color", base.orange), persistFormValues(), publishOverrides();
      }), getElement("color-preset-save")?.addEventListener("click", () => {
        const nameInput = getElement("color-preset-name"), name = String(nameInput?.value || "").trim();
        if (!name) return void showToast("Give the preset a name first", !0);
        const presets = readColorPresets().filter(preset => preset.name !== name);
        presets.push({
          name: name,
          blue: String(getElement("blue-color")?.value || DEFAULT_BASE_COLORS.blue),
          orange: String(getElement("orange-color")?.value || DEFAULT_BASE_COLORS.orange)
        }), localStorage.setItem("colorPresets", JSON.stringify(presets)), localStorage.setItem("baseColorPreset", name),
        nameInput.value = "", renderColorPresetSelect(), showToast(`Saved "${name}" as your base colors`);
      }), getElement("color-preset-delete")?.addEventListener("click", () => {
        const name = getElement("color-preset-select")?.value;
        name && (localStorage.setItem("colorPresets", JSON.stringify(readColorPresets().filter(preset => preset.name !== name))),
        localStorage.removeItem("baseColorPreset"), renderColorPresetSelect(), showToast(`Deleted "${name}"`));
      });
      const matchReplayModeCheckbox = getElement("overlay-toggle-match-replay-mode");
      matchReplayModeCheckbox && (matchReplayModeCheckbox.checked = "true" === localStorage.getItem("matchReplayMode"),
      matchReplayModeCheckbox.addEventListener("change", () => {
        localStorage.setItem("matchReplayMode", matchReplayModeCheckbox.checked ? "true" : "false"),
        publishOverrides();
      })), function() {
        const raw = localStorage.getItem("overlayElementToggles");
        let saved = {};
        if (raw) try {
          saved = JSON.parse(raw) || {};
        } catch {}
        OVERLAY_ELEMENT_TOGGLES.forEach(({id: id, key: key}) => {
          const element = getElement(id);
          element && (element.checked = !saved[key], element.addEventListener("change", () => {
            persistOverlayElementToggles(), publishOverrides();
          }));
        });
      }(), persistFormValues();
    }(), function() {
      const cameraList = getElement("camera-list");
      cameraList && (cameraList.addEventListener("input", () => {
        if (!cameraPremiumEnabled) return;
        const feeds = getCameraFeedsFromDom();
        renderCameraPreview(feeds), persistCameraFeeds(feeds), publishOverrides();
      }), cameraList.addEventListener("change", () => {
        if (!cameraPremiumEnabled) return;
        const feeds = getCameraFeedsFromDom();
        renderCameraPreview(feeds), persistCameraFeeds(feeds), publishOverrides();
      }));
      const storedCameraFeeds = localStorage.getItem("cameraFeeds");
      if (storedCameraFeeds) try {
        const parsed = JSON.parse(storedCameraFeeds);
        renderCameraFeedsUI(Array.isArray(parsed) ? parsed : []);
      } catch {
        renderCameraFeedsUI([]);
      } else renderCameraFeedsUI([]);
    }(), setCameraFeaturePremiumEnabled(!1), connectSocket();
  }
  window.__rocketCastSetCameraOnlyScorePremiumEnabled = setCameraOnlyScorePremiumEnabled, 
  window.__rocketCastSetCameraFeaturePremiumEnabled = setCameraFeaturePremiumEnabled, 
  "loading" === document.readyState ? document.addEventListener("DOMContentLoaded", initializeControlSync) : initializeControlSync();
})();