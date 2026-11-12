// Redaction of common credential shapes, applied to anything stored in telemetry or shown to
// the model. Deterministic patterns only; it reduces accidental leaks, it is not a guarantee.
const PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]',
  ],
  [/(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi, '$1[REDACTED]'],
  [
    /(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret)(["'\s:=]+)[^\s,"'}]+/gi,
    '$1$2[REDACTED]',
  ],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[REDACTED]@'],
];

export function redact(value: string): string {
  return PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}
