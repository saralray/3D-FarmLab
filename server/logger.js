// Lightweight leveled logger for the web server. Emits either human-readable
// text (default — readable in `docker compose logs`) or one JSON object per line
// (LOG_FORMAT=json) for ingestion by a log aggregator (Loki/ELK). It is a thin,
// dependency-free wrapper over console, written so it can never throw into a
// request path: a serialization failure degrades to a plain string instead of
// propagating.
//
// Config (all optional, behavior is unchanged from plain console.* when unset):
//   LOG_LEVEL   debug | info | warn | error   (default: info)
//   LOG_FORMAT  text | json                    (default: text)
//   LOG_SERVICE label put on every line        (default: web)

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SERVICE = process.env.LOG_SERVICE || 'web';
const THRESHOLD = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const AS_JSON = (process.env.LOG_FORMAT || 'text').toLowerCase() === 'json';

// An Error doesn't JSON-serialize usefully (message/stack are non-enumerable),
// so unwrap any Error — at the top level or nested in a field — to a plain object.
function normalizeFields(fields) {
  if (!fields) {
    return undefined;
  }
  if (fields instanceof Error) {
    return { err: { message: fields.message, stack: fields.stack } };
  }
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? { message: value.message, stack: value.stack } : value;
  }
  return out;
}

function emit(level, message, rawFields) {
  if (LEVELS[level] < THRESHOLD) {
    return;
  }
  const fields = normalizeFields(rawFields);
  const time = new Date().toISOString();
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (AS_JSON) {
    let line;
    try {
      line = JSON.stringify({ time, level, service: SERVICE, msg: String(message), ...fields });
    } catch {
      line = JSON.stringify({ time, level, service: SERVICE, msg: String(message) });
    }
    sink(line);
    return;
  }

  // Text mode: "<iso> LEVEL [service] message key=value ...", with any stack
  // appended on its own lines so it stays readable in a terminal.
  let suffix = '';
  let trailer = '';
  if (fields) {
    const parts = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }
      if (value && typeof value === 'object' && typeof value.stack === 'string') {
        parts.push(`${key}=${value.message}`);
        trailer += `\n${value.stack}`;
        continue;
      }
      parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    if (parts.length) {
      suffix = ` ${parts.join(' ')}`;
    }
  }
  sink(`${time} ${level.toUpperCase()} [${SERVICE}] ${message}${suffix}${trailer}`);
}

export const logger = {
  debug: (message, fields) => emit('debug', message, fields),
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};
