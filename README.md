# Mapa de Nicaragua

Mapa interactivo para marcar los lugares de Nicaragua que ya visitaste, los que quieres visitar y los que tienen fecha. Usa **Leaflet** + **OpenStreetMap**, sin build ni dependencias que instalar. Tus datos se guardan en el navegador (`localStorage`).

## App instalable (PWA)

La aplicación es una **Progressive Web App**:

- Puedes **instalarla** en el celular o en el escritorio (Chrome / Edge / Safari).
- Funciona **sin conexión** una vez que la hayas abierto al menos una vez (la interfaz y tus datos).
- Los mosaicos del mapa (calles, satélite, etc.) necesitan internet la primera vez; después algunos se guardan en caché.

### Cómo instalarla

**En el celular (Android / iOS):**
1. Abre el mapa en el navegador.
2. En el menú del navegador elige **“Añadir a la pantalla de inicio”** o **“Instalar aplicación”**.

**En el PC (Chrome / Edge):**
1. Abre el mapa.
2. En la barra de direcciones aparece un icono de instalación (⊕ o similar). Haz clic y confirma.

Una vez instalada se abre en ventana propia, sin la barra del navegador.

## Cómo abrirlo

La app lee `data/lugares.json` con `fetch`, y los navegadores bloquean eso si abres `index.html` con doble clic. Necesitas un servidor local, cualquiera de estos sirve:

**Windows:** haz doble clic en `iniciar.bat` (necesita Python instalado) y se abre el mapa en `http://localhost:8000`.

```bash
# Python (en Windows usa `py` o `python` en lugar de `python3`)
cd mapa-nicaragua
python3 -m http.server 8000
# abre http://localhost:8000
```

```bash
# Node
npx serve .
```

También puedes usar la extensión **Live Server** de VS Code (clic derecho en `index.html` → *Open with Live Server*).

Necesitas conexión a internet para cargar los mosaicos del mapa, Leaflet y las tipografías.

## Cómo usarlo

1. **Toca o haz clic en un pin** (o en un lugar de la lista) y se abre el panel de edición.
2. Elige el **estado**, anota las **fechas** y escribe tus **notas**.
3. Pulsa **Guardar cambios**. Queda guardado aunque cierres o recargues la página.

| Color | Estado | Qué significa |
|---|---|---|
| Verde | Ya visitado | Ya estuve. Anota la fecha de visita. |
| Azul | Quiero visitar | Quiero ir, todavía sin fecha. |
| Naranja | Voy a visitar | Ya tengo fecha prevista. |
| Morado | Quiero volver | Estado extra: ya estuve y quiero repetir. Cuenta como visitado. |
| Gris | Sin marcar | Todavía no has hecho nada con este lugar. |

Los **departamentos** tienen un pin más grande con el centro cuadrado; las **ciudades y pueblos** son más pequeños con el centro redondo.

Atajos del formulario: si escribes una *fecha prevista* en un lugar sin marcar o en "Quiero visitar", pasa solo a "Voy a visitar". Si escribes una *fecha de visita*, pasa a "Ya visitado".

### Filtros, búsqueda y contadores

- La barra superior muestra cuántos lugares has visitado, cuántos están por visitar, cuántos tienen fecha y el porcentaje explorado.
- En la lista lateral (en el móvil, botón ☰) puedes buscar por nombre, filtrar por estado y ocultar departamentos o ciudades, o marcar **Solo pines añadidos por mí** para ver únicamente los lugares que colocaste manualmente (sin importar su estado).
- "Ver toda Nicaragua" vuelve a la vista inicial.
- El control de capas (abajo a la derecha del mapa) cambia entre OpenStreetMap, Calles (Esri), Satélite y Relieve. Si OpenStreetMap muestra "Access blocked", cambia a otra capa.

### Añadir un lugar nuevo

1. Pulsa **＋ Añadir lugar**.
2. Toca el mapa donde está el lugar.
3. Escribe el nombre, elige tipo y departamento, ajusta las coordenadas si hace falta (también puedes arrastrar el pin) y guarda.

Los lugares añadidos se pueden eliminar desde su panel. Los del JSON base solo se pueden restablecer (borran tus datos, no el lugar).

### Respaldo

Los datos viven en el `localStorage` de **este navegador y este dominio**: si borras los datos del sitio, cambias de navegador o abres la app desde otra dirección, no los verás. Usa **Exportar respaldo** para descargar un `.json` y **Importar** para recuperarlo en otro dispositivo. Al importar, el respaldo se **combina** con lo que ya tienes (no reemplaza nada): se agregan los lugares añadidos que falten y, si un mismo lugar está en ambos, se conserva la versión editada más recientemente.

## Estructura

```
mapa-nicaragua/
├── index.html          Estructura de la página y del panel de edición
├── style.css           Estilos (responsive, pines, panel)
├── app.js              Lógica: mapa, pines, filtros, panel, localStorage
├── sw.js               Service Worker (caché offline)
├── manifest.json       Manifiesto PWA (instalable)
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
├── data/
│   └── lugares.json    Departamentos y ciudades (editable)
├── iniciar.bat         Lanzador para Windows
└── README.md
```

## Editar los lugares (`data/lugares.json`)

Es un arreglo de objetos. Para añadir un lugar, copia una línea y cambia los valores:

```json
{"id": "ciudad-esteli", "nombre": "Estelí", "tipo": "ciudad", "coordenadas": [13.0917, -86.3547], "departamento": "Estelí"}
```

| Campo | Obligatorio | Detalle |
|---|---|---|
| `id` | Sí | Único y **estable**: tus datos guardados se enlazan por este id. No lo cambies después. |
| `nombre` | Sí | Texto que se muestra. |
| `tipo` | Sí | `departamento`, `ciudad` o `lugar`. |
| `coordenadas` | Sí | `[latitud, longitud]`. |
| `departamento` | No | Nombre exacto de un departamento del JSON. |

El archivo trae los 15 departamentos más las 2 regiones autónomas de la Costa Caribe (RACCN y RACCS), y unas 48 ciudades y pueblos. Las coordenadas de los departamentos son aproximadas (hacia el centro del territorio), así que no coinciden con la capital.

## Personalizar

- **Colores y nombres de estados:** objeto `ESTADOS` al inicio de `app.js` (un único lugar; el CSS lo toma de ahí).
- **Vista inicial:** constantes `CENTRO` y `ZOOM_INICIAL` en `app.js`.
- **Aspecto:** variables CSS al inicio de `style.css`.

## Publicarlo

Es un sitio estático: súbelo tal cual a GitHub Pages, Netlify o Cloudflare Pages. Recuerda que los datos de cada visitante quedan en su propio navegador.

## Créditos

Mapa © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright). Capas alternativas © [Esri](https://www.esri.com) y [OpenTopoMap](https://opentopomap.org). Librería [Leaflet](https://leafletjs.com).
