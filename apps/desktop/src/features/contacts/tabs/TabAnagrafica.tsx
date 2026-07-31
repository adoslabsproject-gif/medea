import { useEffect, useMemo, useState } from 'react';

import { mailApi } from '../../mail/api';
import type { OrganizationDetail, OrganizationUpdateFull, ShippingTerms } from '../../mail/types';
import { SHIPPING_TERMS_OPTIONS } from '../types';

import styles from './shared.module.css';
import own from './TabAnagrafica.module.css';

interface Props { partner: OrganizationDetail; onSaved?: () => void; }

function detailToForm(p: OrganizationDetail): OrganizationUpdateFull {
  return {
    id: p.id,
    displayName: p.displayName,
    vatNumber: p.vatNumber,
    address: p.address,
    phone: p.phone,
    website: p.website,
    notes: p.notes,
    isClient: p.isClient,
    isSupplier: p.isSupplier,
    taxCode: p.taxCode,
    sdiCode: p.sdiCode,
    pec: p.pec,
    iban: p.iban,
    bankName: p.bankName,
    streetAddress: p.streetAddress,
    city: p.city,
    postalCode: p.postalCode,
    province: p.province,
    countryIso2: p.countryIso2,
    preferredCourier: p.preferredCourier,
    paymentTerms: p.paymentTerms,
    shippingTerms: p.shippingTerms,
    preferredLanguage: p.preferredLanguage,
    emailAddress: p.emailAddress,
  };
}

export function TabAnagrafica({ partner, onSaved }: Props) {
  const [form, setForm] = useState<OrganizationUpdateFull>(() => detailToForm(partner));
  const [pristine, setPristine] = useState<OrganizationUpdateFull>(() => detailToForm(partner));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    const next = detailToForm(partner);
    setForm(next);
    setPristine(next);
  }, [partner.id, partner.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(pristine), [form, pristine]);

  function set<K extends keyof OrganizationUpdateFull>(k: K, v: OrganizationUpdateFull[K]) {
    setForm({ ...form, [k]: v });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await mailApi.db.organizationUpdate(form);
      setPristine(form);
      setSavedFlash(true);
      setTimeout(() => { setSavedFlash(false); }, 1500);
      onSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setForm(pristine);
    setError(null);
  }

  return (
    <div className={own.wrap}>
      <div className={own.grid}>

        <Section title="Identità">
          <Field label="Ragione sociale">
            <input className={own.input} value={form.displayName ?? ''}
              onChange={(e) => { set('displayName', e.target.value || null); }} />
          </Field>
          <Field label="Dominio email" hint="non modificabile">
            <input className={own.input} value={partner.domain} disabled />
          </Field>
          <Field label="Email ufficio">
            <input className={own.input} type="email" value={form.emailAddress ?? ''}
              placeholder="info@…"
              onChange={(e) => { set('emailAddress', e.target.value || null); }} />
          </Field>
          <Field label="Telefono">
            <input className={own.input} value={form.phone ?? ''}
              placeholder="+39 …"
              onChange={(e) => { set('phone', e.target.value || null); }} />
          </Field>
          <Field label="Sito web">
            <input className={own.input} type="url" value={form.website ?? ''}
              placeholder="https://…"
              onChange={(e) => { set('website', e.target.value || null); }} />
          </Field>
          <Field label="Lingua preferita">
            <input className={own.input} maxLength={5} value={form.preferredLanguage ?? ''}
              placeholder="it / en / de…"
              onChange={(e) => { set('preferredLanguage', e.target.value || null); }} />
          </Field>
        </Section>

        <Section title="Dati fiscali">
          <Field label="Partita IVA">
            <input className={own.input} value={form.vatNumber ?? ''}
              onChange={(e) => { set('vatNumber', e.target.value || null); }} />
          </Field>
          <Field label="Codice fiscale">
            <input className={own.input} value={form.taxCode ?? ''}
              onChange={(e) => { set('taxCode', e.target.value || null); }} />
          </Field>
          <Field label="Codice SDI">
            <input className={own.input} maxLength={7} value={form.sdiCode ?? ''}
              placeholder="7 caratteri"
              onChange={(e) => { set('sdiCode', e.target.value || null); }} />
          </Field>
          <Field label="PEC">
            <input className={own.input} type="email" value={form.pec ?? ''}
              onChange={(e) => { set('pec', e.target.value || null); }} />
          </Field>
        </Section>

        <Section title="Sede / Indirizzo">
          <Field label="Via e numero">
            <input className={own.input} value={form.streetAddress ?? ''}
              onChange={(e) => { set('streetAddress', e.target.value || null); }} />
          </Field>
          <div className={own.row3}>
            <Field label="CAP">
              <input className={own.input} maxLength={10} value={form.postalCode ?? ''}
                onChange={(e) => { set('postalCode', e.target.value || null); }} />
            </Field>
            <Field label="Città">
              <input className={own.input} value={form.city ?? ''}
                onChange={(e) => { set('city', e.target.value || null); }} />
            </Field>
            <Field label="Prov.">
              <input className={own.input} maxLength={3} value={form.province ?? ''}
                onChange={(e) => { set('province', (e.target.value || '').toUpperCase() || null); }} />
            </Field>
          </div>
          <Field label="Paese (ISO-2)">
            <input className={own.input} maxLength={2} value={form.countryIso2 ?? ''}
              placeholder="IT"
              onChange={(e) => { set('countryIso2', (e.target.value || '').toUpperCase() || null); }} />
          </Field>
        </Section>

        <Section title="Banca">
          <Field label="IBAN">
            <input className={own.input} value={form.iban ?? ''}
              onChange={(e) => { set('iban', e.target.value || null); }} />
          </Field>
          <Field label="Banca">
            <input className={own.input} value={form.bankName ?? ''}
              onChange={(e) => { set('bankName', e.target.value || null); }} />
          </Field>
        </Section>

        <Section title="Default operativi">
          <Field label="Corriere abituale">
            <input className={own.input} value={form.preferredCourier ?? ''}
              placeholder="DHL / GLS / BRT / Mittente"
              onChange={(e) => { set('preferredCourier', e.target.value || null); }} />
          </Field>
          <Field label="Termini pagamento">
            <input className={own.input} value={form.paymentTerms ?? ''}
              placeholder="es. BB 60gg DF"
              onChange={(e) => { set('paymentTerms', e.target.value || null); }} />
          </Field>
          <Field label="Porto">
            <select
              className={own.input}
              value={form.shippingTerms ?? ''}
              onChange={(e) => { set('shippingTerms', (e.target.value || null) as ShippingTerms | null); }}
            >
              <option value="">— non impostato —</option>
              {SHIPPING_TERMS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
        </Section>

      </div>

      {error && <div className={own.errorBox}>❌ {error}</div>}

      <footer className={`${own.saveBar} ${dirty ? own.saveBarDirty : ''}`}>
        <div className={own.saveStatus}>
          {savedFlash && '✓ Modifiche salvate'}
          {!savedFlash && dirty && <span className={own.dot}>● Modifiche non salvate</span>}
          {!savedFlash && !dirty && <span className={own.muted}>Nessuna modifica</span>}
        </div>
        <div className={own.saveActions}>
          <button
            type="button"
            className={styles.smallBtn}
            onClick={discard}
            disabled={!dirty || saving}
          >Annulla</button>
          <button
            type="button"
            className={`${styles.smallBtn} ${own.btnPrimary}`}
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? 'Salvataggio…' : '💾 Salva scheda'}
          </button>
        </div>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={own.section}>
      <h3 className={own.sectionTitle}>{title}</h3>
      <div className={own.sectionBody}>{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className={own.field}>
      <span className={own.fieldLabel}>
        {label}
        {hint && <span className={own.fieldHint}> · {hint}</span>}
      </span>
      {children}
    </label>
  );
}
