alert("Bimbo Inventory Pro — v19: panel Admin/Corporativo + catálogo + badge de pendientes ✅");

// =======================
// SUPABASE (login y roles)
// =======================
// 👉 Reemplaza estos dos valores con los de tu proyecto:
// Supabase Dashboard > Settings > API > Project URL / anon public key
const SUPABASE_URL = "https://obfikwhukpzelsghowcq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_-qW3XyldNJgpOk6BLReC3A_HIyZHrHM";

let supabaseClient = null;
let supabaseConfigError = null;
try {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.indexOf("PEGA_AQUI") === 0 || SUPABASE_ANON_KEY.indexOf("PEGA_AQUI") === 0) {
    throw new Error("Falta configurar SUPABASE_URL y SUPABASE_ANON_KEY en app.js");
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
  console.error(e);
  supabaseConfigError = e.message;
}

let currentUser = null;    // sesión de auth de Supabase
let currentProfile = null; // fila de la tabla profiles: { role, nombre, route_code, puesto, estado }
let currentSession = null; // fila de scan_sessions: la "lista" abierta de esta ruta
let syncPending = localStorage.getItem("bip_sync_pending") === "1"; // ¿hay cambios sin subir a Supabase?
let syncInProgress = false;
let closePending = localStorage.getItem("bip_close_pending") === "1"; // ¿hay que cerrar la lista en cuanto haya red?

// Navegación Home ("Mis conteos") <-> detalle de lista, solo para role "route".
let currentView = "home";     // "home" | "session"
let viewingSessionId = null;  // id de la scan_session que se está mostrando en #sessionView
let viewingReadOnly = false;  // true si la lista que se muestra ya está cerrada
let viewingMetodo = null;     // "camara" | "pistola" — método guardado en la lista que se ve

// =======================
// GLOBAL ERROR HANDLER (silencioso, solo consola)
// =======================
window.onerror = function (msg, src, line, col, err) {
  console.error("ERROR GLOBAL:", msg, "| línea:", line, "| archivo:", src, err);
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
// CONFIRMACIÓN DE LECTURA (solo cámara)
// =======================
const CONFIRM_HITS = 2;             // lecturas iguales seguidas para aceptar
const CONFIRM_WINDOW_MS = 900;      // tiempo máximo entre esas lecturas
const POST_ACCEPT_COOLDOWN_MS = 500; // pausa después de aceptar un código

let pendingRaw = null;
let pendingHits = 0;
let pendingFirstTime = 0;
let cameraCooldownUntil = 0;

// =======================
// DATA
// =======================
function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

// Valida el dígito verificador GS1 de UPC-A (12) / EAN-13 (13).
// Para cualquier otro largo (SKU internos, QR cortos, etc.) no aplica y se deja pasar.
function isPlausibleBarcode(rawDigits) {
  let digits = rawDigits;
  if (digits.length === 12) digits = "0" + digits; // UPC-A -> EAN-13
  if (digits.length !== 13) return true;

  const nums = digits.split("").map(Number);
  const check = nums.pop();
  let sum = 0;
  nums.forEach((d, i) => {
    sum += d * (i % 2 === 0 ? 1 : 3);
  });
  const calculated = (10 - (sum % 10)) % 10;
  return calculated === check;
}

function normalize(value) {
  let code = String(value || "").replace(/\D/g, "");

  // convertir EAN13 a UPC12
  if (code.length === 13) {
    code = code.slice(1);
  }

  // 🔥 clave: usar solo los primeros 10-11 dígitos (evita errores al final)
  if (code.length >= 11) {
    code = code.slice(0, 11);
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

// Convierte una fila de la tabla Supabase "products" al formato interno de la app
function dbRowToProduct(row) {
  return {
    UPC: row.upc,
    SKU: row.sku || "N/A",
    Producto: row.producto || "",
    UnidadesCaja: Number(row.unidades_caja) || 1,
    Foto: row.foto || ""
  };
}

// Convierte un producto interno al formato de fila para Supabase
function productToDbRow(p) {
  return {
    upc: p.UPC,
    sku: p.SKU || "N/A",
    producto: p.Producto || "",
    unidades_caja: Number(p.UnidadesCaja) || 1,
    foto: p.Foto || "",
    creado_por: currentUser ? currentUser.id : null
  };
}

// Sube (upsert) una lista de productos a la tabla compartida en Supabase.
// Silencioso si no hay sesión o Supabase no está configurado (no bloquea al usuario).
async function syncProductsToSupabase(list) {
  if (!supabaseClient || !currentUser || !list || !list.length) return;
  try {
    const rows = list.map(productToDbRow).filter((r) => r.upc);
    if (!rows.length) return;
    const { error } = await supabaseClient.from("products").upsert(rows, { onConflict: "upc" });
    if (error) console.error("Error sincronizando productos con Supabase:", error);
  } catch (e) {
    console.error("Error sincronizando productos con Supabase:", e);
  }
}

async function loadProducts() {
  // 1) Si hay sesión de Supabase, el catálogo compartido manda.
  if (supabaseClient && currentUser) {
    try {
      const { data, error } = await supabaseClient.from("products").select("*");
      if (error) throw error;
      if (data && data.length > 0) {
        products = data.map(dbRowToProduct);
        saveProducts(); // deja copia local como caché/respaldo offline
        return;
      }
    } catch (e) {
      console.warn("No se pudo cargar products desde Supabase, uso respaldo local:", e);
    }
  }

  // 2) Respaldo: lo que ya hubiera guardado en este navegador.
  const saved = localStorage.getItem("bip_products");
  if (saved) {
    products = JSON.parse(saved);
    return;
  }

  // 3) Último respaldo: products.json del repo, o datos demo.
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
    updateProfileRouteLabel(routeInput.value.trim());
  }
  syncCurrentSessionItems();
}

function updateProfileRouteLabel(route) {
  const label = getEl("profileRouteLabel");
  if (label) label.textContent = route ? "Ruta: " + route : "Sin ruta asignada";
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

        // Si se está viendo una lista ya cerrada (solo lectura), no se puede
        // editar el conteo: se ocultan los controles de +/-, borrar y editar.
        const readOnly = currentProfile && currentProfile.role === "route" && viewingReadOnly;
        // Editar nombre/datos del producto es exclusivo de Admin (catálogo
        // compartido): Route y Corporativo nunca ven ese botón, aunque la
        // lista siga abierta.
        const canEditCatalog = currentProfile && currentProfile.role === "admin";

        if (plusBtn) {
          if (readOnly) {
            plusBtn.classList.add("hidden");
          } else {
            plusBtn.onclick = () => {
              item.Cajas += 1;
              saveAll();
              render();
            };
          }
        }

        if (minusBtn) {
          if (readOnly) {
            minusBtn.classList.add("hidden");
          } else {
            minusBtn.onclick = () => {
              item.Cajas = Math.max(0, item.Cajas - 1);
              if (item.Cajas === 0) delete counts[normalize(item.UPC)];
              saveAll();
              render();
            };
          }
        }

        if (deleteBtn) {
          if (readOnly) {
            deleteBtn.classList.add("hidden");
          } else {
            deleteBtn.onclick = () => {
              delete counts[normalize(item.UPC)];
              saveAll();
              render();
            };
          }
        }

        if (editBtn) {
          if (readOnly || !canEditCatalog) {
            editBtn.classList.add("hidden");
          } else {
            editBtn.onclick = () => openProductModal(item.UPC);
          }
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
  if (currentProfile && currentProfile.role === "route" && viewingReadOnly) return;

  const rawDigits = digitsOnly(rawCode);
  if (!rawDigits) return;

  if (!isPlausibleBarcode(rawDigits)) {
    console.warn("Código rechazado por checksum inválido:", rawDigits);
    showScanToast("Código inválido, escanea de nuevo", rawDigits, false);
    return;
  }

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

  showScanToast(counts[key].Producto, counts[key].UPC, true);
  beep();
  saveAll();
  render();
}

// Filtro exclusivo para la cámara: exige N lecturas iguales seguidas
// antes de aceptar, y aplica una pausa después de aceptar una.
function handleCameraDecode(rawText) {
  const raw = digitsOnly(rawText);
  if (!raw) return;

  const now = Date.now();
  if (now < cameraCooldownUntil) return; // pausa post-aceptación

  if (!isPlausibleBarcode(raw)) {
    // probablemente mal enfocado: no lo contamos ni como candidato
    pendingRaw = null;
    pendingHits = 0;
    return;
  }

  if (raw === pendingRaw && now - pendingFirstTime <= CONFIRM_WINDOW_MS) {
    pendingHits += 1;
  } else {
    pendingRaw = raw;
    pendingHits = 1;
    pendingFirstTime = now;
  }

  if (pendingHits < CONFIRM_HITS) return; // aún no coinciden suficientes lecturas

  // confirmado: se acepta y se reinicia para el próximo código
  pendingRaw = null;
  pendingHits = 0;
  cameraCooldownUntil = now + POST_ACCEPT_COOLDOWN_MS;

  processBarcode(raw);
}

// =======================
// POPUP DE ESCANEO
// =======================
let scanToastTimer = null;
function showScanToast(name, code, ok = true) {
  const toast = getEl("scanToast");
  const nameEl = getEl("scanToastName");
  const codeEl = getEl("scanToastCode");
  const iconEl = toast ? toast.querySelector(".scan-toast-icon") : null;
  if (!toast) return;

  if (nameEl) nameEl.textContent = name;
  if (codeEl) codeEl.textContent = "Código: " + code;
  if (iconEl) iconEl.textContent = ok ? "✅" : "⚠️";
  toast.classList.toggle("error", !ok);

  toast.classList.add("show");
  clearTimeout(scanToastTimer);
  scanToastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 1600);
}

async function startCamera() {
  if (scanning) return;
  if (currentProfile && currentProfile.role === "route" && viewingReadOnly) return;

  pendingRaw = null;
  pendingHits = 0;
  cameraCooldownUntil = 0;

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

    // Activamos pantalla completa ANTES de iniciar la cámara,
    // para que html5-qrcode calcule el tamaño del video ya en modo fullscreen.
    setCameraFullscreen(true);
    // Esperamos un frame para que el navegador aplique el nuevo layout
    // antes de que la librería mida el contenedor.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    html5QrCode = new Html5Qrcode("reader");

    await html5QrCode.start(
      { facingMode: "environment" },
      {
        fps: 12,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
          const size = Math.floor(minEdge * 0.7);
          return { width: size, height: size };
        }
      },
      (decodedText) => {
        handleCameraDecode(decodedText);
      },
      () => {}
    );

    scanning = true;

    const statusPill = getEl("statusPill");
    if (statusPill) {
      statusPill.textContent = "Activo";
      statusPill.className = "status-pill on floating-pill";
    }
  } catch (err) {
    console.error(err);
    setCameraFullscreen(false);
    alert("❌ Error cámara: " + err);
  }
}

function setCameraFullscreen(on) {
  const reader = getEl("reader");
  const startBtn = getEl("startBtn");
  const stopBtn = getEl("stopBtn");

  if (reader) reader.classList.toggle("fullscreen", on);
  document.body.classList.toggle("camera-fullscreen", on);
  if (startBtn) startBtn.classList.toggle("hidden", on);
  if (stopBtn) stopBtn.classList.toggle("floating-stop", on);
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
  setCameraFullscreen(false);

  const statusPill = getEl("statusPill");
  if (statusPill) {
    statusPill.textContent = "Inactivo";
    statusPill.className = "status-pill off";
  }
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
  syncProductsToSupabase([record]);

  if (counts[upc]) {
    counts[upc].SKU = record.SKU;
    counts[upc].Producto = record.Producto;
    counts[upc].UnidadesCaja = record.UnidadesCaja;
    counts[upc].Foto = record.Foto;
    saveAll();
  }

  closeProductModal();
  render();

  // Si el catálogo está abierto, refleja el cambio ahí también.
  const catalogModal = getEl("catalogModal");
  if (catalogModal && !catalogModal.classList.contains("hidden")) {
    renderCatalogList(getEl("catalogSearchInput")?.value || "");
  }
}

// =======================
// CATÁLOGO DE PRODUCTOS (pantalla propia, solo Admin)
// =======================
function openCatalogModal() {
  getEl("catalogModal")?.classList.remove("hidden");
  const search = getEl("catalogSearchInput");
  if (search) search.value = "";
  renderCatalogList("");
}

function closeCatalogModal() {
  getEl("catalogModal")?.classList.add("hidden");
}

function renderCatalogList(filter = "") {
  const list = getEl("catalogList");
  if (!list) return;

  const term = filter.trim().toLowerCase();
  const filtered = !term
    ? products
    : products.filter(
        (p) =>
          (p.Producto || "").toLowerCase().includes(term) ||
          (p.SKU || "").toLowerCase().includes(term) ||
          (p.UPC || "").toLowerCase().includes(term)
      );

  if (!filtered.length) {
    list.innerHTML = '<p class="help-text">Sin productos que coincidan.</p>';
    return;
  }

  list.innerHTML = "";
  filtered
    .slice()
    .sort((a, b) => (a.Producto || "").localeCompare(b.Producto || ""))
    .forEach((p) => {
      const row = document.createElement("div");
      row.className = "catalog-row";

      const photoSrc = p.Foto && p.Foto.trim() ? p.Foto.trim() : DEFAULT_IMAGE;

      row.innerHTML =
        '<div class="catalog-row-photo"><img src="' + photoSrc + '" alt=""></div>' +
        '<div class="catalog-row-info">' +
        "<strong>" + (p.Producto || "Sin nombre") + "</strong>" +
        "<span>SKU " + (p.SKU || "N/A") + " · UPC " + p.UPC + "</span>" +
        "</div>" +
        '<div class="catalog-row-actions">' +
        '<button class="catalog-edit-btn">Editar</button>' +
        '<button class="catalog-delete-btn">🗑</button>' +
        "</div>";

      const img = row.querySelector(".catalog-row-photo img");
      if (img) img.onerror = () => { img.src = DEFAULT_IMAGE; };

      row.querySelector(".catalog-edit-btn").onclick = () => openProductModal(p.UPC);
      row.querySelector(".catalog-delete-btn").onclick = () => deleteProductFromCatalog(p.UPC);

      list.appendChild(row);
    });
}

async function deleteProductFromCatalog(upc) {
  if (!confirm("¿Eliminar este producto del catálogo? No se podrá deshacer.")) return;

  products = products.filter((p) => normalize(p.UPC) !== normalize(upc));
  saveProducts();

  if (supabaseClient) {
    const { error } = await supabaseClient.from("products").delete().eq("upc", upc);
    if (error) {
      console.error("Error borrando producto en Supabase:", error);
      alert("⚠️ Se borró localmente, pero no se pudo borrar en Supabase: " + error.message);
    }
  }

  renderCatalogList(getEl("catalogSearchInput")?.value || "");
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
  alert("✅ Base cargada: " + products.length + " productos. Sincronizando con Supabase...");
  syncProductsToSupabase(products).then(() => {
    console.log("Productos sincronizados con Supabase");
  });
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
// DRAWER / MENÚ / PERFIL
// =======================
function openDrawer() {
  getEl("sideDrawer")?.classList.add("open");
  getEl("drawerOverlay")?.classList.remove("hidden");
  if (currentProfile && currentProfile.role === "admin") {
    loadPendingRoutes();
    refreshPendingBadge();
  }
}

function closeDrawer() {
  getEl("sideDrawer")?.classList.remove("open");
  getEl("drawerOverlay")?.classList.add("hidden");
}

function toggleProfileMenu(forceClose = false) {
  const menu = getEl("profileMenu");
  if (!menu) return;
  if (forceClose) {
    menu.classList.add("hidden");
    return;
  }
  menu.classList.toggle("hidden");
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

  const menuBtn = getEl("menuBtn");
  const closeDrawerBtn = getEl("closeDrawerBtn");
  const drawerOverlay = getEl("drawerOverlay");
  const profileBtn = getEl("profileBtn");
  const profileHelpBtn = getEl("profileHelpBtn");
  const profileLogoutBtn = getEl("profileLogoutBtn");

  if (routeInput) {
    routeInput.value = routeValue;
    updateProfileRouteLabel(routeValue);
    routeInput.addEventListener("input", saveAll);
  }

  if (startBtn) startBtn.onclick = startCamera;
  if (stopBtn) stopBtn.onclick = stopCamera;
  if (exportBtn) exportBtn.onclick = exportCSV;
  if (whatsappBtn) whatsappBtn.onclick = shareWhatsApp;
  if (addProductBtn) addProductBtn.onclick = () => openProductModal(lastCode);

  const closeListBtn = getEl("closeListBtn");
  if (closeListBtn) closeListBtn.onclick = closeCurrentList;

  // Home "Mis conteos" / navegación de listas
  const refreshHomeBtn = getEl("refreshHomeBtn");
  const newSessionBtn = getEl("newSessionBtn");
  const continueSessionBtn = getEl("continueSessionBtn");
  const backToHomeBtn = getEl("backToHomeBtn");
  const closeScanMethodBtn = getEl("closeScanMethodBtn");
  const chooseCameraBtn = getEl("chooseCameraBtn");
  const choosePistolaBtn = getEl("choosePistolaBtn");

  if (refreshHomeBtn) refreshHomeBtn.onclick = loadHomeSessions;
  if (newSessionBtn) newSessionBtn.onclick = promptNewSession;
  if (continueSessionBtn) continueSessionBtn.onclick = () => { if (currentSession) openSessionDetail(currentSession); };
  if (backToHomeBtn) backToHomeBtn.onclick = goBackFromSession;
  if (closeScanMethodBtn) closeScanMethodBtn.onclick = closeScanMethodModal;
  if (chooseCameraBtn) chooseCameraBtn.onclick = () => createNewSession("camara");
  if (choosePistolaBtn) choosePistolaBtn.onclick = () => createNewSession("pistola");

  // Panel Admin/Corporativo
  const goHistoryCardBtn = getEl("goHistoryCardBtn");
  const goUsersCardBtn = getEl("goUsersCardBtn");
  const goCatalogCardBtn = getEl("goCatalogCardBtn");
  const goPendingCardBtn = getEl("goPendingCardBtn");
  const goScanCardBtn = getEl("goScanCardBtn");

  if (goHistoryCardBtn) goHistoryCardBtn.onclick = openHistoryModal;
  if (goUsersCardBtn) goUsersCardBtn.onclick = openUserModal;
  if (goCatalogCardBtn) goCatalogCardBtn.onclick = openCatalogModal;
  if (goPendingCardBtn) goPendingCardBtn.onclick = openDrawer;
  if (goScanCardBtn) {
    goScanCardBtn.onclick = () => {
      updateSessionChrome();
      showSessionView();
    };
  }

  // Catálogo de productos
  const closeCatalogModalBtn = getEl("closeCatalogModalBtn");
  const catalogSearchInput = getEl("catalogSearchInput");
  const catalogAddBtn = getEl("catalogAddBtn");

  if (closeCatalogModalBtn) closeCatalogModalBtn.onclick = closeCatalogModal;
  if (catalogAddBtn) catalogAddBtn.onclick = () => openProductModal("");
  if (catalogSearchInput) {
    catalogSearchInput.addEventListener("input", (e) => renderCatalogList(e.target.value));
  }

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
        syncProductsToSupabase(products);
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

  // Menú hamburguesa
  if (menuBtn) menuBtn.onclick = () => { toggleProfileMenu(true); openDrawer(); };
  if (closeDrawerBtn) closeDrawerBtn.onclick = closeDrawer;
  if (drawerOverlay) drawerOverlay.onclick = closeDrawer;

  // Menú de perfil
  if (profileBtn) {
    profileBtn.onclick = (e) => {
      e.stopPropagation();
      closeDrawer();
      toggleProfileMenu();
    };
  }
  document.addEventListener("click", (e) => {
    const menu = getEl("profileMenu");
    if (!menu || menu.classList.contains("hidden")) return;
    if (!menu.contains(e.target) && e.target !== profileBtn) {
      toggleProfileMenu(true);
    }
  });
  if (profileHelpBtn) {
    profileHelpBtn.onclick = () => {
      toggleProfileMenu(true);
      alert("Bimbo Inventory Pro\nEscanea productos con cámara o scanner Bluetooth NETUM.\nUsa el menú ☰ para configurar ruta y base de productos.");
    };
  }
  if (profileLogoutBtn) {
    profileLogoutBtn.onclick = () => {
      toggleProfileMenu(true);
      handleLogout();
    };
  }

  // Panel de usuarios
  const addUserBtn = getEl("addUserBtn");
  const closeUserModalBtn = getEl("closeUserModalBtn");
  const saveUserBtn = getEl("saveUserBtn");
  const newUserRole = getEl("newUserRole");

  if (addUserBtn) addUserBtn.onclick = openUserModal;
  if (closeUserModalBtn) closeUserModalBtn.onclick = closeUserModal;
  if (saveUserBtn) saveUserBtn.onclick = handleCreateUser;
  if (newUserRole) newUserRole.addEventListener("change", updateUserRoleFields);

  const refreshPendingBtn = getEl("refreshPendingBtn");
  if (refreshPendingBtn) refreshPendingBtn.onclick = loadPendingRoutes;

  // Historial de rutas
  const openHistoryBtn = getEl("openHistoryBtn");
  const closeHistoryModalBtn = getEl("closeHistoryModalBtn");
  const refreshHistoryBtn = getEl("refreshHistoryBtn");
  const historyRouteFilter = getEl("historyRouteFilter");

  if (openHistoryBtn) openHistoryBtn.onclick = openHistoryModal;
  if (closeHistoryModalBtn) closeHistoryModalBtn.onclick = closeHistoryModal;
  if (refreshHistoryBtn) refreshHistoryBtn.onclick = loadHistory;
  if (historyRouteFilter) {
    historyRouteFilter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") loadHistory();
    });
  }

  // Login
  const loginSubmitBtn = getEl("loginSubmitBtn");
  const loginPassword = getEl("loginPassword");
  const loginEmail = getEl("loginEmail");

  if (loginSubmitBtn) loginSubmitBtn.onclick = handleLogin;
  if (loginPassword) {
    loginPassword.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleLogin();
    });
  }
  if (loginEmail) {
    loginEmail.addEventListener("keydown", (e) => {
      if (e.key === "Enter") getEl("loginPassword")?.focus();
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDrawer();
      toggleProfileMenu(true);
    }
    const active = document.activeElement;
    if (active && active.tagName === "INPUT") return;
    getEl("scannerInput")?.focus();
  });

  // Reintento automático de sincronización (y de cierre de lista) cuando vuelve la conexión
  window.addEventListener("online", async () => {
    updateSyncIndicator();
    if (syncPending) await syncCurrentSessionItems();
    if (closePending) await tryCloseWhenOnline();
  });
  window.addEventListener("offline", () => {
    updateSyncIndicator();
  });
  setInterval(async () => {
    if (!navigator.onLine) return;
    if (syncPending && !syncInProgress) await syncCurrentSessionItems();
    if (closePending) await tryCloseWhenOnline();
  }, 15000);

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
// AUTENTICACIÓN Y ROLES
// =======================
function showLogin(message) {
  getEl("loginScreen")?.classList.remove("hidden");
  getEl("appRoot")?.classList.add("hidden");

  const errEl = getEl("loginError");
  if (errEl) {
    if (message) {
      errEl.textContent = message;
      errEl.classList.remove("hidden");
    } else {
      errEl.classList.add("hidden");
    }
  }
}

function showApp() {
  getEl("loginScreen")?.classList.add("hidden");
  getEl("appRoot")?.classList.remove("hidden");
}

async function fetchProfile(userId) {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (error) {
    console.error("Error cargando perfil:", error);
    return null;
  }
  return data;
}

// Muestra/oculta lo que solo puede usar un Admin, y ajusta la ruta/menú de perfil
function applyRoleGating(profile) {
  const isAdmin = profile.role === "admin";

  document.querySelectorAll("[data-admin-only]").forEach((el) => {
    el.classList.toggle("hidden", !isAdmin);
  });

  const canManageUsers = isAdmin || profile.role === "corporativo";
  document.querySelectorAll("[data-usermgmt-only]").forEach((el) => {
    el.classList.toggle("hidden", !canManageUsers);
  });

  document.querySelectorAll("[data-history-only]").forEach((el) => {
    el.classList.toggle("hidden", !canManageUsers);
  });

  // Admin/Corporativo: panel propio en vez de aterrizar en el escáner.
  document.querySelectorAll("[data-staff-only]").forEach((el) => {
    el.classList.toggle("hidden", !canManageUsers);
  });

  document.querySelectorAll("[data-route-only]").forEach((el) => {
    el.classList.toggle("hidden", profile.role !== "route");
  });

  const routeInput = getEl("routeInput");
  if (profile.role === "route" && routeInput) {
    routeInput.value = profile.route_code || "";
    routeInput.disabled = true;
    routeValue = profile.route_code || "";
    saveAll();
  }

  const nameLabel = getEl("profileNameLabel");
  const avatarInitial = getEl("profileAvatarInitial");
  const avatarSmall = document.querySelector("#profileBtn .avatar-circle");
  const initial = (profile.nombre || profile.role || "U").trim().charAt(0).toUpperCase();

  if (nameLabel) nameLabel.textContent = profile.nombre || "Usuario";
  if (avatarInitial) avatarInitial.textContent = initial;
  if (avatarSmall) avatarSmall.textContent = initial;

  const routeLabel = getEl("profileRouteLabel");
  if (routeLabel) {
    if (profile.role === "route") {
      routeLabel.textContent = "Ruta: " + (profile.route_code || "N/A");
    } else if (profile.role === "corporativo") {
      routeLabel.textContent = profile.puesto || "Corporativo";
    } else {
      routeLabel.textContent = "Administrador";
    }
  }
}

async function afterLogin(user) {
  currentUser = user;
  const profile = await fetchProfile(user.id);

  if (!profile) {
    showLogin("Tu cuenta no tiene un perfil asignado. Contacta a un Admin.");
    await supabaseClient.auth.signOut();
    currentUser = null;
    return;
  }

  if (profile.estado === "pendiente") {
    showLogin("Tu cuenta está pendiente de aprobación por un Admin.");
    await supabaseClient.auth.signOut();
    currentUser = null;
    return;
  }

  currentProfile = profile;
  showApp();
  applyRoleGating(profile);
  if (profile.role === "admin") loadPendingRoutes();

  // Ahora que hay sesión, refrescamos el catálogo compartido desde Supabase.
  await loadProducts();

  // Si es una ruta: pantalla "Mis conteos" (o retoma trabajo pendiente).
  // Admin/Corporativo: van a su Panel (Historial, Usuarios, Catálogo...).
  if (profile.role === "route") {
    await initSessionForRoute();
  } else {
    updateSessionChrome();
    showAdminHomeView();
    render();
  }
}

async function handleLogin() {
  if (!supabaseClient) {
    showLogin("Falta configurar Supabase en app.js (SUPABASE_URL / SUPABASE_ANON_KEY).");
    return;
  }

  const email = getEl("loginEmail")?.value.trim();
  const password = getEl("loginPassword")?.value || "";
  const submitBtn = getEl("loginSubmitBtn");

  if (!email || !password) {
    showLogin("Escribe tu correo y contraseña.");
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Entrando...";
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Entrar";
  }

  if (error) {
    console.error("Error de login Supabase:", error);
    // Mostramos el mensaje real de Supabase para poder diagnosticar
    // (puede ser contraseña incorrecta, correo no confirmado, etc.)
    showLogin(error.message || "Correo o contraseña incorrectos.");
    return;
  }

  await afterLogin(data.user);
}

async function handleLogout() {
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  currentSession = null;
  location.reload();
}

async function checkExistingSession() {
  if (!supabaseClient) {
    showLogin("Falta configurar Supabase en app.js (SUPABASE_URL / SUPABASE_ANON_KEY).");
    return;
  }

  const { data } = await supabaseClient.auth.getSession();
  if (data && data.session && data.session.user) {
    await afterLogin(data.session.user);
  } else {
    showLogin();
  }
}

// =======================
// PANEL DE USUARIOS (Admin / Corporativo)
// =======================
function updateUserRoleFields() {
  const role = getEl("newUserRole")?.value;
  const routeWrap = getEl("newUserRouteWrap");
  const puestoWrap = getEl("newUserPuestoWrap");

  if (routeWrap) routeWrap.classList.toggle("hidden", role !== "route");
  if (puestoWrap) puestoWrap.classList.toggle("hidden", role !== "corporativo");
}

function openUserModal() {
  const nombre = getEl("newUserNombre");
  const email = getEl("newUserEmail");
  const password = getEl("newUserPassword");
  const routeCode = getEl("newUserRouteCode");
  const roleSelect = getEl("newUserRole");
  const errEl = getEl("userModalError");
  const modal = getEl("userModal");

  if (nombre) nombre.value = "";
  if (email) email.value = "";
  if (password) password.value = "";
  if (routeCode) routeCode.value = "";
  if (errEl) errEl.classList.add("hidden");

  if (roleSelect) {
    roleSelect.value = "route";
    // Corporativo solo puede crear rutas: bloqueamos el selector en "route".
    roleSelect.disabled = currentProfile && currentProfile.role === "corporativo";
  }

  updateUserRoleFields();

  if (modal) modal.classList.remove("hidden");
}

function closeUserModal() {
  getEl("userModal")?.classList.add("hidden");
}

async function handleCreateUser() {
  const nombre = getEl("newUserNombre")?.value.trim();
  const email = getEl("newUserEmail")?.value.trim();
  const password = getEl("newUserPassword")?.value || "";
  const role = getEl("newUserRole")?.value;
  const route_code = getEl("newUserRouteCode")?.value.trim();
  const puesto = getEl("newUserPuesto")?.value;
  const saveBtn = getEl("saveUserBtn");
  const errEl = getEl("userModalError");

  const showErr = (msg) => {
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.remove("hidden");
    }
  };

  if (!supabaseClient) {
    showErr("Falta configurar Supabase en app.js.");
    return;
  }

  if (!nombre || !email || !password || !role) {
    showErr("Completa todos los campos.");
    return;
  }
  if (password.length < 6) {
    showErr("La contraseña debe tener al menos 6 caracteres.");
    return;
  }
  if (role === "route" && !route_code) {
    showErr("Escribe el número de ruta.");
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Creando...";
  }

  const { data, error } = await supabaseClient.functions.invoke("create-user", {
    body: { email, password, nombre, role, route_code, puesto },
  });

  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.textContent = "Crear usuario";
  }

  if (error || (data && data.error)) {
    showErr((data && data.error) || error?.message || "No se pudo crear el usuario.");
    return;
  }

  closeUserModal();
  if (data && data.estado === "pendiente") {
    alert("✅ Ruta creada. Queda pendiente de aprobación por un Admin.");
  } else {
    alert("✅ Usuario creado correctamente.");
  }
}

// =======================
// APROBACIONES PENDIENTES (Admin)
// =======================

// Actualiza el contador visible (avatar del header + tarjeta del Panel) sin
// que el Admin tenga que abrir el drawer para enterarse de que hay pendientes.
async function refreshPendingBadge() {
  const badges = document.querySelectorAll(".pending-badge");
  if (!badges.length) return;

  if (!supabaseClient || !currentProfile || currentProfile.role !== "admin") {
    badges.forEach((el) => el.classList.add("hidden"));
    return;
  }

  const { count, error } = await supabaseClient
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("estado", "pendiente");

  if (error) {
    console.error("Error contando pendientes:", error);
    return;
  }

  badges.forEach((el) => {
    if (count && count > 0) {
      el.textContent = String(count);
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  });
}

async function loadPendingRoutes() {
  const list = getEl("pendingRoutesList");
  if (!list || !supabaseClient) return;

  if (!currentProfile || currentProfile.role !== "admin") return;

  list.innerHTML = '<p class="help-text">Cargando...</p>';

  let data, error;
  try {
    ({ data, error } = await supabaseClient
      .from("profiles")
      .select("id, nombre, route_code, created_at")
      .eq("estado", "pendiente")
      .order("created_at", { ascending: true }));
  } catch (e) {
    error = e;
  }

  if (error) {
    list.innerHTML = '<p class="help-text">Error cargando pendientes: ' + (error.message || error) + '</p>';
    console.error(error);
    return;
  }

  if (!data || data.length === 0) {
    list.innerHTML = '<p class="help-text">No hay rutas pendientes de aprobación.</p>';
    return;
  }

  list.innerHTML = "";
  data.forEach((row) => {
    const item = document.createElement("div");
    item.className = "pending-item";
    item.innerHTML = `
      <div class="pending-item-info">
        <strong>${row.nombre || "Sin nombre"}</strong>
        <span>Ruta ${row.route_code || "N/A"}</span>
      </div>
      <div class="pending-item-actions">
        <button class="approve-btn">Aprobar</button>
        <button class="reject-btn">Rechazar</button>
      </div>
    `;

    item.querySelector(".approve-btn").onclick = () => approvePendingRoute(row.id);
    item.querySelector(".reject-btn").onclick = () => rejectPendingRoute(row.id);

    list.appendChild(item);
  });
}

async function approvePendingRoute(userId) {
  const { error } = await supabaseClient
    .from("profiles")
    .update({ estado: "activo", aprobado_por: currentUser?.id || null })
    .eq("id", userId);

  if (error) {
    alert("❌ No se pudo aprobar: " + error.message);
    return;
  }

  loadPendingRoutes();
  refreshPendingBadge();
}

async function rejectPendingRoute(userId) {
  if (!confirm("¿Rechazar y borrar esta cuenta pendiente?")) return;

  const { data, error } = await supabaseClient.functions.invoke("delete-user", {
    body: { userId },
  });

  if (error || (data && data.error)) {
    alert("❌ No se pudo rechazar: " + ((data && data.error) || error?.message));
    return;
  }

  loadPendingRoutes();
  refreshPendingBadge();
}

// =======================
// LISTAS DE ESCANEO (scan_sessions) — solo para role "route"
// =======================

// Solo busca la lista abierta de la ruta (no crea ninguna). Crear una lista
// nueva ahora es una acción explícita del driver desde "Mis conteos".
async function findOpenSession() {
  if (!supabaseClient || !currentUser || !currentProfile) return null;
  if (currentProfile.role !== "route" || !currentProfile.route_code) return null;

  try {
    const { data, error } = await supabaseClient
      .from("scan_sessions")
      .select("*")
      .eq("route_code", currentProfile.route_code)
      .eq("estado", "abierta")
      .order("abierta_en", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  } catch (e) {
    console.error("Error buscando lista abierta:", e);
    return null;
  }
}

// =======================
// NAVEGACIÓN: HOME ("Mis conteos") <-> DETALLE DE LISTA — solo role "route"
// =======================

// Ajusta qué partes de la pantalla de detalle se ven según el rol y si la
// lista que se muestra está abierta (editable) o cerrada (solo lectura).
function updateSessionChrome() {
  const isRoute = currentProfile && currentProfile.role === "route";

  if (!isRoute) {
    // Admin/Corporativo: sin estados de solo lectura (siguen sin sesiones),
    // pero sí pueden volver a su Panel con el mismo botón de "atrás".
    getEl("scannerCard")?.classList.remove("hidden");
    getEl("clearBtn")?.classList.remove("hidden");
    getEl("closeListBtn")?.classList.add("hidden");
    getEl("backToHomeBtn")?.classList.remove("hidden");
    getEl("readOnlyBanner")?.classList.add("hidden");
    getEl("cameraMethodSection")?.classList.remove("hidden");
    getEl("manualMethodSection")?.classList.remove("hidden");
    return;
  }

  const editable = !viewingReadOnly;
  getEl("scannerCard")?.classList.toggle("hidden", !editable);
  getEl("clearBtn")?.classList.toggle("hidden", !editable);
  getEl("closeListBtn")?.classList.toggle("hidden", !editable);
  getEl("backToHomeBtn")?.classList.remove("hidden");
  getEl("readOnlyBanner")?.classList.toggle("hidden", editable);
  getEl("syncStatusPill")?.classList.toggle("hidden", !editable);

  if (editable) {
    const usesCamera = viewingMetodo !== "pistola";
    getEl("cameraMethodSection")?.classList.toggle("hidden", !usesCamera);
    getEl("manualMethodSection")?.classList.toggle("hidden", usesCamera);
  }
}

function showHomeView() {
  currentView = "home";
  if (scanning) stopCamera();
  getEl("homeView")?.classList.remove("hidden");
  getEl("adminHomeView")?.classList.add("hidden");
  getEl("sessionView")?.classList.add("hidden");
  loadHomeSessions();
}

// Panel de aterrizaje para Admin/Corporativo (equivalente a "Mis conteos"
// pero con accesos directos en vez de una lista de conteos).
function showAdminHomeView() {
  currentView = "adminHome";
  if (scanning) stopCamera();
  getEl("adminHomeView")?.classList.remove("hidden");
  getEl("homeView")?.classList.add("hidden");
  getEl("sessionView")?.classList.add("hidden");
  refreshPendingBadge();
}

function showSessionView() {
  currentView = "session";
  getEl("homeView")?.classList.add("hidden");
  getEl("adminHomeView")?.classList.add("hidden");
  getEl("sessionView")?.classList.remove("hidden");
}

// El botón "← atrás" de la pantalla de escaneo lleva a Home o al Panel
// según el rol de quien lo esté viendo.
function goBackFromSession() {
  if (currentProfile && currentProfile.role === "route") {
    showHomeView();
  } else {
    showAdminHomeView();
  }
}

// Pinta la pantalla "Mis conteos": la lista abierta (si hay) como banner
// arriba, y el historial de listas cerradas de esta ruta debajo.
async function loadHomeSessions() {
  const list = getEl("sessionsList");
  const newBtn = getEl("newSessionBtn");
  const banner = getEl("openSessionBanner");
  if (!list || !supabaseClient || !currentProfile) return;

  list.innerHTML = '<p class="help-text">Cargando...</p>';

  const { data, error } = await supabaseClient
    .from("scan_sessions")
    .select("*")
    .eq("route_code", currentProfile.route_code)
    .order("abierta_en", { ascending: false });

  if (error) {
    list.innerHTML = '<p class="help-text">Error cargando tus conteos: ' + error.message + '</p>';
    console.error(error);
    return;
  }

  const sessions = data || [];
  const open = sessions.find((s) => s.estado === "abierta") || null;
  currentSession = open;

  if (open) {
    if (banner) {
      banner.classList.remove("hidden");
      const info = getEl("openSessionInfo");
      if (info) info.textContent = "Desde " + (open.abierta_en ? new Date(open.abierta_en).toLocaleString() : "");
    }
    if (newBtn) newBtn.classList.add("hidden");
  } else {
    if (banner) banner.classList.add("hidden");
    if (newBtn) newBtn.classList.remove("hidden");
  }

  const closedSessions = sessions.filter((s) => s.estado !== "abierta");

  if (closedSessions.length === 0) {
    list.innerHTML = '<p class="help-text">Todavía no tienes conteos cerrados.</p>';
    return;
  }

  list.innerHTML = "";
  closedSessions.forEach((session) => {
    const row = document.createElement("div");
    row.className = "session-row";
    const fecha = session.abierta_en ? new Date(session.abierta_en).toLocaleString() : "";
    row.innerHTML =
      '<div class="session-row-info">' +
      "<strong>Conteo del " + fecha + "</strong>" +
      '<span class="history-status cerrada">Cerrada</span>' +
      "</div>" +
      '<span class="session-row-arrow">›</span>';

    row.onclick = () => openSessionDetail(session);
    list.appendChild(row);
  });
}

// Abre el detalle de una lista (propia): si sigue abierta, queda editable
// (cámara/pistola, +/-, limpiar, cerrar); si ya está cerrada, solo lectura.
async function openSessionDetail(session) {
  viewingSessionId = session.id;
  viewingReadOnly = session.estado !== "abierta";
  viewingMetodo = session.metodo || "camara";

  if (!viewingReadOnly) {
    currentSession = session;
    if (syncPending || closePending) {
      // Hay cambios de este dispositivo sin subir todavía: usamos lo que ya
      // está guardado localmente en vez de pisarlo con lo último que llegó
      // a subirse al servidor.
      counts = JSON.parse(localStorage.getItem("bip_counts") || "{}");
    } else {
      await loadSessionItemsIntoCounts(session.id);
    }
  } else {
    await loadSessionItemsIntoCounts(session.id);
  }

  updateSessionChrome();
  render();
  showSessionView();

  if (!viewingReadOnly && navigator.onLine) {
    if (closePending) await tryCloseWhenOnline();
    else if (syncPending) syncCurrentSessionItems();
  }
}

function promptNewSession() {
  getEl("scanMethodModal")?.classList.remove("hidden");
}

function closeScanMethodModal() {
  getEl("scanMethodModal")?.classList.add("hidden");
}

// Crea una lista nueva con el método elegido (cámara o pistola) y entra
// directo a su pantalla de escaneo.
async function createNewSession(metodo) {
  closeScanMethodModal();

  if (!supabaseClient || !currentUser || !currentProfile) return;

  if (!navigator.onLine) {
    alert("📴 Necesitas conexión para iniciar un conteo nuevo. Tu lista actual (si tienes una) sigue funcionando sin conexión.");
    return;
  }

  const { data, error } = await supabaseClient
    .from("scan_sessions")
    .insert({ route_code: currentProfile.route_code, user_id: currentUser.id, metodo })
    .select()
    .single();

  if (error) {
    alert("❌ No se pudo crear el conteo: " + error.message);
    return;
  }

  counts = {};
  saveAllLocalOnly();
  await openSessionDetail(data);
}

async function loadSessionItemsIntoCounts(sessionId) {
  if (!supabaseClient || !sessionId) return;

  const { data, error } = await supabaseClient
    .from("scan_session_items")
    .select("*")
    .eq("session_id", sessionId);

  if (error) {
    console.error("Error cargando items de la lista:", error);
    return;
  }

  const loaded = {};
  (data || []).forEach((row) => {
    loaded[normalize(row.upc)] = {
      UPC: row.upc,
      SKU: row.sku || "N/A",
      Producto: row.producto || "",
      UnidadesCaja: Number(row.unidades_caja) || 1,
      Foto: row.foto || "",
      Cajas: Number(row.cajas) || 0
    };
  });

  counts = loaded;
}

// =======================
// ESTADO DE SINCRONIZACIÓN (offline-first)
// =======================
function markSyncPending(pending) {
  syncPending = pending;
  localStorage.setItem("bip_sync_pending", pending ? "1" : "0");
  updateSyncIndicator();
}

function updateSyncIndicator() {
  const pill = getEl("syncStatusPill");
  if (!pill) return;

  if (closePending) {
    pill.textContent = navigator.onLine ? "🔒 Cerrando lista..." : "🔒 Se cerrará al conectar";
    pill.className = "sync-pill pending";
  } else if (!navigator.onLine) {
    pill.textContent = "📴 Sin conexión";
    pill.className = "sync-pill offline";
  } else if (syncInProgress) {
    pill.textContent = "🔄 Sincronizando...";
    pill.className = "sync-pill syncing";
  } else if (syncPending) {
    pill.textContent = "⚠️ Pendiente de subir";
    pill.className = "sync-pill pending";
  } else {
    pill.textContent = "✅ Sincronizado";
    pill.className = "sync-pill ok";
  }

  // Solo se ve si el profile actual es "route" y se está viendo la lista
  // abierta (no tiene sentido mostrar estado de sync en una lista cerrada).
  if (currentProfile && currentProfile.role === "route" && !viewingReadOnly) {
    pill.classList.remove("hidden");
  } else if (currentProfile && currentProfile.role === "route") {
    pill.classList.add("hidden");
  }
}

// Sube "counts" a la sesión actual de forma segura para redes inestables:
// 1) primero sube (upsert) todo lo que hay local — nunca borra nada si algo falla.
// 2) solo después borra en el servidor lo que ya no está local (productos quitados).
// Así, si se corta la conexión a la mitad, en el peor caso queda un dato viejo
// de más (no destructivo), nunca se pierde lo que el usuario ya escaneó.
async function syncCurrentSessionItems() {
  if (!supabaseClient || !currentSession || !currentProfile || currentProfile.role !== "route") return;

  if (!navigator.onLine) {
    markSyncPending(true);
    return;
  }

  syncInProgress = true;
  updateSyncIndicator();

  try {
    const localItems = Object.values(counts);
    const localKeys = new Set(localItems.map((item) => item.UPC));

    const rows = localItems.map((item) => ({
      session_id: currentSession.id,
      upc: item.UPC,
      sku: item.SKU,
      producto: item.Producto,
      unidades_caja: item.UnidadesCaja,
      cajas: item.Cajas,
      foto: item.Foto
    }));

    if (rows.length) {
      const { error: upsertError } = await supabaseClient
        .from("scan_session_items")
        .upsert(rows, { onConflict: "session_id,upc" });
      if (upsertError) throw upsertError;
    }

    const { data: remoteItems, error: remoteError } = await supabaseClient
      .from("scan_session_items")
      .select("upc")
      .eq("session_id", currentSession.id);

    if (remoteError) throw remoteError;

    const toDelete = (remoteItems || [])
      .map((r) => r.upc)
      .filter((upc) => !localKeys.has(upc));

    if (toDelete.length) {
      const { error: deleteError } = await supabaseClient
        .from("scan_session_items")
        .delete()
        .eq("session_id", currentSession.id)
        .in("upc", toDelete);
      if (deleteError) throw deleteError;
    }

    markSyncPending(false);
  } catch (e) {
    console.error("Error sincronizando lista de escaneo:", e);
    markSyncPending(true);
  } finally {
    syncInProgress = false;
    updateSyncIndicator();
  }
}

// Se llama justo después del login de una ruta. Si hay trabajo sin
// sincronizar (scans sin subir, o un cierre en cola), retoma directo la
// pantalla de esa lista para no perderla de vista. Si no, muestra
// "Mis conteos" como pantalla de inicio.
async function initSessionForRoute() {
  if (!currentProfile || currentProfile.role !== "route") return;

  if (syncPending || closePending) {
    const openSession = await findOpenSession();

    if (openSession) {
      viewingSessionId = openSession.id;
      viewingReadOnly = false;
      viewingMetodo = openSession.metodo || "camara";
      currentSession = openSession;
      // counts ya vienen de localStorage (bip_counts): no los pisamos.
      updateSessionChrome();
      render();
      showSessionView();

      if (navigator.onLine) {
        if (closePending) await tryCloseWhenOnline();
        else if (syncPending) syncCurrentSessionItems();
      }
      return;
    }

    // Había un cierre/sync pendiente pero ya no existe una lista abierta
    // (por ejemplo, se cerró desde otro dispositivo): limpiamos las banderas.
    if (closePending) markClosePending(false);
    if (syncPending) markSyncPending(false);
  }

  showHomeView();
}

function markClosePending(pending) {
  closePending = pending;
  localStorage.setItem("bip_close_pending", pending ? "1" : "0");
  updateSyncIndicator();
}

// Hace el cierre real contra Supabase. Se usa tanto al cerrar con conexión
// como cuando el reintento automático detecta que ya hay señal.
async function performCloseSession() {
  if (!currentSession || !supabaseClient) return false;

  const { error } = await supabaseClient
    .from("scan_sessions")
    .update({
      estado: "cerrada",
      cerrada_en: new Date().toISOString(),
      cerrada_por: currentUser?.id || null
    })
    .eq("id", currentSession.id);

  if (error) {
    console.error("No se pudo cerrar la lista:", error);
    return false;
  }

  markClosePending(false);

  if (scanning) await stopCamera();

  currentSession = null;
  viewingSessionId = null;
  viewingReadOnly = false;
  counts = {};
  saveAllLocalOnly();

  // Ya no se abre una lista nueva automáticamente: el driver vuelve a
  // "Mis conteos" y decide ahí cuándo empezar un conteo nuevo.
  showHomeView();
  return true;
}

// Se llama desde el evento "online" y el retry periódico: si había un
// cierre en cola, primero asegura subir los últimos scans y luego cierra.
async function tryCloseWhenOnline() {
  if (!closePending || !currentSession || !navigator.onLine) return;

  if (syncPending) {
    await syncCurrentSessionItems();
    if (syncPending) return; // sigue sin poder subir, no cerramos todavía
  }

  const ok = await performCloseSession();
  if (ok) alert("✅ Ya volvió la conexión: la lista se cerró.");
}

// Borra por completo una lista abierta que no tiene ningún producto
// escaneado: no vale la pena guardarla como "cerrada" en el historial.
async function discardEmptySession() {
  if (!currentSession) return;

  if (!navigator.onLine) {
    alert("📴 Necesitas conexión para descartar un conteo vacío. Intenta de nuevo cuando tengas señal.");
    return;
  }

  if (!confirm("Este conteo está vacío. ¿Descartarlo? No hace falta guardarlo.")) return;

  const { error } = await supabaseClient
    .from("scan_sessions")
    .delete()
    .eq("id", currentSession.id);

  if (error) {
    alert("❌ No se pudo descartar: " + error.message);
    return;
  }

  if (scanning) await stopCamera();

  markClosePending(false);
  currentSession = null;
  viewingSessionId = null;
  viewingReadOnly = false;
  counts = {};
  saveAllLocalOnly();
  showHomeView();
}

async function closeCurrentList() {
  if (!currentSession) return;

  if (Object.keys(counts).length === 0) {
    await discardEmptySession();
    return;
  }

  if (syncPending || !navigator.onLine) {
    const proceed = confirm(
      "⚠️ No hay conexión (o hay scans sin subir todavía).\n" +
      "Cerrar la lista también necesita internet.\n\n" +
      "Puedo dejarla marcada para cerrarse sola en cuanto vuelva la señal — " +
      "mientras tanto puedes seguir escaneando en esta misma lista sin perder nada.\n\n" +
      "¿Marcarla para cerrar automáticamente?"
    );
    if (!proceed) return;

    markClosePending(true);
    alert("📌 Quedó marcada. Se cerrará sola apenas haya conexión.");
    return;
  }

  if (!confirm("¿Cerrar esta lista? Ya no podrás modificarla después.")) return;

  const ok = await performCloseSession();
  if (ok) {
    alert("✅ Lista cerrada.");
  } else {
    alert("❌ No se pudo cerrar la lista. Intenta de nuevo.");
  }
}

// Igual que saveAll() pero sin re-sincronizar la sesión (para evitar
// un ciclo al vaciar counts justo antes de abrir la lista nueva).
function saveAllLocalOnly() {
  localStorage.setItem("bip_counts", JSON.stringify(counts));
}

// =======================
// HISTORIAL DE RUTAS (Admin / Corporativo)
// =======================
function openHistoryModal() {
  getEl("historyModal")?.classList.remove("hidden");
  loadHistory();
}

function closeHistoryModal() {
  getEl("historyModal")?.classList.add("hidden");
}

async function loadHistory() {
  const list = getEl("historyList");
  if (!list || !supabaseClient) return;

  list.innerHTML = '<p class="help-text">Cargando...</p>';

  const filter = getEl("historyRouteFilter")?.value.trim();

  // Corporativo solo ve el historial de las rutas que él mismo dio de alta
  // (no las de todo el sistema, esas quedan reservadas para Admin).
  let allowedRouteCodes = null;
  if (currentProfile && currentProfile.role === "corporativo") {
    const { data: ownRoutes, error: ownError } = await supabaseClient
      .from("profiles")
      .select("route_code")
      .eq("creado_por", currentUser.id)
      .eq("role", "route");

    if (ownError) {
      list.innerHTML = '<p class="help-text">Error cargando tus rutas: ' + ownError.message + '</p>';
      console.error(ownError);
      return;
    }

    allowedRouteCodes = (ownRoutes || []).map((r) => r.route_code).filter(Boolean);

    if (allowedRouteCodes.length === 0) {
      list.innerHTML = '<p class="help-text">Todavía no has creado ninguna ruta.</p>';
      return;
    }
  }

  let data, error;
  try {
    let query = supabaseClient
      .from("scan_sessions")
      .select("*")
      .order("abierta_en", { ascending: false });

    if (allowedRouteCodes) query = query.in("route_code", allowedRouteCodes);
    if (filter) query = query.eq("route_code", filter);

    ({ data, error } = await query);
  } catch (e) {
    error = e;
  }

  if (error) {
    list.innerHTML = '<p class="help-text">Error cargando historial: ' + (error.message || error) + '</p>';
    console.error(error);
    return;
  }

  if (!data || data.length === 0) {
    list.innerHTML = '<p class="help-text">No hay listas todavía.</p>';
    return;
  }

  list.innerHTML = "";
  data.forEach((session) => {
    const card = document.createElement("div");
    card.className = "history-item";

    const fecha = session.abierta_en ? new Date(session.abierta_en).toLocaleString() : "";
    const estadoLabel = session.estado === "abierta" ? "Abierta" : "Cerrada";

    card.innerHTML = `
      <div class="history-item-head">
        <div>
          <strong>Ruta ${session.route_code || "N/A"}</strong>
          <div><span>${fecha}</span></div>
        </div>
        <span class="history-status ${session.estado}">${estadoLabel}</span>
      </div>
      <div class="history-item-detail"></div>
    `;

    const head = card.querySelector(".history-item-head");
    const detail = card.querySelector(".history-item-detail");

    head.onclick = async () => {
      if (detail.classList.contains("open")) {
        detail.classList.remove("open");
        return;
      }
      detail.classList.add("open");
      await renderSessionDetail(detail, session);
    };

    list.appendChild(card);
  });
}

async function renderSessionDetail(container, session) {
  container.innerHTML = '<p class="help-text">Cargando detalle...</p>';

  const { data, error } = await supabaseClient
    .from("scan_session_items")
    .select("*")
    .eq("session_id", session.id);

  if (error) {
    container.innerHTML = '<p class="help-text">Error cargando items.</p>';
    console.error(error);
    return;
  }

  const items = data || [];
  let totalCases = 0;
  let totalUnits = 0;

  let rowsHtml = items
    .map((item) => {
      totalCases += Number(item.cajas) || 0;
      totalUnits += (Number(item.cajas) || 0) * (Number(item.unidades_caja) || 1);
      return (
        '<div class="history-detail-row"><span>' +
        (item.producto || item.upc) +
        '</span><span>' +
        item.cajas +
        ' cajas</span></div>'
      );
    })
    .join("");

  if (!rowsHtml) rowsHtml = '<p class="help-text">Sin productos escaneados.</p>';

  const closeBtnHtml =
    session.estado === "abierta"
      ? '<button class="history-force-close-btn">Forzar cierre</button>'
      : "";

  container.innerHTML =
    '<div class="history-detail-row"><strong>Total cajas</strong><strong>' + totalCases + '</strong></div>' +
    '<div class="history-detail-row"><strong>Total unidades</strong><strong>' + totalUnits + '</strong></div>' +
    rowsHtml +
    closeBtnHtml;

  const forceBtn = container.querySelector(".history-force-close-btn");
  if (forceBtn) {
    forceBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm("¿Forzar el cierre de esta lista?")) return;

      const { error: closeError } = await supabaseClient
        .from("scan_sessions")
        .update({
          estado: "cerrada",
          cerrada_en: new Date().toISOString(),
          cerrada_por: currentUser?.id || null
        })
        .eq("id", session.id);

      if (closeError) {
        alert("❌ No se pudo forzar el cierre: " + closeError.message);
        return;
      }

      alert("✅ Lista cerrada.");
      loadHistory();
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
    await checkExistingSession();
    setTimeout(() => getEl("scannerInput")?.focus(), 300);
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
