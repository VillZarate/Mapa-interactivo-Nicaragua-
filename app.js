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
  const LOCAL_UID_KEY = 'mapa-nicaragua:uid';
  const DATA_URL = 'data/lugares.json';
  const CENTRO = [12.87, -85.2];
  const ZOOM_INICIAL = 7;

  // ---------- Firebase (mapa compartido entre varias personas) ----------
  const firebaseConfig = {
    apiKey: "AIzaSyC9-nuSFJr5BKFGYyertEo63UkYxJlzWDk",
    authDomain: "mapa-interactivo-nicaragua.firebaseapp.com",
    projectId: "mapa-interactivo-nicaragua",
    storageBucket: "mapa-interactivo-nicaragua.firebasestorage.app",
    messagingSenderId: "992556323603",
    appId: "1:992556323603:web:6903297e5016173a0540e6"
  };

  let db = null;
  let syncListo = false;       // escuchas de lectura activas
  let nubePermitida = false;   // puede escribir (verificado + miembro)
  let esMiembro = false;
  let emailVerificado = false;
  /** ids que estamos escribiendo nosotros (evita eco del onSnapshot) */
  const escribiendoIds = new Set();
  /** autores ocultos del filtro (colección ocultos) */
  let autoresOcultos = new Set();
  let miUid = '';
  let miNombre = '';
  let unsubRegistros = null;
  let unsubLugares = null;
  let unsubOcultos = null;
  let esAdmin = false;
  /** notas públicas por lugarId (solo lectura/display) */
  let notasPublicasPorLugar = {};
  /** mi nota por lugarId: { texto, visibilidad, pendiente? } */
  let misNotas = {};
  const NOTAS_KEY = 'mapa-nicaragua:notas';
  /** evita que una consulta lenta de otro pin pise el panel actual */
  let cargaNotasSeq = 0;

  try {
    if (typeof firebase !== 'undefined') {
      firebase.initializeApp(firebaseConfig);
      db = firebase.firestore();
    }
  } catch (err) {
    console.warn('Firebase no se pudo iniciar:', err);
  }

  function nombreDesdeUsuario(user) {
    if (!user) return 'Anónimo';
    if (user.displayName && String(user.displayName).trim()) {
      return String(user.displayName).trim().slice(0, 40);
    }
    const email = user.email || '';
    const parte = email.split('@')[0] || 'Usuario';
    return parte.slice(0, 40);
  }

  function puedeEscribirNube() {
    // Cualquier cuenta con correo verificado puede escribir en la nube (sin lista de miembros)
    return !!(db && emailVerificado && miUid);
  }

  /** Solo admin ve el filtro y nombres de todos; el autor ve la suya en su pin. */
  function puedeVerAutores() {
    return !!esAdmin;
  }

  function puedeVerAutorDe(l, i) {
    if (esAdmin) return true;
    if (!miUid) return false;
    if (l && l.autorUid && l.autorUid === miUid) return true;
    if (i && i.autorUid && i.autorUid === miUid) return true;
    if (i && i.autor && miNombre && i.autor === miNombre) return true;
    if (l && l.autor && miNombre && l.autor === miNombre) return true;
    return false;
  }

  function esDuenoLugar(l) {
    if (!l || !miUid) return false;
    return !!(l.autorUid && l.autorUid === miUid);
  }

  function esDuenoRegistro(id) {
    const i = info(id);
    // datos locales no siempre traen autorUid; usar autorNombre ≈ miNombre
    if (i && i.autorUid && miUid && i.autorUid === miUid) return true;
    if (i && i.autor && miNombre && i.autor === miNombre) return true;
    return false;
  }

  function puedeEditarPinManual(l) {
    return esAdmin || esDuenoLugar(l);
  }

  function puedeRestablecerRegistro(id) {
    return esAdmin || esDuenoRegistro(id);
  }

  function esPendienteId(id) {
    if (datos[id] && datos[id].pendiente) return true;
    const c = custom.find((x) => x.id === id);
    return !!(c && c.pendiente);
  }

  function marcarPendienteRegistro(id) {
    if (!datos[id]) return;
    datos[id] = { ...datos[id], pendiente: true };
  }

  function marcarPendienteLugar(id) {
    const idx = custom.findIndex((c) => c.id === id);
    if (idx >= 0) custom[idx] = { ...custom[idx], pendiente: true };
  }

  function cargarNotasLocal() {
    try {
      const raw = localStorage.getItem(NOTAS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      misNotas = p && typeof p === 'object' ? p : {};
    } catch (_) { misNotas = {}; }
  }

  function guardarNotasLocal() {
    try {
      localStorage.setItem(NOTAS_KEY, JSON.stringify(misNotas));
    } catch (err) { console.warn(err); }
  }

  function idNota(lugarId, uid) {
    return String(lugarId) + '__' + String(uid || 'anon');
  }

  function guardarNotaEnNube(lugarId, texto, visibilidad) {
    if (!puedeEscribirNube() || !lugarId || !miUid) return Promise.resolve();
    const nid = idNota(lugarId, miUid);
    marcarEscritura(nid);
    const payload = {
      lugarId,
      autorUid: miUid,
      autorNombre: miNombre || 'Anónimo',
      texto: String(texto || '').slice(0, 2000),
      visibilidad: visibilidad === 'publica' ? 'publica' : 'privada',
      actualizado: firebase.firestore.FieldValue.serverTimestamp(),
    };
    return db.collection('notas').doc(nid).set(payload, { merge: true })
      .catch((err) => console.warn('Error guardando nota', err));
  }

  function cargarNotasDeLugar(lugarId) {
    const caja = document.getElementById('notas-publicas');
    const miTexto = document.getElementById('mi-nota-texto');
    const miVis = document.getElementById('mi-nota-vis');
    if (!lugarId) return;

    const seq = ++cargaNotasSeq;

    // Limpiar panel al cambiar de lugar (evita ver nota del pin anterior)
    if (miTexto) miTexto.value = '';
    if (miVis) miVis.value = 'privada';
    if (caja) caja.innerHTML = '<p class="notas-vacio">Cargando notas…</p>';

    const local = misNotas[lugarId];
    if (local) {
      if (miTexto) miTexto.value = local.texto || '';
      if (miVis) miVis.value = local.visibilidad === 'publica' ? 'publica' : 'privada';
    }

    if (!db) {
      if (caja) caja.innerHTML = '<p class="notas-vacio">Sin conexión a la nube.</p>';
      return;
    }

    if (miUid) {
      db.collection('notas').doc(idNota(lugarId, miUid)).get().then((snap) => {
        if (seq !== cargaNotasSeq || seleccionado !== lugarId) return;
        if (snap.exists) {
          const d = snap.data() || {};
          if (!(local && local.pendiente)) {
            if (miTexto) miTexto.value = d.texto || '';
            if (miVis) miVis.value = d.visibilidad === 'publica' ? 'publica' : 'privada';
            misNotas[lugarId] = {
              texto: d.texto || '',
              visibilidad: d.visibilidad === 'publica' ? 'publica' : 'privada',
            };
            guardarNotasLocal();
          }
        }
      }).catch(() => {});
    }

    let q = db.collection('notas').where('lugarId', '==', lugarId);
    if (!esAdmin) {
      q = q.where('visibilidad', '==', 'publica');
    }
    q.get().then((snap) => {
      if (seq !== cargaNotasSeq || seleccionado !== lugarId) return;
      const items = [];
      snap.forEach((doc) => {
        const d = doc.data() || {};
        // Solo notas de ESTE lugar (por si acaso)
        if (d.lugarId && d.lugarId !== lugarId) return;
        if (!esAdmin && d.visibilidad !== 'publica') return;
        if (d.autorUid && miUid && d.autorUid === miUid) return;
        items.push({
          autorNombre: d.autorNombre || 'Alguien',
          texto: d.texto || '',
          visibilidad: d.visibilidad || 'publica',
        });
      });
      notasPublicasPorLugar[lugarId] = items;
      if (!caja) return;
      if (!items.length) {
        caja.innerHTML = '<p class="notas-vacio">No hay notas públicas todavía.</p>';
        return;
      }
      // Notas públicas: siempre muestran el nombre del autor
      caja.innerHTML = items.map((n) =>
        `<div class="nota-item"><strong>${esc(n.autorNombre)}</strong>` +
        (esAdmin && n.visibilidad === 'privada' ? ' <em>(privada)</em>' : '') +
        `<p>${esc(n.texto)}</p></div>`
      ).join('');
    }).catch((err) => {
      if (seq !== cargaNotasSeq) return;
      console.warn('Error cargando notas', err);
      if (caja) caja.innerHTML = '<p class="notas-vacio">No se pudieron cargar las notas.</p>';
    });
  }

  function errorAuthEs(code, fallback) {
    const map = {
      'auth/invalid-email': 'El correo no es válido.',
      'auth/user-disabled': 'Esta cuenta está deshabilitada.',
      'auth/user-not-found': 'No hay ninguna cuenta con ese correo.',
      'auth/wrong-password': 'Contraseña incorrecta.',
      'auth/invalid-credential': 'Correo o contraseña incorrectos.',
      'auth/email-already-in-use': 'Ese correo ya está registrado.',
      'auth/weak-password': 'La contraseña es demasiado débil (mínimo 8 caracteres).',
      'auth/too-many-requests': 'Demasiados intentos. Espera un momento.',
      'auth/network-request-failed': 'Error de red. Revisa tu conexión.',
      'auth/missing-email': 'Escribe tu correo.',
      'auth/invalid-api-key': 'Clave de API no válida. Revisa firebaseConfig.',
      'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Clave de API no válida.',
      'auth/operation-not-allowed': 'Este método de acceso no está habilitado en Firebase.',
    };
    return map[code] || fallback || ('Error: ' + (code || 'desconocido'));
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
    { id: 'manuales',    label: 'Solo manuales',  color: '#0b6e7f' },
  ];

  const AUTOR_KEY = 'mapa-nicaragua:autor';
  const AUTORES_COLORES = ['#0b6e7f', '#b45309', '#7c3aed', '#be123c', '#0369a1', '#15803d'];

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
  let custom = [];      // lugares añadidos manualmente
  let datos = {};       // { [id]: { estado, fechaVisita, fechaPrevista, notas, autor, actualizadoPor } }
  let lugares = [];     // base + custom

  const markers = new Map();
  let filtro = 'todos';
  let filtroAutor = 'todos'; // 'todos' | nombre de autor
  let query = '';
  let mostrarDeps = true;
  let mostrarCiudades = true;
  let soloManuales = false;

  let seleccionado = null;
  let modoNuevo = false;
  let marcadorTemp = null;
  let anadiendo = false;

  const vacio = () => ({ estado: 'sin_marcar', fechaVisita: '', fechaPrevista: '', autor: '', actualizadoPor: '' });
  const info = (id) => ({ ...vacio(), ...(datos[id] || {}) });
  const porId = (id) => lugares.find((l) => l.id === id);

  function autoresPresentes() {
    const set = new Set();
    Object.values(datos).forEach((d) => {
      if (d && d.autor) set.add(d.autor);
      if (d && d.actualizadoPor) set.add(d.actualizadoPor);
    });
    custom.forEach((c) => {
      if (c.autor) set.add(c.autor);
      if (c.autorNombre) set.add(c.autorNombre);
    });
    return [...set]
      .filter((a) => a && !autoresOcultos.has(a))
      .sort((a, b) => a.localeCompare(b, 'es'));
  }

  function colorAutor(nombre) {
    if (!nombre) return '#64748b';
    let h = 0;
    for (let i = 0; i < nombre.length; i++) h = (h * 31 + nombre.charCodeAt(i)) >>> 0;
    return AUTORES_COLORES[h % AUTORES_COLORES.length];
  }

  const esVisitado = (estado) => estado === 'visitado' || estado === 'volver';
  const esPorVisitar = (estado) => estado === 'quiero' || estado === 'planeado';
  const tieneFecha = (i) => i.estado === 'planeado' || (!esVisitado(i.estado) && !!i.fechaPrevista);

  /* ---------- Almacenamiento (localStorage caché + Firestore por documento) ----------
     lugares/{id}   → solo pines manuales
     registros/{id} → estado/fechas/notas de cualquier lugar (base o manual)
     ocultos/{id}   → nombres de autor ocultos del filtro
     admins/{uid}   → solo se crea a mano en la consola (no se escribe desde la app)
  ---------- */

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
    cargarNotasLocal();
  }

  function guardarCacheLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ datos, custom }));
    } catch (err) {
      console.warn(err);
    }
  }

  /** Compatibilidad: antes guardaba todo el mapa; ahora solo refresca la caché local.
      Las escrituras a Firestore van por documento (ver guardarRegistro / guardarLugarManual). */
  function guardarStorage() {
    guardarCacheLocal();
  }

  function marcarEscritura(id) {
    escribiendoIds.add(id);
    setTimeout(() => escribiendoIds.delete(id), 1500);
  }

  function registroDesdeDoc(id, d) {
    if (!d) return null;
    return {
      estado: ESTADOS[d.estado] ? d.estado : 'sin_marcar',
      fechaVisita: d.fechaVisita || '',
      fechaPrevista: d.fechaPrevista || '',
      autor: d.autorNombre || d.autor || '',
      actualizadoPor: d.actualizadoPor || d.autorNombre || '',
    };
  }

  function lugarDesdeDoc(id, d) {
    if (!d || !Array.isArray(d.coordenadas) || d.coordenadas.length !== 2) return null;
    const lugar = {
      id,
      nombre: d.nombre || 'Sin nombre',
      tipo: d.tipo === 'lugar' ? 'lugar' : 'ciudad',
      coordenadas: [Number(d.coordenadas[0]), Number(d.coordenadas[1])],
      personalizado: true,
      autor: d.autorNombre || d.autor || '',
      autorUid: d.autorUid || '',
    };
    if (d.departamento) lugar.departamento = d.departamento;
    return lugarValido(lugar) ? lugar : null;
  }

  /** Crea o actualiza registros/{id} (un documento por lugar).
   *  autorUid / autorNombre solo en la creación; al actualizar no se tocan. */
  function guardarRegistroEnNube(id, registro) {
    if (!puedeEscribirNube() || !id) return;
    marcarEscritura(id);
    const ref = db.collection('registros').doc(id);
    const base = {
      estado: registro.estado || 'sin_marcar',
      fechaVisita: registro.fechaVisita || '',
      fechaPrevista: registro.fechaPrevista || '',
      actualizadoPor: registro.actualizadoPor || miNombre || 'Anónimo',
      actualizado: firebase.firestore.FieldValue.serverTimestamp(),
    };
    ref.get().then((snap) => {
      if (snap.exists) {
        // Ya existe en la nube: no tocar autorUid ni autorNombre
        return ref.set(base, { merge: true });
      }
      // Primera vez en la nube
      return ref.set({
        ...base,
        autorUid: miUid || '',
        autorNombre: registro.autor || miNombre || 'Anónimo',
      }, { merge: true });
    }).catch((err) => console.warn('Error guardando registro', id, err));
  }

  /** Crea o actualiza lugares/{id} (solo pines manuales).
   *  Nunca modifica autorUid de un pin que ya existe. */
  function guardarLugarManualEnNube(lugar) {
    if (!puedeEscribirNube() || !lugar || !lugar.id) return;
    marcarEscritura(lugar.id);
    const ref = db.collection('lugares').doc(lugar.id);
    ref.get().then((snap) => {
      if (snap.exists) {
        const payload = {
          nombre: lugar.nombre,
          tipo: lugar.tipo || 'ciudad',
          coordenadas: lugar.coordenadas,
          departamento: lugar.departamento || '',
          actualizado: firebase.firestore.FieldValue.serverTimestamp(),
        };
        return ref.set(payload, { merge: true });
      }
      return ref.set({
        nombre: lugar.nombre,
        tipo: lugar.tipo || 'ciudad',
        coordenadas: lugar.coordenadas,
        departamento: lugar.departamento || '',
        autorUid: miUid || '',
        autorNombre: lugar.autor || lugar.autorNombre || miNombre || 'Anónimo',
        creado: firebase.firestore.FieldValue.serverTimestamp(),
        actualizado: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }).catch((err) => console.warn('Error guardando lugar manual', lugar.id, err));
  }

  /** Restablecer: borra solo registros/{id}. */
  function borrarRegistroEnNube(id) {
    if (!puedeEscribirNube() || !id) return;
    marcarEscritura(id);
    db.collection('registros').doc(id).delete()
      .catch((err) => console.warn('Error borrando registro', id, err));
  }

  /** Eliminar pin manual: borra lugares/{id} y registros/{id}. */
  function borrarLugarManualEnNube(id) {
    if (!puedeEscribirNube() || !id) return;
    marcarEscritura(id);
    const batch = db.batch();
    batch.delete(db.collection('lugares').doc(id));
    batch.delete(db.collection('registros').doc(id));
    batch.commit().catch((err) => console.warn('Error borrando lugar manual', id, err));
  }

  function aplicarSnapshotRegistros(snapshot, esPrimera) {
    let huboCambioAjeno = false;

    if (esPrimera) {
      // Fusionar: no borrar pendientes locales; la nube no pisa lo pendiente
      const pendientes = {};
      Object.keys(datos).forEach((id) => {
        if (datos[id] && datos[id].pendiente) pendientes[id] = datos[id];
      });
      const nuevo = {};
      snapshot.docs.forEach((doc) => {
        const reg = registroDesdeDoc(doc.id, doc.data());
        if (reg) nuevo[doc.id] = reg;
      });
      Object.keys(pendientes).forEach((id) => {
        nuevo[id] = pendientes[id];
      });
      datos = nuevo;
      huboCambioAjeno = true;
    } else {
      snapshot.docChanges().forEach((change) => {
        const id = change.doc.id;
        if (escribiendoIds.has(id) && change.type === 'modified') return;
        // No tocar ni borrar lo pendiente local
        if (datos[id] && datos[id].pendiente) return;

        if (change.type === 'removed') {
          if (datos[id]) {
            delete datos[id];
            huboCambioAjeno = true;
          }
          return;
        }

        const reg = registroDesdeDoc(id, change.doc.data());
        if (!reg) return;
        const prev = datos[id];
        if (!prev || JSON.stringify(prev) !== JSON.stringify(reg)) {
          datos[id] = reg;
          huboCambioAjeno = true;
        }
      });
    }

    if (huboCambioAjeno) {
      guardarCacheLocal();
      reconstruir();
      if (!esPrimera) toast('Mapa actualizado desde la nube');
    }
  }

  function aplicarSnapshotLugares(snapshot, esPrimera) {
    let huboCambioAjeno = false;

    if (esPrimera) {
      const lista = [];
      snapshot.docs.forEach((doc) => {
        const l = lugarDesdeDoc(doc.id, doc.data());
        if (l) lista.push(l);
      });
      const idsNube = new Set(lista.map((l) => l.id));
      // Conservar pines locales pendientes (u otros custom que aún no están en la nube)
      custom.forEach((c) => {
        if (!idsNube.has(c.id)) lista.push(c);
      });
      custom = lista;
      huboCambioAjeno = true;
    } else {
      snapshot.docChanges().forEach((change) => {
        const id = change.doc.id;
        if (escribiendoIds.has(id) && change.type === 'modified') return;
        const local = custom.find((c) => c.id === id);
        if (local && local.pendiente) return;

        if (change.type === 'removed') {
          const antes = custom.length;
          custom = custom.filter((c) => c.id !== id || c.pendiente);
          if (custom.length !== antes) huboCambioAjeno = true;
          return;
        }

        const l = lugarDesdeDoc(id, change.doc.data());
        if (!l) return;
        const idx = custom.findIndex((c) => c.id === id);
        if (idx >= 0) {
          if (custom[idx].pendiente) return;
          custom[idx] = l;
        } else custom.push(l);
        huboCambioAjeno = true;
      });
    }

    if (huboCambioAjeno) {
      guardarCacheLocal();
      reconstruir();
      if (!esPrimera) toast('Mapa actualizado desde la nube');
    }
  }

  function aplicarSnapshotOcultos(snapshot) {
    const set = new Set();
    snapshot.docs.forEach((doc) => {
      const d = doc.data();
      if (d && d.nombre) set.add(d.nombre);
      else set.add(doc.id);
    });
    autoresOcultos = set;
    pintarFiltrosAutor();
    actualizarPanelAdmin();
  }

  function avisoPermisoFirestore(err) {
    const code = err && err.code ? err.code : '';
    if (code === 'permission-denied' || /permission|insufficient/i.test(String(err && err.message))) {
      toast('Tu correo no está autorizado. Pide acceso al administrador.');
    } else {
      console.warn('Error Firestore:', err);
    }
  }

  /** Lectura pública: siempre escucha la nube (aunque no haya sesión). */
  function conectarLecturaNube() {
    if (!db || syncListo) return;
    let primeraRegistros = true;
    let primeraLugares = true;

    unsubRegistros = db.collection('registros').onSnapshot((snap) => {
      aplicarSnapshotRegistros(snap, primeraRegistros);
      primeraRegistros = false;
    }, (err) => {
      console.warn('Error escuchando registros:', err);
      avisoPermisoFirestore(err);
    });

    unsubLugares = db.collection('lugares').onSnapshot((snap) => {
      aplicarSnapshotLugares(snap, primeraLugares);
      primeraLugares = false;
    }, (err) => {
      console.warn('Error escuchando lugares:', err);
      avisoPermisoFirestore(err);
    });

    unsubOcultos = db.collection('ocultos').onSnapshot((snap) => {
      aplicarSnapshotOcultos(snap);
    }, (err) => {
      console.warn('Error escuchando ocultos:', err);
      avisoPermisoFirestore(err);
    });

    syncListo = true;
  }

  async function comprobarMiembro(user) {
    if (!db || !user || !user.email) return false;
    try {
      const id = String(user.email).toLowerCase().trim();
      const snap = await db.collection('miembros').doc(id).get();
      return snap.exists;
    } catch (err) {
      console.warn('Error comprobando miembro:', err);
      avisoPermisoFirestore(err);
      return false;
    }
  }

  async function subirPendientes() {
    if (!puedeEscribirNube()) return;
    let n = 0;
    Object.keys(datos).forEach((id) => {
      if (datos[id] && datos[id].pendiente) {
        const { pendiente, ...resto } = datos[id];
        datos[id] = resto;
        guardarRegistroEnNube(id, resto);
        n++;
      }
    });
    custom.forEach((c, idx) => {
      if (c.pendiente) {
        const limpio = { ...c };
        delete limpio.pendiente;
        custom[idx] = limpio;
        guardarLugarManualEnNube(limpio);
        if (datos[c.id]) {
          const { pendiente, ...resto } = datos[c.id];
          datos[c.id] = resto;
          guardarRegistroEnNube(c.id, resto);
        }
        n++;
      }
    });
    // Notas pendientes
    Object.keys(misNotas).forEach((lugarId) => {
      const nta = misNotas[lugarId];
      if (nta && nta.pendiente) {
        guardarNotaEnNube(lugarId, nta.texto || '', nta.visibilidad || 'privada');
        delete nta.pendiente;
        n++;
      }
    });
    guardarNotasLocal();
    if (n) {
      guardarCacheLocal();
      reconstruir();
      toast('Cambios pendientes subidos a la nube');
    }
  }

  function actualizarUISesion(user) {
    const info = $('#session-info');
    const btnLogin = $('#btn-login');
    const btnLogout = $('#btn-logout');
    const btnVerify = $('#btn-verify');
    if (!info) return;

    if (!user) {
      info.textContent = 'Sin sesión · lectura pública · tus cambios solo aquí';
      info.classList.remove('is-on');
      if (btnLogin) {
        btnLogin.hidden = false;
        btnLogin.textContent = 'Iniciar sesión';
      }
      if (btnLogout) btnLogout.hidden = true;
      if (btnVerify) btnVerify.hidden = true;
      return;
    }

    if (!user.emailVerified) {
      info.textContent = 'Sin verificar · ' + (user.email || '');
      info.classList.remove('is-on');
      if (btnLogin) btnLogin.hidden = true;
      if (btnLogout) btnLogout.hidden = false;
      if (btnVerify) btnVerify.hidden = false;
      return;
    }

    info.textContent = (esAdmin ? 'Admin · ' : '') + miNombre + (user.email ? ' · ' + user.email : '');
    info.classList.add('is-on');
    if (btnLogin) btnLogin.hidden = true;
    if (btnLogout) btnLogout.hidden = false;
    if (btnVerify) btnVerify.hidden = true;
  }

  async function aplicarUsuario(user) {
    nubePermitida = false;
    esMiembro = false;
    emailVerificado = false;
    esAdmin = false;

    if (!user) {
      miUid = '';
      miNombre = '';
      actualizarUISesion(null);
      pintarFiltrosAutor();
      refrescarTodo();
      return;
    }

    miUid = user.uid;
    miNombre = nombreDesdeUsuario(user);
    emailVerificado = !!user.emailVerified;
    try { localStorage.setItem(LOCAL_UID_KEY, miUid); } catch (_) {}

    if (!user.emailVerified) {
      actualizarUISesion(user);
      pintarFiltrosAutor();
      refrescarTodo();
      toast('Verifica tu correo. Hasta entonces tus cambios quedan solo en este dispositivo.');
      return;
    }

    // Admin opcional (documento admins/{uid} creado a mano en la consola)
    try {
      const adm = await db.collection('admins').doc(user.uid).get();
      esAdmin = adm.exists;
    } catch (_) { esAdmin = false; }

    // Ya no se exige lista "miembros": cualquier correo verificado puede escribir
    esMiembro = true;
    nubePermitida = true;
    actualizarUISesion(user);
    pintarFiltrosAutor();
    refrescarTodo();
    toast(esAdmin ? 'Sesión de administrador lista' : 'Sesión lista · puedes guardar en la nube');
    await subirPendientes();
  }

  function iniciarAuth() {
    if (!db || typeof firebase === 'undefined') {
      console.warn('Firebase SDK no cargado');
      return;
    }
    // Lectura pública siempre; escritura solo miembro verificado
    conectarLecturaNube();
    firebase.auth().onAuthStateChanged((user) => {
      aplicarUsuario(user);
    });
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
    const i = info(l.id);
    const esManual = !!l.personalizado;

    // "Solo manuales": exclusivamente pines añadidos a mano (nunca departamentos ni lugares del JSON)
    if (soloManuales || filtro === 'manuales') {
      if (!esManual) return false;
    } else {
      if (l.tipo === 'departamento' ? !mostrarDeps : !mostrarCiudades) return false;
    }

    // Filtro por autor (quien creó o quien actualizó el pin)
    if (filtroAutor !== 'todos') {
      const autoresDelPin = [l.autor, i.autor, i.actualizadoPor].filter(Boolean);
      if (!autoresDelPin.includes(filtroAutor)) return false;
    }

    // Filtros de estado (excepto cuando el chip es "manuales", que ya se resolvió arriba)
    if (filtro !== 'manuales' && filtro !== 'todos') {
      switch (filtro) {
        case 'visitados':   if (!esVisitado(i.estado)) return false; break;
        case 'por_visitar': if (!esPorVisitar(i.estado)) return false; break;
        case 'con_fecha':   if (!tieneFecha(i)) return false; break;
        case 'volver':      if (i.estado !== 'volver') return false; break;
        case 'sin_marcar':  if (i.estado !== 'sin_marcar') return false; break;
      }
    }

    if (query && !norm(`${l.nombre} ${l.departamento || ''} ${l.autor || i.autor || ''}`).includes(query)) return false;
    return true;
  }

  function refrescarMapa() {
    capa.clearLayers();
    lugares.forEach((l) => {
      if (pasaFiltros(l) && markers.has(l.id)) capa.addLayer(markers.get(l.id));
    });
  }

  function subtitulo(l) {
    const i = info(l.id);
    const autor = l.autor || i.autor || i.actualizadoPor || '';
    let baseTxt;
    if (l.tipo === 'departamento') baseTxt = 'Departamento';
    else {
      const t = TIPOS[l.tipo] || 'Lugar';
      baseTxt = l.departamento ? `${t} en ${l.departamento}` : t;
    }
    if (l.personalizado) {
      baseTxt = (puedeVerAutorDe(l, i) && autor) ? `Manual · ${autor}` : 'Pin manual';
    } else if (puedeVerAutorDe(l, i) && autor) {
      baseTxt = `${baseTxt} · ${autor}`;
    }
    if (esPendienteId(l.id)) baseTxt += ' · Pendiente de subir';
    return baseTxt;
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
          <span class="item-main"><strong>${esc(l.nombre)}</strong><small>${esc(subtitulo(l))}</small>${esPendienteId(l.id) ? '<span class="badge-pendiente">Pendiente de subir</span>' : ''}</span>
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
    pintarFiltrosAutor();
  }

  function pintarFiltros() {
    $('#filtros').innerHTML = FILTROS.map((f) =>
      `<button type="button" class="chip" data-f="${f.id}" style="--c:${f.color}" aria-pressed="${f.id === filtro}">${f.label}</button>`
    ).join('');
  }

  function pintarFiltrosAutor() {
    const el = $('#filtros-autor');
    if (!el) return;
    if (!puedeVerAutores()) {
      el.hidden = true;
      el.innerHTML = '';
      filtroAutor = 'todos';
      return;
    }
    el.hidden = false;
    const lista = autoresPresentes();
    if (!lista.length) {
      el.innerHTML = '<p class="hint-autor">Guarda un pin con tu cuenta para filtrar por autor.</p>';
      return;
    }
    const chips = [
      `<button type="button" class="chip" data-autor="todos" style="--c:#14202b" aria-pressed="${filtroAutor === 'todos'}">Todos los autores</button>`,
      ...lista.map((a) =>
        `<button type="button" class="chip" data-autor="${esc(a)}" style="--c:${colorAutor(a)}" aria-pressed="${filtroAutor === a}">${esc(a)}</button>`
      ),
    ];
    el.innerHTML = chips.join('');
    actualizarPanelAdmin();
  }

  function actualizarPanelAdmin() {
    const box = $('#admin-autores');
    if (!box) return;
    if (!esAdmin) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const lista = $('#admin-autores-lista');
    if (!lista) return;
    const visibles = autoresPresentes();
    const ocultos = [...autoresOcultos].sort((a, b) => a.localeCompare(b, 'es'));
    let html = '';
    if (!visibles.length && !ocultos.length) {
      html = '<p class="hint-autor">No hay autores todavía.</p>';
    }
    visibles.forEach((a) => {
      html += `<div class="admin-autor-row" data-autor="${esc(a)}">
        <span>${esc(a)}</span>
        <button type="button" class="btn btn--soft btn-admin-ocultar" data-autor="${esc(a)}">Ocultar del filtro</button>
        <button type="button" class="btn btn--quiet btn-admin-borrar" data-autor="${esc(a)}">Eliminar contenido</button>
      </div>`;
    });
    if (ocultos.length) {
      html += '<p class="hint-autor" style="margin-top:8px">Ocultos del filtro</p>';
      ocultos.forEach((a) => {
        html += `<div class="admin-autor-row" data-autor="${esc(a)}">
          <span>${esc(a)} <em>(oculto)</em></span>
          <button type="button" class="btn btn--soft btn-admin-mostrar" data-autor="${esc(a)}">Volver a mostrar</button>
        </div>`;
      });
    }
    lista.innerHTML = html;
  }

  async function adminOcultarAutor(nombre) {
    if (!esAdmin || !db || !nombre) return;
    try {
      await db.collection('ocultos').doc(nombre).set({
        nombre,
        actualizado: firebase.firestore.FieldValue.serverTimestamp(),
      });
      toast('Autor ocultado del filtro');
    } catch (err) {
      console.warn(err);
      toast('No se pudo ocultar el autor');
    }
  }

  async function adminMostrarAutor(nombre) {
    if (!esAdmin || !db || !nombre) return;
    try {
      await db.collection('ocultos').doc(nombre).delete();
      toast('Autor visible de nuevo en el filtro');
    } catch (err) {
      console.warn(err);
      toast('No se pudo mostrar el autor');
    }
  }

  async function adminBorrarContenidoAutor(nombre) {
    if (!esAdmin || !db || !nombre) return;
    const conf = prompt(`Para eliminar TODO el contenido de "${nombre}", escribe el nombre exacto:`);
    if (conf !== nombre) {
      toast('Confirmación incorrecta · no se borró nada');
      return;
    }
    if (!confirm(`¿Seguro? Se borrarán pines y registros de "${nombre}".`)) return;
    try {
      let n = 0;
      // Pines manuales de ese autor (por nombre)
      const lugaresSnap = await db.collection('lugares').get();
      const batch1 = db.batch();
      lugaresSnap.forEach((doc) => {
        const d = doc.data() || {};
        if ((d.autorNombre || d.autor || '') === nombre) {
          batch1.delete(doc.ref);
          batch1.delete(db.collection('registros').doc(doc.id));
          n++;
        }
      });
      await batch1.commit();

      // Registros base marcados por ese autor
      const regSnap = await db.collection('registros').get();
      let batch2 = db.batch();
      let ops = 0;
      for (const doc of regSnap.docs) {
        const d = doc.data() || {};
        if ((d.autorNombre || d.autor || d.actualizadoPor || '') === nombre) {
          batch2.delete(doc.ref);
          ops++;
          n++;
          if (ops >= 400) {
            await batch2.commit();
            batch2 = db.batch();
            ops = 0;
          }
        }
      }
      if (ops) await batch2.commit();

      // Local
      custom = custom.filter((c) => (c.autor || c.autorNombre || '') !== nombre);
      Object.keys(datos).forEach((id) => {
        const d = datos[id];
        if (d && (d.autor === nombre || d.actualizadoPor === nombre)) delete datos[id];
      });
      guardarCacheLocal();
      reconstruir();
      toast(`Contenido de "${nombre}" eliminado (${n} docs en nube)`);
      actualizarPanelAdmin();
    } catch (err) {
      console.warn(err);
      toast('Error al eliminar contenido del autor');
    }
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
    resaltarFechas();
    cargarNotasDeLugar(id);

    const meta = $('#p-meta');
    if (meta) {
      if (puedeVerAutorDe(l, i)) {
        const creado = l.autor || i.autor || '—';
        const ultimo = i.actualizadoPor || '';
        meta.hidden = false;
        let html = `<span>Creado por <strong>${esc(creado)}</strong></span>`;
        // Solo mostrar "última modificación" si hay un nombre y no es vacío
        if (ultimo) {
          html += `<span>Última modificación por <strong>${esc(ultimo)}</strong></span>`;
        }
        meta.innerHTML = html;
      } else {
        meta.hidden = true;
        meta.innerHTML = '';
      }
    }

    const btn = $('#btn-borrar');
    if (l.personalizado) {
      btn.hidden = !puedeEditarPinManual(l);
      btn.textContent = 'Eliminar lugar';
    } else {
      btn.hidden = !puedeRestablecerRegistro(id);
      btn.textContent = 'Restablecer';
    }

    // Estado/fechas bloqueados si no eres autor ni admin; la nota sí se puede
    const puedeEstado = esAdmin || esDuenoRegistro(id) || esDuenoLugar(l);
    form.querySelectorAll('input[name="estado"]').forEach((r) => { r.disabled = !puedeEstado; });
    if (form.elements.fechaVisita) form.elements.fechaVisita.disabled = !puedeEstado;
    if (form.elements.fechaPrevista) form.elements.fechaPrevista.disabled = !puedeEstado;
    const btnSave = form.querySelector('button[type="submit"]');
    if (btnSave) btnSave.textContent = puedeEstado ? 'Guardar cambios' : 'Guardar mi nota';

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
    form.querySelectorAll('input[name="estado"]').forEach((r) => { r.disabled = false; });
    if (form.elements.fechaVisita) form.elements.fechaVisita.disabled = false;
    if (form.elements.fechaPrevista) form.elements.fechaPrevista.disabled = false;
    const btnSave = form.querySelector('button[type="submit"]');
    if (btnSave) btnSave.textContent = 'Guardar cambios';
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
    const nombreAutor = miNombre || 'Anónimo';
    const previo = seleccionado ? info(seleccionado) : null;
    const registro = {
      estado: ESTADOS[fd.get('estado')] ? fd.get('estado') : 'sin_marcar',
      fechaVisita: fd.get('fechaVisita') || '',
      fechaPrevista: fd.get('fechaPrevista') || '',
      autor: (previo && previo.autor) ? previo.autor : nombreAutor,
      actualizadoPor: nombreAutor,
    };
    const notaTexto = String((document.getElementById('mi-nota-texto') || {}).value || '').trim().slice(0, 2000);
    const notaVis = ((document.getElementById('mi-nota-vis') || {}).value === 'publica') ? 'publica' : 'privada';

    let id = seleccionado;
    let lugarNuevo = null;

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
      if (!miNombre) {
        toast('Inicia sesión para identificar tus pines en la nube');
      }
      lugarNuevo = {
        id: `custom-${Date.now().toString(36)}`,
        nombre,
        tipo: fd.get('tipo') === 'lugar' ? 'lugar' : 'ciudad',
        coordenadas: [lat, lng],
        personalizado: true,
        autor: nombreAutor,
        autorUid: miUid || '',
      };
      if (fd.get('departamento')) lugarNuevo.departamento = fd.get('departamento');

      custom.push(lugarNuevo);
      lugares.push(lugarNuevo);
      crearMarker(lugarNuevo);
      id = lugarNuevo.id;
      cancelarNuevo();
    }

    if (!id) return;

    const lugarActual = porId(id);
    const puedeEstado = !!modoNuevo || esAdmin
      || (lugarActual && puedeEditarPinManual(lugarActual))
      || puedeRestablecerRegistro(id);

    // 1) Nota/comentario: cualquiera (local o nube si tiene sesión verificada)
    const hayNota = !!(notaTexto || (misNotas[id] && misNotas[id].texto));
    if (hayNota) {
      misNotas[id] = {
        texto: notaTexto,
        visibilidad: notaVis,
        pendiente: !puedeEscribirNube(),
      };
      guardarNotasLocal();
      if (puedeEscribirNube()) {
        guardarNotaEnNube(id, notaTexto, notaVis).then(() => {
          if (misNotas[id]) {
            delete misNotas[id].pendiente;
            guardarNotasLocal();
          }
        });
      }
    }

    // 2) Estado / pin solo autor o admin (un tercero no lo cambia)
    if (!puedeEstado) {
      if (!hayNota) {
        toast('Puedes dejar una nota; el estado solo lo cambia el autor o un admin');
      } else if (puedeEscribirNube()) {
        toast('Nota guardada (sin cambiar el estado del lugar)');
        cargarNotasDeLugar(id);
      } else {
        toast('Nota guardada solo aquí · inicia sesión para compartirla');
      }
      return;
    }

    datos[id] = registro;
    guardarCacheLocal();

    if (puedeEscribirNube()) {
      if (lugarNuevo) guardarLugarManualEnNube(lugarNuevo);
      guardarRegistroEnNube(id, registro);
      toast(hayNota ? 'Estado y nota guardados en la nube' : 'Cambios guardados en la nube');
    } else {
      marcarPendienteRegistro(id);
      if (lugarNuevo) marcarPendienteLugar(id);
      guardarCacheLocal();
      toast('Guardado solo aquí · Pendiente de subir (inicia sesión y verifica el correo)');
    }

    refrescarTodo();
    actualizarMarker(id);
    if (hayNota) cargarNotasDeLugar(id);
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); guardar(); });
  $('#p-close').addEventListener('click', cerrarPanel);

  $('#btn-borrar').addEventListener('click', () => {
    const l = porId(seleccionado);
    if (!l) return;

    if (l.personalizado) {
      if (!puedeEditarPinManual(l)) {
        toast('Solo el autor o un administrador pueden eliminar este pin');
        return;
      }
      if (!confirm(`¿Eliminar "${l.nombre}" del mapa?`)) return;
      const id = l.id;
      custom = custom.filter((c) => c.id !== id);
      lugares = lugares.filter((x) => x.id !== id);
      delete datos[id];
      const m = markers.get(id);
      if (m) { capa.removeLayer(m); markers.delete(id); }
      borrarLugarManualEnNube(id);
      guardarCacheLocal();
      cerrarPanel();
      toast('Lugar eliminado');
    } else {
      if (!puedeRestablecerRegistro(l.id)) {
        toast('Solo el autor o un administrador pueden restablecer este registro');
        return;
      }
      if (!confirm(`¿Borrar estado y fechas de "${l.nombre}"?`)) return;
      const id = l.id;
      delete datos[id];
      borrarRegistroEnNube(id);
      guardarCacheLocal();
      abrirPanel(id, { revelar: false });
      toast('Datos restablecidos');
    }
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
    // Si eliges el chip "Solo manuales", sincroniza el checkbox
    if (filtro === 'manuales') {
      soloManuales = true;
      const chk = $('#chk-manuales');
      if (chk) chk.checked = true;
    }
    pintarFiltros();
    refrescarTodo();
  });

  $('#search').addEventListener('input', (e) => { query = norm(e.target.value); refrescarTodo(); });
  $('#chk-deps').addEventListener('change', (e) => { mostrarDeps = e.target.checked; refrescarTodo(); });
  $('#chk-ciudades').addEventListener('change', (e) => { mostrarCiudades = e.target.checked; refrescarTodo(); });
  const chkMan = $('#chk-manuales');
  if (chkMan) {
    chkMan.addEventListener('change', (e) => {
      soloManuales = e.target.checked;
      if (soloManuales) {
        filtro = 'manuales';
      } else if (filtro === 'manuales') {
        filtro = 'todos';
      }
      pintarFiltros();
      refrescarTodo();
    });
  }

  /* ---------- Auth UI ---------- */
  const authModal = $('#auth-modal');
  const authForm = $('#auth-form');
  const authError = $('#auth-error');
  const authMsg = $('#auth-msg');
  const authName = $('#auth-name');
  const authNameWrap = $('#auth-name-wrap');

  function mostrarAuthError(texto) {
    if (!authError) return;
    authError.hidden = !texto;
    authError.textContent = texto || '';
    if (authMsg) authMsg.hidden = true;
  }
  function mostrarAuthMsg(texto) {
    if (!authMsg) return;
    authMsg.hidden = !texto;
    authMsg.textContent = texto || '';
    if (authError) authError.hidden = true;
  }
  function abrirAuthModal() {
    if (!authModal) return;
    authModal.hidden = false;
    authModal.setAttribute('aria-hidden', 'false');
    mostrarAuthError('');
    mostrarAuthMsg('');
    if (authName) {
      authName.hidden = true;
      if (authNameWrap) authNameWrap.hidden = true;
    }
    setTimeout(() => $('#auth-email') && $('#auth-email').focus(), 50);
  }
  function cerrarAuthModal() {
    if (!authModal) return;
    authModal.hidden = true;
    authModal.setAttribute('aria-hidden', 'true');
  }

  if ($('#btn-login')) $('#btn-login').addEventListener('click', abrirAuthModal);
  if ($('#btn-logout')) {
    $('#btn-logout').addEventListener('click', async () => {
      try {
        await firebase.auth().signOut();
        toast('Sesión cerrada');
      } catch (err) {
        toast(errorAuthEs(err.code, err.message));
      }
    });
  }
  if ($('#btn-verify')) {
    $('#btn-verify').addEventListener('click', async () => {
      const user = firebase.auth().currentUser;
      if (!user) {
        toast('No hay sesión activa');
        return;
      }
      try {
        await user.reload();
        await user.getIdToken(true);
        const refreshed = firebase.auth().currentUser;
        aplicarUsuario(refreshed);
        if (refreshed && refreshed.emailVerified) {
          toast('Correo verificado · conectando a la nube');
        } else {
          toast('Aún no está verificado. Revisa tu bandeja de entrada.');
        }
      } catch (err) {
        toast(errorAuthEs(err.code, err.message));
      }
    });
  }
  document.querySelectorAll('[data-auth-close]').forEach((el) => {
    el.addEventListener('click', cerrarAuthModal);
  });

  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = ($('#auth-email') && $('#auth-email').value || '').trim();
      const pass = ($('#auth-password') && $('#auth-password').value) || '';
      if (pass.length < 8) {
        mostrarAuthError('La contraseña debe tener al menos 8 caracteres.');
        return;
      }
      mostrarAuthError('');
      try {
        await firebase.auth().signInWithEmailAndPassword(email, pass);
        const u = firebase.auth().currentUser;
        if (u && !u.emailVerified) {
          mostrarAuthMsg('Entra a tu correo y verifica la cuenta para sincronizar la nube.');
        } else {
          cerrarAuthModal();
          toast('Sesión iniciada');
        }
      } catch (err) {
        mostrarAuthError(errorAuthEs(err.code, err.message));
      }
    });
  }

  if ($('#auth-register')) {
    $('#auth-register').addEventListener('click', async () => {
      const email = ($('#auth-email') && $('#auth-email').value || '').trim();
      const pass = ($('#auth-password') && $('#auth-password').value) || '';
      const nombre = (authName && authName.value || '').trim().slice(0, 40);

      if (authName && authName.hidden) {
        authName.hidden = false;
        if (authNameWrap) authNameWrap.hidden = false;
        authName.required = true;
        mostrarAuthMsg('Escribe un nombre para mostrar y pulsa otra vez «Crear cuenta».');
        authName.focus();
        return;
      }
      if (!nombre) {
        mostrarAuthError('Indica un nombre para mostrar.');
        return;
      }
      if (pass.length < 8) {
        mostrarAuthError('La contraseña debe tener al menos 8 caracteres.');
        return;
      }
      mostrarAuthError('');
      try {
        const cred = await firebase.auth().createUserWithEmailAndPassword(email, pass);
        if (cred.user) {
          await cred.user.updateProfile({ displayName: nombre });
          await cred.user.sendEmailVerification();
          miNombre = nombre;
          mostrarAuthMsg('Cuenta creada. Te enviamos un correo de verificación. Debes verificarlo antes de escribir en la nube.');
          toast('Revisa tu correo para verificar la cuenta');
        }
      } catch (err) {
        mostrarAuthError(errorAuthEs(err.code, err.message));
      }
    });
  }

  if ($('#auth-forgot')) {
    $('#auth-forgot').addEventListener('click', async () => {
      const email = ($('#auth-email') && $('#auth-email').value || '').trim();
      if (!email) {
        mostrarAuthError('Escribe tu correo arriba para recuperar la contraseña.');
        return;
      }
      try {
        await firebase.auth().sendPasswordResetEmail(email);
        mostrarAuthMsg('Te enviamos un enlace para restablecer la contraseña.');
      } catch (err) {
        mostrarAuthError(errorAuthEs(err.code, err.message));
      }
    });
  }

  const filtrosAutorEl = $('#filtros-autor');
  if (filtrosAutorEl) {
    filtrosAutorEl.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      filtroAutor = b.dataset.autor || 'todos';
      pintarFiltrosAutor();
      refrescarTodo();
    });
  }

  const adminLista = $('#admin-autores-lista');
  if (adminLista) {
    adminLista.addEventListener('click', (e) => {
      const ocultar = e.target.closest('.btn-admin-ocultar');
      const mostrar = e.target.closest('.btn-admin-mostrar');
      const borrar = e.target.closest('.btn-admin-borrar');
      if (ocultar) adminOcultarAutor(ocultar.dataset.autor);
      if (mostrar) adminMostrarAutor(mostrar.dataset.autor);
      if (borrar) adminBorrarContenidoAutor(borrar.dataset.autor);
    });
  }

  $('#btn-center').addEventListener('click', () => {
    map.flyTo(CENTRO, ZOOM_INICIAL, { duration: 0.8 });
    cerrarSidebar();
  });

  /* ---------- Respaldo: exportar e importar ---------- */

  $('#btn-export').addEventListener('click', () => {
    const payload = {
      version: 2,
      exportado: new Date().toISOString(),
      autor: miNombre || '',
      datos,
      custom,
    };
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

      // Combinar (no reemplazar): los del respaldo se mezclan con los tuyos
      const importadosDatos = p.datos || {};
      let nuevos = 0;
      let actualizados = 0;
      Object.keys(importadosDatos).forEach((id) => {
        if (datos[id]) {
          // Si ya existe, solo actualiza si el importado tiene más info útil
          const actual = datos[id];
          const entrante = importadosDatos[id];
          datos[id] = {
            ...actual,
            ...entrante,
            autor: actual.autor || entrante.autor || '',
            actualizadoPor: entrante.actualizadoPor || actual.actualizadoPor || '',
          };
          actualizados++;
        } else {
          datos[id] = importadosDatos[id];
          nuevos++;
        }
      });

      const importadosCustom = Array.isArray(p.custom) ? p.custom.filter(lugarValido) : [];
      const idsActuales = new Set(custom.map((c) => c.id));
      importadosCustom.forEach((c) => {
        if (!idsActuales.has(c.id)) {
          custom.push(c);
          idsActuales.add(c.id);
          nuevos++;
        }
      });

      guardarCacheLocal();
      // Subir cada documento a Firestore (no un único doc global)
      Object.keys(datos).forEach((id) => guardarRegistroEnNube(id, datos[id]));
      custom.forEach((c) => guardarLugarManualEnNube(c));
      cerrarPanel();
      reconstruir();
      toast(`Respaldo combinado: ${nuevos} nuevos, ${actualizados} actualizados`);
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
    if ($('#chk-manuales')) $('#chk-manuales').checked = false;
    pintarEstados();
    pintarFiltros();
    cargarStorage();
    await cargarBase();
    reconstruir();
    pintarFiltrosAutor();
    // Auth por correo (sin anónimo). Nube solo con sesión verificada.
    iniciarAuth();
  }

  iniciar();
})();
