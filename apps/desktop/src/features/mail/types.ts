/**
 * Tipi condivisi con il backend Rust (`apps/desktop/src-tauri/src/commands/imap_cmd.rs`).
 * Devono restare allineati a quelli serializzati da `serde` (camelCase).
 */

export interface ImapCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  secure?: boolean;
  acceptInvalidCerts?: boolean;
}

export interface SmtpCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  implicitTls?: boolean;
  acceptInvalidCerts?: boolean;
}

export interface FolderInfo {
  name: string;
  delimiter: string | null;
  attributes: string[];
}

export interface MessageSummary {
  uid: number;
  messageId: string | null;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  to: string[];
  date: string | null;
  preview: string | null;
  isSeen: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  size: number;
}

export interface AttachmentInfo {
  filename: string | null;
  contentType: string;
  size: number;
}

export type ThreatLevel = 'safe' | 'caution' | 'danger';

export interface ThreatReport {
  level: ThreatLevel;
  reasons: string[];
  suggestions: string[];
  category: string;
  icon: string;
  sha256Hex: string | null;
}

export interface AttachmentEntry {
  index: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  isInline: boolean;
  threat: ThreatReport;
}

// ── Anagrafica gestionale (v3) ─────────────────────────────────────────────

export type ShippingTerms = 'porto_franco' | 'porto_assegnato' | 'franco_con_addebito';

export interface OrganizationDetail {
  id: number;
  domain: string;
  displayName: string | null;
  vatNumber: string | null;
  taxCode: string | null;
  sdiCode: string | null;
  pec: string | null;
  emailAddress: string | null;
  phone: string | null;
  website: string | null;
  iban: string | null;
  bankName: string | null;
  streetAddress: string | null;
  city: string | null;
  postalCode: string | null;
  province: string | null;
  countryIso2: string | null;
  preferredCourier: string | null;
  paymentTerms: string | null;
  shippingTerms: ShippingTerms | null;
  preferredLanguage: string | null;
  notes: string | null;
  address: string | null;
  isClient: boolean;
  isSupplier: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationUpdateFull {
  id: number;
  displayName?: string | null;
  vatNumber?: string | null;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  notes?: string | null;
  isClient: boolean;
  isSupplier: boolean;
  taxCode?: string | null;
  sdiCode?: string | null;
  pec?: string | null;
  iban?: string | null;
  bankName?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  postalCode?: string | null;
  province?: string | null;
  countryIso2?: string | null;
  preferredCourier?: string | null;
  paymentTerms?: string | null;
  shippingTerms?: ShippingTerms | null;
  preferredLanguage?: string | null;
  emailAddress?: string | null;
}

export interface OrganizationInsertInput {
  displayName: string;
  domain?: string | null;
  emailAddress?: string | null;
  isClient?: boolean;
  isSupplier?: boolean;
}

export interface BrandRow {
  id: number;
  name: string;
  displayOrder: number;
}

export interface CategoryRow {
  id: number;
  parentId: number | null;
  name: string;
  code: string | null;
  displayOrder: number;
}

export interface CustomerDiscountInput {
  id?: number | null;
  customerId: number;
  categoryId?: number | null;
  brandId?: number | null;
  discountPct: number;
  notes?: string | null;
}

export interface CustomerDiscountRow {
  id: number;
  customerId: number;
  categoryId: number | null;
  categoryName: string | null;
  brandId: number | null;
  brandName: string | null;
  discountPct: number;
  notes: string | null;
}

export interface CustomerPriceOverrideInput {
  id?: number | null;
  customerId: number;
  articleId: number;
  unitPrice: number;
  currency?: string | null;
  notes?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
}

export interface CustomerPriceOverrideRow {
  id: number;
  customerId: number;
  articleId: number;
  articleCode: string;
  articleDescription: string;
  unitPrice: number;
  currency: string;
  notes: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface PriceResolution {
  articleId: number;
  articleCode: string;
  articleDescription: string;
  customerId: number;
  listPrice: number | null;
  overridePrice: number | null;
  discountPctApplied: number;
  discountSource: 'override' | 'cat+brand' | 'cat' | 'brand' | 'global' | null;
  finalPrice: number | null;
  currency: string;
}

export type DocDirection = 'incoming' | 'outgoing';
export type DocType =
  | 'sales_order' | 'sales_confirm' | 'quote'
  | 'purchase_order' | 'purchase_confirm' | 'communication';

export interface CustomerDocumentInput {
  id?: number | null;
  organizationId: number;
  direction: DocDirection;
  docType: DocType;
  docNumber?: string | null;
  docDate: string;
  status?: string | null;
  totalAmount?: number | null;
  currency?: string | null;
  messageId?: number | null;
  attachmentFilename?: string | null;
  attachmentPath?: string | null;
  attachmentSha256?: string | null;
  notes?: string | null;
}

export interface CustomerDocumentRow {
  id: number;
  organizationId: number;
  direction: DocDirection;
  docType: DocType;
  docNumber: string | null;
  docDate: string;
  status: string | null;
  totalAmount: number | null;
  currency: string;
  messageId: number | null;
  attachmentFilename: string | null;
  attachmentPath: string | null;
  attachmentSha256: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
}

export interface MessageFull extends MessageSummary {
  bodyText: string | null;
  bodyHtml: string | null;
  cc: string[];
  bcc: string[];
  inReplyTo: string | null;
  references: string[];
  attachments: AttachmentInfo[];
}

export interface OutgoingMessage {
  fromName: string | null;
  fromAddress: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  inReplyTo?: string | null;
  references?: string[];
}

/**
 * Profilo account combinato — IMAP + SMTP + metadati locali.
 * Persistito (cifrato) in localStorage.
 */
export interface MailAccount {
  id: string;
  displayName: string;
  emailAddress: string;
  imap: ImapCredentials;
  smtp: SmtpCredentials;
  defaultFolder?: string;
  createdAt: string;
}
