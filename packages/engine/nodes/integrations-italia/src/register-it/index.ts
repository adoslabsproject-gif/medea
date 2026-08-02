import type { NodeModule, NodeExecutor } from '@medea/engine-nodes-stdlib';
import { executeWithHostBreaker } from '@medea/engine-nodes-stdlib';
import { safeFetchWithRedirects, readJsonCapped, readTextTruncated } from '@medea/engine-safe-fetch';

const REGISTER_IT_API = 'https://api.register.it/v1';

const dnsExecutor: NodeExecutor = async (config, _input, _context) => {
  const startedAt = Date.now();
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';
  if (!apiKey) throw new Error('Register.it: missing apiKey');
  const domain = typeof config.domain === 'string' ? config.domain : '';
  if (!domain) throw new Error('Register.it: missing domain');
  const recordType = typeof config.recordType === 'string' ? config.recordType : 'A';
  const name = typeof config.name === 'string' ? config.name : '';
  const value = typeof config.value === 'string' ? config.value : '';
  const ttl = Number(config.ttl ?? 3600);

  // Gateway: per-host CB + safeFetchWithRedirects + 30s timeout (audit 2026-06-04).
  const url = `${REGISTER_IT_API}/domains/${encodeURIComponent(domain)}/dns/records`;
  const res = await executeWithHostBreaker(url, () =>
    safeFetchWithRedirects(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ type: recordType, name, value, ttl }),
      timeoutMs: 30_000,
    }),
  );
  if (!res.ok) {
    throw new Error(`Register.it ${String(res.status)}: ${(await readTextTruncated(res, 8192)).text.slice(0, 300)}`);
  }
  const body = (await readJsonCapped(res));
  return { output: body, durationMs: Date.now() - startedAt };
};

export const registerItDomain: NodeModule = {
  def: {
    id: 'italia_register_it_domain',
    type: 'action',
    label: 'Register.it: DNS Update',
    icon: 'globe',
    color: '#0ea5e9',
    description:
      'Crea un record DNS su un dominio gestito Register.it (REST API v1 + apiKey, POST /dns/records). ' +
      'Supporta record: A/AAAA/CNAME/MX/TXT/SRV/CAA. ' +
      'TTL configurabile (default 3600s). Output: la risposta JSON di Register.it (la shape dipende dall\'API; tipicamente include l\'id del record creato). ' +
      'Use case: switch dinamico IP A-record per failover infrastruttura, ' +
      'gestione automatica MX records post-migrazione mailbox, ' +
      'TXT record per verifica domain ownership (SPF/DKIM/DMARC), aggiornamento subdomain wildcard CNAME.',
    configFields: [
      { key: 'apiKey', label: 'Register.it API key', type: 'secret', required: true, help: 'Da pannello Register.it → API → "Crea chiave". Richiede attivazione del servizio API.' },
      { key: 'domain', label: 'Dominio', type: 'text', required: true, placeholder: 'esempio.it', help: 'Dominio gestito dal tuo account Register.it (senza www).' },
      {
        key: 'recordType',
        label: 'Tipo record DNS',
        type: 'select',
        required: true,
        options: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'],
        defaultValue: 'A',
        help: 'A = IPv4 · AAAA = IPv6 · CNAME = alias dominio · MX = mail server · TXT = SPF/DKIM/DMARC/verification · SRV = service location · CAA = autorità di certificazione autorizzate.',
      },
      { key: 'name', label: 'Nome record (host)', type: 'expression', required: true, placeholder: 'www  oppure  @  oppure  {{input.subdomain}}', help: '@ = dominio apex (esempio.it). Altrimenti subdomain (es. www, mail). Supporta {{espressioni}} per creazione dinamica (es. da nodo upstream).' },
      { key: 'value', label: 'Valore record', type: 'expression', required: true, placeholder: '{{input.serverIp}}', help: 'Formato dipende dal tipo: A=IPv4, AAAA=IPv6, CNAME=hostname, MX="priority host", TXT=stringa. Spesso dinamico (es. dopo provisioning server).' },
      { key: 'ttl', label: 'TTL (secondi)', type: 'number', required: false, defaultValue: '3600', help: 'Time-to-live cache DNS. 3600 = 1 ora (default). 300 = 5 min (per cambi frequenti). 86400 = 1 giorno.' },
    ],
    vendor: 'flowforge-italia',
    version: '0.2.0',
  },
  executor: dnsExecutor,
};
