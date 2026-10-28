/* ==========================================================
   Mapa de Nicaragua · lógica de la aplicación
   - Lugares base: data/lugares.json
   - Tus datos (estado, fechas, notas) y lugares añadidos
     se guardan en localStorage de este navegador.
   ========================================================== */
(() => {
  'use strict';

  /* ---------- Configuración ---------- */

  const STORAGE_KEY = 'mapa-nicaragua:v1';
  const DATA_URL = 'data/lugares.json';
  const CENTRO = [12.87, -85.2];
  const ZOOM_INICIAL = 7;

  // ---------- Firebase (mapa compartido entre varias personas) ----------
  const firebaseConfig = {
    apiKey: "AIzaSyB0r8KU9HpjJ6CYGcrwqJuuM4LWwmMbTw0",
    authDomain: "mapa-interactivo-nicaragua.firebaseapp.com",
    projectId: "mapa-interactivo-nicaragua",
    storageBucket: "mapa-interactivo-nicaragua.firebasestorage.app",
    messagingSenderId: "992556323603",
    appId: "1:992556323603:web:6903297e5016173a0540e6"
  };

  let db = null;
  let syncListo = false;
  let escribiendoNube = false;

  try {
    if (typeof firebase !== 'undefined') {
      firebase.initializeApp(firebaseConfig);
      db = firebase.firestore();
    }
  } catch (err) {
    console.warn('Firebase no se pudo iniciar:', err);
  }

  // Único lugar donde se definen los estados y sus colores.
  const ESTADOS = {
    sin_marcar: { label: 'Sin marcar',     color: '#94a3b8' },
    visitado:   { label: 'Ya visitado',    color: '#16a34a' },
    quiero:     { label: 'Quiero visitar', color: '#2563eb' },
    planeado:   { label: 'Voy a visitar',  color: '#f97316' },
    volver:     { label: 'Quiero volver',  color: '#9333ea' }, // estado extra: ya estuve y quiero repetir
  };

  const FILTROS = [
    { id: 'todos',       label: 'Todos',          color: '#14202b' },
    { id: 'visitados',   label: 'Visitados',      color: ESTADOS.visitado.color },
    { id: 'por_visitar', label: 'Por visitar',    color: ESTADOS.quiero.color },
    { id: 'con_fecha',   label: 'Con fecha',      color: ESTADOS.planeado.color },
    { id: 'volver',      label: 'Quiero volver',  color: ESTADOS.volver.color },
    { id: 'sin_marcar',  label: 'Sin marcar',     color: ESTADOS.sin_marcar.color },
  ];

  const TIPOS = { departamento: 'Departamento', ciudad: 'Ciudad', lugar: 'Lugar' };

  // Expone los colores al CSS (--c-visitado, --c-quiero, ...)
  Object.entries(ESTADOS).forEach(([k, e]) =>
    document.documentElement.style.setProperty(`--c-${k}`, e.color));

  /* ---------- Utilidades ---------- */

  const $ = (sel, root = document) => root.querySelector(sel);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  const esMovil = () => window.matchMedia('(max-width: 860px)').matches;

  const fmtFecha = (iso) => {
    if (!iso) return '';
    const d = new Date(`${iso}T00:00:00`);
    return isNaN(d) ? iso : d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  /* ---------- Estado de la aplicación ---------- */

  let base = [];        // lugares de data/lugares.json
  let custom = [];      // lugares añadidos por ti
  let datos = {};       // { [id]: { estado, fechaVisita, fechaPrevista, notas } }
  let lugares = [];     // base + custom

  const markers = new Map();
  let filtro = 'todos';
  let query = '';
  let mostrarDeps = true;
  let mostrarCiudades = true;

  let seleccionado = null;
  let modoNuevo = false;
  let marcadorTemp = null;
  let anadiendo = false;

  const vacio = () => ({ estado: 'sin_marcar', fechaVisita: '', fechaPrevista: '', notas: '' });
  const info = (id) => ({ ...vacio(), ...(datos[id] || {}) });
  const porId = (id) => lugares.find((l) => l.id === id);

  const esVisitado = (estado) => estado === 'visitado' || estado === 'volver';
  const esPorVisitar = (estado) => estado === 'quiero' || estado === 'planeado';
  const tieneFecha = (i) => i.estado === 'planeado' || (!esVisitado(i.estado) && !!i.fechaPrevista);

  /* ---------- Almacenamiento (local + nube compartida) ---------- */

  function cargarStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      datos = p.datos && typeof p.datos === 'object' ? p.datos : {};
      custom = Array.isArray(p.custom) ? p.custom.filter(lugarValido) : [];
    } catch (err) {
      console.warn('No se pudieron leer los datos guardados:', err);
    }
  }

  function guardarStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ datos, custom }));
    } catch (err) {
      console.warn(err);
      toast('No se pudo guardar en este navegador');
    }
    // También guardar en la nube para compartir
    guardarEnNube();
  }

  function guardarEnNube() {
    if (!db || !syncListo || escribiendoNube) return;
    escribiendoNube = true;
    db.collection('mapa').doc('compartido').set({
      datos,
      custom,
      actualizado: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true })
      .then(() => { escribiendoNube = false; })
      .catch((err) => {
        escribiendoNube = false;
        console.warn('No se pudo guardar en la nube:', err);
      });
  }

  async function iniciarNube() {
    if (!db || typeof firebase === 'undefined') return;
    try {
      await firebase.auth().signInAnonymously();
      const ref = db.collection('mapa').doc('compartido');

      // Cargar datos existentes de la nube
      const snap = await ref.get();
      if (snap.exists) {
        const p = snap.data();
        if (p.datos && typeof p.datos === 'object') datos = p.datos;
        if (Array.isArray(p.custom)) custom = p.custom.filter(lugarValido);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ datos, custom }));
        } catch (_) {}
      }

      syncListo = true;
      let primeraVez = true;

      // Escuchar cambios en tiempo real (cuando otra persona edita)
      ref.onSnapshot((doc) => {
        if (escribiendoNube) return;
        if (!doc.exists) return;
        const p = doc.data();
        const nuevosDatos = p.datos && typeof p.datos === 'object' ? p.datos : {};
        const nuevosCustom = Array.isArray(p.custom) ? p.custom.filter(lugarValido) : [];
        datos = nuevosDatos;
        custom = nuevosCustom;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ datos, custom }));
        } catch (_) {}
        if (!primeraVez) {
          reconstruir();
          toast('Mapa actualizado desde la nube');
        }
        primeraVez = false;
      });
    } catch (err) {
      console.warn('Nube no disponible, se usa solo este dispositivo:', err);
    }
  }

  function lugarValido(l) {
    return l && typeof l.id === 'string' && typeof l.nombre === 'string' &&
      Array.isArray(l.coordenadas) && l.coordenadas.length === 2 &&
      l.coordenadas.every((n) => typeof n === 'number' && isFinite(n));
  }

  async function cargarBase() {
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const lista = Array.isArray(json) ? json : json.lugares;
      const vistos = new Set();
      base = (lista || []).filter((l) => {
        if (!lugarValido(l) || vistos.has(l.id)) {
          console.warn('Lugar ignorado en lugares.json:', l);
          return false;
        }
        vistos.add(l.id);
        return true;
      });
    } catch (err) {
      console.error(err);
      base = [];
      const b = $('#banner');
      b.innerHTML = 'No se pudo cargar <code>data/lugares.json</code>. Si abriste <code>index.html</code> con doble clic, ' +
        'inicia un servidor local (mira el README, por ejemplo <code>python3 -m http.server</code>).';
      b.hidden = false;
    }
  }

  /* ---------- Mapa ---------- */

  const map = L.map('map', {
    minZoom: 6,
    maxBounds: [[8.0, -91.0], [17.0, -79.0]],
    maxBoundsViscosity: 0.8,
  }).setView(CENTRO, ZOOM_INICIAL);

  // Capas base estables (sin API key). OpenStreetMap por defecto porque es el más confiable.
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const calles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, USGS, OpenStreetMap contributors',
  });

  const satelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics, GIS User Community',
  });

  const relieve = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    subdomains: 'abc',
    attribution: 'Map data &copy; OpenStreetMap contributors, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
  });

  L.control.layers({
    'OpenStreetMap': osm,
    'Calles (Esri)': calles,
    'Satélite': satelite,
    'Relieve': relieve,
  }, null, { position: 'bottomright' }).addTo(map);

  // Clustering: agrupa pines cercanos → mucho más fluido en el celular
  const capa = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 14,
  }).addTo(map);

  map.on('click', (e) => {
    if (!anadiendo) return;
    alternarAnadir(false);
    abrirNuevo(e.latlng.lat, e.latlng.lng);
  });

  /* ---------- Pines ---------- */

  function iconFor(l, estado, sel) {
    const dep = l.tipo === 'departamento';
    const S = dep ? 40 : 30;
    return L.divIcon({
      className: 'pin-wrap',
      iconSize: [S, S],
      iconAnchor: [S / 2, S],
      tooltipAnchor: [0, -S + 4],
      html: `<div class="pin ${dep ? 'pin--dep' : ''} ${sel ? 'is-selected' : ''}" style="--c:${ESTADOS[estado].color}"><i></i></div>`,
    });
  }

  const zBase = (l) => (l.tipo === 'departamento' ? 0 : 200);

  function crearMarker(l) {
    const m = L.marker(l.coordenadas, {
      icon: iconFor(l, info(l.id).estado, false),
      zIndexOffset: zBase(l),
      title: l.nombre,
    });
    const tip = document.createElement('span');
    tip.textContent = l.nombre;
    m.bindTooltip(tip, { direction: 'top', className: 'tip' });
    m.on('click', () => { if (!anadiendo) abrirPanel(l.id); });
    markers.set(l.id, m);
  }

  function actualizarMarker(id) {
    const l = porId(id);
    const m = markers.get(id);
    if (!l || !m) return;
    const sel = seleccionado === id;
    m.setIcon(iconFor(l, info(id).estado, sel));
    m.setZIndexOffset(sel ? 1000 : zBase(l));
  }

  /* ---------- Filtros, lista y contadores ---------- */

  function pasaFiltros(l) {
    if (l.tipo === 'departamento' ? !mostrarDeps : !mostrarCiudades) return false;
    const i = info(l.id);
    switch (filtro) {
      case 'visitados':   if (!esVisitado(i.estado)) return false; break;
      case 'por_visitar': if (!esPorVisitar(i.estado)) return false; break;
      case 'con_fecha':   if (!tieneFecha(i)) return false; break;
      case 'volver':      if (i.estado !== 'volver') return false; break;
      case 'sin_marcar':  if (i.estado !== 'sin_marcar') return false; break;
    }
    if (query && !norm(`${l.nombre} ${l.departamento || ''}`).includes(query)) return false;
    return true;
  }

  function refrescarMapa() {
    capa.clearLayers();
    lugares.forEach((l) => {
      if (pasaFiltros(l) && markers.has(l.id)) capa.addLayer(markers.get(l.id));
    });
  }

  function subtitulo(l) {
    if (l.tipo === 'departamento') return 'Departamento';
    const t = TIPOS[l.tipo] || 'Lugar';
    return l.departamento ? `${t} en ${l.departamento}` : t;
  }

  function renderLista() {
    const items = lugares
      .filter(pasaFiltros)
      .sort((a, b) => (a.tipo === 'departamento') === (b.tipo === 'departamento')
        ? a.nombre.localeCompare(b.nombre, 'es')
        : (a.tipo === 'departamento' ? -1 : 1));

    $('#count-label').textContent = `${items.length} ${items.length === 1 ? 'lugar' : 'lugares'}`;

    if (!items.length) {
      $('#list').innerHTML = '<li class="empty">No hay lugares con este filtro. Prueba con otro estado o borra la búsqueda.</li>';
      return;
    }

    $('#list').innerHTML = items.map((l) => {
      const i = info(l.id);
      let fecha = '';
      if (esVisitado(i.estado) && i.fechaVisita) fecha = fmtFecha(i.fechaVisita);
      else if (tieneFecha(i) && i.fechaPrevista) fecha = fmtFecha(i.fechaPrevista);
      return `<li>
        <button type="button" class="item ${seleccionado === l.id ? 'is-active' : ''}" data-id="${esc(l.id)}">
          <span class="dot ${l.tipo === 'departamento' ? 'dot--dep' : ''}" style="--c:${ESTADOS[i.estado].color}"></span>
          <span class="item-main"><strong>${esc(l.nombre)}</strong><small>${esc(subtitulo(l))}</small></span>
          <span class="item-date">${esc(fecha)}</span>
        </button>
      </li>`;
    }).join('');
  }

  function actualizarStats() {
    let v = 0, p = 0, f = 0;
    lugares.forEach((l) => {
      const i = info(l.id);
      if (esVisitado(i.estado)) v++;
      else if (esPorVisitar(i.estado)) p++;
      if (tieneFecha(i)) f++;
    });
    const total = lugares.length;
    const pct = total ? Math.round((v / total) * 100) : 0;
    $('#st-visitados').textContent = v;
    $('#st-porvisitar').textContent = p;
    $('#st-confecha').textContent = f;
    $('#st-bar').style.width = `${pct}%`;
    $('#st-pct').textContent = `${pct} % explorado (${v} de ${total})`;
  }

  function refrescarTodo() {
    refrescarMapa();
    renderLista();
    actualizarStats();
  }

  function pintarFiltros() {
    $('#filtros').innerHTML = FILTROS.map((f) =>
      `<button type="button" class="chip" data-f="${f.id}" style="--c:${f.color}" aria-pressed="${f.id === filtro}">${f.label}</button>`
    ).join('');
  }

  /* ---------- Panel de edición ---------- */

  const panel = $('#panel');
  const form = $('#form');

  function pintarEstados() {
    $('#estados').innerHTML = Object.entries(ESTADOS).map(([k, e]) =>
      `<label class="opt" style="--c:${e.color}"><input type="radio" name="estado" value="${k}"><span><i class="dot"></i>${e.label}</span></label>`
    ).join('');
  }

  function poblarDepartamentos() {
    const deps = lugares.filter((l) => l.tipo === 'departamento').sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    $('#f-dep').innerHTML = '<option value="">Sin departamento</option>' +
      deps.map((d) => `<option value="${esc(d.nombre)}">${esc(d.nombre)}</option>`).join('');
  }

  function resaltarFechas() {
    const est = form.elements.estado.value;
    $('#fld-visita').classList.toggle('is-hl', esVisitado(est));
    $('#fld-prevista').classList.toggle('is-hl', est === 'planeado');
  }

  // Ayudas: poner una fecha cambia el estado si todavía no coincide.
  form.addEventListener('change', (e) => {
    const name = e.target.name;
    const est = form.elements.estado.value;
    if (name === 'fechaPrevista' && e.target.value && (est === 'sin_marcar' || est === 'quiero')) {
      form.elements.estado.value = 'planeado';
    }
    if (name === 'fechaVisita' && e.target.value && !esVisitado(est)) {
      form.elements.estado.value = 'visitado';
    }
    if (name === 'estado' || name === 'fechaPrevista' || name === 'fechaVisita') resaltarFechas();
  });

  function mostrarPanel() {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    if (esMovil()) cerrarSidebar();
  }

  function revelar(latlng) {
    const size = map.getSize();
    const movil = esMovil();
    map.panInside(latlng, {
      paddingTopLeft: [40, 80],
      paddingBottomRight: movil ? [40, Math.round(size.y * 0.72) + 20] : [400, 60],
    });
  }

  function abrirPanel(id, opts = {}) {
    const l = porId(id);
    if (!l) return;
    cancelarNuevo();
    const previo = seleccionado;
    seleccionado = id;
    if (previo && previo !== id) actualizarMarker(previo);
    actualizarMarker(id);

    const i = info(id);
    $('#p-titulo').textContent = l.nombre;
    $('#p-sub').textContent = subtitulo(l);
    $('#nuevo-campos').hidden = true;
    form.reset();
    form.elements.estado.value = i.estado;
    form.elements.fechaVisita.value = i.fechaVisita;
    form.elements.fechaPrevista.value = i.fechaPrevista;
    form.elements.notas.value = i.notas;
    resaltarFechas();

    const btn = $('#btn-borrar');
    btn.hidden = false;
    btn.textContent = l.personalizado ? 'Eliminar lugar' : 'Restablecer';

    mostrarPanel();
    if (opts.revelar !== false) revelar(L.latLng(l.coordenadas));
    renderLista();
  }

  function abrirNuevo(lat, lng) {
    cancelarNuevo();
    const previo = seleccionado;
    seleccionado = null;
    if (previo) actualizarMarker(previo);
    modoNuevo = true;

    marcadorTemp = L.marker([lat, lng], {
      draggable: true,
      icon: iconFor({ tipo: 'ciudad' }, 'quiero', true),
      zIndexOffset: 2000,
    }).addTo(map);
    marcadorTemp.on('dragend', () => {
      const p = marcadorTemp.getLatLng();
      form.elements.lat.value = p.lat.toFixed(5);
      form.elements.lng.value = p.lng.toFixed(5);
    });

    form.reset();
    form.elements.lat.value = lat.toFixed(5);
    form.elements.lng.value = lng.toFixed(5);
    form.elements.estado.value = 'quiero';
    resaltarFechas();

    $('#p-titulo').textContent = 'Lugar nuevo';
    $('#p-sub').textContent = 'Arrastra el pin o ajusta las coordenadas';
    $('#nuevo-campos').hidden = false;
    $('#btn-borrar').hidden = true;

    mostrarPanel();
    revelar(L.latLng(lat, lng));
    setTimeout(() => form.elements.nombre.focus({ preventScroll: true }), 300);
    renderLista();
  }

  function cancelarNuevo() {
    if (marcadorTemp) { marcadorTemp.remove(); marcadorTemp = null; }
    modoNuevo = false;
    $('#nuevo-campos').hidden = true;
  }

  function cerrarPanel() {
    cancelarNuevo();
    const previo = seleccionado;
    seleccionado = null;
    if (previo) actualizarMarker(previo);
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    renderLista();
  }

  // Mover el pin temporal al escribir coordenadas
  ['lat', 'lng'].forEach((n) => form.elements[n].addEventListener('input', () => {
    if (!marcadorTemp) return;
    const lat = parseFloat(form.elements.lat.value);
    const lng = parseFloat(form.elements.lng.value);
    if (isFinite(lat) && isFinite(lng)) marcadorTemp.setLatLng([lat, lng]);
  }));

  function guardar() {
    const fd = new FormData(form);
    const registro = {
      estado: ESTADOS[fd.get('estado')] ? fd.get('estado') : 'sin_marcar',
      fechaVisita: fd.get('fechaVisita') || '',
      fechaPrevista: fd.get('fechaPrevista') || '',
      notas: String(fd.get('notas') || '').trim(),
    };

    let id = seleccionado;

    if (modoNuevo) {
      const nombre = String(fd.get('nombre') || '').trim();
      const lat = parseFloat(fd.get('lat'));
      const lng = parseFloat(fd.get('lng'));
      if (!nombre) { toast('Escribe un nombre para el lugar'); form.elements.nombre.focus(); return; }
      if (!isFinite(lat) || !isFinite(lng) || !map.options.maxBounds.contains([lat, lng])) {
        toast('Las coordenadas deben estar en Nicaragua o cerca');
        form.elements.lat.focus();
        return;
      }
      const lugar = {
        id: `custom-${Date.now().toString(36)}`,
        nombre,
        tipo: fd.get('tipo') === 'lugar' ? 'lugar' : 'ciudad',
        coordenadas: [lat, lng],
        personalizado: true,
      };
      if (fd.get('departamento')) lugar.departamento = fd.get('departamento');

      custom.push(lugar);
      lugares.push(lugar);
      crearMarker(lugar);
      id = lugar.id;
      cancelarNuevo();
    }

    if (!id) return;
    datos[id] = registro;
    guardarStorage();
    refrescarTodo();

    if (modoNuevo === false && !seleccionado) {
      abrirPanel(id, { revelar: false });   // pasa de "nuevo" a edición normal
    } else {
      actualizarMarker(id);
    }
    toast('Cambios guardados');
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); guardar(); });
  $('#p-close').addEventListener('click', cerrarPanel);

  $('#btn-borrar').addEventListener('click', () => {
    const l = porId(seleccionado);
    if (!l) return;

    if (l.personalizado) {
      if (!confirm(`¿Eliminar "${l.nombre}" del mapa?`)) return;
      custom = custom.filter((c) => c.id !== l.id);
      lugares = lugares.filter((x) => x.id !== l.id);
      delete datos[l.id];
      const m = markers.get(l.id);
      if (m) { capa.removeLayer(m); markers.delete(l.id); }
      cerrarPanel();
      toast('Lugar eliminado');
    } else {
      if (!confirm(`¿Borrar estado, fechas y notas de "${l.nombre}"?`)) return;
      delete datos[l.id];
      abrirPanel(l.id, { revelar: false });
      toast('Datos restablecidos');
    }
    guardarStorage();
    refrescarTodo();
  });

  /* ---------- Añadir lugares ---------- */

  function alternarAnadir(forzar) {
    anadiendo = typeof forzar === 'boolean' ? forzar : !anadiendo;
    document.body.classList.toggle('adding', anadiendo);
    $('#hint').hidden = !anadiendo;
    const btn = $('#btn-add');
    btn.classList.toggle('is-active', anadiendo);
    btn.textContent = anadiendo ? '✕ Cancelar' : '＋ Añadir lugar';
    if (anadiendo) { cerrarPanel(); cerrarSidebar(); }
  }

  $('#btn-add').addEventListener('click', () => alternarAnadir());

  /* ---------- Barra lateral ---------- */

  const sidebar = $('#sidebar');

  function cerrarSidebar() {
    sidebar.classList.remove('open');
    $('#btn-menu').setAttribute('aria-expanded', 'false');
  }

  $('#btn-menu').addEventListener('click', () => {
    const abierto = sidebar.classList.toggle('open');
    $('#btn-menu').setAttribute('aria-expanded', String(abierto));
    if (abierto) cerrarPanel();
  });

  function irA(id) {
    const l = porId(id);
    if (!l) return;
    const z = Math.max(map.getZoom(), l.tipo === 'departamento' ? 8 : 11);
    map.flyTo(l.coordenadas, z, { duration: 0.8 });
    map.once('moveend', () => revelar(L.latLng(l.coordenadas)));
    abrirPanel(id, { revelar: false });
  }

  $('#list').addEventListener('click', (e) => {
    const b = e.target.closest('.item');
    if (b) irA(b.dataset.id);
  });

  $('#filtros').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    filtro = b.dataset.f;
    pintarFiltros();
    refrescarTodo();
  });

  $('#search').addEventListener('input', (e) => { query = norm(e.target.value); refrescarTodo(); });
  $('#chk-deps').addEventListener('change', (e) => { mostrarDeps = e.target.checked; refrescarTodo(); });
  $('#chk-ciudades').addEventListener('change', (e) => { mostrarCiudades = e.target.checked; refrescarTodo(); });

  $('#btn-center').addEventListener('click', () => {
    map.flyTo(CENTRO, ZOOM_INICIAL, { duration: 0.8 });
    cerrarSidebar();
  });

  /* ---------- Respaldo: exportar e importar ---------- */

  $('#btn-export').addEventListener('click', () => {
    const payload = { version: 1, exportado: new Date().toISOString(), datos, custom };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mapa-nicaragua-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Respaldo descargado');
  });

  $('#btn-import').addEventListener('click', () => $('#file-import').click());

  $('#file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const p = JSON.parse(await file.text());
      if (!p || typeof p.datos !== 'object' || p.datos === null) throw new Error('formato');
      if (!confirm('Esto reemplaza tus datos actuales por los del respaldo. ¿Continuar?')) return;
      datos = p.datos;
      custom = Array.isArray(p.custom) ? p.custom.filter(lugarValido) : [];
      guardarStorage();
      cerrarPanel();
      reconstruir();
      toast('Respaldo importado');
    } catch (err) {
      console.error(err);
      toast('El archivo no es un respaldo válido');
    }
  });

  /* ---------- Teclado ---------- */

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (anadiendo) alternarAnadir(false);
    else if (panel.classList.contains('open')) cerrarPanel();
    else cerrarSidebar();
  });

  /* ---------- Arranque ---------- */

  function reconstruir() {
    markers.clear();
    capa.clearLayers();
    lugares = [...base, ...custom];
    lugares.forEach(crearMarker);
    poblarDepartamentos();
    refrescarTodo();
  }

  async function iniciar() {
    $('#chk-deps').checked = true;
    $('#chk-ciudades').checked = true;
    pintarEstados();
    pintarFiltros();
    cargarStorage();
    await cargarBase();
    // Conectar a la nube (si falla, sigue con datos locales)
    await iniciarNube();
    reconstruir();
  }

  iniciar();
})();
