/**
 * legal-compliance.knowledge — compendio inline normative IT/EU + helpers puri.
 *
 * Separato da legal-compliance.ts per rispettare cap 250 righe per file (regola
 * "no monoliti" CLAUDE.md). Versionato manualmente quando normative cambiano.
 *
 * Token budget ~2.5k → entro safety margin per prompt 8k context Liara.
 */

export const LEGAL_KNOWLEDGE_INLINE = `
COMPENDIO NORMATIVE IT/EU (riferimento per citation):

GDPR (Reg. UE 2016/679):
- art.5 principi (liceità/correttezza/trasparenza/limitazione finalità/minimizzazione/esattezza/limitazione conservazione/integrità/responsabilizzazione)
- art.6 basi giuridiche (consenso/contratto/obbligo legale/interesse vitale/interesse pubblico/legittimo interesse)
- art.7 condizioni consenso (libero/specifico/informato/inequivocabile/revocabile)
- art.9 categorie particolari (dati salute/biometrici/genetici/orientamento religioso-politico)
- art.13/14 informativa (titolare/DPO/finalità/base giuridica/destinatari/trasferimenti/conservazione/diritti)
- art.15-22 diritti (accesso/rettifica/cancellazione/limitazione/portabilità/opposizione/no profilazione automatica)
- art.25 privacy by design/default
- art.28 responsabile trattamento (DPA contract)
- art.30 registro attività trattamento
- art.32 misure tecniche organizzative (pseudonimizzazione/cifratura/resilienza/disaster recovery/testing)
- art.33 notifica violazione Garante (72h)
- art.34 comunicazione violazione interessati
- art.35 DPIA (alto rischio: sistematic large-scale/categorie particolari/sorveglianza pubblica)
- art.37-39 DPO (obbligatorio: autorità pubblica/large-scale monitoring/categorie particolari)
- art.44-49 trasferimenti extra-UE (adeguatezza/SCC/BCR/deroghe specifiche)
- art.77-79 reclami Garante + ricorso giurisdizionale
- art.82 risarcimento danno
- art.83 sanzioni (max 20M€ o 4% fatturato globale)

eIDAS 2.0 (Reg. UE 910/2014 + amendments 2024):
- art.3 firma elettronica (semplice/avanzata/qualificata QES)
- art.25-27 firma elettronica qualificata (valore legale equivalente firma autografa)
- art.35-40 sigillo elettronico (persone giuridiche, integrità documenti)
- art.41-43 timestamp elettronico qualificato (prova data certa)
- art.45 service trust providers QTSP elenco AgID
- Nuovo (2024): European Digital Identity Wallet (EUDI Wallet)

AI Act (Reg. UE 2024/1689):
- art.5 pratiche vietate (social scoring/manipulation/biometric mass surveillance pubblico)
- art.6 sistemi alto rischio (Allegato III: educazione/lavoro/credit/giustizia/migration/critical infra)
- art.9-15 obblighi alto rischio (risk mgmt/data governance/technical documentation/log/transparency/human oversight/accuracy-robustness)
- art.50 trasparenza (deepfake/AI generated content disclosure)
- art.52 foundation models / GPAI (Generative purpose AI)
- art.99 sanzioni (max 35M€ o 7% fatturato globale per art.5 violations)
- Entrata vigore: 2 agosto 2026 obblighi alto rischio

DPR 445/2000 (conservazione documentale):
- art.43-44 conservazione digitale (firma + timestamp + indice)
- art.65 valore probatorio documento informatico

Codice Consumo (D.lgs. 206/2005):
- art.33 clausole vessatorie (presunzione vessatorietà in 18 ipotesi)
- art.49-52 informazioni precontrattuali B2C
- art.52-58 diritto di recesso 14gg (contratti distanza/fuori locali)
- art.130-135 garanzia legale conformità (24 mesi)

e-Privacy 2002/58/EC + D.Lgs 196/2003 art.122 IT:
- cookie tecnici (no consenso); analytics/profiling (consenso preventivo)
- marketing diretto (opt-in obbligatorio, granularità per categoria)
- soft opt-in art.7 D.lgs 70/2003 (cliente esistente, prodotto similar, opt-out facile)
`.trim();

export const SEVERITY_RANK: Record<string, number> = {
  critical: 4, high: 3, medium: 2, low: 1,
};

export interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  framework: string;
  article: string;
  title: string;
  excerpt: string;
  remediation: string;
}

export interface Recommendation {
  priority: 'P0' | 'P1' | 'P2';
  framework: string;
  action: string;
}

export const MIN_DOC_CHARS = 200;
export const MAX_DOC_CHARS = 200_000;
export const CHUNK_SIZE = 4000;
export const CHUNK_OVERLAP = 200;
export const MAX_CHUNKS = 50;

export function chunkDocument(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
    if (chunks.length >= MAX_CHUNKS) break; // anti-runaway
  }
  return chunks;
}

export function dedupFindings(all: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of all) {
    const key = `${f.framework}|${f.article}|${f.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  out.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
  return out;
}

export function applySeverityFloor(findings: Finding[], floor: string): Finding[] {
  const floorRank = SEVERITY_RANK[floor] ?? 2;
  return findings.filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= floorRank);
}

export function computeScore(findings: Finding[]): number {
  let score = 100;
  for (const f of findings) {
    score -= f.severity === 'critical' ? 25 : f.severity === 'high' ? 12 : f.severity === 'medium' ? 5 : 2;
  }
  return Math.max(0, Math.min(100, score));
}
