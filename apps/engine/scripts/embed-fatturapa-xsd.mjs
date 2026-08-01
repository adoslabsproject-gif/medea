/**
 * Genera `src/executors/sdi/fatturapa-xsd.generated.ts` embeddando i 2 XSD
 * ufficiali FatturaPA (vendored in src/executors/sdi/schemas/) come stringhe.
 *
 * PERCHÉ embeddare invece di leggere i file a runtime:
 *  - tsup bundla solo il JS → un .xsd su disco NON finirebbe nell'immagine senza
 *    un COPY nel Dockerfile (punto di rottura). Stringa nel bundle = zero Docker.
 *  - Validazione offline deterministica (nessuna dipendenza da rete/Agenzia).
 *
 * DUE TRASFORMAZIONI applicate durante l'embed (riproducibili, auditate qui):
 *  1. FatturaPA: lo `schemaLocation` dell'import xmldsig (URL W3C) → nome locale
 *     "xmldsig-core-schema.xsd", risolto da un input-provider IN-MEMORY a runtime.
 *  2. xmldsig: rimozione del blocco <!DOCTYPE ...> che referenzia una DTD ESTERNA
 *     W3C (XMLSchema.dtd) — altrimenti libxml2 tenterebbe di scaricarla online. Le
 *     entità dichiarate (&dsig; %p; %s;) sono NON usate nel corpo e xmlns:ds è già
 *     esplicito sul root → la rimozione è sicura (verificato).
 *
 * Sorgente di verità = i .xsd vendored (byte-identici al download ufficiale; vedi
 * schemas/README.md per URL+sha256). Esegui questo script SOLO quando aggiorni lo
 * schema; l'output generato è COMMITTATO (no build-time surprise, gate sul committed).
 *
 *   node scripts/embed-fatturapa-xsd.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, '..', 'src', 'executors', 'sdi', 'schemas');
const outFile = join(here, '..', 'src', 'executors', 'sdi', 'fatturapa-xsd.generated.ts');

const FATTURAPA = 'Schema_del_file_xml_FatturaPA_v1.2.2.xsd';
const XMLDSIG = 'xmldsig-core-schema.xsd';

const W3C_IMPORT = 'schemaLocation="http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd"';
const LOCAL_IMPORT = `schemaLocation="${XMLDSIG}"`;

let fatturapa = readFileSync(join(schemasDir, FATTURAPA), 'utf-8');
if (!fatturapa.includes(W3C_IMPORT)) {
  throw new Error(`embed-fatturapa-xsd: import W3C non trovato in ${FATTURAPA} (schema cambiato?)`);
}
fatturapa = fatturapa.replace(W3C_IMPORT, LOCAL_IMPORT);

let xmldsig = readFileSync(join(schemasDir, XMLDSIG), 'utf-8');
const docTypeRe = /<!DOCTYPE schema[\s\S]*?\]>\s*/m;
if (!docTypeRe.test(xmldsig)) {
  throw new Error('embed-fatturapa-xsd: <!DOCTYPE> non trovato in xmldsig (schema cambiato?)');
}
xmldsig = xmldsig.replace(docTypeRe, '');
if (xmldsig.includes('<!DOCTYPE')) throw new Error('embed-fatturapa-xsd: DOCTYPE residuo');

// JSON.stringify → escaping sicuro (niente backtick/${} injection nei template).
const banner = `/**
 * GENERATO da scripts/embed-fatturapa-xsd.mjs — NON modificare a mano.
 * Schema ufficiale FatturaPA v1.2.2 (Agenzia delle Entrate) + xmldsig-core (W3C),
 * trasformati per validazione XSD offline. Rigenera con: node scripts/embed-fatturapa-xsd.mjs
 */
/* eslint-disable */
// @ts-nocheck`;

const body = `${banner}
export const FATTURAPA_XSD_V122 = ${JSON.stringify(fatturapa)};
export const XMLDSIG_CORE_XSD = ${JSON.stringify(xmldsig)};
export const XMLDSIG_SCHEMA_FILENAME = ${JSON.stringify(XMLDSIG)};
`;

writeFileSync(outFile, body, 'utf-8');
console.log(`[embed-fatturapa-xsd] scritto ${outFile} (fatturapa ${fatturapa.length}B, xmldsig ${xmldsig.length}B)`);
