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
const CAUSAS: Array<{ busca: RegExp; tipo: TipoProblema; queHacer: string }> = [
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
      reintentable: false,
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
      queHacer: 'A la API key le falta el scope de esa operación. Para emitir y anular hace falta «documents».',
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
        'No hubo respuesta, así que no se sabe si la venta se facturó. ' +
        'Antes de reintentar, pregunta con `documentos.buscarPorReferencia(tuReferencia)`.',
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
      reintentable: error.retriable,
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
