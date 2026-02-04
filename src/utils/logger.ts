export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_LEVEL = process.env.LOG_LEVEL
  ? LogLevel[process.env.LOG_LEVEL as keyof typeof LogLevel] || LogLevel.INFO
  : LogLevel.INFO;

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => log(LogLevel.DEBUG, message, context),
  info: (message: string, context?: Record<string, unknown>) => log(LogLevel.INFO, message, context),
  warn: (message: string, context?: Record<string, unknown>) => log(LogLevel.WARN, message, context),
  error: (message: string, error?: Error | string, context?: Record<string, unknown>) => {
    const errorMsg = error instanceof Error ? error.message : error;
    const errorStack = error instanceof Error ? error.stack : undefined;
    log(LogLevel.ERROR, message, { ...context, error: errorMsg, stack: errorStack });
  },
};

function log(level: LogLevel, message: string, context?: Record<string, unknown>) {
  if (level < LOG_LEVEL) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level: LogLevel[level],
    message,
    ...context,
  };

  // Always write to stderr to avoid interfering with MCP stdout transport
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(entry));
}
