# Cómo contribuir

¡Gracias por ayudar! Las aportaciones más útiles son **fuentes nuevas** y **arreglos de fuentes que han cambiado**.

## Preparar el entorno
Solo necesitas Node.js 20 o posterior (no hay dependencias que instalar).

```bash
npm run check   # sintaxis, versiones e IDs de la interfaz
npm test        # pruebas de regresión con respuestas simuladas
npm run build   # todo lo anterior + dist/RASTRO-HUELLA-vX.Y.Z.zip y su .sha256
```

Para probar en el navegador: `chrome://extensions` → Modo desarrollador → **Cargar descomprimida** → carpeta `extension/`. Tras cada cambio, pulsa ⟳ en la tarjeta de la extensión.

## Estructura
| Ruta | Contenido |
|---|---|
| `extension/js/sources.js` | Fuentes por usuario y correo y pivotes manuales |
| `extension/js/social.js` | Facebook, X e Instagram (página y pestaña) |
| `extension/js/google.js` | Google por correo |
| `extension/js/email.js` | Reglas de evidencia para fuentes por correo |
| `extension/js/engine.js` | Ejecución, control anti-falsos positivos, correlación, fotos |
| `extension/js/http.js` | Peticiones con trazabilidad y SHA-256 |
| `extension/js/report.js` | Informes y exportaciones |
| `extension/background.js` | Service worker: reglas de cabeceras y verificación en pestaña |

## Reglas para una fuente nueva
1. **Nunca** uses inicio de sesión, recuperación de contraseña, envío de códigos ni flujos que avisen al titular.
2. Devuelve `found` solo con una señal explícita (campo de la API, alias exacto en la página). Ante la duda, `unknown` con un motivo claro.
3. Un 401/403/429/5xx **no** es «no encontrado».
4. Deja activado el control con identificador inexistente salvo que la fuente responda de forma explícita (y explica por qué en el código).
5. Si el dato sale hacia un tercero que no es la propia plataforma, marca `third: true`.
6. Añade pruebas: un positivo, un negativo y un caso indeterminado.

## Datos reales
No incluyas en código, pruebas, issues ni capturas identificadores, correos o resultados de investigaciones reales. Usa `example.org` y alias inventados.
