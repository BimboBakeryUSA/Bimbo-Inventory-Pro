alert("APP.JS CARGADO");

window.onerror = function(msg, src, line, col, err) {
    alert(
      "ERROR:\n" +
      msg +
      "\nLINEA: " + line
    );
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

const $ = (id) => document.getElementById(id);
alert("APP.JS EJECUTANDO"); 

async function loadProducts(){
  const saved = localStorage.getItem("bip_products");
  if(saved){ products = JSON.parse(saved); return; }
  try{
    const res = await fetch(PRODUCT_DB_URL);
    products = await res.json();
  }catch(e){
    products = defaultProducts();
  }
}
function defaultProducts(){
  return [
    {"UPC":"1234","SKU":"1001","Producto":"Takis Fuego","UnidadesCaja":12,"Foto":""},
    {"UPC":"757528045609","SKU":"1002","Producto":"Takis Blue Heat","UnidadesCaja":12,"Foto":""},
    {"UPC":"757528046224","SKU":"1003","Producto":"Takis Intense Nacho","UnidadesCaja":12,"Foto":""},
    {"UPC":"757528044664","SKU":"1004","Producto":"Takis Nitro","UnidadesCaja":12,"Foto":""},
    {"UPC":"7432358480","SKU":"8444","Producto":"Rosca de Reyes","UnidadesCaja":5,"Foto":""}
  ];
}
function saveProducts(){ localStorage.setItem("bip_products", JSON.stringify(products)); }
function saveAll(){ localStorage.setItem("bip_counts", JSON.stringify(counts)); localStorage.setItem("bip_route", $("routeInput").value.trim()); }
function normalize(value){ return String(value || "").replace(/[^0-9A-Za-z]/g, "").trim(); }
function findProduct(code){
  const clean = normalize(code);
  return products.find(p => normalize(p.UPC) === clean || normalize(p.SKU) === clean) || {UPC: clean, SKU: "N/A", Producto: "Código no registrado: " + clean, UnidadesCaja: 1, Foto: "", noRegistrado: true};
}
function beep(){
  try{ const ctx = new (window.AudioContext || window.webkitAudioContext)(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); osc.connect(gain); gain.connect(ctx.destination); osc.frequency.value = 980; gain.gain.value = 0.08; osc.start(); setTimeout(() => { osc.stop(); ctx.close(); }, 120); }catch(e){}
  if(navigator.vibrate) navigator.vibrate(90);
}
function processBarcode(rawCode){
  const code = normalize(rawCode); if(!code) return;
  const now = Date.now(); if(code === lastCode && now - lastScanTime < 900) return;
  lastCode = code; lastScanTime = now;
  const product = findProduct(code); const key = normalize(product.UPC || code);
  if(!counts[key]){ counts[key] = {UPC: product.UPC || code, SKU: product.SKU || "N/A", Producto: product.Producto || "Sin nombre", UnidadesCaja: Number(product.UnidadesCaja) || 1, Foto: product.Foto || "", Cajas: 0}; }
  counts[key].Cajas += 1;
  $("lastScanText").textContent = "Último: " + counts[key].Producto;
  beep(); saveAll(); render();
}
function productImageSrc(item){ return item.Foto && item.Foto.trim() ? item.Foto.trim() : DEFAULT_IMAGE; }
function render(){
  const list = $("productList"); list.innerHTML = "";
  const items = Object.values(counts); let totalCases = 0, totalUnits = 0;
  if(items.length === 0){ list.innerHTML = '<div class="empty-state">Todavía no hay productos escaneados.</div>'; }
  items.sort((a,b) => a.Producto.localeCompare(b.Producto)).forEach(item => {
    totalCases += Number(item.Cajas) || 0; totalUnits += (Number(item.Cajas) || 0) * (Number(item.UnidadesCaja) || 1);
    const tpl = $("productCardTemplate").content.cloneNode(true);
    tpl.querySelector("h3").textContent = item.Producto; tpl.querySelector(".sku-line").textContent = "SKU: " + item.SKU; tpl.querySelector(".upc-line").textContent = "UPC: " + item.UPC; tpl.querySelector(".case-count").textContent = item.Cajas; tpl.querySelector(".unit-count").textContent = item.Cajas * item.UnidadesCaja;
    const photo = tpl.querySelector(".product-photo"); const img = document.createElement("img"); img.src = productImageSrc(item); img.alt = item.Producto; img.onerror = () => { img.src = DEFAULT_IMAGE; }; photo.appendChild(img);
    tpl.querySelector(".plus-btn").onclick = () => { item.Cajas += 1; saveAll(); render(); };
    tpl.querySelector(".minus-btn").onclick = () => { item.Cajas = Math.max(0, item.Cajas - 1); if(item.Cajas === 0) delete counts[normalize(item.UPC)]; saveAll(); render(); };
    tpl.querySelector(".delete-btn").onclick = () => { delete counts[normalize(item.UPC)]; saveAll(); render(); };
    tpl.querySelector(".edit-product-btn").onclick = () => openProductModal(item.UPC);
    list.appendChild(tpl);
  });
  $("totalSku").textContent = items.length; $("totalCases").textContent = totalCases; $("totalUnits").textContent = totalUnits;
}
async function startCamera(){
  if(scanning) return;
  if(typeof Html5Qrcode === "undefined"){ alert("No cargó html5-qrcode. Sube la app a GitHub Pages y abre con internet la primera vez."); return; }
  html5QrCode = new Html5Qrcode("reader");
  const config = { fps: 12, qrbox: (w,h) => { const s = Math.floor(Math.min(w,h)*0.78); return {width:s, height:Math.floor(s*0.48)}; }, aspectRatio: 1.5, disableFlip: false };
  try{ await html5QrCode.start({ facingMode: "environment" }, config, decodedText => processBarcode(decodedText), () => {}); scanning = true; $("statusPill").textContent = "Activo"; $("statusPill").className = "status-pill on"; }
  catch(err){ alert("No se pudo abrir la cámara. Revisa permisos y abre la app desde HTTPS en GitHub Pages."); }
}
async function stopCamera(){
  if(html5QrCode && scanning){ try{ await html5QrCode.stop(); await html5QrCode.clear(); }catch(e){} }
  scanning = false; $("statusPill").textContent = "Inactivo"; $("statusPill").className = "status-pill off";
}
function upsertProductFromForm(){
  const upc = normalize($("newUpc").value); const sku = $("newSku").value.trim() || "N/A"; const name = $("newName").value.trim(); const units = Number($("newUnits").value) || 1; const photo = $("newPhoto").value.trim();
  if(!upc){ alert("Escanea o escribe el UPC/código."); return; } if(!name){ alert("Escribe el nombre del producto."); return; }
  const record = { UPC: upc, SKU: sku, Producto: name, UnidadesCaja: units, Foto: photo };
  const idx = products.findIndex(p => normalize(p.UPC) === upc || normalize(p.SKU) === upc);
  if(idx >= 0) products[idx] = record; else products.push(record); saveProducts();
  if(counts[upc]){ counts[upc].SKU = record.SKU; counts[upc].Producto = record.Producto; counts[upc].UnidadesCaja = record.UnidadesCaja; counts[upc].Foto = record.Foto; saveAll(); }
  closeProductModal(); render(); alert("Producto guardado.");
}
function openProductModal(code=""){
  const clean = normalize(code || lastCode); const p = clean ? findProduct(clean) : null;
  $("newUpc").value = p ? normalize(p.UPC || clean) : ""; $("newSku").value = p && !p.noRegistrado ? (p.SKU || "") : ""; $("newName").value = p && !p.noRegistrado ? (p.Producto || "") : ""; $("newUnits").value = p && !p.noRegistrado ? (p.UnidadesCaja || 1) : 1; $("newPhoto").value = p && !p.noRegistrado ? (p.Foto || "") : "";
  updatePreview(); $("productModal").classList.remove("hidden"); setTimeout(() => $("newUpc").focus(), 150);
}
function closeProductModal(){ $("productModal").classList.add("hidden"); }
function updatePreview(){ const url = $("newPhoto").value.trim(); $("newPhotoPreview").src = url || DEFAULT_IMAGE; $("newPhotoPreview").onerror = () => { $("newPhotoPreview").src = DEFAULT_IMAGE; }; }
function exportCSV(){
  const route = $("routeInput").value.trim(); let csv = "Ruta,SKU,UPC,Producto,Cajas,UnidadesCaja,Unidades,Foto
";
  Object.values(counts).forEach(item => { const row = [route,item.SKU,item.UPC,item.Producto,item.Cajas,item.UnidadesCaja,item.Cajas*item.UnidadesCaja,item.Foto].map(v => '"' + String(v).replaceAll('"','""') + '"').join(","); csv += row + "
"; });
  downloadFile("Bimbo_Inventory_Route_" + (route || "NA") + ".csv", csv, "text/csv");
}
function shareWhatsApp(){
  const route = $("routeInput").value.trim() || "N/A"; let msg = `Bimbo Inventory Pro%0ARuta: ${encodeURIComponent(route)}%0A%0A`;
  Object.values(counts).forEach(item => { msg += `${encodeURIComponent(item.Producto)} - ${item.Cajas} cajas / ${item.Cajas * item.UnidadesCaja} unidades%0A`; });
  msg += `%0ATotal Cajas: ${$("totalCases").textContent}%0ATotal Unidades: ${$("totalUnits").textContent}`; window.open("https://wa.me/?text=" + msg, "_blank");
}
function downloadFile(filename, content, type){ const blob = new Blob([content], {type}); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href); }
function parseCsvLine(line){ const result=[]; let current=""; let inQuotes=false; for(const ch of line){ if(ch==='"') inQuotes=!inQuotes; else if(ch==="," && !inQuotes){ result.push(current); current=""; } else current += ch; } result.push(current); return result.map(x => x.trim().replace(/^"|"$/g,"")); }
async function importCSV(file){
  const text = await file.text(); const lines = text.split(/
?
/).filter(Boolean); const headers = parseCsvLine(lines.shift()).map(h => h.trim().toLowerCase());
  const getIndex = names => names.map(n => headers.indexOf(n)).find(i => i >= 0);
  const upcI=getIndex(["upc","codigo","barcode"]), skuI=getIndex(["sku"]), prodI=getIndex(["producto","product","name"]), unitsI=getIndex(["unidadescaja","unitspercase","unidades por caja"]), fotoI=getIndex(["foto","photo","image"]);
  const imported = lines.map(line => { const v=parseCsvLine(line); return { UPC:v[upcI]||"", SKU: skuI>=0?v[skuI]:"", Producto: prodI>=0?v[prodI]:"", UnidadesCaja: unitsI>=0?Number(v[unitsI]||1):1, Foto: fotoI>=0?v[fotoI]:"" }; }).filter(p => p.UPC && p.Producto);
  products = imported; saveProducts(); alert("Base cargada: " + products.length + " productos.");
}
function downloadTemplate(){ const csv="UPC,SKU,Producto,UnidadesCaja,Foto
757528008680,1001,Takis Fuego,12,
757528045609,1002,Takis Blue Heat,12,
7432358480,8444,Rosca de Reyes,5,
"; downloadFile("bimbo_products_template.csv", csv, "text/csv"); }

function setupEvents(){

  $("routeInput").value = routeValue; $("routeInput").addEventListener("input", saveAll);
  $("startBtn").onclick = startCamera; $("stopBtn").onclick = stopCamera; $("exportBtn").onclick = exportCSV; $("whatsappBtn").onclick = shareWhatsApp;
  $("addProductBtn").onclick = () => openProductModal(lastCode); $("closeModalBtn").onclick = closeProductModal; $("saveProductBtn").onclick = upsertProductFromForm; $("useLastCodeBtn").onclick = () => { $("newUpc").value = lastCode || ""; };
  $("newPhoto").addEventListener("input", updatePreview); $("newUpc").addEventListener("keydown", e => { if(e.key === "Enter"){ $("newSku").focus(); } });
  $("clearBtn").onclick = () => { if(confirm("¿Limpiar el conteo actual?")){ counts={}; saveAll(); render(); $("lastScanText").textContent="Sin scans"; } };
  $("resetDbBtn").onclick = () => { if(confirm("¿Restaurar base de productos demo?")){ products = defaultProducts(); saveProducts(); alert("Base demo restaurada."); } };
  $("scannerInput").addEventListener("keydown", e => { if(e.key === "Enter"){ processBarcode(e.target.value); e.target.value=""; } });
  $("csvInput").addEventListener("change", e => { if(e.target.files && e.target.files[0]) importCSV(e.target.files[0]); }); $("templateBtn").onclick = downloadTemplate;
  window.addEventListener("keydown", e => { const active=document.activeElement; if(active && active.tagName === "INPUT") return; $("scannerInput").focus(); });
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredPrompt=e; $("installBtn").classList.remove("hidden"); });
  $("installBtn").onclick = async () => { if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt=null; $("installBtn").classList.add("hidden"); } };
}
if("serviceWorker" in navigator){ navigator.serviceWorker.register("sw.js").catch(() => {}); }
alert('APP INICIANDO');
(async function init(){

  alert("INIT 1");

  await loadProducts();

  alert("INIT 2");

  setupEvents();

  alert("INIT 3");

  render();

  alert("INIT 4");

})();
                            
                            render(); setTimeout(() => $("scannerInput").focus(), 400); })();
