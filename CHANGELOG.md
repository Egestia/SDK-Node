# Cambios

Este archivo sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el paquete usa [versionado semántico](https://semver.org/lang/es/).

## [1.1.0]

### Boletas de honorarios de terceros
- `honorarios.emitir()` — se manda el BRUTO y vuelve la boleta con el folio, la
  tasa y el monto de la retención **que aplicó el SII**, y el líquido. Lo que se
  transfiere es `netAmount`; `withheldAmount` lo entera la empresa al SII.
- `honorarios.obtener()`, `buscarPorReferencia()` y `anular()` —con la causa que
  exige el SII: `no_prestacion` o `error_digitacion`—, más `intentarEmitir()` e
  `intentarAnular()`.
- **Idempotencia por referencia.** Acá pesa más que en un DTE: una boleta de más
  no es un folio quemado, es una retención duplicada y un pago de más. Repetir
  la llamada devuelve la boleta que ya existe (`repetido: true`); emitir con la
  misma referencia y otro monto se frena en vez de devolver la vieja; y dos
  llamadas simultáneas se serializan, para que el hueco entre consultar y emitir
  no deje pasar una segunda.
- La boleta guarda la **sucursal** a la que se carga el gasto, resuelta por su
  número o su UUID igual que en los documentos.
- Scope propio, `honorarios`: retener plata de un prestador no viene de regalo
  con el permiso de facturar.
- Problemas nuevos que el SDK explica: `ya_emitida`, `en_curso`, clave
  tributaria sin configurar, domicilio o comuna del prestador incompletos.

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
