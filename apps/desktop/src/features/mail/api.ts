/**
 * Wrapper TypeScript dei `#[tauri::command]` IMAP/SMTP.
 * Mantiene la separazione tra UI e bridge — i nomi dei comandi non leakano
 * fuori da qui.
 */

import { invoke } from '@tauri-apps/api/core';

import type {
  AttachmentEntry,
  BrandRow,
  CategoryRow,
  CustomerDiscountInput,
  CustomerDiscountRow,
  CustomerDocumentInput,
  CustomerDocumentRow,
  CustomerPriceOverrideInput,
  CustomerPriceOverrideRow,
  FolderInfo,
  ImapCredentials,
  MailAccount,
  MessageFull,
  MessageSummary,
  OrganizationDetail,
  OrganizationInsertInput,
  OrganizationUpdateFull,
  OutgoingMessage,
  PriceResolution,
  SmtpCredentials,
} from './types';

/* ── DB types (mirroring db_cmd.rs serde output) ───────────────────────── */
export interface DbListedMessage {
  id: number;
  uid: number;
  messageId: string | null;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  toJson: string;
  preview: string | null;
  internalDate: string | null;
  isSeen: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  size: number;
  folderPath: string | null;
}

export interface DbContactRow {
  id: number;
  emailAddress: string;
  displayName: string | null;
  organizationDomain: string | null;
  organizationName: string | null;
  isClient: boolean;
  isSupplier: boolean;
  messageCount: number;
  lastSeenAt: string | null;
}

export interface DbOrganizationRow {
  id: number;
  domain: string;
  displayName: string | null;
  vatNumber: string | null;
  isClient: boolean;
  isSupplier: boolean;
  contactCount: number;
  city: string | null;
  countryIso2: string | null;
  emailAddress: string | null;
}

export interface DbArticleRow {
  id: number;
  code: string;
  description: string;
  unit: string | null;
  vatPercent: number | null;
  isActive: boolean;
  brandId: number | null;
  brandName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  purchasePrice: number | null;
  salePrice: number | null;
  currency: string | null;
  boxQuantity: number | null;
  countryOfOrigin: string | null;
  hsCode: string | null;
  notes: string | null;
}

export interface DbPriceListRow {
  id: number;
  name: string;
  organizationId: number | null;
  organizationName: string | null;
  isDefault: boolean;
  itemCount: number;
  validFrom: string | null;
  validTo: string | null;
  notes: string | null;
}

export interface DbInlinePart {
  contentId: string;
  contentType: string;
  base64: string;
  filename: string | null;
}

export interface DbFullMessage extends DbListedMessage {
  bodyText: string | null;
  bodyHtml: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  inReplyTo: string | null;
  references: string[];
}

export interface DbSearchHit {
  messageId: number;
  snippet: string;
  rank: number;
  subject: string | null;
  fromAddress: string | null;
  internalDate: string | null;
}

export interface FolderStats {
  folderId: number;
  total: number;
  unread: number;
}

export interface SyncProgress {
  accountId: string;
  folderPath: string;
  fetched: number;
  total: number;
  stored: number;
  message: string;
}

export interface SyncResult {
  fetched: number;
  stored: number;
  alreadyInDb: number;
  elapsedMs: number;
}

interface StoredAccountForDb {
  id: string;
  displayName: string;
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpImplicitTls: boolean;
  lastFullSync: string | null;
}

export interface ArticleInput {
  id?: number | null;
  code: string;
  description: string;
  unit?: string | null;
  vatPercent?: number | null;
  notes?: string | null;
  isActive?: boolean;
  // v3 — gestionale
  brandId?: number | null;
  categoryId?: number | null;
  purchasePrice?: number | null;
  salePrice?: number | null;
  currency?: string | null;
  boxQuantity?: number | null;
  countryOfOrigin?: string | null;
  hsCode?: string | null;
}

export interface PriceListInput {
  id?: number | null;
  name: string;
  organizationId?: number | null;
  isDefault?: boolean;
  validFrom?: string | null;
  validTo?: string | null;
  notes?: string | null;
}

export interface PriceListItemInput {
  id?: number | null;
  priceListId: number;
  articleId: number;
  price: number;
  discountPercent?: number;
  notes?: string | null;
}

export interface DbPriceListItemRow {
  id: number;
  articleId: number;
  articleCode: string;
  articleDescription: string;
  articleUnit: string | null;
  price: number;
  discountPercent: number;
  notes: string | null;
}

/**
 * @deprecated Usa `OrganizationUpdateFull` da `mail/types`. Mantenuto solo come
 * sotto-tipo strutturale per compatibilità con componenti legacy.
 */
export type OrganizationUpdateInput = OrganizationUpdateFull;

export const mailApi = {
  imap: {
    test: (creds: ImapCredentials): Promise<boolean> => invoke('imap_test_connection', { creds }),
    listFolders: (creds: ImapCredentials): Promise<FolderInfo[]> =>
      invoke('imap_list_folders', { creds }),
    append: (
      creds: ImapCredentials,
      folder: string,
      emlBytes: number[],
      flags: string[],
    ): Promise<void> => invoke('imap_append', { creds, folder, emlBytes, flags }),
    listMessages: (
      creds: ImapCredentials,
      folder: string,
      limit: number,
    ): Promise<MessageSummary[]> => invoke('imap_list_messages', { creds, folder, limit }),
    fetch: (creds: ImapCredentials, folder: string, uid: number): Promise<MessageFull> =>
      invoke('imap_fetch_message', { creds, folder, uid }),
  },
  smtp: {
    test: (creds: SmtpCredentials): Promise<boolean> => invoke('smtp_test_connection', { creds }),
    send: (creds: SmtpCredentials, msg: OutgoingMessage): Promise<string> =>
      invoke('smtp_send', { creds, msg }),
    sendAndArchiveSent: (
      smtpCreds: SmtpCredentials,
      imapCreds: ImapCredentials,
      sentFolder: string,
      msg: OutgoingMessage,
    ): Promise<string> =>
      invoke('mail_send_and_archive_sent', { smtpCreds, imapCreds, sentFolder, msg }),
    /** Costruisce l'EML del messaggio senza inviarlo. Usato per APPEND-only (Drafts/Sent retry). */
    buildEml: (msg: OutgoingMessage): Promise<number[]> => invoke('mail_build_eml', { msg }),
    saveDraft: (
      imapCreds: ImapCredentials,
      draftsFolder: string,
      msg: OutgoingMessage,
    ): Promise<void> => invoke('mail_save_draft', { imapCreds, draftsFolder, msg }),
  },
  db: {
    accountUpsert: (acc: MailAccount): Promise<void> => {
      const dbAcc: StoredAccountForDb = {
        id: acc.id,
        displayName: acc.displayName,
        emailAddress: acc.emailAddress,
        imapHost: acc.imap.host,
        imapPort: acc.imap.port,
        imapUsername: acc.imap.username,
        smtpHost: acc.smtp.host,
        smtpPort: acc.smtp.port,
        smtpUsername: acc.smtp.username,
        smtpImplicitTls: acc.smtp.implicitTls ?? false,
        lastFullSync: null,
      };
      return invoke('db_account_upsert', { account: dbAcc });
    },
    ensureFolder: (
      accountId: string,
      path: string,
      name: string,
      folderType: string,
    ): Promise<number> => invoke('db_ensure_folder', { accountId, path, name, folderType }),
    listMessages: (
      accountId: string,
      folderId: number,
      limit: number,
      offset: number,
    ): Promise<DbListedMessage[]> =>
      invoke('db_list_messages', { accountId, folderId, limit, offset }),
    getMessage: (id: number): Promise<DbFullMessage | null> => invoke('db_get_message', { id }),
    recentMessages: (accountId: string, limit: number): Promise<DbListedMessage[]> =>
      invoke('db_recent_messages', { accountId, limit }),
    search: (accountId: string, query: string, limit: number): Promise<DbSearchHit[]> =>
      invoke('db_search', { accountId, query, limit }),
    folderStats: (accountId: string, folderId: number): Promise<FolderStats> =>
      invoke('db_folder_stats', { accountId, folderId }),
    listContacts: (limit: number, offset: number): Promise<DbContactRow[]> =>
      invoke('db_list_contacts', { limit, offset }),
    listOrganizations: (limit: number, offset: number): Promise<DbOrganizationRow[]> =>
      invoke('db_list_organizations', { limit, offset }),
    listArticles: (limit: number, offset: number): Promise<DbArticleRow[]> =>
      invoke('db_list_articles', { limit, offset }),
    listPriceLists: (): Promise<DbPriceListRow[]> => invoke('db_list_price_lists'),
    getInlineParts: (messageId: number): Promise<DbInlinePart[]> =>
      invoke('db_get_inline_parts', { messageId }),
    listAttachments: (messageId: number): Promise<AttachmentEntry[]> =>
      invoke('db_list_attachments', { messageId }),
    saveAttachment: (messageId: number, partIndex: number, destPath: string): Promise<string> =>
      invoke('db_save_attachment', { messageId, partIndex, destPath }),
    markSeen: (messageId: number, seen: boolean): Promise<void> =>
      invoke('db_message_mark_seen', { messageId, seen }),
    setFlag: (messageId: number, flagged: boolean): Promise<void> =>
      invoke('db_message_set_flag', { messageId, flagged }),
    localDelete: (messageId: number): Promise<void> =>
      invoke('db_message_local_delete', { messageId }),
    localRestore: (messageId: number): Promise<void> =>
      invoke('db_message_local_restore', { messageId }),
    articleUpsert: (article: ArticleInput): Promise<number> =>
      invoke('db_article_upsert', { article }),
    articleDelete: (id: number): Promise<void> => invoke('db_article_delete', { id }),
    priceListUpsert: (priceList: PriceListInput): Promise<number> =>
      invoke('db_price_list_upsert', { priceList }),
    priceListDelete: (id: number): Promise<void> => invoke('db_price_list_delete', { id }),
    priceListItemUpsert: (item: PriceListItemInput): Promise<number> =>
      invoke('db_price_list_item_upsert', { item }),
    priceListItemDelete: (id: number): Promise<void> => invoke('db_price_list_item_delete', { id }),
    priceListItems: (priceListId: number): Promise<DbPriceListItemRow[]> =>
      invoke('db_price_list_items', { priceListId }),
    contactSetFlags: (id: number, isClient: boolean, isSupplier: boolean): Promise<void> =>
      invoke('db_contact_set_flags', { id, isClient, isSupplier }),
    organizationUpdate: (org: OrganizationUpdateFull): Promise<void> =>
      invoke('db_organization_update', { org }),
    organizationInsert: (org: OrganizationInsertInput): Promise<number> =>
      invoke('db_organization_insert', { org }),
    organizationDelete: (id: number): Promise<void> => invoke('db_organization_delete', { id }),
    bulkDeleteOrganizations: (ids: number[]): Promise<number> =>
      invoke('db_bulk_delete_organizations', { ids }),
    bulkDeleteArticles: (ids: number[]): Promise<number> =>
      invoke('db_bulk_delete_articles', { ids }),
    organizationSetRoles: (id: number, isClient: boolean, isSupplier: boolean): Promise<void> =>
      invoke('db_organization_set_roles', { id, isClient, isSupplier }),
    listBusinessPartners: (
      onlyClients: boolean,
      onlySuppliers: boolean,
    ): Promise<DbOrganizationRow[]> =>
      invoke('db_list_business_partners', { onlyClients, onlySuppliers }),
    getOrganization: (id: number): Promise<OrganizationDetail | null> =>
      invoke('db_get_organization', { id }),
    listBrands: (): Promise<BrandRow[]> => invoke('db_list_brands'),
    listCategories: (): Promise<CategoryRow[]> => invoke('db_list_categories'),
    customerDiscountUpsert: (discount: CustomerDiscountInput): Promise<number> =>
      invoke('db_customer_discount_upsert', { discount }),
    customerDiscountDelete: (id: number): Promise<void> =>
      invoke('db_customer_discount_delete', { id }),
    listCustomerDiscounts: (customerId: number): Promise<CustomerDiscountRow[]> =>
      invoke('db_list_customer_discounts', { customerId }),
    customerPriceOverrideUpsert: (override: CustomerPriceOverrideInput): Promise<number> =>
      invoke('db_customer_price_override_upsert', { override }),
    customerPriceOverrideDelete: (id: number): Promise<void> =>
      invoke('db_customer_price_override_delete', { id }),
    listCustomerPriceOverrides: (customerId: number): Promise<CustomerPriceOverrideRow[]> =>
      invoke('db_list_customer_price_overrides', { customerId }),
    resolvePrice: (customerId: number, articleCode: string): Promise<PriceResolution | null> =>
      invoke('db_resolve_price', { customerId, articleCode }),
    customerDocumentUpsert: (doc: CustomerDocumentInput): Promise<number> =>
      invoke('db_customer_document_upsert', { doc }),
    customerDocumentDelete: (id: number): Promise<void> =>
      invoke('db_customer_document_delete', { id }),
    listCustomerDocuments: (
      organizationId: number,
      docType?: string,
    ): Promise<CustomerDocumentRow[]> =>
      invoke('db_list_customer_documents', { organizationId, docType: docType ?? null }),
    listMessagesForDomain: (
      accountId: string,
      domain: string,
      limit: number,
    ): Promise<DbListedMessage[]> =>
      invoke('db_list_messages_for_domain', { accountId, domain, limit }),
    /** Email scambiate con UN indirizzo (in/out), su tutti gli account. */
    listMessagesForAddress: (address: string, limit: number): Promise<DbListedMessage[]> =>
      invoke('db_list_messages_for_address', { address, limit }),
  },
  sync: {
    folder: (
      accountId: string,
      creds: ImapCredentials,
      folderPath: string,
      folderType: string,
      maxMessages?: number,
    ): Promise<SyncResult> =>
      invoke('mail_sync_folder', {
        accountId,
        creds,
        folderPath,
        folderType,
        maxMessages: maxMessages ?? null,
      }),
  },
};
