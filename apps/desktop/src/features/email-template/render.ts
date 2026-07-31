/**
 * Applica la carta intestata al corpo di un messaggio in uscita.
 *
 * Vincoli email-client (non negoziabili, Outlook/Gmail sono del 2003):
 * niente CSS esterno, niente flex/grid, layout a `<table>`, stili inline,
 * immagini come data URL.
 */

/* eslint-disable no-restricted-syntax -- questo HTML viaggia nella casella del
   destinatario: le custom property del design system non esistono lì, servono
   colori letterali. È l'unica eccezione consentita alla regola. */

import type { EmailTemplate } from './types';
import { PLACEHOLDERS } from './types';

export interface SenderInfo {
  displayName: string;
  organizationName: string;
  emailAddress: string;
  signatureHtml: string;
}

/** Testo semplice → HTML: escape + a capo preservati. */
export function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br />');
}

/** HTML → testo leggibile, per la parte `text/plain` del multipart. */
export function htmlToText(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n');
  return (div.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Layout predefinito quando il template non ha HTML personalizzato. */
function defaultLayout(t: EmailTemplate, sender: SenderInfo): string {
  const accent = t.accentColor || '#4f46e5';
  const logo = t.logoDataUrl
    ? `<img src="${t.logoDataUrl}" alt="" style="max-height:56px;max-width:240px;display:block;border:0;" />`
    : '';
  const title = t.headerTitle ?? sender.organizationName;
  const subtitle = t.headerSubtitle ?? '';
  const footer = t.footerHtml ?? '';

  const header = logo || title
    ? `<tr><td style="padding:20px 24px;border-bottom:3px solid ${accent};">
         ${logo}
         ${title ? `<div style="font-size:17px;font-weight:700;color:#111827;margin-top:${logo ? '10px' : '0'};">${title}</div>` : ''}
         ${subtitle ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">${subtitle}</div>` : ''}
       </td></tr>`
    : '';

  const foot = footer
    ? `<tr><td style="padding:14px 24px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280;line-height:1.5;">${footer}</td></tr>`
    : '';

  return `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:20px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0"
             style="width:640px;max-width:96%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
        ${header}
        <tr><td style="padding:24px;font-size:14px;line-height:1.6;color:#111827;">
          ${PLACEHOLDERS.body}
          ${PLACEHOLDERS.signature}
        </td></tr>
        ${foot}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Compone l'HTML finale del messaggio. `bodyHtml` è il corpo già in HTML
 * (usa `textToHtml` se parti dal testo semplice).
 */
export function applyTemplate(
  template: EmailTemplate | null,
  bodyHtml: string,
  sender: SenderInfo,
): string {
  if (!template) {
    // Nessun template: corpo + firma, senza impaginazione.
    return sender.signatureHtml
      ? `<div>${bodyHtml}</div><br />${sender.signatureHtml}`
      : `<div>${bodyHtml}</div>`;
  }
  const skeleton = template.customHtml?.trim()
    ? template.customHtml
    : defaultLayout(template, sender);

  const signatureBlock = sender.signatureHtml
    ? `<div style="margin-top:18px;">${sender.signatureHtml}</div>`
    : '';

  return skeleton
    .split(PLACEHOLDERS.body).join(bodyHtml)
    .split(PLACEHOLDERS.signature).join(signatureBlock)
    .split(PLACEHOLDERS.logo).join(
      template.logoDataUrl
        ? `<img src="${template.logoDataUrl}" alt="" style="max-height:56px;border:0;" />`
        : '',
    )
    .split(PLACEHOLDERS.senderName).join(sender.displayName)
    .split(PLACEHOLDERS.companyName).join(sender.organizationName);
}

/** Anteprima con un corpo di esempio, per l'editor. */
export function previewTemplate(template: EmailTemplate, sender: SenderInfo): string {
  const sample = textToHtml(
    'Buongiorno,\n\nquesto è un esempio di come apparirà il messaggio ai destinatari.\n\nCordiali saluti',
  );
  return applyTemplate(template, sample, sender);
}
