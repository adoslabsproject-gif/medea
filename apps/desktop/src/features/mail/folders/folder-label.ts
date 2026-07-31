import type { FolderInfo } from '../types';

/**
 * Mappa il path/attributi IMAP a un'etichetta umana italiana.
 * Riconosce sia gli attributi RFC6154 (\Inbox, \Sent, …) sia i nomi
 * comuni IT/EN/FR/ES/DE.
 */
export function folderLabel(name: string, attributes: string[] = []): string {
  const attrs = attributes.join(' ').toLowerCase();
  const n = name.toLowerCase();

  if (attrs.includes('\\inbox') || n === 'inbox' || n === 'posta in arrivo') {
    return 'Posta in arrivo';
  }
  if (attrs.includes('\\sent') || /^(sent|sent items|sent messages|inviat|posta inviata)$/.test(n)) {
    return 'Inviata';
  }
  if (attrs.includes('\\drafts') || /^(drafts?|bozze|bozz)$/.test(n)) {
    return 'Bozze';
  }
  if (attrs.includes('\\junk') || /spam|junk|indesider/.test(n)) {
    return 'Spam';
  }
  if (attrs.includes('\\trash') || /trash|cestin|deleted/.test(n)) {
    return 'Cestino';
  }
  if (attrs.includes('\\archive') || /archive|archivi/.test(n)) {
    return 'Archivio';
  }
  return name;
}

export function folderLabelFromInfo(f: FolderInfo): string {
  return folderLabel(f.name, f.attributes);
}

export function folderType(name: string, attributes: string[] = []): string {
  const attrs = attributes.join(' ').toLowerCase();
  const n = name.toLowerCase();
  if (attrs.includes('\\inbox') || n === 'inbox') return 'inbox';
  if (attrs.includes('\\sent') || /sent|inviat/.test(n)) return 'sent';
  if (attrs.includes('\\drafts') || /draft|bozz/.test(n)) return 'drafts';
  if (attrs.includes('\\junk') || /spam|junk/.test(n)) return 'spam';
  if (attrs.includes('\\trash') || /trash|cestin|deleted/.test(n)) return 'trash';
  if (attrs.includes('\\archive') || /archive|archivi/.test(n)) return 'archive';
  return 'custom';
}
