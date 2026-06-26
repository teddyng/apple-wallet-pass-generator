const state = {
  activeTab: "details",
  signingMode: "p12",
  previewMode: "pass",
  files: {},
  statusLockedUntil: 0,
  primaryFields: [
    { key: "reward", label: "Reward", value: "Free Coffee" }
  ],
  secondaryFields: [
    { key: "member", label: "Member", value: "Taylor Smith" },
    { key: "points", label: "Points", value: "1280" }
  ],
  auxiliaryFields: [
    { key: "tier", label: "Tier", value: "Gold" }
  ],
  backFields: [
    { key: "terms", label: "Terms", value: "Valid at participating locations." }
  ]
};

const fieldKinds = ["primaryFields", "secondaryFields", "auxiliaryFields", "backFields"];
const IMAGE_FILE_LIMIT = 8 * 1024 * 1024;
const SIGNING_FILE_LIMIT = 5 * 1024 * 1024;
const MAX_BULK_ROWS = 50;
const imagePreviewKeys = new Set(["icon", "logo", "strip", "thumbnail", "background", "footer"]);
const signingFileKeys = new Set(["p12", "wwdrP12", "certificate", "privateKey", "wwdrPem"]);

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function read(id) {
  return $(`#${id}`).value.trim();
}

function checked(id) {
  return $(`#${id}`).checked;
}

function setStatus(message, tone = "") {
  const status = $("#statusText");
  status.textContent = message;
  status.classList.toggle("is-error", tone === "error");
  status.classList.toggle("is-success", tone === "success");
}

function lockStatus(message, tone = "", durationMs = 0) {
  state.statusLockedUntil = durationMs ? Date.now() + durationMs : 0;
  setStatus(message, tone);
}

function hasText(id) {
  const input = $(`#${id}`);
  return Boolean(input && input.value.trim());
}

function hasFile(key) {
  return Boolean(state.files[key]);
}

function hasPemText(id) {
  return Boolean($(`#${id}`) && $(`#${id}`).value.trim());
}

function statusFromState() {
  if (!hasText("passTypeIdentifier")) return "Add Pass Type Identifier";
  if (!hasText("teamIdentifier")) return "Add Team Identifier";
  if (!hasText("organizationName")) return "Add Organization Name";
  if (checked("barcodeEnabled") && !hasText("barcodeMessage")) return "Add barcode message";

  if (state.signingMode === "p12") {
    if (!hasFile("p12")) return "Add P12 certificate";
    if (!hasFile("wwdrP12")) return "Add WWDR certificate";
  } else {
    if (!hasFile("certificate") && !hasPemText("certificateText")) return "Add signing certificate";
    if (!hasFile("privateKey") && !hasPemText("privateKeyText")) return "Add private key";
    if (!hasFile("wwdrPem") && !hasPemText("wwdrText")) return "Add WWDR certificate";
  }

  return "Ready to generate";
}

function syncStatus() {
  if (Date.now() < state.statusLockedUntil) return;
  const message = statusFromState();
  setStatus(message, message === "Ready to generate" ? "success" : "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function styleName(value) {
  return {
    generic: "Generic",
    coupon: "Coupon",
    storeCard: "Store Card",
    eventTicket: "Event Ticket",
    boardingPass: "Boarding"
  }[value] || "Generic";
}

function fieldMarkup(field, isPrimary = false) {
  const label = field.label || field.key || "Field";
  const value = field.value || "";
  return `
    <div class="preview-field ${isPrimary ? "is-primary" : ""}">
      <span class="preview-label">${escapeHtml(label)}</span>
      <span class="preview-value">${escapeHtml(value)}</span>
    </div>
  `;
}

function renderFieldRows(kind) {
  const container = $(`#${kind}`);
  container.innerHTML = state[kind].map((field, index) => `
    <div class="field-row" data-kind="${kind}" data-index="${index}">
      <label>
        <span>Key</span>
        <input data-field="key" value="${escapeHtml(field.key || "")}" autocomplete="off">
      </label>
      <label>
        <span>Label</span>
        <input data-field="label" value="${escapeHtml(field.label || "")}">
      </label>
      <label>
        <span>Value</span>
        <input data-field="value" value="${escapeHtml(field.value || "")}">
      </label>
      <button type="button" class="icon-button remove" data-remove="${kind}" data-index="${index}" aria-label="Remove field" title="Remove field">×</button>
    </div>
  `).join("");
}

function renderAllFieldRows() {
  fieldKinds.forEach(renderFieldRows);
}

function passJsonPreview() {
  const style = read("passStyle");
  const pass = {
    formatVersion: 1,
    passTypeIdentifier: read("passTypeIdentifier"),
    serialNumber: read("serialNumber"),
    teamIdentifier: read("teamIdentifier"),
    organizationName: read("organizationName"),
    description: read("description"),
    logoText: read("logoText"),
    foregroundColor: colorAsRgb(read("foregroundColor")),
    labelColor: colorAsRgb(read("labelColor")),
    backgroundColor: colorAsRgb(read("backgroundColor"))
  };

  const relevantDate = read("relevantDate");
  if (relevantDate) pass.relevantDate = new Date(relevantDate).toISOString();

  const expirationDate = read("expirationDate");
  if (expirationDate) pass.expirationDate = new Date(expirationDate).toISOString();

  if (checked("sharingProhibited")) pass.sharingProhibited = true;
  if (checked("voided")) pass.voided = true;

  const stylePayload = {
    primaryFields: state.primaryFields.filter((field) => field.value),
    secondaryFields: state.secondaryFields.filter((field) => field.value),
    auxiliaryFields: state.auxiliaryFields.filter((field) => field.value),
    backFields: state.backFields.filter((field) => field.value)
  };
  if (style === "boardingPass") stylePayload.transitType = read("transitType");
  pass[style] = stylePayload;

  if (checked("barcodeEnabled") && read("barcodeMessage")) {
    const barcode = {
      format: read("barcodeFormat"),
      message: read("barcodeMessage"),
      messageEncoding: read("barcodeEncoding") || "iso-8859-1"
    };
    if (read("barcodeAltText")) barcode.altText = read("barcodeAltText");
    pass.barcode = barcode;
    pass.barcodes = [barcode];
  }

  const storeIds = read("associatedStoreIdentifiers")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  if (storeIds.length) pass.associatedStoreIdentifiers = storeIds;

  const latitude = Number(read("locationLatitude"));
  const longitude = Number(read("locationLongitude"));
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    pass.locations = [{ latitude, longitude }];
    if (read("locationText")) pass.locations[0].relevantText = read("locationText");
  }

  return pass;
}

function colorAsRgb(hex) {
  const clean = String(hex || "#000000").replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function cellHash(seed, x, y = 0) {
  return hashString(`${seed}:${x}:${y}`);
}

function prepareBarcodeCanvas(width, height) {
  const canvas = $("#barcodeCanvas");
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111111";
  return { context, width, height };
}

function fillModule(context, start, cell, x, y, size = 1) {
  context.fillRect(
    Math.round(start + x * cell),
    Math.round(start + y * cell),
    Math.ceil(cell * size),
    Math.ceil(cell * size)
  );
}

function drawFinder(context, start, cell, x, y) {
  context.fillStyle = "#111111";
  fillModule(context, start, cell, x, y, 7);
  context.fillStyle = "#ffffff";
  fillModule(context, start, cell, x + 1, y + 1, 5);
  context.fillStyle = "#111111";
  fillModule(context, start, cell, x + 2, y + 2, 3);
}

function inQrFinderArea(x, y, modules) {
  return (
    (x < 8 && y < 8) ||
    (x >= modules - 8 && y < 8) ||
    (x < 8 && y >= modules - 8)
  );
}

function drawQrPreview(message, format) {
  const { context, width } = prepareBarcodeCanvas(156, 156);
  const modules = 29;
  const cell = Math.floor((width - 18) / modules);
  const start = Math.floor((width - cell * modules) / 2);
  const seed = `${format}:${message}`;

  context.fillStyle = "#111111";
  for (let y = 0; y < modules; y += 1) {
    for (let x = 0; x < modules; x += 1) {
      if (inQrFinderArea(x, y, modules)) continue;
      if ((cellHash(seed, x, y) % 9) < 4) fillModule(context, start, cell, x, y);
    }
  }

  drawFinder(context, start, cell, 0, 0);
  drawFinder(context, start, cell, modules - 7, 0);
  drawFinder(context, start, cell, 0, modules - 7);
}

function drawAztecPreview(message) {
  const { context, width } = prepareBarcodeCanvas(156, 156);
  const modules = 31;
  const cell = Math.floor((width - 18) / modules);
  const start = Math.floor((width - cell * modules) / 2);
  const center = Math.floor(modules / 2);
  const seed = `aztec:${message}`;

  context.fillStyle = "#111111";
  for (let y = 0; y < modules; y += 1) {
    for (let x = 0; x < modules; x += 1) {
      const inCenter = Math.abs(x - center) <= 5 && Math.abs(y - center) <= 5;
      if (!inCenter && (cellHash(seed, x, y) % 10) < 4) {
        fillModule(context, start, cell, x, y);
      }
    }
  }

  for (let ring = 5; ring >= 0; ring -= 1) {
    context.fillStyle = ring % 2 === 0 ? "#111111" : "#ffffff";
    fillModule(context, start, cell, center - ring, center - ring, ring * 2 + 1);
  }
}

function drawPdf417Preview(message) {
  const { context, width, height } = prepareBarcodeCanvas(190, 86);
  const rows = 5;
  const margin = 10;
  const rowHeight = (height - margin * 2) / rows;
  const unit = (width - margin * 2) / 74;
  const seed = `pdf417:${message}`;

  context.fillStyle = "#111111";
  for (let row = 0; row < rows; row += 1) {
    const top = margin + row * rowHeight;
    context.fillRect(margin, top, unit * 2, rowHeight * 0.78);
    context.fillRect(width - margin - unit * 2, top, unit * 2, rowHeight * 0.78);

    let x = margin + unit * 5;
    let column = 0;
    while (x < width - margin - unit * 5) {
      const darkWidth = 1 + (cellHash(seed, column, row) % 4);
      const lightWidth = 1 + (cellHash(seed, column + 91, row) % 3);
      context.fillRect(x, top, Math.max(1, darkWidth * unit), rowHeight * 0.78);
      x += (darkWidth + lightWidth) * unit;
      column += 1;
    }
  }
}

function drawCode128Preview(message) {
  const { context, width, height } = prepareBarcodeCanvas(190, 76);
  const margin = 12;
  const seed = `code128:${message}`;
  let x = margin;
  let column = 0;

  context.fillStyle = "#111111";
  for (const widthUnit of [2, 1, 1, 2, 1, 2]) {
    context.fillRect(x, margin, widthUnit * 2, height - margin * 2);
    x += widthUnit * 4;
  }

  while (x < width - margin - 12) {
    const barWidth = 1 + (cellHash(seed, column) % 4);
    const gapWidth = 1 + (cellHash(seed, column + 53) % 3);
    context.fillRect(x, margin, barWidth * 2, height - margin * 2);
    x += (barWidth + gapWidth) * 2;
    column += 1;
  }

  context.fillRect(width - margin - 8, margin, 3, height - margin * 2);
  context.fillRect(width - margin - 2, margin, 2, height - margin * 2);
}

function updateBarcodePreview() {
  const barcodeEnabled = checked("barcodeEnabled") && read("barcodeMessage");
  $("#barcodePreview").classList.toggle("is-hidden", !barcodeEnabled);
  $("#previewBarcodeText").textContent = read("barcodeAltText") || read("barcodeMessage");

  if (!barcodeEnabled) return;

  const format = read("barcodeFormat");
  const message = read("barcodeMessage");
  if (format === "PKBarcodeFormatPDF417") {
    drawPdf417Preview(message);
  } else if (format === "PKBarcodeFormatCode128") {
    drawCode128Preview(message);
  } else if (format === "PKBarcodeFormatAztec") {
    drawAztecPreview(message);
  } else {
    drawQrPreview(message, format);
  }
}

function updatePreview() {
  const passPreview = $("#passPreview");
  const foregroundColor = read("foregroundColor");
  const labelColor = read("labelColor");

  passPreview.style.backgroundColor = read("backgroundColor");
  passPreview.style.color = foregroundColor;
  passPreview.querySelectorAll(".preview-value").forEach((node) => {
    node.style.color = foregroundColor;
  });
  passPreview.querySelectorAll(".preview-label").forEach((node) => {
    node.style.color = labelColor;
  });

  $("#previewLogoText").textContent = read("logoText") || read("organizationName") || "PASS";
  $("#previewStyle").textContent = styleName(read("passStyle"));

  const primary = state.primaryFields.filter((field) => field.value);
  const secondary = [...state.secondaryFields, ...state.auxiliaryFields].filter((field) => field.value);

  $("#previewPrimary").innerHTML = (primary.length ? primary : [{ label: "Primary", value: "Value" }])
    .slice(0, 2)
    .map((field) => fieldMarkup(field, true))
    .join("");

  $("#previewSecondary").innerHTML = secondary
    .slice(0, 4)
    .map((field) => fieldMarkup(field))
    .join("");

  updateBarcodePreview();
  $("#jsonPreview").textContent = JSON.stringify(passJsonPreview(), null, 2);
  syncStatus();
}

function activateTab(tabName) {
  state.activeTab = tabName;
  $$(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === tabName));
  $$(".panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === tabName));
}

function activateSigningMode(mode) {
  state.signingMode = mode;
  $$(".segment-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.signingMode === mode);
  });
  $$(".signing-mode").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.signingPanel === mode);
  });
}

function activatePreview(mode) {
  state.previewMode = mode;
  $$(".preview-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.preview === mode);
  });
  $$(".preview-view").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.previewPanel === mode);
  });
}

function fileToPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let binary = "";
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }
      resolve({
        name: file.name,
        type: file.type || "application/octet-stream",
        data: btoa(binary)
      });
    };
    reader.readAsArrayBuffer(file);
  });
}

function updateImageUploadPreview(fileKey, payload) {
  if (!imagePreviewKeys.has(fileKey)) return;

  const preview = $(`[data-image-preview="${fileKey}"]`);
  if (!preview) return;

  const image = $("img", preview);
  const hasImage = Boolean(payload && payload.data);
  preview.classList.toggle("is-empty", !hasImage);

  if (image) {
    image.src = hasImage ? `data:${payload.type || "image/png"};base64,${payload.data}` : "";
  }
}

async function bindFileInput(inputId, fileKey, displayKey) {
  const input = $(`#${inputId}`);
  const label = $(`[data-file-name="${displayKey || fileKey}"]`);
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) {
      state.files[fileKey] = null;
      if (label) label.textContent = "None";
      updateImageUploadPreview(fileKey, null);
      return;
    }

    try {
      const limit = signingFileKeys.has(fileKey) ? SIGNING_FILE_LIMIT : IMAGE_FILE_LIMIT;
      if (file.size > limit) {
        throw new Error(`${file.name} is too large. Max size is ${Math.round(limit / 1024 / 1024)} MB.`);
      }
      state.files[fileKey] = await fileToPayload(file);
      if (label) label.textContent = file.name;
      updateImageUploadPreview(fileKey, state.files[fileKey]);
      syncStatus();
    } catch (error) {
      state.files[fileKey] = null;
      if (label) label.textContent = "Unreadable";
      updateImageUploadPreview(fileKey, null);
      lockStatus(error.message, "error", 8000);
    }
  });
}

function textPayload(value) {
  const text = String(value || "").trim();
  return text ? { text } : null;
}

function collectPayload() {
  const location = {
    latitude: read("locationLatitude"),
    longitude: read("locationLongitude"),
    relevantText: read("locationText")
  };

  const payload = {
    pass: {
      passStyle: read("passStyle"),
      transitType: read("transitType"),
      passTypeIdentifier: read("passTypeIdentifier"),
      teamIdentifier: read("teamIdentifier"),
      organizationName: read("organizationName"),
      serialNumber: read("serialNumber"),
      description: read("description"),
      logoText: read("logoText"),
      relevantDate: read("relevantDate"),
      expirationDate: read("expirationDate"),
      associatedStoreIdentifiers: read("associatedStoreIdentifiers"),
      sharingProhibited: checked("sharingProhibited"),
      voided: checked("voided")
    },
    colors: {
      backgroundColor: read("backgroundColor"),
      foregroundColor: read("foregroundColor"),
      labelColor: read("labelColor")
    },
    primaryFields: state.primaryFields,
    secondaryFields: state.secondaryFields,
    auxiliaryFields: state.auxiliaryFields,
    backFields: state.backFields,
    barcode: {
      enabled: checked("barcodeEnabled"),
      format: read("barcodeFormat"),
      message: read("barcodeMessage"),
      encoding: read("barcodeEncoding"),
      altText: read("barcodeAltText")
    },
    locations: location.latitude && location.longitude ? [location] : [],
    images: {
      icon: state.files.icon || null,
      logo: state.files.logo || null,
      strip: state.files.strip || null,
      thumbnail: state.files.thumbnail || null,
      background: state.files.background || null,
      footer: state.files.footer || null
    },
    signing: {
      mode: state.signingMode
    }
  };

  if (state.signingMode === "p12") {
    payload.signing.p12 = state.files.p12 || null;
    payload.signing.p12Password = read("p12Password");
    payload.signing.wwdrCertificate = state.files.wwdrP12 || null;
  } else {
    payload.signing.certificate = state.files.certificate || textPayload(read("certificateText"));
    payload.signing.privateKey = state.files.privateKey || textPayload(read("privateKeyText"));
    payload.signing.wwdrCertificate = state.files.wwdrPem || textPayload(read("wwdrText"));
    payload.signing.privateKeyPassphrase = read("privateKeyPassphrase");
  }

  return payload;
}

function parseCsvTable(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);
  return rows.filter((item) => item.some((value) => value.trim()));
}

function parseBulkRows() {
  const raw = $("#bulkRows").value;
  const table = parseCsvTable(raw);
  if (table.length < 2) return [];

  const headers = table[0].map((header) => header.trim());
  return table.slice(1)
    .map((cells) => {
      const row = {};
      headers.forEach((header, index) => {
        if (!header) return;
        row[header] = String(cells[index] || "").trim();
      });
      return row;
    })
    .filter((row) => Object.values(row).some((value) => String(value).trim()));
}

function updateBulkCount() {
  const count = $("#bulkCount");
  if (!count) return;
  const rows = parseBulkRows();
  const label = rows.length === 1 ? "row" : "rows";
  count.textContent = `${rows.length} ${label}`;
  count.classList.toggle("is-error", rows.length > MAX_BULK_ROWS);
}

function filenameFromResponse(response, fallback) {
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  return match ? match[1] : fallback;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function responseError(response, fallback) {
  const text = await response.text();
  try {
    const payload = JSON.parse(text);
    if (payload.error) return new Error(payload.error);
  } catch {
    // Plain text errors are still useful when the server did not return JSON.
  }
  return new Error(text || fallback);
}

async function generatePass() {
  const button = $("#generateButton");
  button.disabled = true;
  lockStatus("Generating...", "", 120000);

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectPayload())
    });

    if (!response.ok) {
      throw await responseError(response, "Could not generate pass.");
    }

    const blob = await response.blob();
    const filename = filenameFromResponse(response, `${read("serialNumber") || "wallet-pass"}.pkpass`);
    downloadBlob(blob, filename);
    lockStatus(`Downloaded ${filename}`, "success", 6000);
    window.setTimeout(syncStatus, 6500);
  } catch (error) {
    lockStatus(error.message || "Could not generate pass.", "error", 8000);
    window.setTimeout(syncStatus, 8500);
  } finally {
    button.disabled = false;
  }
}

async function generateBulkPasses() {
  const button = $("#bulkGenerateButton");
  const rows = parseBulkRows();

  if (!rows.length) {
    lockStatus("Add bulk CSV rows first.", "error", 7000);
    window.setTimeout(syncStatus, 7500);
    return;
  }

  if (rows.length > MAX_BULK_ROWS) {
    lockStatus(`Bulk creation is limited to ${MAX_BULK_ROWS} passes at a time.`, "error", 7000);
    window.setTimeout(syncStatus, 7500);
    return;
  }

  button.disabled = true;
  lockStatus(`Generating ${rows.length} passes...`, "", 180000);

  try {
    const response = await fetch("/api/generate-bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template: collectPayload(),
        rows
      })
    });

    if (!response.ok) {
      throw await responseError(response, "Could not generate bulk passes.");
    }

    const blob = await response.blob();
    const filename = filenameFromResponse(response, "wallet-passes.zip");
    downloadBlob(blob, filename);
    lockStatus(`Downloaded ${filename}`, "success", 6000);
    window.setTimeout(syncStatus, 6500);
  } catch (error) {
    lockStatus(error.message || "Could not generate bulk passes.", "error", 9000);
    window.setTimeout(syncStatus, 9500);
  } finally {
    button.disabled = false;
  }
}

async function loadCurrentUser() {
  try {
    const response = await fetch("/api/me");
    if (!response.ok) return;
    const user = await response.json();
    const adminLink = $("#adminLink");
    if (adminLink) {
      adminLink.classList.toggle("is-hidden", user.role !== "admin");
    }
  } catch {
    // The protected page still works if this small enhancement fails.
  }
}

function bindEvents() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });

  $$(".segment-button").forEach((button) => {
    button.addEventListener("click", () => activateSigningMode(button.dataset.signingMode));
  });

  $$(".preview-tab").forEach((button) => {
    button.addEventListener("click", () => activatePreview(button.dataset.preview));
  });

  $("#generateButton").addEventListener("click", generatePass);
  $("#bulkGenerateButton").addEventListener("click", generateBulkPasses);

  $("#passForm").addEventListener("input", (event) => {
    const row = event.target.closest(".field-row");
    if (row && event.target.dataset.field) {
      const { kind, index } = row.dataset;
      state[kind][Number(index)][event.target.dataset.field] = event.target.value;
    }

    if (event.target.id === "bulkRows") updateBulkCount();

    const isBoarding = read("passStyle") === "boardingPass";
    $$(".boarding-only").forEach((node) => node.classList.toggle("is-hidden", !isBoarding));
    updatePreview();
  });

  $("#passForm").addEventListener("change", updatePreview);

  $$(".add-field").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.kind;
      state[kind].push({ key: "", label: "", value: "" });
      renderFieldRows(kind);
      updatePreview();
    });
  });

  $("#passForm").addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove]");
    if (!removeButton) return;
    const kind = removeButton.dataset.remove;
    state[kind].splice(Number(removeButton.dataset.index), 1);
    renderFieldRows(kind);
    updatePreview();
  });

  bindFileInput("iconFile", "icon");
  bindFileInput("logoFile", "logo");
  bindFileInput("stripFile", "strip");
  bindFileInput("thumbnailFile", "thumbnail");
  bindFileInput("backgroundFile", "background");
  bindFileInput("footerFile", "footer");
  bindFileInput("p12File", "p12");
  bindFileInput("wwdrFileP12", "wwdrP12");
  bindFileInput("certificateFile", "certificate");
  bindFileInput("privateKeyFile", "privateKey");
  bindFileInput("wwdrFilePem", "wwdrPem");
}

renderAllFieldRows();
bindEvents();
loadCurrentUser();
updateBulkCount();
updatePreview();
