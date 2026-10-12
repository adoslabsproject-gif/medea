/** I provider di posta per cui Medea conosce già host e porte. */

export type Preset = 'gmail' | 'outlook' | 'icloud' | 'yahoo' | 'aruba' | 'libero' | 'custom';

export interface PresetConfig {
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpImplicitTls: boolean;
  hint?: string;
  /**
   * Il provider non accetta la password dell'account da un programma di
   * posta: ne vuole una generata apposta.
   */
  vuolePasswordPerApp?: boolean;
}

export const PRESETS: Record<Preset, PresetConfig> = {
  gmail: {
    label: 'Gmail / Google Workspace',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpImplicitTls: true,
    hint: 'Richiede una App Password (Account Google → Sicurezza → Verifica in 2 passaggi → Password per le app). Non funziona con la password normale.',
    vuolePasswordPerApp: true,
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpImplicitTls: false,
    hint: 'Outlook spesso richiede OAuth (in arrivo in Fase 4). Per ora alcuni account funzionano con App Password.',
  },
  icloud: {
    label: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    smtpImplicitTls: false,
    hint: 'Richiede una password specifica per app generata su appleid.apple.com → Accesso e sicurezza.',
    vuolePasswordPerApp: true,
  },
  yahoo: {
    label: 'Yahoo Mail',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    smtpImplicitTls: true,
    hint: 'Richiede una password app generata nelle impostazioni di sicurezza Yahoo.',
    vuolePasswordPerApp: true,
  },
  aruba: {
    label: 'Aruba',
    imapHost: 'imaps.aruba.it',
    imapPort: 993,
    smtpHost: 'smtps.aruba.it',
    smtpPort: 465,
    smtpImplicitTls: true,
  },
  libero: {
    label: 'Libero / Virgilio',
    imapHost: 'imapmail.libero.it',
    imapPort: 993,
    smtpHost: 'smtp.libero.it',
    smtpPort: 465,
    smtpImplicitTls: true,
  },
  custom: {
    label: 'Personalizzato (server tuo / aziendale)',
    imapHost: '',
    imapPort: 993,
    smtpHost: '',
    smtpPort: 587,
    smtpImplicitTls: false,
    hint: 'Inserisci host/porta esatti del tuo provider. IMAP standard: 993 (TLS). SMTP standard: 587 (STARTTLS) o 465 (implicit TLS).',
  },
};
