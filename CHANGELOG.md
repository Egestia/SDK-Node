# Cambios

Este archivo sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el paquete usa [versionado semántico](https://semver.org/lang/es/).

## [1.0.0]

Primera versión.

### Emitir
- `documentos.emitir()` — boletas y facturas desde el JSON de una venta.
- El **cliente** se crea si no existe (por RUT, o por correo si no hay RUT) y se
  completa con lo que falte, sin pisar lo que el ERP ya tenía.
- Los **productos** se crean por SKU la primera vez y se reutilizan después.
- Ciclo completo automático: emitir, firmar, enviar al SII y consultar el estado
  hasta tener respuesta.

### Reintentos
- El SDK abre una **interacción** por venta y la manda él: un reenvío —aunque
  sea con los datos corregidos— reutiliza el documento y **su folio**. Un folio
  del CAF no se quema dos veces por la misma venta.
- Registro de interacciones en memoria, con enchufe para persistirlo.

### Estados
- `documentos.anular()` — nota de crédito que anula el original. Idempotente.
- `anularYReemitir()` — el camino cuando el SII ya aceptó y hay que cambiar algo.
- El SDK detecta el intento de **corregir un documento ya aceptado** y lo frena,
  distinguiéndolo de un reenvío idéntico.

### Diagnóstico
- `intentarEmitir()` / `intentarAnular()` devuelven el problema explicado en vez
  de lanzarlo: tipo, qué hacer, si conviene reintentar y si el documento quedó
  creado igual.
- Reconoce: SII sin configurar, ambiente no habilitado, **sin folios**,
  certificado vencido, documento ya emitido, rechazo del SII.

### Consultar
- `documentos.obtener()`, `buscarPorReferencia()`, `sincronizar()`, `xml()`.
- `folios()` — cuántos folios quedan por tipo, para avisar antes de quedarse sin.
