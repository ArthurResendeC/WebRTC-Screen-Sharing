import { z } from 'zod';

// Relato de erro que o navegador manda para POST /client-errors. Existe porque um
// erro de render sem boundary deixa a página em branco e ninguém vê o console de
// quem estava na sala; o servidor só valida e escreve uma linha no log do deploy.
export const CLIENT_ERROR_LIMITS = {
  message: 2_000,
  stack: 8_000,
  source: 500,
  path: 300,
  userAgent: 500,
} as const;

// O corpo inteiro, com folga para as chaves e o escape do JSON.
export const CLIENT_ERROR_BODY_MAX = 32_000;

export const clientErrorReportSchema = z
  .object({
    kind: z.enum([
      'error',
      'unhandled-rejection',
      'resource',
      'render',
      'react-recoverable',
      'signaling',
    ]),
    message: z.string().min(1).max(CLIENT_ERROR_LIMITS.message),
    stack: z.string().max(CLIENT_ERROR_LIMITS.stack).optional(),
    componentStack: z.string().max(CLIENT_ERROR_LIMITS.stack).optional(),
    source: z.string().max(CLIENT_ERROR_LIMITS.source).optional(),
    path: z.string().max(CLIENT_ERROR_LIMITS.path),
    userAgent: z.string().max(CLIENT_ERROR_LIMITS.userAgent),
    time: z.iso.datetime(),
  })
  .strict();

export type ClientErrorReport = z.infer<typeof clientErrorReportSchema>;
export type ClientErrorKind = ClientErrorReport['kind'];
