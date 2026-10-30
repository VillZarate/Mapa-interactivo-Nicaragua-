# Mapa interactivo de Nicaragua

PWA con **Leaflet** + **Firebase** (Authentication y Firestore) para marcar lugares visitados, por visitar y con fecha.

**Versión actual: 2.0 (Fase 2 — auth por correo)**

Sitio: https://villzarate.github.io/Mapa-interactivo-Nicaragua-/

---

## Qué incluye

- Mapa de Nicaragua con departamentos, ciudades y pines manuales
- Estados: visitado, por visitar, con fecha, quiero volver
- Filtros, búsqueda, clustering
- **Cuenta con correo y contraseña** (Firebase Auth)
- Sincronización en la nube solo con **correo verificado**
- Sin sesión: datos solo en este dispositivo (`localStorage`)
- PWA instalable (service worker `mapa-ni-v3-auth`)

---

## Estructura de datos (Firestore)

| Colección | Contenido |
|-----------|-----------|
| `lugares/{id}` | Pines añadidos a mano |
| `registros/{id}` | Estado, fechas y notas (base o manual) |
| `ocultos/{id}` | Autores ocultos del filtro (admin) |
| `admins/{uid}` | Documento vacío = administrador |

Los lugares de `data/lugares.json` **no** se guardan en Firestore; solo su `registros/{id}` si alguien los marca.

---

## Cómo usar

1. Abre el mapa e **Inicia sesión** o **Crea cuenta**.
2. Verifica el correo (enlace que envía Firebase).
3. Pulsa **«Ya verifiqué mi correo»** si ya confirmaste y aún no sincroniza.
4. Con sesión verificada, los cambios se comparten en la nube.

---

## Archivos principales

- `index.html` — interfaz
- `app.js` — lógica del mapa y Firebase
- `style.css` — estilos
- `sw.js` — PWA / caché offline
- `data/lugares.json` — lugares base
- `firestore.rules` — reglas de seguridad (publicar en la consola de Firebase)

---

## Publicar cambios

1. Sube los archivos a GitHub (`main`).
2. GitHub Pages sirve la raíz del repo.
3. Tras cambiar `app.js` / `sw.js`, haz una recarga forzada o borra datos del sitio para evitar caché antigua.

---

## Administrador

En Firestore, crea a mano el documento `admins/{tuUid}` (vacío) para poder editar o borrar registros migrados con `autorUid` vacío.

---

## Licencia / uso

Proyecto personal de viajes por Nicaragua. Map tiles: OpenStreetMap, Esri, OpenTopoMap según la capa elegida.
