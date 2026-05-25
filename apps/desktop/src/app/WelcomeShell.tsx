import { useState } from 'react';

import { Button, Dialog, Select, TextField, Tooltip } from '@medea/ui';

import styles from './WelcomeShell.module.css';
import { useTheme } from './providers/ThemeProvider';
import type { ThemeMode } from './providers/ThemeProvider';

export function WelcomeShell() {
  const { theme, setTheme } = useTheme();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');

  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="welcome-title">
        <div className={styles.heroRow}>
          <span className={styles.glyph} aria-hidden>
            M
          </span>
          <div>
            <h1 id="welcome-title" className={styles.title}>
              Medea
            </h1>
            <p className={styles.subtitle}>
              Personal operational memory system — Fase 0 in piedi.
            </p>
          </div>
        </div>

        <p className={styles.meta}>
          design-system · ui (5 primitivi) · Tauri shell · pnpm + Turborepo · OKLCH +{' '}
          <code>light-dark()</code>
        </p>

        <div className={styles.stack}>
          <TextField
            label="Il tuo nome"
            placeholder="Es. Nicola"
            value={name}
            onChange={(e) => { setName(e.target.value); }}
            hint="Solo locale, mai inviato altrove."
            fullWidth
          />

          <Select
            label="Tema"
            value={theme}
            onChange={(e) => { setTheme(e.target.value as ThemeMode); }}
            items={[
              { value: 'system', label: 'Segui sistema' },
              { value: 'light', label: 'Chiaro' },
              { value: 'dark', label: 'Scuro' },
              { value: 'hc', label: 'Alto contrasto' },
            ]}
            fullWidth
          />

          <div className={styles.row}>
            <Tooltip label="Mostra il dialog di benvenuto" placement="top">
              <Button variant="solid" onClick={() => { setDialogOpen(true); }}>
                Apri dialog
              </Button>
            </Tooltip>
            <Button variant="soft">Azione secondaria</Button>
            <Button variant="outline">Bordata</Button>
            <Button variant="ghost">Ghost</Button>
          </div>
        </div>
      </section>

      <Dialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); }}
        title="Benvenuto in Medea"
        description="Fase 0 dello scaffold completata."
        footer={
          <>
            <Button variant="ghost" onClick={() => { setDialogOpen(false); }}>
              Chiudi
            </Button>
            <Button variant="solid" onClick={() => { setDialogOpen(false); }}>
              Tutto chiaro
            </Button>
          </>
        }
      >
        <p>
          Ciao{name ? ` ${name}` : ''}. Stai vedendo il design system OKLCH attivo, i 5 primitivi UI
          (Button, TextField, Select, Tooltip, Dialog) e la shell Tauri.
        </p>
        <p style={{ marginTop: 'var(--space-3)', color: 'var(--color-text-secondary)' }}>
          Il prossimo passo è la Fase 1: <code>mail-core</code> in Rust.
        </p>
      </Dialog>
    </main>
  );
}
