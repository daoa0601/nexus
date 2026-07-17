export type NexusErrorCode =
  | "INVALID_REQUEST"
  | "AUTHENTICATION_FAILED"
  | "FORBIDDEN"
  | "MODEL_NOT_FOUND"
  | "RATE_LIMITED"
  | "DEADLINE_EXCEEDED"
  | "UPSTREAM_UNAVAILABLE"
  | "SERVER_SHUTTING_DOWN"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

const statusByCode: Readonly<Record<NexusErrorCode, number>> = {
  INVALID_REQUEST: 400,
  AUTHENTICATION_FAILED: 401,
  FORBIDDEN: 403,
  MODEL_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  DEADLINE_EXCEEDED: 504,
  UPSTREAM_UNAVAILABLE: 503,
  SERVER_SHUTTING_DOWN: 503,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};

const typeByCode: Readonly<Record<NexusErrorCode, string>> = {
  INVALID_REQUEST: "invalid_request_error",
  AUTHENTICATION_FAILED: "authentication_error",
  FORBIDDEN: "permission_error",
  MODEL_NOT_FOUND: "invalid_request_error",
  RATE_LIMITED: "rate_limit_error",
  DEADLINE_EXCEEDED: "timeout_error",
  UPSTREAM_UNAVAILABLE: "upstream_error",
  SERVER_SHUTTING_DOWN: "service_unavailable_error",
  NOT_FOUND: "invalid_request_error",
  INTERNAL_ERROR: "internal_error",
};

export class NexusError extends Error {
  readonly code: NexusErrorCode;
  readonly status: number;

  constructor(code: NexusErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "NexusError";
    this.code = code;
    this.status = statusByCode[code];
  }
}

export interface ErrorEnvelope {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly code: NexusErrorCode;
  };
  readonly request_id: string;
}

export const errorEnvelope = (error: NexusError, requestId: string): ErrorEnvelope => ({
  error: {
    message: error.message,
    type: typeByCode[error.code],
    code: error.code,
  },
  request_id: requestId,
});

export const toNexusError = (error: unknown): NexusError => {
  if (error instanceof NexusError) {
    return error;
  }
  return new NexusError("INTERNAL_ERROR", "An internal error occurred");
};

export class DeadlineAbortReason extends Error {
  constructor() {
    super("deadline exceeded");
    this.name = "DeadlineAbortReason";
  }
}

export class AttemptTimeoutReason extends Error {
  constructor() {
    super("attempt timeout exceeded");
    this.name = "AttemptTimeoutReason";
  }
}

export class HedgeLoserReason extends Error {
  constructor() {
    super("hedged attempt lost");
    this.name = "HedgeLoserReason";
  }
}

export class ClientDisconnectReason extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientDisconnectReason";
  }
}

export class ShutdownAbortReason extends Error {
  constructor() {
    super("gateway shutting down");
    this.name = "ShutdownAbortReason";
  }
}
