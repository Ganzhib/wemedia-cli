export type ErrorCode = 'INPUT' | 'AUTH' | 'API' | 'NETWORK' | 'PROTOCOL' | 'BUSY' | 'INTERNAL' | 'UNSUPPORTED' | 'VERIFICATION' | 'UNKNOWN' | 'PARTIAL' | 'CONFLICT';

export class CliError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function exitCode(error: CliError): number {
  switch (error.code) {
    case 'INPUT': return 2;
    case 'AUTH': return 3;
    case 'API': case 'PROTOCOL': return 4;
    case 'NETWORK': return 5;
    case 'BUSY': return 6;
    case 'INTERNAL': return 1;
    case 'UNSUPPORTED': return 7;
    case 'VERIFICATION': return 8;
    case 'UNKNOWN': return 9;
    case 'PARTIAL': return 10;
    case 'CONFLICT': return 11;
  }
}
