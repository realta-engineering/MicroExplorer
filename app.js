"use strict";

const missions = {
  leaf: {
    title: "Leaf detective",
    icon: "🍃",
    tag: "PLANT POWER",
    prompt: "Can you find the tiny doors that help a leaf breathe?",
    wonder: "Are all the cells the same shape?",
  },
  fabric: {
    title: "Fabric finder",
    icon: "🧵",
    tag: "MATERIAL MYSTERY",
    prompt: "Compare two fabrics. Which one has the twistiest fibres?",
    wonder: "Why are some threads smooth and others fuzzy?",
  },
  crumb: {
    title: "Mystery crumb",
    icon: "🥨",
    tag: "FOOD SCIENCE",
    prompt: "Investigate a tiny crumb without tasting the evidence!",
    wonder: "Can you spot crystals, bubbles, or grains?",
  },
  water: {
    title: "Pond patrol",
    icon: "💧",
    tag: "MICRO LIFE",
    prompt: "Place one safe pond-water drop on a slide and watch patiently.",
    wonder: "Does anything wiggle, spin, or change direction?",
  },
};

const videoFilters = {
  natural: "none",
  contrast: "contrast(1.5) saturate(1.18)",
  mono: "grayscale(1) contrast(1.25)",
  invert: "invert(1) hue-rotate(180deg)",
};

const state = {
  stream: null,
  activeMission: "leaf",
  filter: "natural",
  zoom: 1,
  snapshots: [],
  xp: 0,
  toastTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const viewerCard = $("#viewerCard");
const video = $("#microscopeVideo");
const cameraSelect = $("#cameraSelect");
const connectButton = $("#connectButton");
const connectButtonText = $("#connectButtonText");
const captureButton = $("#captureButton");
const fullscreenButton = $("#fullscreenButton");
const connectionPill = $("#connectionPill");
const connectionText = $("#connectionText");
const liveLabel = $("#liveLabel");
const resolutionReadout = $("#resolutionReadout");
const zoomSlider = $("#zoomSlider");
const zoomOutput = $("#zoomOutput");
const zoomReadout = $("#zoomReadout");
const canvas = $("#captureCanvas");
const snapshotGrid = $("#snapshotGrid");
const snapshotEmpty = $("#snapshotEmpty");
const clearSnapshotsButton = $("#clearSnapshotsButton");
const toast = $("#toast");
const confettiLayer = $("#confettiLayer");
const xpCount = $("#xpCount");
const observationNote = $("#observationNote");
const noteCount = $("#noteCount");

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  state.toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3200);
}

function setConnection(stateName, message) {
  connectionPill.dataset.state = stateName;
  connectionText.textContent = message;
}

function addXp(points) {
  state.xp += points;
  xpCount.textContent = String(state.xp);
}

function stopStream() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  video.srcObject = null;
}

function friendlyCameraError(error) {
  const messages = {
    NotAllowedError: "Camera permission was blocked. Allow camera access, then try again.",
    NotFoundError: "No camera was found. Check the microscope cable and power.",
    NotReadableError: "The camera may be busy in another app. Close it there, then retry.",
    OverconstrainedError: "That camera setting is unavailable. Try another camera.",
    SecurityError: "Camera access needs a secure HTTPS page.",
  };
  return messages[error?.name] || "The microscope could not start. Reconnect it and try again.";
}

async function populateCameraList(preferredId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === "videoinput");
  const activeId = preferredId || state.stream?.getVideoTracks()[0]?.getSettings()?.deviceId;

  cameraSelect.replaceChildren();
  cameras.forEach((camera, index) => {
    const option = document.createElement("option");
    option.value = camera.deviceId;
    option.textContent = camera.label || `Camera ${index + 1}`;
    cameraSelect.append(option);
  });

  cameraSelect.disabled = cameras.length < 2;
  if (activeId && cameras.some((camera) => camera.deviceId === activeId)) {
    cameraSelect.value = activeId;
  }
}

async function connectCamera(deviceId = "") {
  if (!window.isSecureContext) {
    setConnection("error", "HTTPS needed");
    showToast("Publish with GitHub Pages HTTPS before connecting a camera.");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setConnection("error", "Browser unsupported");
    showToast("This browser cannot open cameras. Try current Safari, Chrome, Edge, or Firefox.");
    return;
  }

  setConnection("working", "Waking the lens…");
  connectButton.disabled = true;
  connectButtonText.textContent = "Waking the lens…";

  stopStream();

  const videoConstraints = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  };

  if (deviceId) {
    videoConstraints.deviceId = { exact: deviceId };
  } else {
    videoConstraints.facingMode = { ideal: "environment" };
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });

    video.srcObject = state.stream;
    await video.play();

    const track = state.stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const width = settings.width || video.videoWidth;
    const height = settings.height || video.videoHeight;

    if (!deviceId) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const likelyMicroscope = devices.find((device) =>
        device.kind === "videoinput" && /microscope|usb|uvc|scope/i.test(device.label),
      );
      if (likelyMicroscope && likelyMicroscope.deviceId !== settings.deviceId) {
        await connectCamera(likelyMicroscope.deviceId);
        return;
      }
    }

    viewerCard.classList.add("is-live");
    liveLabel.textContent = "LIVE";
    resolutionReadout.textContent = width && height ? `${width} × ${height}` : "LENS ONLINE";
    captureButton.disabled = false;
    fullscreenButton.disabled = false;
    connectButtonText.textContent = "Reconnect microscope";
    setConnection("live", "Lens online");
    await populateCameraList(settings.deviceId);
    showToast("Lens online! Your tiny-world lab is ready.");
    addXp(5);

    track.addEventListener("ended", () => {
      viewerCard.classList.remove("is-live");
      captureButton.disabled = true;
      fullscreenButton.disabled = true;
      liveLabel.textContent = "STANDBY";
      resolutionReadout.textContent = "CAMERA DISCONNECTED";
      setConnection("idle", "Camera resting");
      showToast("The camera disconnected. Check the cable when you are ready.");
    }, { once: true });
  } catch (error) {
    viewerCard.classList.remove("is-live");
    captureButton.disabled = true;
    fullscreenButton.disabled = true;
    liveLabel.textContent = "STANDBY";
    resolutionReadout.textContent = "CHECK CONNECTION";
    setConnection("error", "Needs attention");
    showToast(friendlyCameraError(error));
  } finally {
    connectButton.disabled = false;
    if (!state.stream) connectButtonText.textContent = "Try microscope again";
  }
}

function setZoom(value) {
  state.zoom = Number(value);
  const label = `${state.zoom.toFixed(1)}×`;
  video.style.setProperty("--video-zoom", String(state.zoom));
  zoomOutput.value = label;
  zoomOutput.textContent = label;
  zoomReadout.textContent = label;
}

function selectFilter(name) {
  state.filter = name;
  video.style.filter = videoFilters[name];
  $$(".filter-chip").forEach((button) => {
    const active = button.dataset.filter === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function blobFromCanvas(targetCanvas) {
  return new Promise((resolve) => targetCanvas.toBlob(resolve, "image/jpeg", 0.92));
}

async function captureDiscovery() {
  if (!state.stream || !video.videoWidth || !video.videoHeight) {
    showToast("Power up the microscope before taking a snapshot.");
    return;
  }

  captureButton.disabled = true;
  const sourceWidth = video.videoWidth / state.zoom;
  const sourceHeight = video.videoHeight / state.zoom;
  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;
  const outputWidth = Math.min(1600, Math.round(sourceWidth));
  const outputHeight = Math.round(outputWidth * (sourceHeight / sourceWidth));

  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d", { alpha: false });
  context.filter = videoFilters[state.filter];
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    outputWidth,
    outputHeight,
  );

  const blob = await blobFromCanvas(canvas);
  if (!blob) {
    captureButton.disabled = false;
    showToast("That snapshot did not develop. Please try once more.");
    return;
  }

  const snapshot = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    url: URL.createObjectURL(blob),
    time: new Date(),
    mission: missions[state.activeMission].title,
    note: observationNote.value.trim(),
  };

  state.snapshots.unshift(snapshot);
  renderSnapshots();
  celebrate();
  addXp(10);
  showToast("Discovery captured! +10 explorer points");
  captureButton.disabled = false;
}

function snapshotCard(snapshot, index) {
  const card = document.createElement("article");
  card.className = "snapshot-card";
  card.dataset.snapshotId = snapshot.id;

  const imageWrap = document.createElement("div");
  imageWrap.className = "snapshot-image-wrap";

  const image = document.createElement("img");
  image.src = snapshot.url;
  image.alt = `${snapshot.mission} microscope discovery`;

  const badge = document.createElement("span");
  badge.className = "snapshot-index";
  badge.textContent = `DISCOVERY ${state.snapshots.length - index}`;
  imageWrap.append(image, badge);

  const info = document.createElement("div");
  info.className = "snapshot-info";

  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = snapshot.mission;
  const meta = document.createElement("small");
  meta.textContent = snapshot.note || snapshot.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  copy.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "snapshot-actions";

  const download = document.createElement("a");
  download.href = snapshot.url;
  download.download = `micro-quest-${snapshot.id}.jpg`;
  download.setAttribute("aria-label", `Download ${snapshot.mission} snapshot`);
  download.title = "Download snapshot";
  download.textContent = "↓";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.deleteSnapshot = snapshot.id;
  remove.setAttribute("aria-label", `Delete ${snapshot.mission} snapshot`);
  remove.title = "Delete snapshot";
  remove.textContent = "×";

  actions.append(download, remove);
  info.append(copy, actions);
  card.append(imageWrap, info);
  return card;
}

function renderSnapshots() {
  snapshotGrid.replaceChildren();
  if (!state.snapshots.length) {
    snapshotGrid.append(snapshotEmpty);
    clearSnapshotsButton.hidden = true;
    return;
  }

  state.snapshots.forEach((snapshot, index) => {
    snapshotGrid.append(snapshotCard(snapshot, index));
  });
  clearSnapshotsButton.hidden = false;
}

function deleteSnapshot(id) {
  const snapshot = state.snapshots.find((item) => item.id === id);
  if (snapshot) URL.revokeObjectURL(snapshot.url);
  state.snapshots = state.snapshots.filter((item) => item.id !== id);
  renderSnapshots();
}

function clearSnapshots() {
  state.snapshots.forEach((snapshot) => URL.revokeObjectURL(snapshot.url));
  state.snapshots = [];
  renderSnapshots();
  showToast("Discovery reel cleared for a fresh expedition.");
}

function celebrate() {
  const colors = ["#5ff2d6", "#ffd166", "#ff6b9d", "#7657ff", "#63c9ff"];
  for (let index = 0; index < 24; index += 1) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.setProperty("--x", `${Math.random() * 100}%`);
    piece.style.setProperty("--size", `${7 + Math.random() * 8}px`);
    piece.style.setProperty("--color", colors[index % colors.length]);
    piece.style.setProperty("--speed", `${1.7 + Math.random() * 1.2}s`);
    piece.style.setProperty("--rotation", `${Math.random() * 180}deg`);
    piece.style.setProperty("--drift", `${-80 + Math.random() * 160}px`);
    confettiLayer.append(piece);
    piece.addEventListener("animationend", () => piece.remove(), { once: true });
  }
}

function selectMission(key) {
  const mission = missions[key];
  if (!mission) return;

  saveCurrentNote();
  state.activeMission = key;
  $("#quest-heading").textContent = mission.title;
  $("#questIcon").textContent = mission.icon;
  $("#questTag").textContent = mission.tag;
  $("#questPrompt").textContent = mission.prompt;
  $("#wonderQuestion").textContent = mission.wonder;

  $$(".mission").forEach((button) => {
    const active = button.dataset.mission === key;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  observationNote.value = readSavedNote(key);
  updateNoteCount();
  showToast(`${mission.title} mission selected.`);
}

function noteStorageKey(key = state.activeMission) {
  return `micro-quest-note-${key}`;
}

function readSavedNote(key) {
  try {
    return localStorage.getItem(noteStorageKey(key)) || "";
  } catch {
    return "";
  }
}

function saveCurrentNote() {
  try {
    localStorage.setItem(noteStorageKey(), observationNote.value.trim());
  } catch {
    return false;
  }
  return true;
}

function updateNoteCount() {
  noteCount.textContent = String(observationNote.value.length);
}

async function openFullscreen() {
  const stage = $("#stage");
  try {
    if (stage.requestFullscreen) {
      await stage.requestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    } else {
      showToast("Fullscreen is not available in this browser.");
    }
  } catch {
    showToast("Fullscreen could not open this time.");
  }
}

connectButton.addEventListener("click", () => connectCamera(cameraSelect.value));
cameraSelect.addEventListener("change", () => connectCamera(cameraSelect.value));
captureButton.addEventListener("click", captureDiscovery);
fullscreenButton.addEventListener("click", openFullscreen);
zoomSlider.addEventListener("input", (event) => setZoom(event.target.value));

$$(".filter-chip").forEach((button) => {
  button.addEventListener("click", () => selectFilter(button.dataset.filter));
});

$$(".mission").forEach((button) => {
  button.addEventListener("click", () => selectMission(button.dataset.mission));
});

observationNote.addEventListener("input", updateNoteCount);
$("#saveNoteButton").addEventListener("click", () => {
  const saved = saveCurrentNote();
  showToast(saved ? "Field note tucked safely into this browser." : "This browser could not save the note.");
  if (saved) addXp(2);
});

$("#completeQuestButton").addEventListener("click", () => {
  saveCurrentNote();
  addXp(25);
  celebrate();
  showToast(`${missions[state.activeMission].title} complete! +25 explorer points`);
});

snapshotGrid.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-delete-snapshot]")
    : null;
  if (button) deleteSnapshot(button.dataset.deleteSnapshot);
});

clearSnapshotsButton.addEventListener("click", clearSnapshots);

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    if (state.stream) populateCameraList(cameraSelect.value).catch(() => {});
  });
}

window.addEventListener("pagehide", () => {
  stopStream();
  state.snapshots.forEach((snapshot) => URL.revokeObjectURL(snapshot.url));
});

setZoom(1);
selectFilter("natural");
observationNote.value = readSavedNote("leaf");
updateNoteCount();

if (!window.isSecureContext) {
  setConnection("error", "Preview only");
  connectionText.textContent = "Publish with HTTPS";
} else if (!navigator.mediaDevices?.getUserMedia) {
  setConnection("error", "Browser unsupported");
}
