# Schemi XSD ufficiali FatturaPA — vendored

Questi file sono **copie byte-identiche** degli schemi ufficiali, vendorati per la
validazione XSD **offline** della fattura elettronica prima dell'invio al SdI
(nodo `italia_sdi_send_invoice`). Sorgente di verità per `../fatturapa-xsd.generated.ts`
(generato da `scripts/embed-fatturapa-xsd.mjs`, che applica 2 trasformazioni per
l'uso offline — vedi commento dello script).

| File                                       | Origine                                                                                                                          | Versione     | sha256                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------ |
| `Schema_del_file_xml_FatturaPA_v1.2.2.xsd` | [Agenzia delle Entrate](https://www.fatturapa.gov.it/export/documenti/fatturapa/v1.2.2/Schema_del_file_xml_FatturaPA_v1.2.2.xsd) | 1.2.2        | `cedaeece91d7a5334960143f0735ee020e6e94f33685b512f5899eb85c507e18` |
| `xmldsig-core-schema.xsd`                  | [W3C XML-Signature](https://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd)                                | REC-20020212 | `35cf8197da812c85e40d57891b35c94187569ed474a2dac813ce5090dafcd35c` |

## Aggiornamento dello schema

1. Scarica il nuovo `.xsd` ufficiale, sostituisci il file qui, aggiorna la tabella
   (versione + sha256 da `shasum -a 256 <file>`).
2. Rigenera l'embedded: `node scripts/embed-fatturapa-xsd.mjs`.
3. Aggiorna i test (`../xsd-validator.test.ts`) con una fattura ufficiale valida
   della nuova versione.

⚠️ NON modificare questi file a mano: l'integrità (sha256 vs Agenzia) è la garanzia
che la validazione corrisponde allo schema reale.
