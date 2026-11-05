# Política de seguridad

## Versiones con soporte
Solo la última versión publicada recibe correcciones.

## Cómo comunicar una vulnerabilidad
**No abras un issue público.** Usa la pestaña **Security → Report a vulnerability** de este repositorio (aviso privado de GitHub). Indica:
- versión afectada y navegador;
- descripción y pasos para reproducirla;
- impacto (p. ej., fuga de datos de la investigación, ejecución de código en la consola de la extensión, cookies o sesiones enviadas a terceros).

Se responderá en cuanto sea posible. Agradecemos que no publiques los detalles hasta que exista una versión corregida.

## Alcance que nos interesa especialmente
- Contenido de una plataforma consultada que pueda inyectar HTML o script en la consola o en los informes.
- Peticiones que salgan con cookies o datos del investigador cuando la herramienta declara que no lo hace.
- Datos de la sesión o del historial que se envíen fuera del navegador.
- Debilidades en el cálculo o la verificación de los hashes de los informes y evidencias.

## Fuera de alcance
- Que una plataforma bloquee, limite o cambie su respuesta (es un fallo de fuente: usa la plantilla «Fuente que no funciona»).
- Las claves públicas de clientes web incluidas en el código (Google Fotos, Instagram): las publican esos mismos servicios en sus webs y no dan acceso a ninguna cuenta.
