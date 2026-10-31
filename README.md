# Mapa interactivo de Nicaragua

PWA con **Leaflet** + **Firebase** (Authentication y Firestore) para marcar lugares visitados, por visitar y con fecha.

**Versión: 2.1** — lectura pública del mapa, escritura solo para **miembros** con correo verificado.

Sitio: https://villzarate.github.io/Mapa-interactivo-Nicaragua-/

> Este proyecto se desarrolló con asistencia de inteligencia artificial (Grok / xAI y otras herramientas), bajo la dirección del autor del mapa.

---

## Cómo funciona el acceso

| Estado | Qué ve | Qué puede guardar en la nube |
|--------|--------|------------------------------|
| Sin sesión | Mapa público (pines de todos) | Solo en este dispositivo (pendiente) |
| Sesión sin verificar correo | Mapa público | Solo local (pendiente) |
| Verificado pero **no** está en `miembros` | Mapa público | Solo local + aviso de pedir acceso |
| Verificado **y** miembro | Mapa público + sincroniza | Sí: sube pendientes y escribe en Firestore |

### Dar acceso a alguien (administrador)

1. Firebase → Firestore → colección **`miembros`**
2. Añade un documento cuyo **ID** sea el correo en **minúsculas** (ej. `ana@gmail.com`)
3. Puede ir vacío o con un campo `nombre`
4. La persona pulsa «Ya verifiqué mi correo» o vuelve a entrar

Opcional: documento `admins/{uid}` para poder editar/borrar datos migrados con `autorUid` vacío.

---

## Estructura Firestore

| Colección | Uso |
|-----------|-----|
| `lugares/{id}` | Pines manuales |
| `registros/{id}` | Estados y notas |
| `miembros/{email}` | Quién puede escribir |
| `admins/{uid}` | Administradores |
| `ocultos/{id}` | Autores ocultos del filtro |

---

## Archivos

- `index.html`, `app.js`, `style.css` — app
- `sw.js` — PWA (caché `mapa-ni-v4-miembros`)
- `data/lugares.json` — lugares base
- `firestore.rules` — publicar en Firebase **después** de probar el código

---

## Publicar

1. Sube los archivos a GitHub
2. Recarga forzada / borra datos del sitio (nueva versión de SW)
3. Publica reglas cuando el login y `miembros` estén bien

---

## Notas

- `autorUid` / `autorNombre` solo se escriben al **crear** un documento; las actualizaciones no los cambian.
- Pines solo locales muestran la etiqueta **Pendiente de subir**.
