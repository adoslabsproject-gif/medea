import { invoke } from '@tauri-apps/api/core';

import type { EmailTemplate, EmailTemplateInput } from './types';

export const templateApi = {
  list: (): Promise<EmailTemplate[]> => invoke('db_template_list'),
  getDefault: (): Promise<EmailTemplate | null> => invoke('db_template_default'),
  upsert: (template: EmailTemplateInput): Promise<number> =>
    invoke('db_template_upsert', { template }),
  delete: (id: number): Promise<void> => invoke('db_template_delete', { id }),
};
