/**
 * italia_fatturapa_parse — XML FatturaPA → JSON tipizzato.
 *
 * Copre il contratto del NodeDef (outputContract anti-drift) + bug-bounty:
 * ditta individuale (Nome+Cognome), lotto multi-body, campi assenti → null,
 * XML rotto, radice sbagliata, chain diretta da italia_p7m_extract.
 */
import { describe, it, expect } from 'vitest';
import { parseFatturaPa, fatturapaParseExecutor } from './fatturapa-parse.js';
import type { NodeExecutionContext } from '@flowforge/nodes-stdlib';

const ctx = { tenantId: 't1', runId: 'r1', nodeId: 'n1' } as unknown as NodeExecutionContext;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"><FatturaElettronicaHeader><DatiTrasmissione><IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>01234567890</IdCodice></IdTrasmittente><ProgressivoInvio>00001</ProgressivoInvio><FormatoTrasmissione>FPR12</FormatoTrasmissione><CodiceDestinatario>ABCDEFG</CodiceDestinatario></DatiTrasmissione><CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>01234567890</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Fornitore Test SRL</Denominazione></Anagrafica><RegimeFiscale>RF01</RegimeFiscale></DatiAnagrafici></CedentePrestatore><CessionarioCommittente><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>09876543210</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Zeli SRL</Denominazione></Anagrafica></DatiAnagrafici></CessionarioCommittente></FatturaElettronicaHeader><FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>2026-07-01</Data><Numero>142/A</Numero><ImportoTotaleDocumento>1830.00</ImportoTotaleDocumento></DatiGeneraliDocumento></DatiGenerali><DatiBeniServizi><DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Servizio hosting annuale</Descrizione><Quantita>1.00</Quantita><PrezzoUnitario>1000.00</PrezzoUnitario><PrezzoTotale>1000.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee><DettaglioLinee><NumeroLinea>2</NumeroLinea><Descrizione>Assistenza tecnica</Descrizione><Quantita>10.00</Quantita><PrezzoUnitario>50.00</PrezzoUnitario><PrezzoTotale>500.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee><DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>1500.00</ImponibileImporto><Imposta>330.00</Imposta><EsigibilitaIVA>I</EsigibilitaIVA></DatiRiepilogo></DatiBeniServizi><DatiPagamento><CondizioniPagamento>TP02</CondizioniPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>2026-08-31</DataScadenzaPagamento><ImportoPagamento>1830.00</ImportoPagamento></DettaglioPagamento></DatiPagamento></FatturaElettronicaBody></p:FatturaElettronica>`;

describe('parseFatturaPa — estrazione completa', () => {
  it('testata: cedente/cessionario con P.IVA composta, formato, numero, data, totale', () => {
    const [f] = parseFatturaPa(XML);
    expect(f).toBeDefined();
    expect(f!.formato).toBe('FPR12');
    expect(f!.cedente).toEqual({ denominazione: 'Fornitore Test SRL', partitaIva: 'IT01234567890', codiceFiscale: null });
    expect(f!.cessionario.denominazione).toBe('Zeli SRL');
    expect(f!.tipoDocumento).toBe('TD01');
    expect(f!.numero).toBe('142/A');
    expect(f!.data).toBe('2026-07-01');
    expect(f!.importoTotaleDocumento).toBe(1830);
    expect(f!.codiceDestinatario).toBe('ABCDEFG');
  });

  it('righe ESATTE: 2 linee con quantità, prezzi e aliquote numerici', () => {
    const [f] = parseFatturaPa(XML);
    expect(f!.righe).toHaveLength(2);
    expect(f!.righe[0]).toEqual({
      numeroLinea: 1, descrizione: 'Servizio hosting annuale',
      quantita: 1, prezzoUnitario: 1000, prezzoTotale: 1000, aliquotaIva: 22,
    });
    expect(f!.righe[1]!.prezzoTotale).toBe(500);
  });

  it('riepilogo IVA + scadenze di pagamento', () => {
    const [f] = parseFatturaPa(XML);
    expect(f!.riepilogoIva).toEqual([{ aliquota: 22, imponibile: 1500, imposta: 330 }]);
    expect(f!.scadenze).toEqual([{ modalitaPagamento: 'MP05', dataScadenza: '2026-08-31', importo: 1830 }]);
  });

  it('ditta individuale: Nome+Cognome al posto della Denominazione', () => {
    const xml = XML.replace(
      '<Anagrafica><Denominazione>Fornitore Test SRL</Denominazione></Anagrafica>',
      '<Anagrafica><Nome>Mario</Nome><Cognome>Rossi</Cognome></Anagrafica>',
    );
    const [f] = parseFatturaPa(xml);
    expect(f!.cedente.denominazione).toBe('Mario Rossi');
  });

  it('lotto: 2 FatturaElettronicaBody → 2 elementi con testata condivisa', () => {
    const body = XML.slice(XML.indexOf('<FatturaElettronicaBody>'), XML.indexOf('</p:FatturaElettronica>'));
    const doppio = XML.replace('</p:FatturaElettronica>', body.replace('142/A', '143/A') + '</p:FatturaElettronica>');
    const fatture = parseFatturaPa(doppio);
    expect(fatture).toHaveLength(2);
    expect(fatture[0]!.numero).toBe('142/A');
    expect(fatture[1]!.numero).toBe('143/A');
    expect(fatture[1]!.cedente.denominazione).toBe('Fornitore Test SRL');
  });

  it('🚨 campi assenti → null, MAI stringhe inventate', () => {
    const xml = XML.replace('<ImportoTotaleDocumento>1830.00</ImportoTotaleDocumento>', '')
      .replace('<DatiPagamento><CondizioniPagamento>TP02</CondizioniPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>2026-08-31</DataScadenzaPagamento><ImportoPagamento>1830.00</ImportoPagamento></DettaglioPagamento></DatiPagamento>', '');
    const [f] = parseFatturaPa(xml);
    expect(f!.importoTotaleDocumento).toBeNull();
    expect(f!.scadenze).toEqual([]);
  });

  it('🚨 XML rotto → errore actionable', () => {
    expect(() => parseFatturaPa('<p:FatturaElettronica><senza-chiusura')).toThrow(/XML non parsabile/u);
  });

  it('🚨 radice diversa → errore che la nomina (no output vuoto silenzioso)', () => {
    expect(() => parseFatturaPa('<?xml version="1.0"?><Ordine><x/></Ordine>')).toThrow(/non è una FatturaElettronica/u);
  });
});

describe('fatturapaParseExecutor', () => {
  it('config.xml → { fatture, count }', async () => {
    const res = await fatturapaParseExecutor({ xml: XML }, null, ctx);
    const out = res.output as { fatture: unknown[]; count: number };
    expect(out.count).toBe(1);
    expect(out.fatture).toHaveLength(1);
  });

  it('chain diretta: input.content da italia_p7m_extract quando config vuota', async () => {
    const res = await fatturapaParseExecutor({}, { content: XML }, ctx);
    expect((res.output as { count: number }).count).toBe(1);
  });

  it('validateXsd on → campo xsd presente con esito (la fixture minimale NON è conforme: mancano campi obbligatori)', async () => {
    const res = await fatturapaParseExecutor({ xml: XML, validateXsd: 'true' }, null, ctx);
    const out = res.output as { xsd?: { valid: boolean; errors: string[] } };
    expect(out.xsd).toBeDefined();
    expect(typeof out.xsd!.valid).toBe('boolean');
  });

  it('🚨 nessun XML → errore che spiega la chain', async () => {
    await expect(fatturapaParseExecutor({}, null, ctx)).rejects.toThrow(/concatena italia_p7m_extract|campo "xml"/u);
  });
});
