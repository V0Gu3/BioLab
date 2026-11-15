(function (root) {
  'use strict';

  // PDF y Excel se usan sólo al exportar, importar o previsualizar documentos.
  // Cargarlos al interpretar la página retrasaba la primera pantalla aunque la
  // mayoría de sesiones no los necesitara. Se descargan después de que la
  // interfaz ya está disponible y se comparten entre todas las acciones.
  const pending = new Map();
  function loadScript(id, source, ready) {
    if (ready()) return Promise.resolve();
    if (pending.has(id)) return pending.get(id);
    const task = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = source; script.async = true;
      script.onload = () => ready() ? resolve() : reject(new Error(`No se pudo preparar ${id}.`));
      script.onerror = () => reject(new Error(`No se pudo descargar ${id}.`));
      document.head.append(script);
    }).finally(() => pending.delete(id));
    pending.set(id, task); return task;
  }
  const libraries = {
    pdf: () => loadScript('generador de PDF', 'assets/vendor/jspdf-4.2.1.umd.min.js', () => Boolean(root.jspdf?.jsPDF)),
    excel: () => loadScript('generador de Excel', 'assets/vendor/xlsx-js-style-1.2.0.bundle.js', () => Boolean(root.XLSX))
  };
  root.BioLibraries = libraries;

  const warm = () => {
    const schedule = root.requestIdleCallback || (callback => root.setTimeout(callback, 1200));
    schedule(() => { libraries.pdf().catch(() => {}); libraries.excel().catch(() => {}); }, { timeout: 4500 });
  };
  root.addEventListener('load', warm, { once: true });
})(window);
