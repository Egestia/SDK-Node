import {
  EgestiaAuthError,
  EgestiaEmissionError,
  EgestiaError,
  EgestiaNetworkError,
  EgestiaScopeError,
  EgestiaValidationError,
} from './errors.js';

/** En qué punto se rompió. */
export type TipoProblema =
  | 'validacion'    // los datos enviados no sirven
  | 'auth'          // la API key
  | 'scope'         // permisos de la key
  | 'configuracion' // falta algo en Egestia: SII o certificado
  | 'sin_folios'    // se acabó el CAF de ese tipo de documento
  | 'ya_aceptado'   // el SII ya lo recibió: no admite correcciones
  | 'ya_emitida'    // esa referencia ya emitió documento, por otro monto
  | 'en_curso'      // la misma referencia se está emitiendo ahora mismo
  | 'sin_tipo_cambio' // no hay valor de la moneda para esa fecha
  | 'sii'           // el SII rechazó o no contestó
  | 'red'           // no llegó
  | 'no_encontrado' // el id o la referencia no existen en ese cliente
  | 'servidor'      // Egestia falló
  | 'desconocido';

/**
 * El problema, explicado.
 *
 * La gracia de un SDK es que quien integra no tenga que interpretar mensajes
 * sueltos ni entrar al panel de Egestia para saber qué pasó: acá viene qué
 * falló, si es culpa suya o del otro lado, qué hacer y —lo más importante— si
 * el documento quedó creado igual.
 */
export interface Problema {
  tipo: TipoProblema;
  /** Una frase para mostrar o registrar. */
  mensaje: string;
  /** Qué hacer al respecto, en concreto. */
  queHacer: string;
  /** ¿Reintentar tiene sentido? */
  reintentable: boolean;
  /** Código HTTP, o 0 si no hubo respuesta. */
  status: number;
  /**
   * Id del documento, cuando existe pese al fallo.
   *
   * Es el dato que evita el error caro: si viene, la venta YA está registrada
   * y volver a emitirla sin referencia quemaría otro folio del CAF.
   */
  documentId?: string | null;
  documentStatus?: string | null;
  /** Lo último que respondió el SII, si alcanzó a responder. */
  sii?: unknown;
  /** La respuesta cruda de Egestia, para el log. */
  detalle?: unknown;
}

/** Frases de Egestia que tienen una causa concreta y una salida concreta. */
const CAUSAS: Array<{
  busca: RegExp;
  tipo: TipoProblema;
  queHacer: string;
  /** Cuando el código HTTP por sí solo no dice si insistir sirve. */
  reintentable?: boolean;
}> = [
  {
    busca: /Configure la empresa SII/i,
    tipo: 'configuracion',
    queHacer: 'El cliente no ha configurado sus datos del SII en Egestia (SII → Configuración).',
  },
  {
    busca: /ambiente SII no está habilitado/i,
    tipo: 'configuracion',
    queHacer: 'Falta activar «Ambiente habilitado para emitir documentos» en SII → Configuración.',
  },
  {
    busca: /No hay folios disponibles|CAF sin xmlContent|Suba el archivo CAF|folios que se superponen/i,
    tipo: 'sin_folios',
    queHacer:
      'Se acabaron los folios de ese tipo de documento. Hay que pedir un CAF nuevo al SII y cargarlo en ' +
      'Egestia (SII → Folios/CAF). Hasta entonces no se puede emitir ese tipo: la venta queda registrada ' +
      'en borrador y se emite sola al reintentar. Con `egestia.folios()` puedes avisar antes de quedarte sin.',
  },
  {
    busca: /clave tributaria/i,
    tipo: 'configuracion',
    queHacer:
      'El cliente no tiene cargada su clave tributaria del SII, y sin ella no se pueden emitir boletas ' +
      'de honorarios. Se configura en Egestia → Configuración → SII → Certificado Digital.',
  },
  {
    busca: /certificad/i,
    tipo: 'configuracion',
    queHacer: 'El certificado digital falta o venció. Se renueva en Egestia → Certificados.',
  },
  {
    busca: /ya fue emitido|ya fue aceptado/i,
    tipo: 'validacion',
    queHacer: 'Ese documento ya está emitido. Consúltalo con `documentos.obtener(id)` en vez de reemitirlo.',
  },
  {
    busca: /no tiene folio/i,
    tipo: 'validacion',
    queHacer: 'Todavía es un borrador: no existe para el SII y no hay nada que anular.',
  },
  {
    busca: /rechaz|reparo/i,
    tipo: 'sii',
    queHacer: 'El SII rechazó el documento. Revisa el detalle en `sii` y corrige antes de reemitir.',
  },

  // ── Boletas de honorarios ──────────────────────────────────────────────────
  {
    busca: /ya emitió una boleta por|ya emitió una factura por/i,
    tipo: 'ya_emitida',
    queHacer:
      'Esa referencia ya emitió una boleta, y por OTRO monto: no es un reintento, es otro pago con la ' +
      'referencia equivocada. La boleta que ya existe viene en `detalle.data`. Si el monto anterior ' +
      'estaba malo, anúlala con `honorarios.anular(id, { causa: "error_digitacion" })` y emite otra ' +
      'con una referencia nueva.',
  },
  {
    busca: /Ya se está emitiendo (la boleta|la factura)/i,
    tipo: 'en_curso',
    queHacer:
      'Otra llamada con esta misma referencia está emitiendo ahora mismo. No emitas otra: espera unos ' +
      'segundos y pregunta con `honorarios.buscarPorReferencia(tuReferencia)`.',
    reintentable: true,
  },
  {
    busca: /domicilio|la comuna/i,
    tipo: 'validacion',
    queHacer:
      'El SII imprime el domicilio y la comuna del prestador en la boleta y sin ellos la rechaza. ' +
      'Complétalos en su ficha de contacto en Egestia, o mándalos en `direccion` y `comuna`.',
  },
  {
    busca: /causa tiene que ser una de las dos/i,
    tipo: 'validacion',
    queHacer:
      'El SII acepta dos causas de anulación y no más: «no_prestacion» si el servicio no se prestó, ' +
      '«error_digitacion» si la boleta salió con un dato malo.',
  },
  {
    busca: /Sólo se anulan las boletas que emitió la empresa/i,
    tipo: 'validacion',
    queHacer: 'Una boleta recibida la anula quien la emitió: desde acá no se puede.',
  },
  // ── Facturas de compra por servicios del exterior ──────────────────────────
  {
    busca: /No tenemos el valor de|No hay tipo de cambio para la moneda/i,
    tipo: 'sin_tipo_cambio',
    queHacer:
      'Egestia no tiene el valor de esa moneda para la fecha de emisión, y el SII exige emitir con el ' +
      'del día (Oficio 1794/2017). No se inventa: la factura queda en borrador con su referencia, así ' +
      'que reintentar la MISMA referencia más tarde la emite. Si es urgente, manda `tipoCambio`.',
    reintentable: true,
  },
  {
    busca: /No hay CAF de factura de compra/i,
    tipo: 'sin_folios',
    queHacer:
      'Falta el CAF del tipo 46 —factura de compra—, que es distinto del de las facturas de venta. ' +
      'Hay que pedirlo al SII y cargarlo en Egestia (SII → Folios/CAF). La factura queda en borrador ' +
      'con su referencia y se emite al reintentar, sin duplicarse.',
  },
  {
    busca: /forma de RUT chileno|nómina de prestadores extranjeros/i,
    tipo: 'validacion',
    queHacer:
      'El receptor de una factura de compra es el número del prestador en la nómina de inscritos del ' +
      'SII, o 55.555.555-5 si no está inscrito. Egestia resuelve el que corresponde: mira `avisos` en ' +
      'la respuesta para saber cuál usó.',
  },
  {
    busca: /se corrige con una nota de crédito/i,
    tipo: 'ya_aceptado',
    queHacer:
      'La factura ya está en el SII y no se edita. Para echarla atrás hay que emitir una nota de ' +
      'crédito, y eso hoy se hace desde Egestia.',
  },
  {
    busca: /No hay conexión con apibase|no se puede consultar al SII/i,
    tipo: 'sii',
    queHacer:
      'Egestia no pudo llegar al SII. No se emitió nada, así que reintentar es seguro —con la misma ' +
      'referencia— en unos minutos.',
    reintentable: true,
  },
];

/**
 * Convierte cualquier error del SDK en un problema explicado.
 *
 * Sirve tanto para el `catch` como para la variante que no lanza.
 */
export function explicar(error: unknown): Problema {
  if (error instanceof EgestiaEmissionError) {
    const detalle: any = error.details;
    const motivo = detalle?.data?.motivo || error.message;
    const causa = CAUSAS.find((c) => c.busca.test(motivo));

    return {
      tipo: causa?.tipo ?? 'sii',
      mensaje: motivo,
      queHacer:
        (causa?.queHacer ?? 'Revisa el documento en Egestia antes de reintentar.') +
        ' El documento YA está creado: reintenta con la MISMA referencia o no reintentes.',
      reintentable: false,
      status: error.status,
      documentId: error.documentId,
      documentStatus: error.documentStatus,
      sii: detalle?.data?.sii ?? null,
      detalle,
    };
  }

  if (error instanceof EgestiaValidationError) {
    const causa = CAUSAS.find((c) => c.busca.test(error.message));
    return {
      tipo: causa?.tipo ?? 'validacion',
      mensaje: error.message,
      queHacer: causa?.queHacer ?? 'Corrige los datos: repetir la misma petición dará lo mismo.',
      reintentable: causa?.reintentable ?? false,
      status: error.status,
      detalle: error.details,
    };
  }

  if (error instanceof EgestiaAuthError) {
    return {
      tipo: 'auth',
      mensaje: error.message,
      queHacer: 'Revisa la API key: puede estar mal copiada, vencida o revocada. Se regenera en Egestia → Integraciones.',
      reintentable: false,
      status: error.status,
      detalle: error.details,
    };
  }

  if (error instanceof EgestiaScopeError) {
    return {
      tipo: 'scope',
      mensaje: error.message,
      queHacer:
        'A la API key le falta el scope de esa operación: «documents» para boletas y facturas, ' +
        '«honorarios» para las boletas de honorarios de terceros, «compras» para las facturas de ' +
        'compra por servicios del exterior. Se marcan al crear la key en Egestia → Integraciones.',
      reintentable: false,
      status: 403,
      detalle: error.details,
    };
  }

  if (error instanceof EgestiaNetworkError) {
    return {
      tipo: 'red',
      mensaje: error.message,
      queHacer:
        'No hubo respuesta, así que no se sabe si la venta se facturó. Antes de reintentar, pregunta ' +
        'con `documentos.buscarPorReferencia(tuReferencia)` —o `honorarios.buscarPorReferencia(…)` ' +
        'si era una boleta de honorarios—.',
      reintentable: true,
      status: 0,
      detalle: error.details,
    };
  }

  if (error instanceof EgestiaError) {
    // El SDK marca este caso con su propio código: no viene del servidor, lo
    // detecta él al ver que se intentó corregir algo ya aceptado.
    if (error.code === 'ya_aceptado') {
      const detalle: any = error.details;
      return {
        tipo: 'ya_aceptado',
        mensaje: error.message,
        queHacer:
          'Este documento ya existe para el SII y no se puede corregir. El camino es anularlo con una ' +
          'nota de crédito y emitir uno nuevo: `documentos.anularYReemitir(id, ventaCorregida)`.',
        reintentable: false,
        status: 409,
        documentId: detalle?.data?.id ?? null,
        documentStatus: detalle?.data?.status ?? null,
        detalle,
      };
    }

    const causa = CAUSAS.find((c) => c.busca.test(error.message));
    // Un 404 casi siempre es el id equivocado, o la key de OTRO cliente: cada
    // documento vive en el schema de su empresa y no se ve desde fuera.
    if (error.status === 404 && !causa) {
      return {
        tipo: 'no_encontrado',
        mensaje: error.message,
        queHacer: 'Ese id no existe para esta API key. Revisa que sea el documento correcto y que la key sea la de ese cliente.',
        reintentable: false,
        status: 404,
        detalle: error.details,
      };
    }

    return {
      tipo: causa?.tipo ?? (error.status >= 500 ? 'servidor' : 'desconocido'),
      mensaje: error.message,
      queHacer: causa?.queHacer ?? (error.retriable
        ? 'Falla del lado de Egestia. Se puede reintentar en unos segundos.'
        : 'Revisa el detalle de la respuesta.'),
      // El código HTTP no siempre alcanza: un 409 «se está emitiendo ahora
      // mismo» se resuelve solo, y volver a preguntar es exactamente lo que
      // hay que hacer.
      reintentable: causa?.reintentable ?? error.retriable,
      status: error.status,
      detalle: error.details,
    };
  }

  const e = error as Error;
  return {
    tipo: 'desconocido',
    mensaje: e?.message ?? String(error),
    queHacer: 'Error fuera de la API. Revisa los datos antes de llamar.',
    reintentable: false,
    status: 0,
    detalle: error,
  };
}

/** Lo que devuelven los métodos que no lanzan. */
export type Resultado<T> =
  | { ok: true; datos: T; problema?: undefined }
  | { ok: false; datos?: undefined; problema: Problema };
