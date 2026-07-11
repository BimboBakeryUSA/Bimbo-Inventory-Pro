alert("APP.JS CARGADO ✅ V6");

// =======================
// GLOBAL ERROR HANDLER
// =======================
window.onerror = function (msg, src, line, col, err) {
  alert(
    "❌ ERROR DETECTADO:\n\n" +
    msg +
    "\n\n📍 Línea: " + line +
    "\n📄 Archivo: " + (src || "N/A")
  );
  console.error("ERROR GLOBAL:", msg, line, col, err);
};

// =======================
// HELPERS
// =======================
const getEl = (id) => {
  const el = document.getElementById(id);
  if (!el) console.error("❌ Elemento no encontrado:", id);
  return el;
};

const PRODUCT_DB_URL = "products.json";
const DEFAULT_IMAGE = "default-product.svg";

let products = [];
let counts = JSON.parse(localStorage.getItem("bip_counts") || "{}");
let routeValue = localStorage.getItem("bip_route") || "";
let html5QrCode = null;
let scanning = false;
let lastCode = "";
let lastScanTime = 0;
let deferredPrompt = null;

// =======================
// DATA
// =======================
function normalize(value) {
  let code = String(value || "").replace(/\D/g, "");

  // 🔧 normalizar códigos largos (EAN13 → quitar primer dígito)
  if (code.length === 13) {
    code = code.slice(1);
  }

  return code;
}

function defaultProducts() {
  return [
    { UPC: "757528008680", SKU: "1001", Producto: "Takis Fuego", UnidadesCaja: 12, Foto: "" },
    { UPC: "757528045609", SKU: "1002", Producto: "Takis Blue Heat", UnidadesCaja: 12, Foto: "" },
    { UPC: "757528046224", SKU: "1003", Producto: "Takis Intense Nacho", UnidadesCaja: 12, Foto: "" },
    { UPC: "757528044664", SKU: "1004", Producto: "Takis Nitro", UnidadesCaja: 12, Foto: "" },
    { UPC: "7432358480", SKU: "8444", Producto: "Rosca de Reyes", UnidadesCaja: 5, Foto: "" }
  ];
}

async function loadProducts() {
  const saved = localStorage.getItem("bip_products");
  if (saved) {
    products = JSON.parse(saved);
    return;
  }

  try {
    const res = await fetch(PRODUCT_DB_URL);
    if (!res.ok) throw new Error("No se pudo cargar products.json");
    products = await res.json();
  } catch (e) {
    console.warn("Usando base demo:", e);
    products = defaultProducts();
  }
}

function saveProducts() {
  localStorage.setItem("bip_products", JSON.stringify(products));
}

function saveAll() {
  localStorage.setItem("bip_counts", JSON.stringify(counts));
  const routeInput = getEl("routeInput");
  if (routeInput) {
    localStorage.setItem("bip_route", routeInput.value.trim());
  }
}

function findProduct(code) {
  const clean = normalize(code);
  return (
    products.find(
      (p) =>
        normalize(p.UPC) === clean ||
        normalize(p.SKU) === clean
    ) || {
      UPC: clean,
      SKU: "N/A",
      Producto: "Código no registrado: " + clean,
      UnidadesCaja: 1,
      Foto: "",
      noRegistrado: true
    }
  );
}

// Convierte conteos viejos tipo {code,cantidad} al formato nuevo
function migrateCountsIfNeeded() {
  const migrated = {};

  Object.values(counts).forEach((item) => {
    if (item && Object.prototype.hasOwnProperty.call(item, "code")) {
      const code = normalize(item.code);
      const p = findProduct(code);
      migrated[normalize(p.UPC || code)] = {
        UPC: p.UPC || code,
        SKU: p.SKU || "N/A",
        Producto: p.Producto || ("Código no registrado: " + code),
        UnidadesCaja: Number(p.UnidadesCaja) || 1,
        Foto: p.Foto || "",
        Cajas: Number(item.cantidad) || 0
      };
    } else if (item && Object.prototype.hasOwnProperty.call(item, "UPC")) {
      const key = normalize(item.UPC);
      migrated[key] = {
        UPC: item.UPC,
        SKU: item.SKU || "N/A",
        Producto: item.Producto || "Sin nombre",
        UnidadesCaja: Number(item.UnidadesCaja) || 1,
        Foto: item.Foto || "",
        Cajas: Number(item.Cajas) || 0
      };
    }
  });

  counts = migrated;
  saveAll();
}

// =======================
// UI / RENDER
// =======================
function productImageSrc(item) {
  return item.Foto && item.Foto.trim() ? item.Foto.trim() : DEFAULT_IMAGE;
}

function beep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 980;
      gain.gain.value = 0.06;
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 100);
    }
  } catch (e) {
    console.warn("beep error", e);
  }

  if (navigator.vibrate) navigator.vibrate(80);
}

function render() {
  const list = getEl("productList");
  if (!list) return;

  list.innerHTML = "";

  const items = Object.values(counts);
  let totalCases = 0;
  let totalUnits = 0;

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state">Todavía no hay productos escaneados.</div>';
  } else {
    items
      .sort((a, b) => a.Producto.localeCompare(b.Producto))
      .forEach((item) => {
        totalCases += Number(item.Cajas) || 0;
        totalUnits += (Number(item.Cajas) || 0) * (Number(item.UnidadesCaja) || 1);

        const tpl = getEl("productCardTemplate");
        if (!tpl) return;

        const node = tpl.content.cloneNode(true);

        const h3 = node.querySelector("h3");
        const skuLine = node.querySelector(".sku-line");
        const upcLine = node.querySelector(".upc-line");
        const caseCount = node.querySelector(".case-count");
        const unitCount = node.querySelector(".unit-count");
        const photoWrap = node.querySelector(".product-photo");
        const plusBtn = node.querySelector(".plus-btn");
        const minusBtn = node.querySelector(".minus-btn");
        const deleteBtn = node.querySelector(".delete-btn");
        const editBtn = node.querySelector(".edit-product-btn");

        if (h3) h3.textContent = item.Producto;
        if (skuLine) skuLine.textContent = "SKU: " + item.SKU;
        if (upcLine) upcLine.textContent = "UPC: " + item.UPC;
        if (caseCount) caseCount.textContent = item.Cajas;
        if (unitCount) unitCount.textContent = (item.Cajas * item.UnidadesCaja);

        if (photoWrap) {
          const img = document.createElement("img");
          img.src = productImageSrc(item);
          img.alt = item.Producto;
          img.onerror = () => { img.src = DEFAULT_IMAGE; };
          photoWrap.innerHTML = "";
          photoWrap.appendChild(img);
        }

        if (plusBtn) {
          plusBtn.onclick = () => {
            item.Cajas += 1;
            saveAll();
            render();
          };
        }

        if (minusBtn) {
          minusBtn.onclick = () => {
            item.Cajas = Math.max(0, item.Cajas - 1);
            if (item.Cajas === 0) delete counts[normalize(item.UPC)];
            saveAll();
            render();
          };
        }

        if (deleteBtn) {
          deleteBtn.onclick = () => {
            delete counts[normalize(item.UPC)];
            saveAll();
            render();
          };
        }

        if (editBtn) {
          editBtn.onclick = () => openProductModal(item.UPC);
        }

        list.appendChild(node);
      });
  }

  const totalSku = getEl("totalSku");
  const totalCasesEl = getEl("totalCases");
  const totalUnitsEl = getEl("totalUnits");

  if (totalSku) totalSku.textContent = String(items.length);
  if (totalCasesEl) totalCasesEl.textContent = String(totalCases);
  if (totalUnitsEl) totalUnitsEl.textContent = String(totalUnits);
}

// =======================
// SCAN / CAMERA
// =======================
function processBarcode(rawCode) {
  const code = normalize(rawCode);
  if (!code) return;

  const now = Date.now();
  if (code === lastCode && now - lastScanTime < 900) return;

  lastCode = code;
  lastScanTime = now;

  const product = findProduct(code);
  const key = normalize(product.UPC || code);

  if (!counts[key]) {
    counts[key] = {
      UPC: product.UPC || code,
      SKU: product.SKU || "N/A",
      Producto: product.Producto || ("Código no registrado: " + code),
      UnidadesCaja: Number(product.UnidadesCaja) || 1,
      Foto: product.Foto || "",
      Cajas: 0
    };
  }

  counts[key].Cajas += 1;

  const lastScanText = getEl("lastScanText");
  if (lastScanText) lastScanText.textContent = "Último: " + counts[key].Producto;

  beep();
  saveAll();
  render();
}

async function startCamera() {
  console.log("📷 Iniciando cámara...");

  if (scanning) return;

  if (typeof Html5Qrcode === "undefined") {
    alert("❌ Librería html5-qrcode NO cargó");
    return;
  }

  try {
    const reader = getEl("reader");
    if (!reader) {
      alert("❌ No existe el contenedor #reader");
      return;
    }

    html5QrCode = new Html5Qrcode("reader");

    await html5QrCode.start(
      { facingMode: "environment" },
      {
        fps: 12,
        qrbox: { width: 250, height: 250 }
      },
      (decodedText) => {
        processBarcode(decodedText);
      },
      () => {}
    );

    scanning = true;

    const statusPill = getEl("statusPill");
    if (statusPill) {
      statusPill.textContent = "Activo";
      statusPill.className = "status-pill on";
    }

    console.log("✅ Cámara activa");
  } catch (err) {
    console.error(err);
    alert("❌ Error cámara: " + err);
  }
}

async function stopCamera() {
  try {
    if (html5QrCode && scanning) {
      await html5QrCode.stop();
      await html5QrCode.clear();
    }
  } catch (e) {
    console.warn("stopCamera warning:", e);
  }

  scanning = false;

  const statusPill = getEl("statusPill");
  if (statusPill) {
    statusPill.textContent = "Inactivo";
    statusPill.className = "status-pill off";
  }

  console.log("🛑 Cámara detenida");
}

// =======================
// PRODUCT MODAL
// =======================
function updatePreview() {
  const input = getEl("newPhoto");
  const preview = getEl("newPhotoPreview");
  if (!input || !preview) return;

  const url = input.value.trim();
  preview.src = url || DEFAULT_IMAGE;
  preview.onerror = () => { preview.src = DEFAULT_IMAGE; };
}

function openProductModal(code = "") {
  const clean = normalize(code || lastCode);
  const p = clean ? findProduct(clean) : null;

  const newUpc = getEl("newUpc");
  const newSku = getEl("newSku");
  const newName = getEl("newName");
  const newUnits = getEl("newUnits");
  const newPhoto = getEl("newPhoto");
  const modal = getEl("productModal");

  if (newUpc) newUpc.value = p ? normalize(p.UPC || clean) : "";
  if (newSku) newSku.value = p && !p.noRegistrado ? (p.SKU || "") : "";
  if (newName) newName.value = p && !p.noRegistrado ? (p.Producto || "") : "";
  if (newUnits) newUnits.value = p && !p.noRegistrado ? (p.UnidadesCaja || 1) : 1;
  if (newPhoto) newPhoto.value = p && !p.noRegistrado ? (p.Foto || "") : "";

  updatePreview();

  if (modal) {
    modal.classList.remove("hidden");
    setTimeout(() => {
      if (newUpc) newUpc.focus();
    }, 120);
  }
}

function closeProductModal() {
  const modal = getEl("productModal");
  if (modal) modal.classList.add("hidden");
}

function upsertProductFromForm() {
  const upc = normalize(getEl("newUpc")?.value);
  const sku = getEl("newSku")?.value.trim() || "N/A";
  const name = getEl("newName")?.value.trim() || "";
  const units = Number(getEl("newUnits")?.value) || 1;
  const photo = getEl("newPhoto")?.value.trim() || "";

  if (!upc) {
    alert("Escribe o escanea el UPC/código.");
    return;
  }

  if (!name) {
    alert("Escribe el nombre del producto.");
    return;
  }

  const record = {
    UPC: upc,
    SKU: sku,
    Producto: name,
    UnidadesCaja: units,
    Foto: photo
  };

  const idx = products.findIndex(
    (p) => normalize(p.UPC) === upc || normalize(p.SKU) === upc
  );

  if (idx >= 0) products[idx] = record;
  else products.push(record);

  saveProducts();

  if (counts[upc]) {
    counts[upc].SKU = record.SKU;
    counts[upc].Producto = record.Producto;
    counts[upc].UnidadesCaja = record.UnidadesCaja;
    counts[upc].Foto = record.Foto;
    saveAll();
  }

  closeProductModal();
  render();
  alert("✅ Producto guardado");
}

// =======================
// EXPORT / SHARE / IMPORT
// =======================
function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportCSV() {
  const route = getEl("routeInput")?.value.trim() || "";
  let csv = "Ruta,SKU,UPC,Producto,Cajas,UnidadesCaja,Unidades,Foto\n";

  Object.values(counts).forEach((item) => {
    const row = [
      route,
      item.SKU,
      item.UPC,
      item.Producto,
      item.Cajas,
      item.UnidadesCaja,
      item.Cajas * item.UnidadesCaja,
      item.Foto
    ]
      .map((v) => '"' + String(v ?? "").replaceAll('"', '""') + '"')
      .join(",");

    csv += row + "\n";
  });

  downloadFile(
    "Bimbo_Inventory_Route_" + (route || "NA") + ".csv",
    csv,
    "text/csv;charset=utf-8;"
  );
}

function shareWhatsApp() {
  const route = getEl("routeInput")?.value.trim() || "N/A";

  let msg = `Bimbo Inventory Pro\nRuta: ${route}\n\n`;

  Object.values(counts).forEach((item) => {
    msg += `${item.Producto} - ${item.Cajas} cajas / ${item.Cajas * item.UnidadesCaja} unidades\n`;
  });

  const totalCases = getEl("totalCases")?.textContent || "0";
  const totalUnits = getEl("totalUnits")?.textContent || "0";

  msg += `\nTotal Cajas: ${totalCases}\nTotal Unidades: ${totalUnits}`;

  window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank");
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  result.push(current);

  return result.map((x) => x.trim().replace(/^"|"$/g, ""));
}

async function importCSV(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) {
    alert("CSV vacío");
    return;
  }

  const headers = parseCsvLine(lines.shift()).map((h) => h.trim().toLowerCase());

  const getIndex = (names) =>
    names.map((n) => headers.indexOf(n)).find((i) => i >= 0);

  const upcI = getIndex(["upc", "codigo", "barcode"]);
  const skuI = getIndex(["sku"]);
  const prodI = getIndex(["producto", "product", "name"]);
  const unitsI = getIndex(["unidadescaja", "unitspercase", "unidades por caja"]);
  const fotoI = getIndex(["foto", "photo", "image"]);

  const imported = lines
    .map((line) => {
      const v = parseCsvLine(line);
      return {
        UPC: upcI >= 0 ? (v[upcI] || "") : "",
        SKU: skuI >= 0 ? (v[skuI] || "") : "",
        Producto: prodI >= 0 ? (v[prodI] || "") : "",
        UnidadesCaja: unitsI >= 0 ? Number(v[unitsI] || 1) : 1,
        Foto: fotoI >= 0 ? (v[fotoI] || "") : ""
      };
    })
    .filter((p) => p.UPC && p.Producto);

  products = imported;
  saveProducts();
  alert("✅ Base cargada: " + products.length + " productos");
}

function downloadTemplate() {
  const csv =
    "UPC,SKU,Producto,UnidadesCaja,Foto\n" +
    "757528008680,1001,Takis Fuego,12,\n" +
    "757528045609,1002,Takis Blue Heat,12,\n" +
    "7432358480,8444,Rosca de Reyes,5,\n";

  downloadFile("bimbo_products_template.csv", csv, "text/csv;charset=utf-8;");
}

// =======================
// EVENTS
// =======================
function setupEvents() {
  const routeInput = getEl("routeInput");
  const startBtn = getEl("startBtn");
  const stopBtn = getEl("stopBtn");
  const exportBtn = getEl("exportBtn");
  const whatsappBtn = getEl("whatsappBtn");
  const addProductBtn = getEl("addProductBtn");
  const clearBtn = getEl("clearBtn");
  const resetDbBtn = getEl("resetDbBtn");
  const scannerInput = getEl("scannerInput");
  const csvInput = getEl("csvInput");
  const templateBtn = getEl("templateBtn");
  const saveProductBtn = getEl("saveProductBtn");
  const closeModalBtn = getEl("closeModalBtn");
  const useLastCodeBtn = getEl("useLastCodeBtn");
  const newPhoto = getEl("newPhoto");
  const newUpc = getEl("newUpc");
  const installBtn = getEl("installBtn");

  if (routeInput) {
    routeInput.value = routeValue;
    routeInput.addEventListener("input", saveAll);
  }

  if (startBtn) startBtn.onclick = startCamera;
  if (stopBtn) stopBtn.onclick = stopCamera;
  if (exportBtn) exportBtn.onclick = exportCSV;
  if (whatsappBtn) whatsappBtn.onclick = shareWhatsApp;
  if (addProductBtn) addProductBtn.onclick = () => openProductModal(lastCode);

  if (clearBtn) {
    clearBtn.onclick = () => {
      if (confirm("¿Limpiar el conteo actual?")) {
        counts = {};
        saveAll();
        render();
        const lastScanText = getEl("lastScanText");
        if (lastScanText) lastScanText.textContent = "Sin scans";
      }
    };
  }

  if (resetDbBtn) {
    resetDbBtn.onclick = () => {
      if (confirm("¿Restaurar base de productos demo?")) {
        products = defaultProducts();
        saveProducts();
        alert("✅ Base demo restaurada");
      }
    };
  }

  if (scannerInput) {
    scannerInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        processBarcode(e.target.value);
        e.target.value = "";
      }
    });
  }

  if (csvInput) {
    csvInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) {
        importCSV(e.target.files[0]);
      }
    });
  }

  if (templateBtn) templateBtn.onclick = downloadTemplate;
  if (saveProductBtn) saveProductBtn.onclick = upsertProductFromForm;
  if (closeModalBtn) closeModalBtn.onclick = closeProductModal;

  if (useLastCodeBtn) {
    useLastCodeBtn.onclick = () => {
      const newUpcEl = getEl("newUpc");
      if (newUpcEl) newUpcEl.value = lastCode || "";
    };
  }

  if (newPhoto) newPhoto.addEventListener("input", updatePreview);

  if (newUpc) {
    newUpc.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        getEl("newSku")?.focus();
      }
    });
  }

  window.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    if (active && active.tagName === "INPUT") return;
    getEl("scannerInput")?.focus();
  });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.classList.remove("hidden");
  });

  if (installBtn) {
    installBtn.onclick = async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt = null;
        installBtn.classList.add("hidden");
      }
    };
  }
}

// =======================
// INIT
// =======================
document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadProducts();
    migrateCountsIfNeeded();
    setupEvents();
    render();
    setTimeout(() => getEl("scannerInput")?.focus(), 300);
    console.log("✅ APP INICIADA");
  } catch (e) {
    console.error("INIT ERROR:", e);
    alert("❌ Error en INIT: " + e.message);
  }
});

// =======================
// SERVICE WORKER
// Lo dejo desactivado mientras pruebas,
// para evitar cache de versiones viejas.
// =======================
// if ("serviceWorker" in navigator) {
//   navigator.serviceWorker.register("sw.js").catch(() => {});
// }
