import { invoke } from '@tauri-apps/api/core';

import type { ChatRequest, ChatResponse } from './types';

export const aiApi = {
  chat: (req: ChatRequest): Promise<ChatResponse> => invoke('ai_chat', { req }),
};
