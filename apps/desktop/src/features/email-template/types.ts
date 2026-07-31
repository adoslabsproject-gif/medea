/** Carta intestata applicata ai messaggi in uscita (nuovi e risposte). */
export interface EmailTemplate {
  id: number;
  name: string;
  isDefault: boolean;
  /** Logo come data URL — viaggia dentro l'HTML, nessun file esterno. */
  logoDataUrl: string | null;
  headerTitle: string | null;
  headerSubtitle: string | null;
  footerHtml: string | null;
  accentColor: string;
  /** HTML completo con `{{BODY}}`; se assente si usa il layout generato. */
  customHtml: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailTemplateInput {
  id?: number | null;
  name: string;
  isDefault: boolean;
  logoDataUrl: string | null;
  headerTitle: string | null;
  headerSubtitle: string | null;
  footerHtml: string | null;
  accentColor: string;
  customHtml: string | null;
}

/* eslint-disable no-restricted-syntax -- colore di default della carta intestata:
   finisce nell'HTML dell'email, dove i token CSS non esistono. */
export const EMPTY_TEMPLATE: EmailTemplateInput = {
  name: 'Carta intestata',
  isDefault: true,
  logoDataUrl: null,
  headerTitle: null,
  headerSubtitle: null,
  footerHtml: null,
  accentColor: '#4f46e5',
  customHtml: null,
};
/* eslint-enable no-restricted-syntax */

/** Segnaposto sostituiti al momento dell'invio. */
export const PLACEHOLDERS = {
  body: '{{BODY}}',
  logo: '{{LOGO}}',
  signature: '{{SIGNATURE}}',
  senderName: '{{MITTENTE}}',
  companyName: '{{AZIENDA}}',
} as const;
