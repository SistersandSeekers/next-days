let replenData = {};
let prioritizeB = false; // Controlled by the checkbox
let latestRows = [];

function normalizeHeader(header) {
  return String(header || "")
    .replace(/^\uFEFF/, "")
    .replace(/^"+|"+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function splitPastedRow(row) {
  if (row.includes("\t")) {
    return row.split("\t");
  }
  return row.trim().split(/\s{2,}/);
}

// --- File handling for Replenishment CSV ---
const dropArea = document.getElementById("drop-area");
const fileInput = document.getElementById("csvFile");
const fileNameDisplay = document.getElementById("file-name");

fileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) {
    fileNameDisplay.textContent = `Selected file: ${file.name}`;
    handleFile(file);
  }
});

["dragenter", "dragover"].forEach((eventName) => {
  dropArea.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropArea.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.remove("dragover");
  });
});

dropArea.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) {
    fileNameDisplay.textContent = `Selected file: ${file.name}`;
    handleFile(file);
  }
});

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = function (e) {
    const content = e.target.result;
    replenData = parseCSV(content);
  };
  reader.readAsText(file, "UTF-8");
}

// --- Parser for replenishment CSV (flexible headers) ---
function parseCSV(content) {
  const delimiter = ",";
  const lines = content.trim().split("\n");

  function clean(cell) {
    if (typeof cell !== "string") return "";
    return cell.replace(/^"|"$/g, "").trim();
  }

  // Parse headers
  const headers = lines[0]
    .split(delimiter)
    .map(normalizeHeader);

  // Flexible header resolution
  const itemIndex = headers.findIndex((h) =>
    ["item", "itemcode", "sku"].includes(h),
  );
  const locIndex = headers.findIndex((h) =>
    ["fromlocation", "locationbarcode", "location"].includes(h),
  );
  const qtyIndex = headers.findIndex((h) =>
    ["fromquantity", "qty", "quantity", "stockcount"].includes(h),
  );

  if (itemIndex === -1 || locIndex === -1 || qtyIndex === -1) {
    throw new Error("CSV must contain item, location, and quantity columns");
  }

  const data = {};

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const row = lines[i].split(delimiter).map(clean);
    const sku = row[itemIndex];
    const location = row[locIndex];
    const qty = parseInt(row[qtyIndex] || "0", 10);

    if (sku && location && !isNaN(qty)) {
      if (!data[sku]) data[sku] = { total: 0, locations: {} };
      data[sku].total += qty;
      data[sku].locations[location] =
        (data[sku].locations[location] || 0) + qty;
    }
  }

  return data;
}

// --- Parser for pasted CSV demand file (Next Days) ---
function parseDemandCSV(content) {
  const lines = content.trim().split("\n");
  const headers = splitPastedRow(lines[0]).map(normalizeHeader);

  // Be flexible: accept old and new names
  const skuIndex = headers.findIndex((h) =>
    ["item", "itemcode", "sku"].includes(h),
  );
  const qtyIndex = headers.findIndex((h) =>
    ["requested", "qty", "quantity"].includes(h),
  );

  if (skuIndex === -1 || qtyIndex === -1) {
    throw new Error(
      "CSV must contain an item column (Item or ItemCode) and a quantity column (Requested or QTy)",
    );
  }

  const demand = {};
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const row = splitPastedRow(lines[i]).map((c) =>
      c.replace(/^"|"$/g, "").trim(),
    );
    const sku = row[skuIndex];
    const qty = parseInt(row[qtyIndex] || "0", 10);

    if (sku && qty > 0) {
      demand[sku] = (demand[sku] || 0) + qty;
    }
  }
  return demand;
}

// --- Old parser for pasted error log text ---
function extractErrorLogSKUs(text) {
  const lines = text.split("\n");
  const skuCounts = {};

  for (const line of lines) {
    const match = line.match(/for\s+(\w+)\s+\(x(\d+)\)/i);
    if (match) {
      const sku = match[1];
      const qty = parseInt(match[2], 10);
      skuCounts[sku] = (skuCounts[sku] || 0) + qty;
    }
  }
  return skuCounts;
}

// --- Location parsing + sorting ---
function parseLocation(loc) {
  const match = loc.match(/^([A-Z]+\d+)\.C(\d+)\.S(\d+)$/);
  if (!match) return { parsed: false, aisle: "", col: 0, shelf: 0 };
  return {
    parsed: true,
    aisle: match[1],
    col: parseInt(match[2], 10),
    shelf: parseInt(match[3], 10),
  };
}

function pickLocationSorter([locA], [locB]) {
  const parsedA = parseLocation(locA);
  const parsedB = parseLocation(locB);

  // Helper: B -> C -> A -> others
  function aislePriority(aisle) {
    if (!aisle) return 999;
    const letter = aisle.charAt(0).toUpperCase();
    if (letter === "B") return 0;
    if (letter === "C") return 1;
    if (letter === "A") return 2;
    return 3; // everything else after B/C/A
  }

  if (parsedA.parsed && parsedB.parsed) {
    if (prioritizeB) {
      const prA = aislePriority(parsedA.aisle);
      const prB = aislePriority(parsedB.aisle);

      // First: B, then C, then A, then others
      if (prA !== prB) return prA - prB;
    }

    // Within same aisle priority, keep your original ordering
    if (parsedA.aisle !== parsedB.aisle) {
      return parsedA.aisle.localeCompare(parsedB.aisle);
    }
    if (parsedA.col !== parsedB.col) {
      return parsedA.col - parsedB.col;
    }
    return parsedA.shelf - parsedB.shelf;
  }

  // Fall back for unparsable locations
  if (parsedA.parsed && !parsedB.parsed) return -1;
  if (!parsedA.parsed && parsedB.parsed) return 1;
  return locA.localeCompare(locB);
}

// --- Main processing ---
function processData() {
  // Read checkbox state each time
  const cb = document.getElementById("prioritizeB");
  prioritizeB = cb ? cb.checked : false;

  const logText = document.getElementById("errorLog").value.trim();

  let demandData;

  // Detect demand CSV vs old log
  const firstRowHeaders = splitPastedRow(logText.split("\n")[0]).map(
    normalizeHeader,
  );
  const looksLikeDemandCSV =
    firstRowHeaders.some((h) => ["item", "itemcode", "sku"].includes(h)) &&
    firstRowHeaders.some((h) =>
      ["requested", "qty", "quantity"].includes(h),
    );

  if (looksLikeDemandCSV) {
    demandData = parseDemandCSV(logText);
  } else {
    demandData = extractErrorLogSKUs(logText);
  }

  const pickTasks = [];

  for (const sku of Object.keys(demandData)) {
    const required = demandData[sku];
    const availableData = replenData[sku] || { total: 0, locations: {} };
    let toPick = required;

    if (availableData.total > 0) {
      const sortedLocations = Object.entries(availableData.locations).sort(
        pickLocationSorter,
      );

      const picks = [];
      for (const [location, qty] of sortedLocations) {
        if (toPick <= 0) break;
        const pickQty = Math.min(qty, toPick);
        picks.push({ location, qty: pickQty });
        toPick -= pickQty;
      }

      if (toPick > 0) {
        picks.push({
          location: `❌ More required than on replen sheet: ${toPick}`,
          qty: 0,
        });
      }

      for (const p of picks) {
        pickTasks.push({
          sku,
          required,
          location: p.location,
          qty: p.qty,
          multi: picks.length > 1,
        });
      }
    } else {
      pickTasks.push({
        sku,
        required,
        location: "—",
        qty: 0,
        multi: false,
      });
    }
  }

  pickTasks.sort((a, b) => pickLocationSorter([a.location], [b.location]));

  const rows = {};
  for (const task of pickTasks) {
    if (!rows[task.sku]) {
      rows[task.sku] = {
        sku: task.sku,
        required: task.required,
        picks: [],
      };
    }
    if (task.multi && task.qty > 0) {
      rows[task.sku].picks.push(`${task.location} (${task.qty})`);
    } else {
      rows[task.sku].picks.push(`${task.location}`);
    }
  }

  latestRows = Object.values(rows);
  renderResults();
}

function renderResults() {
  const alphabeticalOrder = document.getElementById("alphabeticalOrder");
  const displayRows = [...latestRows];

  if (alphabeticalOrder && alphabeticalOrder.checked) {
    displayRows.sort((a, b) =>
      a.sku.localeCompare(b.sku, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }

  let html =
    "<h3>Next Days</h3><table><tr><th>SKU</th><th>Quantity</th><th>From Location</th></tr>";
  for (const row of displayRows) {
    const availableData = replenData[row.sku] || { total: 0 };
    const enough = availableData.total >= row.required;

    html += `<tr class="${enough ? "enough" : "notenough"}">
      <td>${row.sku}</td>
      <td>${row.required}</td>
      <td>${row.picks.join("<br>")}</td>
    </tr>`;
  }
  html += "</table>";
  document.getElementById("results").innerHTML = html;
}

const alphabeticalOrderCheckbox = document.getElementById("alphabeticalOrder");
if (alphabeticalOrderCheckbox) {
  alphabeticalOrderCheckbox.addEventListener("change", renderResults);
}

// --- Optional: re-run when the B checkbox changes ---
const prioritizeBCheckbox = document.getElementById("prioritizeB");
if (prioritizeBCheckbox) {
  prioritizeBCheckbox.addEventListener("change", () => {
    if (document.getElementById("errorLog").value.trim()) {
      processData();
    }
  });
}
