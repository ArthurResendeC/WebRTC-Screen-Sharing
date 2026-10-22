import {
  CLIENT_ERROR_LIMITS,
  type ClientErrorKind,
  type ClientErrorReport,
} from '../lib/clientErrors';

// Importado primeiro por app.tsx: os listeners são instalados na avaliação deste
// módulo, antes dos outros, então um erro ao avaliar qualquer módulo seguinte já é
// relatado. Um erro de sintaxe no próprio bundle continua fora de alcance.
const ENDPOINT = '/client-errors';
// Um laço de erro (um render que falha a cada frame) não pode inundar o log.
const MAX_REPORTS_PER_PAGE = 10;

const reported = new Set<string>();

const clip = (value: string | undefined, max: number) =>
  value === undefined ? undefined : value.slice(0, max);

function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error)
    return { message: `${error.name}: ${error.message}`, stack: error.stack };
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

export function reportClientError(
  kind: ClientErrorKind,
  error: unknown,
  details: { componentStack?: string; source?: string } = {},
) {
  const { message, stack } = describe(error);
  const key = `${kind}\0${message}\0${details.source ?? ''}`;
  if (reported.has(key) || reported.size >= MAX_REPORTS_PER_PAGE) return;
  reported.add(key);
  const report: ClientErrorReport = {
    kind,
    message: clip(message, CLIENT_ERROR_LIMITS.message) || '(sem mensagem)',
    stack: clip(stack, CLIENT_ERROR_LIMITS.stack),
    componentStack: clip(details.componentStack, CLIENT_ERROR_LIMITS.stack),
    source: clip(details.source, CLIENT_ERROR_LIMITS.source),
    // Só o pathname: o hash do convite carrega a credencial da sala.
    path: location.pathname.slice(0, CLIENT_ERROR_LIMITS.path),
    userAgent: navigator.userAgent.slice(0, CLIENT_ERROR_LIMITS.userAgent),
    time: new Date().toISOString(),
  };
  const body = JSON.stringify(report);
  // sendBeacon sobrevive a um reload logo em seguida (o botão da tela de erro).
  try {
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon?.(ENDPOINT, blob)) return;
  } catch {
    // Cai para o fetch abaixo.
  }
  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {
    // Relatar é best-effort: sem rede, o erro fica só no console.
  });
}

// Quedas do socket de signaling depois de entrar na sala: o código de fechamento diz
// quem derrubou (1006 rede/proxy, 1001 proxy saindo, 1012 deploy, 4000 heartbeat).
export function reportSignalingDrop(close: {
  code: number;
  reason: string;
  openMs: number;
}) {
  const seconds = Math.round(close.openMs / 1000);
  reportClientError(
    'signaling',
    `Signaling caiu: código ${close.code}${close.reason ? ` (${close.reason})` : ''}, aberto há ${seconds}s, aba ${document.visibilityState}, ${navigator.onLine ? 'online' : 'offline'}`,
  );
}

// Captura: erros de carregamento de recurso não sobem até window, só são vistos na
// fase de captura. Só script e folha de estilo: sem eles a página não monta.
window.addEventListener(
  'error',
  event => {
    const target = event.target;
    if (target instanceof HTMLScriptElement) {
      reportClientError('resource', 'Falha ao carregar script', {
        source: target.src,
      });
      return;
    }
    if (target instanceof HTMLLinkElement) {
      reportClientError('resource', 'Falha ao carregar folha de estilo', {
        source: target.href,
      });
      return;
    }
    if (target !== window) return;
    reportClientError('error', event.error ?? event.message, {
      source: event.filename
        ? `${event.filename}:${event.lineno}:${event.colno}`
        : undefined,
    });
  },
  true,
);

window.addEventListener('unhandledrejection', event => {
  reportClientError('unhandled-rejection', event.reason);
});
