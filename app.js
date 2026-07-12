"use strict";

const videoFilters = {
  natural: "none",
  contrast: "contrast(1.5) saturate(1.18)",
  mono: "grayscale(1) contrast(1.25)",
  invert: "invert(1) hue-rotate(180deg)",
};

const qualityProfiles = [
  { width: 2560, height: 1440 },
  { width: 1920, height: 1080 },
  { width: 1600, height: 1200 },
  { width: 1280, height: 960 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 800, height: 600 },
];

const state = {
  stream: null,
  filter: "natural",
  zoom: 1,
  torchSupported: false,
  lightOn: false,
  explorerName: "",
  snapshots: [],
  pendingSnapshot: null,
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
const lightButton = $("#lightButton");
const lightButtonText = $("#lightButtonText");
const lightTip = $("#lightTip");
const canvas = $("#captureCanvas");
const snapshotGrid = $("#snapshotGrid");
const snapshotEmpty = $("#snapshotEmpty");
const clearSnapshotsButton = $("#clearSnapshotsButton");
const downloadPdfButton = $("#downloadPdfButton");
const labelDialog = $("#labelDialog");
const labelForm = $("#labelForm");
const labelInput = $("#snapshotLabel");
const labelPreview = $("#labelPreview");
const toast = $("#toast");

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

function resetLightControl(message = "Connect a camera to check for LED control.") {
  state.torchSupported = false;
  state.lightOn = false;
  lightButton.disabled = true;
  lightButton.setAttribute("aria-pressed", "false");
  lightButtonText.textContent = "Check light";
  lightTip.textContent = message;
}

function configureLightControl(track) {
  let capabilities = {};
  try {
    capabilities = track.getCapabilities?.() || {};
  } catch {
    // Some browsers expose getCapabilities but do not allow it for every device.
  }

  const torchCapability = capabilities.torch;
  const supportsTorch = torchCapability === true
    || (Array.isArray(torchCapability) && torchCapability.includes(true));

  if (!supportsTorch) {
    resetLightControl("Use the microscope's light wheel or button; browser LED control is unavailable.");
    return;
  }

  state.torchSupported = true;
  state.lightOn = Boolean(track.getSettings?.().torch);
  lightButton.disabled = false;
  lightButton.setAttribute("aria-pressed", String(state.lightOn));
  lightButtonText.textContent = state.lightOn ? "Light on" : "Light off";
  lightTip.textContent = "This camera allows its subject light to be controlled here.";
}

async function toggleSubjectLight() {
  const track = state.stream?.getVideoTracks()[0];
  if (!track || !state.torchSupported) {
    showToast("This microscope uses its hardware light wheel or button.");
    return;
  }

  const nextState = !state.lightOn;
  lightButton.disabled = true;

  try {
    await applyAdvancedTrackSetting(track, { torch: nextState });
    state.lightOn = nextState;
    lightButton.setAttribute("aria-pressed", String(nextState));
    lightButtonText.textContent = nextState ? "Light on" : "Light off";
    showToast(nextState ? "Subject light switched on." : "Subject light switched off.");
  } catch {
    state.torchSupported = false;
    lightButton.setAttribute("aria-pressed", "false");
    lightButtonText.textContent = "No light control";
    lightTip.textContent = "The camera rejected LED control. Use its hardware light wheel or button.";
    showToast("The browser could not control this microscope's light.");
  } finally {
    lightButton.disabled = !state.torchSupported;
  }
}

function stopStream() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  video.srcObject = null;
  resetLightControl();
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

async function applyAdvancedTrackSetting(track, setting) {
  const constraints = track.getConstraints?.() || {};
  const changedKeys = Object.keys(setting);
  const existingAdvanced = (constraints.advanced || []).filter((entry) =>
    changedKeys.every((key) => !(key in entry)),
  );

  await track.applyConstraints({
    ...constraints,
    advanced: [...existingAdvanced, setting],
  });
}

async function optimiseCameraQuality(track) {
  const initialSettings = track.getSettings();
  const initialPixels = (initialSettings.width || 0) * (initialSettings.height || 0);
  let capabilities = {};

  try {
    capabilities = track.getCapabilities?.() || {};
  } catch {
    // The current settings still provide a safe fallback in older browsers.
  }

  const maxWidth = capabilities.width?.max || Infinity;
  const maxHeight = capabilities.height?.max || Infinity;
  const supportsNativeSizing = capabilities.resizeMode?.includes("none");
  const supportsContinuousFocus = capabilities.focusMode?.includes("continuous");
  const profiles = [...qualityProfiles];

  if (Number.isFinite(maxWidth) && Number.isFinite(maxHeight)) {
    profiles.push({ width: maxWidth, height: maxHeight });
  }

  const candidates = profiles
    .filter(({ width, height }) => width <= maxWidth && height <= maxHeight)
    .filter(({ width, height }) => width * height > initialPixels)
    .filter((profile, index, all) =>
      all.findIndex(({ width, height }) => width === profile.width && height === profile.height) === index,
    )
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));

  for (const profile of candidates) {
    const constraints = {
      width: { exact: profile.width },
      height: { exact: profile.height },
      // Some microscopes only expose their highest resolution at a lower frame rate.
      frameRate: { ideal: 15 },
    };

    if (supportsNativeSizing) constraints.resizeMode = { exact: "none" };
    if (supportsContinuousFocus) constraints.advanced = [{ focusMode: "continuous" }];

    try {
      await track.applyConstraints(constraints);
      return { upgraded: true, autofocus: supportsContinuousFocus };
    } catch {
      // Try the next native resolution advertised by common UVC microscopes.
    }
  }

  if (supportsContinuousFocus) {
    try {
      await applyAdvancedTrackSetting(track, { focusMode: "continuous" });
    } catch {
      return { upgraded: false, autofocus: false };
    }
  }

  return { upgraded: false, autofocus: supportsContinuousFocus };
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

    const track = state.stream.getVideoTracks()[0];
    let settings = track.getSettings();

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

    setConnection("working", "Finding sharpest view…");
    connectButtonText.textContent = "Finding sharpest view…";
    const qualityResult = await optimiseCameraQuality(track);

    video.srcObject = state.stream;
    await video.play();

    settings = track.getSettings();
    const width = settings.width || video.videoWidth;
    const height = settings.height || video.videoHeight;

    viewerCard.classList.add("is-live");
    liveLabel.textContent = "LIVE";
    resolutionReadout.textContent = width && height ? `${width} × ${height}` : "LENS ONLINE";
    captureButton.disabled = false;
    fullscreenButton.disabled = false;
    configureLightControl(track);
    connectButtonText.textContent = "Reconnect microscope";
    setConnection("live", "Lens online");
    await populateCameraList(settings.deviceId);
    if (qualityResult.upgraded) {
      showToast(`Sharper camera mode found: ${width} × ${height}.`);
    } else if (width <= 640 && height <= 480) {
      showToast("The camera is sending 640 × 480. Use its focus ring and subject light for the clearest view.");
    } else {
      showToast(`Lens online at ${width} × ${height}.`);
    }
    track.addEventListener("ended", () => {
      viewerCard.classList.remove("is-live");
      captureButton.disabled = true;
      fullscreenButton.disabled = true;
      resetLightControl();
      liveLabel.textContent = "STANDBY";
      resolutionReadout.textContent = "CAMERA DISCONNECTED";
      setConnection("idle", "Camera resting");
      showToast("The camera disconnected. Check the cable when you are ready.");
    }, { once: true });
  } catch (error) {
    viewerCard.classList.remove("is-live");
    captureButton.disabled = true;
    fullscreenButton.disabled = true;
    resetLightControl();
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
    label: "",
  };

  requestSnapshotLabel(snapshot);
}

function requestSnapshotLabel(snapshot) {
  state.pendingSnapshot = snapshot;
  labelPreview.src = snapshot.url;
  labelInput.value = "";
  labelInput.setCustomValidity("");

  if (typeof labelDialog.showModal === "function") {
    labelDialog.showModal();
    window.setTimeout(() => labelInput.focus(), 0);
    return;
  }

  const response = window.prompt("Label your snapshot:", "");
  if (response?.trim()) {
    savePendingSnapshot(response);
  } else {
    discardPendingSnapshot();
  }
}

function cameraIsLive() {
  return Boolean(state.stream?.getVideoTracks().some((track) => track.readyState === "live"));
}

function finishLabelStep() {
  labelPreview.removeAttribute("src");
  if (labelDialog.open) labelDialog.close();
  captureButton.disabled = !cameraIsLive();
}

function savePendingSnapshot(label) {
  if (!state.pendingSnapshot) return;
  state.pendingSnapshot.label = label.trim().replace(/\s+/g, " ");
  state.snapshots.unshift(state.pendingSnapshot);
  state.pendingSnapshot = null;
  finishLabelStep();
  renderSnapshots();
  showToast("Discovery labelled and saved to your reel.");
}

function discardPendingSnapshot() {
  if (state.pendingSnapshot) URL.revokeObjectURL(state.pendingSnapshot.url);
  state.pendingSnapshot = null;
  finishLabelStep();
  showToast("Ready for another look through the lens.");
}

function snapshotCard(snapshot, index) {
  const card = document.createElement("article");
  card.className = "snapshot-card";
  card.dataset.snapshotId = snapshot.id;

  const imageWrap = document.createElement("div");
  imageWrap.className = "snapshot-image-wrap";

  const image = document.createElement("img");
  image.src = snapshot.url;
  image.alt = `${snapshot.label} microscope discovery`;

  const badge = document.createElement("span");
  badge.className = "snapshot-index";
  badge.textContent = `DISCOVERY ${state.snapshots.length - index}`;
  imageWrap.append(image, badge);

  const info = document.createElement("div");
  info.className = "snapshot-info";

  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = snapshot.label;
  const meta = document.createElement("small");
  meta.textContent = snapshot.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  copy.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "snapshot-actions";

  const download = document.createElement("a");
  download.href = snapshot.url;
  download.download = `${safeSnapshotFilename(snapshot.label)}-${snapshot.id}.jpg`;
  download.setAttribute("aria-label", `Download ${snapshot.label} snapshot`);
  download.title = "Download snapshot";
  download.textContent = "↓";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.deleteSnapshot = snapshot.id;
  remove.setAttribute("aria-label", `Delete ${snapshot.label} snapshot`);
  remove.title = "Delete snapshot";
  remove.textContent = "×";

  actions.append(download, remove);
  info.append(copy, actions);
  card.append(imageWrap, info);
  return card;
}

function safeSnapshotFilename(label) {
  return label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "micro-discovery";
}

function renderSnapshots() {
  snapshotGrid.replaceChildren();
  if (!state.snapshots.length) {
    snapshotGrid.append(snapshotEmpty);
    clearSnapshotsButton.hidden = true;
    downloadPdfButton.hidden = true;
    return;
  }

  state.snapshots.forEach((snapshot, index) => {
    snapshotGrid.append(snapshotCard(snapshot, index));
  });
  clearSnapshotsButton.hidden = false;
  downloadPdfButton.hidden = false;
}

function roundedRectPath(context, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function loadSnapshotImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Snapshot image could not be loaded"));
    image.src = url;
  });
}

function drawImageCover(context, image, x, y, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.naturalWidth - sourceWidth) / 2;
  const sourceY = (image.naturalHeight - sourceHeight) / 2;
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

async function drawDiscoveryCard(context, snapshot, discoveryNumber, y) {
  const x = 90;
  const width = 1060;
  const height = 590;
  const imageHeight = 430;
  const image = await loadSnapshotImage(snapshot.url);

  context.save();
  context.shadowColor = "rgba(7, 27, 51, 0.13)";
  context.shadowBlur = 24;
  context.shadowOffsetY = 10;
  context.fillStyle = "#ffffff";
  roundedRectPath(context, x, y, width, height, 28);
  context.fill();
  context.restore();

  context.save();
  roundedRectPath(context, x, y, width, height, 28);
  context.clip();
  drawImageCover(context, image, x, y, width, imageHeight);
  context.restore();

  context.fillStyle = "rgba(7, 27, 51, 0.78)";
  roundedRectPath(context, x + 24, y + 24, 180, 42, 12);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = '800 18px "Arial", sans-serif';
  context.fillText(`DISCOVERY ${discoveryNumber}`, x + 42, y + 52);

  const infoY = y + imageHeight;
  context.fillStyle = "#071b33";
  let labelFontSize = 28;
  context.font = `800 ${labelFontSize}px "Arial", sans-serif`;
  while (labelFontSize > 20 && context.measureText(snapshot.label).width > 650) {
    labelFontSize -= 1;
    context.font = `800 ${labelFontSize}px "Arial", sans-serif`;
  }
  let pdfLabel = snapshot.label;
  while (pdfLabel.length > 1 && context.measureText(pdfLabel).width > 650) {
    pdfLabel = `${pdfLabel.slice(0, -2).trimEnd()}…`;
  }
  context.fillText(pdfLabel, x + 34, infoY + 48);

  context.fillStyle = "#77869a";
  context.font = '600 18px "Arial", sans-serif';
  context.textAlign = "right";
  context.fillText(
    snapshot.time.toLocaleString([], {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
    x + width - 34,
    infoY + 47,
  );
  context.textAlign = "left";

  context.fillStyle = "#46566a";
  context.font = '500 22px "Arial", sans-serif';
  context.fillText("Captured through the microscope", x + 34, infoY + 91);
}

function canvasAsJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PDF page could not be rendered"));
    }, "image/jpeg", 0.92);
  });
}

async function renderDiscoveryPdfPage(snapshots, pageIndex, pageCount, explorerName) {
  const canvasPage = document.createElement("canvas");
  canvasPage.width = 1240;
  canvasPage.height = 1754;
  const context = canvasPage.getContext("2d", { alpha: false });

  context.fillStyle = "#f6f1e7";
  context.fillRect(0, 0, canvasPage.width, canvasPage.height);
  context.fillStyle = "#071b33";
  context.fillRect(0, 0, canvasPage.width, 230);

  context.fillStyle = "rgba(95, 242, 214, 0.13)";
  context.beginPath();
  context.arc(1130, 42, 125, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "rgba(255, 107, 157, 0.15)";
  context.beginPath();
  context.arc(1030, 210, 76, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#5ff2d6";
  context.font = '800 19px "Arial", sans-serif';
  context.fillText("MICROEXPLORER • DISCOVERY REEL", 90, 55);
  context.fillStyle = "#ffffff";
  context.font = '800 52px "Arial", sans-serif';
  context.fillText("Tiny-World Discoveries", 90, 122);
  context.fillStyle = "rgba(255, 255, 255, 0.78)";
  let nameFontSize = 25;
  context.font = `600 ${nameFontSize}px "Arial", sans-serif`;
  while (nameFontSize > 18 && context.measureText(`Explorer: ${explorerName}`).width > 850) {
    nameFontSize -= 1;
    context.font = `600 ${nameFontSize}px "Arial", sans-serif`;
  }
  context.fillText(`Explorer: ${explorerName}`, 90, 170);
  context.font = '500 18px "Arial", sans-serif';
  context.fillText(
    new Date().toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" }),
    90,
    202,
  );

  for (let index = 0; index < snapshots.length; index += 1) {
    await drawDiscoveryCard(context, snapshots[index], (pageIndex * 2) + index + 1, 270 + (index * 625));
  }

  context.fillStyle = "#718095";
  context.font = '600 17px "Arial", sans-serif';
  context.fillText("Look closely. Stay curious.", 90, 1690);
  context.textAlign = "right";
  context.fillText(`Page ${pageIndex + 1} of ${pageCount}`, 1150, 1690);
  context.textAlign = "left";

  const jpegBlob = await canvasAsJpeg(canvasPage);
  return new Uint8Array(await jpegBlob.arrayBuffer());
}

function bytesFromString(value) {
  return new TextEncoder().encode(value);
}

function combineBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });
  return result;
}

function pdfStream(dictionary, data) {
  return combineBytes([
    bytesFromString(`<< ${dictionary} /Length ${data.length} >>\nstream\n`),
    data,
    bytesFromString("\nendstream"),
  ]);
}

function buildDiscoveryPdf(jpegPages) {
  const objects = [null];
  const reserveObject = () => {
    objects.push(null);
    return objects.length - 1;
  };
  const catalogId = reserveObject();
  const pagesId = reserveObject();
  const pageIds = [];

  jpegPages.forEach((jpegData) => {
    const imageId = reserveObject();
    const contentId = reserveObject();
    const pageId = reserveObject();
    const content = bytesFromString("q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ");

    objects[imageId] = pdfStream(
      "/Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
      jpegData,
    );
    objects[contentId] = pdfStream("", content);
    objects[pageId] = bytesFromString(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  });

  objects[pagesId] = bytesFromString(
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
  );
  objects[catalogId] = bytesFromString(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  const header = combineBytes([
    bytesFromString("%PDF-1.4\n%"),
    new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  ]);
  const parts = [header];
  const offsets = [0];
  let byteOffset = header.length;

  for (let id = 1; id < objects.length; id += 1) {
    const objectBytes = combineBytes([
      bytesFromString(`${id} 0 obj\n`),
      objects[id],
      bytesFromString("\nendobj\n"),
    ]);
    offsets[id] = byteOffset;
    parts.push(objectBytes);
    byteOffset += objectBytes.length;
  }

  const xrefOffset = byteOffset;
  const xrefRows = ["0000000000 65535 f "];
  for (let id = 1; id < objects.length; id += 1) {
    xrefRows.push(`${String(offsets[id]).padStart(10, "0")} 00000 n `);
  }
  parts.push(bytesFromString(
    `xref\n0 ${objects.length}\n${xrefRows.join("\n")}\ntrailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
  ));

  return new Blob(parts, { type: "application/pdf" });
}

function safePdfFilename(explorerName) {
  const safeName = explorerName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${safeName || "explorer"}-tiny-world-discoveries.pdf`;
}

function setPdfButtonLabel(label, includeIcon = false) {
  downloadPdfButton.replaceChildren();
  if (includeIcon) {
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "↓";
    downloadPdfButton.append(icon, ` ${label}`);
  } else {
    downloadPdfButton.textContent = label;
  }
}

async function downloadDiscoveryPdf() {
  if (!state.snapshots.length) {
    showToast("Take at least one snapshot before making a PDF.");
    return;
  }

  const response = window.prompt("What is the explorer's name?", state.explorerName);
  if (response === null) return;
  const explorerName = response.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!explorerName) {
    showToast("Add the explorer's name to create the PDF.");
    return;
  }

  state.explorerName = explorerName;
  downloadPdfButton.disabled = true;
  setPdfButtonLabel("Creating PDF…");

  try {
    await document.fonts?.ready;
    const snapshots = [...state.snapshots];
    const pageCount = Math.ceil(snapshots.length / 2);
    const jpegPages = [];

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      jpegPages.push(await renderDiscoveryPdfPage(
        snapshots.slice(pageIndex * 2, (pageIndex * 2) + 2),
        pageIndex,
        pageCount,
        explorerName,
      ));
    }

    const pdfBlob = buildDiscoveryPdf(jpegPages);
    const pdfUrl = URL.createObjectURL(pdfBlob);
    const download = document.createElement("a");
    download.href = pdfUrl;
    download.download = safePdfFilename(explorerName);
    document.body.append(download);
    download.click();
    download.remove();
    window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60000);
    showToast(`PDF saved for ${explorerName}.`);
  } catch {
    showToast("The PDF could not be created. Please try again.");
  } finally {
    downloadPdfButton.disabled = false;
    setPdfButtonLabel("Export PDF", true);
  }
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
lightButton.addEventListener("click", toggleSubjectLight);

$$(".filter-chip").forEach((button) => {
  button.addEventListener("click", () => selectFilter(button.dataset.filter));
});

labelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const label = labelInput.value.trim().replace(/\s+/g, " ");
  if (!label) {
    labelInput.setCustomValidity("Give your discovery a label first.");
    labelInput.reportValidity();
    return;
  }
  labelInput.setCustomValidity("");
  savePendingSnapshot(label);
});

labelInput.addEventListener("input", () => labelInput.setCustomValidity(""));
$("#retakeButton").addEventListener("click", discardPendingSnapshot);
labelDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  discardPendingSnapshot();
});

snapshotGrid.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-delete-snapshot]")
    : null;
  if (button) deleteSnapshot(button.dataset.deleteSnapshot);
});

clearSnapshotsButton.addEventListener("click", clearSnapshots);
downloadPdfButton.addEventListener("click", downloadDiscoveryPdf);

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    if (state.stream) populateCameraList(cameraSelect.value).catch(() => {});
  });
}

window.addEventListener("pagehide", () => {
  stopStream();
  state.snapshots.forEach((snapshot) => URL.revokeObjectURL(snapshot.url));
  if (state.pendingSnapshot) URL.revokeObjectURL(state.pendingSnapshot.url);
});

setZoom(1);
selectFilter("natural");

if (!window.isSecureContext) {
  setConnection("error", "Preview only");
  connectionText.textContent = "Publish with HTTPS";
} else if (!navigator.mediaDevices?.getUserMedia) {
  setConnection("error", "Browser unsupported");
}
