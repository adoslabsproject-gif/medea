export type PartnerFilter = 'all' | 'clients' | 'suppliers';

export type DetailTab =
  | 'anagrafica'
  | 'contatti'
  | 'listino'
  | 'sconti'
  | 'documenti'
  | 'comunicazioni'
  | 'note';

export const SHIPPING_TERMS_LABELS: Record<string, string> = {
  porto_franco: 'Porto franco',
  porto_assegnato: 'Porto assegnato',
  franco_con_addebito: 'Franco con addebito',
};

export const SHIPPING_TERMS_OPTIONS = [
  { value: 'porto_franco', label: 'Porto franco' },
  { value: 'porto_assegnato', label: 'Porto assegnato' },
  { value: 'franco_con_addebito', label: 'Franco con addebito' },
] as const;
