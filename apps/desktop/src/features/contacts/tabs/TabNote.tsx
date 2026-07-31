import { useEffect, useState } from 'react';

import { mailApi } from '../../mail/api';
import type { OrganizationDetail } from '../../mail/types';

import styles from './shared.module.css';
import own from './TabNote.module.css';

interface Props {
  partner: OrganizationDetail;
}

export function TabNote({ partner }: Props) {
  const [text, setText] = useState(partner.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setText(partner.notes ?? '');
  }, [partner.id, partner.notes]);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await mailApi.db.organizationUpdate({
        id: partner.id,
        displayName: partner.displayName,
        vatNumber: partner.vatNumber,
        address: partner.address,
        phone: partner.phone,
        website: partner.website,
        notes: text || null,
        isClient: partner.isClient,
        isSupplier: partner.isSupplier,
        taxCode: partner.taxCode,
        sdiCode: partner.sdiCode,
        pec: partner.pec,
        iban: partner.iban,
        bankName: partner.bankName,
        streetAddress: partner.streetAddress,
        city: partner.city,
        postalCode: partner.postalCode,
        province: partner.province,
        countryIso2: partner.countryIso2,
        preferredCourier: partner.preferredCourier,
        paymentTerms: partner.paymentTerms,
        shippingTerms: partner.shippingTerms,
        preferredLanguage: partner.preferredLanguage,
        emailAddress: partner.emailAddress,
      });
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
      }, 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={own.wrap}>
      <textarea
        className={own.textarea}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        placeholder="Note operative su questo cliente / fornitore. Es: 'Solo bonifici a 60gg dalla fattura', 'Spedire sempre con DHL Express', 'Contattare prima Mario per ordini > 5k€'…"
        rows={12}
      />
      <div className={own.actions}>
        <span className={own.hint}>
          Queste note sono incluse nel contesto AI quando lavori con questo cliente.
        </span>
        <button
          type="button"
          className={styles.smallBtn}
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? 'Salvataggio…' : saved ? '✓ Salvato' : 'Salva note'}
        </button>
      </div>
    </div>
  );
}
