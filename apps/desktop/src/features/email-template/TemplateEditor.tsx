import { Button, TextField } from '@medea/ui';
import { useEffect, useState } from 'react';

import { templateApi } from './api';
import { previewTemplate } from './render';
import type { SenderInfo } from './render';
import styles from './TemplateEditor.module.css';
import type { EmailTemplate, EmailTemplateInput } from './types';
import { EMPTY_TEMPLATE, PLACEHOLDERS } from './types';

const LOGO_MAX_BYTES = 300 * 1024;

interface Props {
  sender: SenderInfo;
}

function toTemplate(input: EmailTemplateInput): EmailTemplate {
  return {
    id: input.id ?? 0,
    name: input.name,
    isDefault: input.isDefault,
    logoDataUrl: input.logoDataUrl,
    headerTitle: input.headerTitle,
    headerSubtitle: input.headerSubtitle,
    footerHtml: input.footerHtml,
    accentColor: input.accentColor,
    customHtml: input.customHtml,
    createdAt: '',
    updatedAt: '',
  };
}

/** Editor della carta intestata: logo, intestazione, piè di pagina, colore. */
export function TemplateEditor({ sender }: Props) {
  const [draft, setDraft] = useState<EmailTemplateInput>(EMPTY_TEMPLATE);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    templateApi.getDefault()
      .then((t) => {
        if (!t) return;
        setDraft({
          id: t.id,
          name: t.name,
          isDefault: t.isDefault,
          logoDataUrl: t.logoDataUrl,
          headerTitle: t.headerTitle,
          headerSubtitle: t.headerSubtitle,
          footerHtml: t.footerHtml,
          accentColor: t.accentColor,
          customHtml: t.customHtml,
        });
        setAdvanced(Boolean(t.customHtml?.trim()));
      })
      .catch((e: unknown) => { setError(String(e)); });
  }, []);

  function onLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > LOGO_MAX_BYTES) {
      setError('Logo troppo grande (max 300 KB): viene incorporato in ogni email.');
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      setDraft((d) => ({ ...d, logoDataUrl: typeof r.result === 'string' ? r.result : null }));
      setError(null);
    };
    r.readAsDataURL(f);
  }

  async function save() {
    setError(null);
    try {
      const id = await templateApi.upsert({ ...draft, isDefault: true });
      setDraft((d) => ({ ...d, id }));
      setSaved(true);
      setTimeout(() => { setSaved(false); }, 1500);
    } catch (e) {
      setError(String(e));
    }
  }

  const preview = previewTemplate(toTemplate(draft), sender);

  return (
    <div className={styles.root}>
      <div className={styles.form}>
        <TextField
          label="Nome template"
          value={draft.name}
          onChange={(e) => { setDraft({ ...draft, name: e.target.value }); }}
          fullWidth
        />

        <div className={styles.logoRow}>
          <div className={styles.logoBox}>
            {draft.logoDataUrl
              ? <img src={draft.logoDataUrl} alt="Logo" />
              : <span className={styles.logoEmpty}>nessun logo</span>}
          </div>
          <div className={styles.logoActions}>
            <label className={styles.fileBtn}>
              {draft.logoDataUrl ? 'Cambia logo' : 'Carica logo'}
              <input type="file" accept="image/*" onChange={onLogo} hidden />
            </label>
            {draft.logoDataUrl && (
              <Button variant="ghost" size="sm"
                onClick={() => { setDraft({ ...draft, logoDataUrl: null }); }}>
                Rimuovi
              </Button>
            )}
            <p className={styles.hint}>
              PNG/JPG, max 300 KB. Viene incorporato nell&apos;email come immagine
              interna: si vede anche senza connessione e non è un tracker.
            </p>
          </div>
        </div>

        <TextField
          label="Titolo intestazione"
          value={draft.headerTitle ?? ''}
          onChange={(e) => { setDraft({ ...draft, headerTitle: e.target.value || null }); }}
          placeholder={sender.organizationName || 'Nome azienda'}
          fullWidth
        />
        <TextField
          label="Sottotitolo"
          value={draft.headerSubtitle ?? ''}
          onChange={(e) => { setDraft({ ...draft, headerSubtitle: e.target.value || null }); }}
          placeholder="es. Soluzioni industriali dal 1980"
          fullWidth
        />

        <label className={styles.colorRow}>
          <span>Colore linea/accento</span>
          <input
            type="color"
            value={draft.accentColor}
            onChange={(e) => { setDraft({ ...draft, accentColor: e.target.value }); }}
          />
          <code>{draft.accentColor}</code>
        </label>

        <label className={styles.textareaLabel}>
          <span>Piè di pagina (HTML)</span>
          <textarea
            rows={3}
            className={styles.textarea}
            value={draft.footerHtml ?? ''}
            onChange={(e) => { setDraft({ ...draft, footerHtml: e.target.value || null }); }}
            placeholder="Ragione sociale · P.IVA · indirizzo · telefono"
          />
        </label>

        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={advanced}
            onChange={(e) => {
              setAdvanced(e.target.checked);
              if (!e.target.checked) setDraft((d) => ({ ...d, customHtml: null }));
            }}
          />
          <span>HTML personalizzato (sostituisce il layout predefinito)</span>
        </label>

        {advanced && (
          <label className={styles.textareaLabel}>
            <span>
              HTML — usa {PLACEHOLDERS.body} per il corpo, {PLACEHOLDERS.signature} per la
              firma, {PLACEHOLDERS.logo}, {PLACEHOLDERS.companyName}, {PLACEHOLDERS.senderName}
            </span>
            <textarea
              rows={12}
              className={`${styles.textarea} ${styles.mono}`}
              value={draft.customHtml ?? ''}
              onChange={(e) => { setDraft({ ...draft, customHtml: e.target.value || null }); }}
              placeholder="<table>…{{BODY}}…</table>"
            />
          </label>
        )}

        {error && <p className={styles.error}>❌ {error}</p>}

        <div className={styles.actions}>
          <Button variant="solid" onClick={() => { void save(); }}>
            {saved ? '✓ Template salvato' : '💾 Salva template'}
          </Button>
        </div>
        <p className={styles.hint}>
          Il template viene applicato ai messaggi nuovi e alle risposte. Nel Composer
          puoi disattivarlo per il singolo messaggio.
        </p>
      </div>

      <div className={styles.previewCol}>
        <div className={styles.previewLabel}>Anteprima</div>
        <iframe title="Anteprima template" srcDoc={preview} sandbox="" className={styles.preview} />
      </div>
    </div>
  );
}
