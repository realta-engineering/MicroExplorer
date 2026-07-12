"use strict";

const videoFilters = {
  natural: "none",
  contrast: "contrast(1.5) saturate(1.18)",
  mono: "grayscale(1) contrast(1.25)",
  invert: "invert(1) hue-rotate(180deg)",
};

const videoFilterLabels = {
  contrast: "Contrast+ view",
  mono: "B&W view",
  invert: "Inverted view",
};

const organizerStorageKey = "microexplorer-organizer";

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
  autoEnhance: false,
  autoEnhanceFilter: "none",
  edgeHighlight: false,
  edgeIntensity: 0.6,
  edgeFrame: null,
  edgeLastSample: 0,
  focusHelper: false,
  focusFrame: null,
  focusLastSample: 0,
  focusSamples: 0,
  focusScore: 0,
  focusBest: 0,
  focusMin: Infinity,
  explorerName: "",
  organizerName: "",
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
const focusHelperButton = $("#focusHelperButton");
const autoEnhanceButton = $("#autoEnhanceButton");
const edgeHighlightButton = $("#edgeHighlightButton");
const edgeIntensityControl = $("#edgeIntensityControl");
const edgeIntensity = $("#edgeIntensity");
const edgeOverlay = $("#edgeOverlay");
const edgeOverlayContext = edgeOverlay.getContext("2d");
const focusHelperPanel = $("#focusHelperPanel");
const focusStatus = $("#focusStatus");
const focusMeterFill = $("#focusMeterFill");
const assistTip = $("#assistTip");
const canvas = $("#captureCanvas");
const snapshotGrid = $("#snapshotGrid");
const snapshotEmpty = $("#snapshotEmpty");
const clearSnapshotsButton = $("#clearSnapshotsButton");
const downloadPdfButton = $("#downloadPdfButton");
const labelDialog = $("#labelDialog");
const labelForm = $("#labelForm");
const labelInput = $("#snapshotLabel");
const labelPreview = $("#labelPreview");
const exportDialog = $("#exportDialog");
const exportForm = $("#exportForm");
const exportExplorerName = $("#exportExplorerName");
const exportOrganizerName = $("#exportOrganizerName");
const rememberOrganizer = $("#rememberOrganizer");
const forgetOrganizerButton = $("#forgetOrganizerButton");
const toast = $("#toast");
const analysisCanvas = document.createElement("canvas");
analysisCanvas.width = 160;
analysisCanvas.height = 120;
const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });
const edgeSourceCanvas = document.createElement("canvas");
const edgeSourceContext = edgeSourceCanvas.getContext("2d", { willReadFrequently: true });
const captureEdgeCanvas = document.createElement("canvas");
const captureEdgeContext = captureEdgeCanvas.getContext("2d");

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

function stopStream() {
  if (!state.stream) return;
  resetProcessingTools();
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
    focusHelperButton.disabled = false;
    autoEnhanceButton.disabled = false;
    edgeHighlightButton.disabled = false;
    assistTip.textContent = "Focus guidance and enhancement are optional and reversible.";
    connectButtonText.textContent = "Reconnect microscope";
    setConnection("live", "Lens online");
    await populateCameraList(settings.deviceId);
    if (qualityResult.upgraded) {
      showToast(`Sharper camera mode found: ${width} × ${height}.`);
    } else if (width <= 640 && height <= 480) {
      showToast("The camera is sending 640 × 480. Use its focus ring and physical light wheel for the clearest view.");
    } else {
      showToast(`Lens online at ${width} × ${height}.`);
    }
    track.addEventListener("ended", () => {
      viewerCard.classList.remove("is-live");
      captureButton.disabled = true;
      fullscreenButton.disabled = true;
      resetProcessingTools();
      liveLabel.textContent = "STANDBY";
      resolutionReadout.textContent = "CAMERA DISCONNECTED";
      setConnection("idle", "Camera resting");
      showToast("The camera disconnected. Check the cable when you are ready.");
    }, { once: true });
  } catch (error) {
    viewerCard.classList.remove("is-live");
    captureButton.disabled = true;
    fullscreenButton.disabled = true;
    resetProcessingTools();
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
  resetFocusCalibration();
}

function activeVideoFilter() {
  const filters = [videoFilters[state.filter]];
  if (state.autoEnhance) filters.push(state.autoEnhanceFilter);
  const activeFilters = filters.filter((filter) => filter && filter !== "none");
  return activeFilters.join(" ") || "none";
}

function applyVideoProcessing() {
  video.style.filter = activeVideoFilter();
}

function selectFilter(name) {
  state.filter = name;
  applyVideoProcessing();
  $$(".filter-chip").forEach((button) => {
    const active = button.dataset.filter === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function drawAnalysisFrame() {
  if (!video.videoWidth || !video.videoHeight) return null;

  let sourceWidth = video.videoWidth / state.zoom;
  let sourceHeight = video.videoHeight / state.zoom;
  const targetAspect = analysisCanvas.width / analysisCanvas.height;
  const sourceAspect = sourceWidth / sourceHeight;

  if (sourceAspect > targetAspect) sourceWidth = sourceHeight * targetAspect;
  else sourceHeight = sourceWidth / targetAspect;

  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;
  analysisContext.filter = "none";
  analysisContext.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    analysisCanvas.width,
    analysisCanvas.height,
  );
  return analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
}

function focusMetrics() {
  const imageData = drawAnalysisFrame();
  if (!imageData) return null;

  const { data } = imageData;
  const width = analysisCanvas.width;
  const height = analysisCanvas.height;
  const gray = new Float32Array(width * height);
  let brightnessTotal = 0;
  let brightnessSquaredTotal = 0;

  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    const value = (data[offset] * 0.299) + (data[offset + 1] * 0.587) + (data[offset + 2] * 0.114);
    gray[index] = value;
    brightnessTotal += value;
    brightnessSquaredTotal += value * value;
  }

  let laplacianSquaredTotal = 0;
  let laplacianCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width) + x;
      const laplacian = (gray[index] * 4)
        - gray[index - 1]
        - gray[index + 1]
        - gray[index - width]
        - gray[index + width];
      laplacianSquaredTotal += laplacian * laplacian;
      laplacianCount += 1;
    }
  }

  const mean = brightnessTotal / gray.length;
  const detail = Math.max(0, (brightnessSquaredTotal / gray.length) - (mean * mean));
  const sharpness = Math.log1p(laplacianSquaredTotal / laplacianCount);
  return { detail, sharpness };
}

function resetFocusCalibration() {
  state.focusLastSample = 0;
  state.focusSamples = 0;
  state.focusScore = 0;
  state.focusBest = 0;
  state.focusMin = Infinity;
  focusHelperPanel.dataset.state = "checking";
  focusStatus.textContent = "Checking focus…";
  focusMeterFill.style.width = "0%";
}

function updateFocusFeedback(metrics) {
  state.focusSamples += 1;
  state.focusScore = state.focusSamples === 1
    ? metrics.sharpness
    : (state.focusScore * 0.72) + (metrics.sharpness * 0.28);
  state.focusBest = Math.max(state.focusScore, state.focusBest * 0.999);
  state.focusMin = Math.min(state.focusMin, state.focusScore);

  if (metrics.detail < 35) {
    focusHelperPanel.dataset.state = "searching";
    focusStatus.textContent = "Find a detailed area";
    focusMeterFill.style.width = "12%";
    return;
  }

  if (state.focusSamples < 6) {
    focusHelperPanel.dataset.state = "checking";
    focusStatus.textContent = "Checking focus…";
    focusMeterFill.style.width = `${Math.min(60, state.focusSamples * 10)}%`;
    return;
  }

  if (state.focusBest - state.focusMin < 0.1) {
    focusHelperPanel.dataset.state = "adjusting";
    focusStatus.textContent = "Turn the wheel to compare";
    focusMeterFill.style.width = "48%";
    return;
  }

  const focusRatio = state.focusBest ? state.focusScore / state.focusBest : 0;
  focusMeterFill.style.width = `${Math.max(18, Math.min(100, focusRatio * 100))}%`;
  if (focusRatio >= 0.93) {
    focusHelperPanel.dataset.state = "sharp";
    focusStatus.textContent = "Sharpest view!";
  } else if (focusRatio >= 0.75) {
    focusHelperPanel.dataset.state = "close";
    focusStatus.textContent = "Almost there…";
  } else {
    focusHelperPanel.dataset.state = "adjusting";
    focusStatus.textContent = "Turn the focus wheel slowly";
  }
}

function focusLoop(timestamp) {
  if (!state.focusHelper) return;
  state.focusFrame = window.requestAnimationFrame(focusLoop);
  if (timestamp - state.focusLastSample < 160) return;
  state.focusLastSample = timestamp;

  try {
    const metrics = focusMetrics();
    if (metrics) updateFocusFeedback(metrics);
  } catch {
    stopFocusHelper();
    showToast("Focus helper could not read this camera view.");
  }
}

function startFocusHelper() {
  if (!cameraIsLive()) {
    showToast("Power up the microscope before using focus helper.");
    return;
  }
  state.focusHelper = true;
  focusHelperButton.setAttribute("aria-pressed", "true");
  focusHelperPanel.hidden = false;
  viewerCard.classList.add("focus-helper-active");
  resetFocusCalibration();
  state.focusFrame = window.requestAnimationFrame(focusLoop);
  assistTip.textContent = "Turn the physical focus wheel slowly and watch the sharpness guide.";
}

function stopFocusHelper() {
  state.focusHelper = false;
  if (state.focusFrame !== null) window.cancelAnimationFrame(state.focusFrame);
  state.focusFrame = null;
  focusHelperButton.setAttribute("aria-pressed", "false");
  focusHelperPanel.hidden = true;
  viewerCard.classList.remove("focus-helper-active");
}

function toggleFocusHelper() {
  if (state.focusHelper) {
    stopFocusHelper();
    assistTip.textContent = "Focus helper is off. Your microscope view is unchanged.";
  } else {
    startFocusHelper();
  }
}

function calculateAutoEnhanceFilter() {
  const imageData = drawAnalysisFrame();
  if (!imageData) return null;
  const luminance = [];
  for (let offset = 0; offset < imageData.data.length; offset += 16) {
    luminance.push(
      (imageData.data[offset] * 0.299)
      + (imageData.data[offset + 1] * 0.587)
      + (imageData.data[offset + 2] * 0.114),
    );
  }
  luminance.sort((a, b) => a - b);
  const percentile = (fraction) => luminance[Math.floor((luminance.length - 1) * fraction)];
  const low = percentile(0.05);
  const middle = percentile(0.5);
  const high = percentile(0.95);
  const contrast = Math.max(1.02, Math.min(1.35, 225 / Math.max(45, high - low)));
  const brightness = Math.max(0.88, Math.min(1.18, 132 / Math.max(24, middle)));
  return `brightness(${brightness.toFixed(2)}) contrast(${contrast.toFixed(2)}) saturate(1.08)`;
}

function toggleAutoEnhance() {
  if (state.autoEnhance) {
    state.autoEnhance = false;
    state.autoEnhanceFilter = "none";
    autoEnhanceButton.setAttribute("aria-pressed", "false");
    applyVideoProcessing();
    assistTip.textContent = "Auto enhance is off. The natural camera image is restored.";
    showToast("Auto enhance switched off.");
    return;
  }

  if (!cameraIsLive()) {
    showToast("Power up the microscope before using auto enhance.");
    return;
  }

  const enhancement = calculateAutoEnhanceFilter();
  if (!enhancement) return;
  state.autoEnhance = true;
  state.autoEnhanceFilter = enhancement;
  autoEnhanceButton.setAttribute("aria-pressed", "true");
  applyVideoProcessing();
  assistTip.textContent = "Brightness and contrast were balanced for the current specimen.";
  showToast("Auto enhance balanced this microscope view.");
}

function visibleVideoCrop(targetAspect) {
  let width = video.videoWidth / state.zoom;
  let height = video.videoHeight / state.zoom;
  if (width / height > targetAspect) width = height * targetAspect;
  else height = width / targetAspect;
  return {
    x: (video.videoWidth - width) / 2,
    y: (video.videoHeight - height) / 2,
    width,
    height,
  };
}

function sobelEdgeImage(imageData, outputContext, intensity) {
  const { width, height, data } = imageData;
  const gray = new Uint8Array(width * height);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    gray[index] = Math.round(
      (data[offset] * 0.299) + (data[offset + 1] * 0.587) + (data[offset + 2] * 0.114),
    );
  }

  const output = outputContext.createImageData(width, height);
  const threshold = 82 - (intensity * 50);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width) + x;
      const topLeft = gray[index - width - 1];
      const top = gray[index - width];
      const topRight = gray[index - width + 1];
      const left = gray[index - 1];
      const right = gray[index + 1];
      const bottomLeft = gray[index + width - 1];
      const bottom = gray[index + width];
      const bottomRight = gray[index + width + 1];
      const gradientX = -topLeft + topRight - (2 * left) + (2 * right) - bottomLeft + bottomRight;
      const gradientY = -topLeft - (2 * top) - topRight + bottomLeft + (2 * bottom) + bottomRight;
      const magnitude = (Math.abs(gradientX) + Math.abs(gradientY)) / 4;
      if (magnitude <= threshold) continue;

      const outputOffset = index * 4;
      output.data[outputOffset] = 95;
      output.data[outputOffset + 1] = 242;
      output.data[outputOffset + 2] = 214;
      output.data[outputOffset + 3] = Math.min(225, (magnitude - threshold) * (2.2 + intensity));
    }
  }
  return output;
}

function drawEdgeSource(crop, width, height) {
  if (edgeSourceCanvas.width !== width || edgeSourceCanvas.height !== height) {
    edgeSourceCanvas.width = width;
    edgeSourceCanvas.height = height;
  }
  edgeSourceContext.clearRect(0, 0, width, height);
  edgeSourceContext.filter = "blur(0.7px)";
  edgeSourceContext.drawImage(
    video,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    width,
    height,
  );
  edgeSourceContext.filter = "none";
  return edgeSourceContext.getImageData(0, 0, width, height);
}

function renderLiveEdges() {
  const stage = $("#stage");
  const aspect = stage.clientWidth / stage.clientHeight;
  const height = 180;
  const width = Math.min(320, Math.round(height * aspect));
  if (edgeOverlay.width !== width || edgeOverlay.height !== height) {
    edgeOverlay.width = width;
    edgeOverlay.height = height;
  }
  const crop = visibleVideoCrop(width / height);
  const source = drawEdgeSource(crop, width, height);
  const edges = sobelEdgeImage(source, edgeOverlayContext, state.edgeIntensity);
  edgeOverlayContext.clearRect(0, 0, width, height);
  edgeOverlayContext.putImageData(edges, 0, 0);
}

function edgeLoop(timestamp) {
  if (!state.edgeHighlight) return;
  state.edgeFrame = window.requestAnimationFrame(edgeLoop);
  if (timestamp - state.edgeLastSample < 80) return;
  state.edgeLastSample = timestamp;
  try {
    renderLiveEdges();
  } catch {
    stopEdgeHighlight();
    showToast("Edge Explorer could not process this camera view.");
  }
}

function startEdgeHighlight() {
  if (!cameraIsLive()) {
    showToast("Power up the microscope before using Edge Explorer.");
    return;
  }
  state.edgeHighlight = true;
  state.edgeLastSample = 0;
  edgeHighlightButton.setAttribute("aria-pressed", "true");
  edgeIntensityControl.hidden = false;
  edgeOverlay.hidden = false;
  state.edgeFrame = window.requestAnimationFrame(edgeLoop);
  assistTip.textContent = "Mint outlines reveal strong boundaries generated from the live image.";
}

function stopEdgeHighlight() {
  state.edgeHighlight = false;
  if (state.edgeFrame !== null) window.cancelAnimationFrame(state.edgeFrame);
  state.edgeFrame = null;
  edgeHighlightButton.setAttribute("aria-pressed", "false");
  edgeIntensityControl.hidden = true;
  edgeOverlay.hidden = true;
  edgeOverlayContext.clearRect(0, 0, edgeOverlay.width, edgeOverlay.height);
}

function toggleEdgeHighlight() {
  if (state.edgeHighlight) {
    stopEdgeHighlight();
    assistTip.textContent = "Edge Explorer is off. The generated outlines were removed.";
    showToast("Edge Explorer switched off.");
  } else {
    startEdgeHighlight();
  }
}

function applyCaptureEdges(targetContext, crop, width, height) {
  const source = drawEdgeSource(crop, width, height);
  captureEdgeCanvas.width = width;
  captureEdgeCanvas.height = height;
  const edges = sobelEdgeImage(source, captureEdgeContext, state.edgeIntensity);
  captureEdgeContext.clearRect(0, 0, width, height);
  captureEdgeContext.putImageData(edges, 0, 0);
  targetContext.save();
  targetContext.filter = "none";
  targetContext.drawImage(captureEdgeCanvas, 0, 0);
  targetContext.restore();
}

function resetProcessingTools() {
  stopFocusHelper();
  stopEdgeHighlight();
  state.autoEnhance = false;
  state.autoEnhanceFilter = "none";
  autoEnhanceButton.setAttribute("aria-pressed", "false");
  focusHelperButton.disabled = true;
  autoEnhanceButton.disabled = true;
  edgeHighlightButton.disabled = true;
  assistTip.textContent = "Connect the microscope to use discovery helpers.";
  applyVideoProcessing();
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
  context.filter = activeVideoFilter();
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
  if (state.edgeHighlight) {
    applyCaptureEdges(
      context,
      { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
      outputWidth,
      outputHeight,
    );
  }

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
    enhancements: [
      ...(videoFilterLabels[state.filter] ? [videoFilterLabels[state.filter]] : []),
      ...(state.autoEnhance ? ["Auto enhanced"] : []),
      ...(state.edgeHighlight ? ["Edge highlight"] : []),
    ],
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
  const timeLabel = snapshot.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.textContent = snapshot.enhancements?.length
    ? `${timeLabel} • ${snapshot.enhancements.join(" + ")}`
    : timeLabel;
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
  const processingNote = snapshot.enhancements?.length
    ? `Enhanced view: ${snapshot.enhancements.join(" + ")}`
    : "Captured through the microscope";
  context.fillText(processingNote, x + 34, infoY + 91);
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

function fittedCanvasFont(context, text, maxWidth, startSize, minSize, weight = 800) {
  let size = startSize;
  context.font = `${weight} ${size}px "Arial", sans-serif`;
  while (size > minSize && context.measureText(text).width > maxWidth) {
    size -= 1;
    context.font = `${weight} ${size}px "Arial", sans-serif`;
  }
  return size;
}

async function renderCertificatePdfPage(explorerName, organizerName, pageIndex, pageCount) {
  const canvasPage = document.createElement("canvas");
  canvasPage.width = 1240;
  canvasPage.height = 1754;
  const context = canvasPage.getContext("2d", { alpha: false });

  context.fillStyle = "#f6f1e7";
  context.fillRect(0, 0, canvasPage.width, canvasPage.height);
  context.fillStyle = "#071b33";
  context.fillRect(0, 0, canvasPage.width, 200);

  context.fillStyle = "rgba(95, 242, 214, 0.14)";
  context.beginPath();
  context.arc(1135, 45, 145, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "rgba(255, 107, 157, 0.18)";
  context.beginPath();
  context.arc(100, 1620, 120, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = "#7657ff";
  context.lineWidth = 4;
  context.setLineDash([14, 12]);
  roundedRectPath(context, 62, 242, 1116, 1370, 38);
  context.stroke();
  context.setLineDash([]);

  context.textAlign = "center";
  context.fillStyle = "#5ff2d6";
  context.font = '800 20px "Arial", sans-serif';
  context.fillText("MICROEXPLORER - CERTIFICATE OF DISCOVERY", 620, 62);
  context.fillStyle = "#ffffff";
  context.font = '800 48px "Arial", sans-serif';
  context.fillText("Tiny discoveries. Big achievement!", 620, 132);

  context.fillStyle = "#e9e4ff";
  context.beginPath();
  context.arc(620, 375, 92, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "#7657ff";
  context.lineWidth = 5;
  context.beginPath();
  context.arc(620, 375, 72, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = "#5438d7";
  context.font = '800 68px "Arial", sans-serif';
  context.fillText("✦", 620, 399);

  context.fillStyle = "#5438d7";
  context.font = '800 22px "Arial", sans-serif';
  context.fillText("CONGRATULATIONS", 620, 520);

  context.fillStyle = "#071b33";
  fittedCanvasFont(context, explorerName, 950, 76, 40, 800);
  context.fillText(explorerName, 620, 610);

  context.fillStyle = "#718095";
  context.font = '700 22px "Arial", sans-serif';
  context.fillText("YOU ARE NOW AN", 620, 680);

  context.fillStyle = "#7657ff";
  roundedRectPath(context, 160, 718, 920, 170, 34);
  context.fill();
  context.fillStyle = "#ffffff";
  fittedCanvasFont(context, "Official MicroExplorer", 820, 58, 38, 800);
  context.fillText("Official MicroExplorer", 620, 820);

  context.fillStyle = "#46566a";
  context.font = '600 25px "Arial", sans-serif';
  context.fillText("Recognised for exploring, observing, and capturing", 620, 980);
  context.fillText("the tiny worlds all around us.", 620, 1018);

  context.fillStyle = "#718095";
  context.font = '800 18px "Arial", sans-serif';
  context.fillText("PRESENTED BY", 620, 1135);
  context.fillStyle = "#071b33";
  fittedCanvasFont(context, organizerName, 900, 42, 26, 800);
  context.fillText(organizerName, 620, 1192);

  context.fillStyle = "#718095";
  context.font = '600 20px "Arial", sans-serif';
  context.fillText(
    new Date().toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" }),
    620,
    1250,
  );

  context.fillStyle = "#fff7db";
  roundedRectPath(context, 245, 1345, 750, 118, 24);
  context.fill();
  context.fillStyle = "#716333";
  context.font = '700 22px "Arial", sans-serif';
  context.fillText("Keep looking closely. Stay curious.", 620, 1415);

  context.textAlign = "left";
  context.fillStyle = "#718095";
  context.font = '600 17px "Arial", sans-serif';
  context.fillText("MicroExplorer Discovery Reel", 90, 1690);
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

function readStoredOrganizer(storage) {
  try {
    return storage.getItem(organizerStorageKey) || "";
  } catch {
    return "";
  }
}

function removeStoredOrganizer(storage) {
  try {
    storage.removeItem(organizerStorageKey);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

function writeStoredOrganizer(storage, organizerName) {
  try {
    storage.setItem(organizerStorageKey, organizerName);
    return true;
  } catch {
    return false;
  }
}

function openExportDialog() {
  if (!state.snapshots.length) {
    showToast("Take at least one snapshot before making a PDF.");
    return;
  }

  const rememberedOrganizer = readStoredOrganizer(localStorage);
  const sessionOrganizer = readStoredOrganizer(sessionStorage);
  exportExplorerName.value = "";
  exportOrganizerName.value = rememberedOrganizer || sessionOrganizer || "";
  rememberOrganizer.checked = Boolean(rememberedOrganizer);
  forgetOrganizerButton.hidden = !(rememberedOrganizer || sessionOrganizer);
  exportExplorerName.setCustomValidity("");
  exportOrganizerName.setCustomValidity("");
  exportDialog.showModal();
  window.setTimeout(() => exportExplorerName.focus(), 0);
}

function forgetOrganizer() {
  removeStoredOrganizer(localStorage);
  removeStoredOrganizer(sessionStorage);
  state.organizerName = "";
  exportOrganizerName.value = "";
  rememberOrganizer.checked = false;
  forgetOrganizerButton.hidden = true;
  exportOrganizerName.focus();
  showToast("Organizer forgotten on this device.");
}

async function generateDiscoveryPdf(explorerName, organizerName) {

  state.explorerName = explorerName;
  state.organizerName = organizerName;
  downloadPdfButton.disabled = true;
  setPdfButtonLabel("Creating PDF…");

  try {
    await document.fonts?.ready;
    const snapshots = [...state.snapshots];
    const discoveryPageCount = Math.ceil(snapshots.length / 2);
    const pageCount = discoveryPageCount + 1;
    const jpegPages = [];

    for (let pageIndex = 0; pageIndex < discoveryPageCount; pageIndex += 1) {
      jpegPages.push(await renderDiscoveryPdfPage(
        snapshots.slice(pageIndex * 2, (pageIndex * 2) + 2),
        pageIndex,
        pageCount,
        explorerName,
      ));
    }
    jpegPages.push(await renderCertificatePdfPage(
      explorerName,
      organizerName,
      discoveryPageCount,
      pageCount,
    ));

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
    state.explorerName = "";
    exportExplorerName.value = "";
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
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else if (viewerCard.requestFullscreen) {
      await viewerCard.requestFullscreen();
    } else if (viewerCard.webkitRequestFullscreen) {
      viewerCard.webkitRequestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
      showToast("This browser uses its own video fullscreen controls.");
    } else {
      showToast("Fullscreen is not available in this browser.");
    }
  } catch {
    showToast("Fullscreen could not open this time.");
  }
}

function updateFullscreenControls() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  const isFullscreen = fullscreenElement === viewerCard;
  viewerCard.classList.toggle("fullscreen-active", isFullscreen);
  fullscreenButton.setAttribute("aria-label", isFullscreen
    ? "Exit microscope fullscreen view"
    : "Open microscope view fullscreen");
  fullscreenButton.title = isFullscreen ? "Exit fullscreen" : "Fullscreen view";
  fullscreenButton.querySelector("span").textContent = isFullscreen ? "×" : "⛶";
}

connectButton.addEventListener("click", () => connectCamera(cameraSelect.value));
cameraSelect.addEventListener("change", () => connectCamera(cameraSelect.value));
captureButton.addEventListener("click", captureDiscovery);
fullscreenButton.addEventListener("click", openFullscreen);
document.addEventListener("fullscreenchange", updateFullscreenControls);
document.addEventListener("webkitfullscreenchange", updateFullscreenControls);
zoomSlider.addEventListener("input", (event) => setZoom(event.target.value));
focusHelperButton.addEventListener("click", toggleFocusHelper);
autoEnhanceButton.addEventListener("click", toggleAutoEnhance);
edgeHighlightButton.addEventListener("click", toggleEdgeHighlight);
edgeIntensity.addEventListener("input", (event) => {
  state.edgeIntensity = Number(event.target.value);
  assistTip.textContent = "Edge intensity changes how many generated outlines are visible.";
});

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

exportForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const explorerName = exportExplorerName.value.trim().replace(/\s+/g, " ").slice(0, 60);
  const organizerName = exportOrganizerName.value.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!explorerName) {
    exportExplorerName.setCustomValidity("Add the explorer's name first.");
    exportExplorerName.reportValidity();
    return;
  }
  if (!organizerName) {
    exportOrganizerName.setCustomValidity("Add the event organizer first.");
    exportOrganizerName.reportValidity();
    return;
  }

  writeStoredOrganizer(sessionStorage, organizerName);
  if (rememberOrganizer.checked) writeStoredOrganizer(localStorage, organizerName);
  else removeStoredOrganizer(localStorage);
  forgetOrganizerButton.hidden = false;
  exportDialog.close();
  void generateDiscoveryPdf(explorerName, organizerName);
});

exportExplorerName.addEventListener("input", () => exportExplorerName.setCustomValidity(""));
exportOrganizerName.addEventListener("input", () => exportOrganizerName.setCustomValidity(""));
forgetOrganizerButton.addEventListener("click", forgetOrganizer);
$("#cancelExportButton").addEventListener("click", () => {
  exportExplorerName.value = "";
  exportDialog.close();
});
exportDialog.addEventListener("cancel", () => {
  exportExplorerName.value = "";
});

snapshotGrid.addEventListener("click", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("[data-delete-snapshot]")
    : null;
  if (button) deleteSnapshot(button.dataset.deleteSnapshot);
});

clearSnapshotsButton.addEventListener("click", clearSnapshots);
downloadPdfButton.addEventListener("click", openExportDialog);

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
