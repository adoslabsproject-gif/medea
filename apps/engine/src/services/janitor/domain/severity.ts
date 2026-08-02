/**
 * Domain — CorruptionSeverity.
 *
 * Wrapper tipato attorno a 'critical' | 'warning' con helpers per ordinamento
 * e UI label. Federico-grade: severity non è una stringa primitive sparsa
 * nel codebase — è un Value Object con semantica.
 */

export const SEVERITIES = ['critical', 'warning'] as const;

export type CorruptionSeverity = (typeof SEVERITIES)[number];

const SEVERITY_RANK: Readonly<Record<CorruptionSeverity, number>> = Object.freeze({
  critical: 2,
  warning: 1,
});

const SEVERITY_LABEL_IT: Readonly<Record<CorruptionSeverity, string>> = Object.freeze({
  critical: 'Critica',
  warning: 'Avviso',
});

const SEVERITY_HEX: Readonly<Record<CorruptionSeverity, string>> = Object.freeze({
  critical: '#dc2626', // red-600 (Tailwind danger)
  warning: '#d97706', // amber-600 (Tailwind warning)
});

export function isSeverity(value: unknown): value is CorruptionSeverity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

/** Compara due severity: ritorna positivo se `a` > `b`, neg se `<`, 0 se uguali. */
export function compareSeverity(a: CorruptionSeverity, b: CorruptionSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

/** Massima severity tra un insieme — utile per "header status" di un report. */
export function maxSeverity(severities: readonly CorruptionSeverity[]): CorruptionSeverity | null {
  if (severities.length === 0) return null;
  return severities.reduce<CorruptionSeverity>(
    (acc, s) => (compareSeverity(s, acc) > 0 ? s : acc),
    severities[0]!,
  );
}

export function severityLabel(s: CorruptionSeverity): string {
  return SEVERITY_LABEL_IT[s];
}

export function severityColor(s: CorruptionSeverity): string {
  return SEVERITY_HEX[s];
}
