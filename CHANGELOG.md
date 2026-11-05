# Registro de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado [SemVer](https://semver.org/lang/es/): mientras la versión sea 0.x, cualquier versión menor puede cambiar criterios de detección.

## [0.8.1] - 2026-11-05
### Corregido
- **Instagram: falsos «No encontrado».** La API `web_profile_info` responde 404 o `user: null` a peticiones anónimas o limitadas aunque la cuenta exista. Esa negativa ya no se acepta sola: se comprueba la página `instagram.com/{usuario}/` (Open Graph: nombre, alias, foto, ID numérico y recuentos).
- «No encontrado» en Instagram exige dos negativas (API y página). Cualquier otra combinación queda indeterminada con «Verificar en pestaña».

## [0.8.0] - 2026-11-05
### Añadido
- **Google por correo** (opción «Google por correo (sesión)», desactivada por defecto): nombre, foto de perfil, portada, GAIA ID, última edición del perfil y enlace a sus reseñas de Google Maps. Se ejecuta en una pestaña de `photos.google.com` con la sesión de Google del navegador (People API interna, SAPISIDHASH). Solo contenedores PROFILE y DOMAIN_PROFILE. No notifica al titular; Google registra la consulta en la cuenta con sesión.
- **Facebook por usuario**: Open Graph, URL canónica con alias exacto, ID numérico y foto; verificación en pestaña cuando exige sesión.
- **X / Twitter (navegador)**: perfil leído en pestaña sin terceros (nombre, foto 400×400, portada, ID numérico, bio, ubicación, web, alta, recuentos).
- vxTwitter como segunda opción de terceros si FxTwitter falla.
- **Pestaña Fotos**: galería de fotos de perfil y portadas sin duplicados, en la mayor resolución conocida; descarga individual con SHA-256 en trazabilidad; ZIP con `manifiesto.csv` y `LEEME.txt`; enlaces de búsqueda inversa (Lens, Yandex, Bing, TinEye).
- Pivotes manuales: el correo en Facebook (con sesión), posts de X que lo mencionan, Google acotado a X/Facebook, Google Calendar público.
- El informe incluye Portada y SHA-256 del avatar.
- 8 pruebas de regresión nuevas (32 en total).

## [0.7.0]
### Añadido
- Enriquecimiento opcional con la API v2 de OSINT Industries (clave propia; premium desactivado; sin reintentos de consultas de pago; la clave no se guarda ni se exporta).
- Importación local de respuestas JSON de OSINT Industries (máx. 5 MB y 500 módulos) con hash del fichero.
- Exploración opcional de hasta tres alias derivados del correo, siempre como hipótesis de confianza baja.
- Comprobación pública de npm por correo exacto de mantenedor.
- Firma «Creado por S3GAD3» en el pie.
### Cambiado
- Al iniciar una búsqueda se restaura el filtro «Relevantes».
- GitHub y GitLab por correo: búsqueda paginada con contraste del correo público exacto y cobertura declarada.
- Los detectores de registro no interpretan 401/403/429/5xx como existencia o ausencia.
- Microsoft 365: el autodescubrimiento se presenta como información del servicio, no como prueba de buzón.
- VSCO queda indeterminado hasta validar un adaptador actualizado.

## Versiones anteriores
Versiones internas no publicadas: adaptadores por usuario y correo, control anti-falsos positivos con identificador inexistente, verificación en pestaña, correlación (nombres, avatares por dHash, cronología), trazabilidad con SHA-256, informe TXT/HTML/JSON con hash propio y exportaciones CSV para i2 / Maltego / Gephi.

[0.8.1]: https://github.com/OWNER/rastro-huella/releases/tag/v0.8.1
[0.8.0]: https://github.com/OWNER/rastro-huella/releases/tag/v0.8.0
[0.7.0]: https://github.com/OWNER/rastro-huella/releases/tag/v0.7.0
