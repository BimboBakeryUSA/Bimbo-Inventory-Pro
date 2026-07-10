alert("APP.JS CARGADO ✅ y testeando");
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
  console.error("ERROR GLOBAL:", msg, line, err);
};

// =======================
// SAFE GET ELEMENT
// =======================
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) {
    console.error("❌ Elemento NO encontrado:", id);
  }
  return el;
};
alert("LINEA 3 VARIABLES");
// =======================
// VARIABLES
// =======================
const PRODUCT_DB_URL = "products.json";
const DEFAULT_IMAGE = "default-product.svg";

let products = [];
let counts = JSON.parse(localStorage.getItem("bip_counts") || "{}");
let routeValue = localStorage.getItem("bip_route") || "";
let html5QrCode = null;
let scanning = false;
let lastCode = "";

// =======================
// LOAD PRODUCTS
// =======================
async function loadProducts() {
  console.log("📦 Cargando productos...");

  const saved = localStorage.getItem("bip_products");
  if (saved) {
    products = JSON.parse(saved);
    console.log("✅ Productos desde localStorage");
    return;
  }

  try {
    const res = await fetch(PRODUCT_DB_URL);
    products = await res.json();
    console.log("✅ Productos desde JSON");
  } catch (e) {
    console.warn("⚠️ No se pudo cargar JSON, usando default");
    products = defaultProducts();
  }
}

// =======================
function defaultProducts() {
  return [
    { UPC: "757528008680", SKU: "1001", Producto: "Takis Fuego", UnidadesCaja: 12, Foto: "" },
    { UPC: "7432358480", SKU: "8444", Producto: "Rosca de Reyes", UnidadesCaja: 5, Foto: "" }
  ];
}

// =======================
function saveAll() {
  try {
    localStorage.setItem("bip_counts", JSON.stringify(counts));
    if ($("routeInput")) {
      localStorage.setItem("bip_route", $("routeInput").value.trim());
    }
  } catch (e) {
    console.error("❌ Error guardando:", e);
  }
}

// =======================
// RENDER
// =======================
function render() {
  console.log("🎨 Renderizando...");

  const list = $("productList");
  if (!list) {
    console.error("❌ No existe productList");
    return;
  }

  list.innerHTML = "";

  const items = Object.values(counts);

  if (items.length === 0) {
    list.innerHTML = "No hay productos";
    return;
  }

  items.forEach(item => {
    const div = document.createElement("div");
    div.textContent = `${item.Producto} - ${item.Cajas}`;
    list.appendChild(div);
  });
}

// =======================
// CAMERA
// =======================
async function startCamera() {
  console.log("📷 Iniciando cámara...");

  if (typeof Html5Qrcode === "undefined") {
    alert("❌ Librería html5-qrcode NO cargó");
    return;
  }

  try {
    html5QrCode = new Html5Qrcode("reader");

    await html5QrCode.start(
      { facingMode: "environment" },
     {
  fps: 12,
  qrbox: { width: 250, height: 250 }
},
(decodedText) => processBarcode(decodedText)

    );

    scanning = true;
    console.log("✅ Cámara activa");
  } catch (err) {
    alert("❌ Error cámara: " + err);
  }
}

// =======================
// EVENTS
// =======================
function setupEvents() {

  console.log({
  startBtn: $("startBtn"),
  stopBtn: $("stopBtn"),
  exportBtn: $("exportBtn"),
  scannerInput: $("scannerInput"),
});

  
  console.log("🔌 Configurando eventos...");
  

  try {
    const startBtn = $("startBtn");
    const stopBtn = $("stopBtn");
    const routeInput = $("routeInput");

    console.log("DEBUG ELEMENTS:", {
      startBtn,
      stopBtn,
      routeInput
    });

    if (routeInput) {
      routeInput.value = routeValue;
      routeInput.addEventListener("input", saveAll);
    }

    if (startBtn) startBtn.onclick = startCamera;

    if (stopBtn) {
      stopBtn.onclick = async () => {
        if (html5QrCode) {
          await html5QrCode.stop();
          console.log("🛑 Cámara detenida");
        }
      };
    }

  } catch (e) {
    console.error("❌ Error en setupEvents:", e);
    alert("Error en setupEvents: " + e.message);
  }
}

// =======================
// INIT
// =======================
document.addEventListener("DOMContentLoaded", async () => {
  console.log("🚀 DOM listo");

  try {
    await loadProducts();
    setupEvents();
    render();

    console.log("✅ APP INICIADA");
  } catch (e) {
    console.error("❌ Error en INIT:", e);
    alert("Error en INIT: " + e.message);
  }
});

// =======================
// SERVICE WORKER DEBUG
// =======================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js")
    .then(() => console.log("✅ SW registrado"))
    .catch(err => console.warn("⚠️ SW error:", err));
}
