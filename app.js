alert("APP.JS CARGADO");

window.onerror = function(msg, src, line, col, err) {
  alert(
    "ERROR:\n" +
    msg +
    "\nLINEA: " + line
  );
};

alert("DESPUES DEL ONERROR");
