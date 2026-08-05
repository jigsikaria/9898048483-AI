import { config } from './config.ts';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function levelEnabled(level: LogLevel): boolean {
  const configured = config.logLevel.toLowerCase() as LogLevel;
  return LEVEL_ORDER[level] >= (LEVEL_ORDER[configured] ?? LEVEL_ORDER.info);
}

export function log(level: LogLevel, ...args: unknown[]): void {
  if (!levelEnabled(level)) return;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink('[adapter-os]', ...args);
}
