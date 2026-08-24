/**
 * Los errores que puede devolver Egestia, tipados.
 *
 * Un integrador necesita distinguir tres cosas que un `Error` pelado no
 * distingue: si el problema fue suyo (datos malos), si fue de Egestia o el SII
 * (y por tanto se puede reintentar), y —el caso delicado— si el documento
 * QUEDÓ CREADO aunque la emisión fallara.
 */
export class EgestiaError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.name = 'EgestiaError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** ¿Tiene sentido volver a intentarlo? */
  get retriable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** La API key no sirve: falta, está mal escrita, venció o la revocaron. */
export class EgestiaAuthError extends EgestiaError {
  constructor(message: string, status: number, details?: unknown) {
    super(message, status, 'auth', details);
    this.name = 'EgestiaAuthError';
  }
}

/** A la key le falta el scope que ese endpoint exige. */
export class EgestiaScopeError extends EgestiaError {
  constructor(message: string, details?: unknown) {
    super(message, 403, 'scope', details);
    this.name = 'EgestiaScopeError';
  }
}

/** Los datos enviados no pasan la validación de Egestia. */
export class EgestiaValidationError extends EgestiaError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'validation', details);
    this.name = 'EgestiaValidationError';
  }
}

/**
 * El documento se creó pero NO se pudo emitir al SII.
 *
 * Es el caso que más confunde y el que nunca hay que resolver reintentando a
 * ciegas: la venta ya está registrada en Egestia con su `documentId`. Reintentar
 * con la MISMA `reference` devuelve ese mismo documento; reintentar sin ella
 * crea un segundo DTE y quema otro folio del CAF.
 */
export class EgestiaEmissionError extends EgestiaError {
  readonly documentId: string | null;
  readonly documentStatus: string | null;

  constructor(message: string, documentId: string | null, documentStatus: string | null, details?: unknown) {
    super(message, 502, 'emission', details);
    this.name = 'EgestiaEmissionError';
    this.documentId = documentId;
    this.documentStatus = documentStatus;
  }
}

/** La petición no llegó o no alcanzó a responder. */
export class EgestiaNetworkError extends EgestiaError {
  constructor(message: string, details?: unknown) {
    super(message, 0, 'network', details);
    this.name = 'EgestiaNetworkError';
  }
}
