/**
 * TypeScript Language Service in-process per il Custom Node Editor.
 *
 * Strategia enterprise (no spawn child_process — sandbox-safe):
 *   - `typescript` package importato direttamente
 *   - LanguageService creato per sessione (= per WebSocket connection)
 *   - LanguageServiceHost serve i 3 file virtuali (executor/definition/schema)
 *     + le .d.ts inline per SDK community + `zod` + `safe-fetch`
 *   - Documenti tenuti in memoria con versioning per cache hit di TS
 *
 * Endpoints supportati (LSP-light, JSON-RPC 2.0 compatibili):
 *   - initialize       → capabilities
 *   - update           → sostituisce il source di un documento (line-based)
 *   - completion       → getCompletionsAtPosition + entry details on demand
 *   - hover            → getQuickInfoAtPosition
 *   - diagnostics      → getSemanticDiagnostics + getSyntacticDiagnostics
 *
 * Tutte le operazioni sono SINCRONE — TypeScript Language Service e\` sync.
 *
 * @module lsp/typescript-lsp
 */

// TypeScript 5.x usa __filename a livello modulo, che non e\` definito sotto
// ESM Node 20+ runtime. Soluzione enterprise: carichiamo TS via createRequire
// (CJS-safe) invece di top-level ESM import. Cosi\` TS si inizializza nel suo
// runtime CJS nativo e tutti gli helper (isFileSystemCaseSensitive, ecc.)
// funzionano correttamente.
//
// `import type * as tsTypes` preserva i typings (tsTypes.LanguageService, ecc.)
// per il type-checker mentre `ts` carica l'implementazione runtime via CJS.
import type * as TypescriptNS from 'typescript';
import type * as FsNS from 'node:fs';
import type * as tsTypes from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ts = require('typescript') as typeof TypescriptNS;

const SDK_LIB = `
declare module 'zod' {
  export const z: any;
  export type ZodSchema<T = any> = any;
  export type ZodType<T = any> = any;
  export type ZodObject<T = any> = any;
}
declare module '@medea/engine-community-node-sdk' {
  export interface NodeExecutionContext {
    input: unknown;
    config: Record<string, unknown>;
    env: Record<string, string>;
  }
  export type NodeExecutor = (ctx: NodeExecutionContext) => Promise<unknown>;
  export interface NodeDefinition {
    defId: string;
    displayName: string;
    kind: 'action' | 'trigger' | 'logic' | 'agent';
    category: string;
    inputs: string[];
    outputs: string[];
    description?: string;
    config?: Array<Record<string, unknown>>;
  }
}
declare module '@medea/engine-safe-fetch' {
  export interface SafeFetchOptions extends RequestInit {
    timeoutMs?: number;
  }
  export function safeFetch(url: string, opts?: SafeFetchOptions): Promise<Response>;
}
declare module 'virtual:schema' {
  export const schema: any;
}
`;

/**
 * Source canonico per i 3 file dell'editor + i lib ambient. Le path sono
 * memory-only — non toccano il filesystem.
 */
export const VIRTUAL_PATHS = {
  executor: '/virtual/executor.ts',
  definition: '/virtual/definition.ts',
  schema: '/virtual/schema.ts',
  sdkLib: '/virtual/__ff_sdk__.d.ts',
} as const;

export type VirtualFile = 'executor' | 'definition' | 'schema';

interface Doc {
  content: string;
  version: number;
}

export interface LspCompletionItem {
  label: string;
  kind: string;
  detail?: string;
  insertText?: string;
  sortText?: string;
}

export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'info';
  line: number;
  col: number;
  message: string;
  code: string | number;
  file: VirtualFile;
}

export interface LspHover {
  contents: string;
  range?: { startLine: number; startCol: number; endLine: number; endCol: number };
}

/** Singleton-per-session TypeScript LanguageService. */
export class TypeScriptLsp {
  private readonly docs = new Map<string, Doc>();
  private readonly service: tsTypes.LanguageService;
  private readonly compilerOptions: tsTypes.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    allowSyntheticDefaultImports: true,
    jsx: ts.JsxEmit.None,
    noEmit: true,
    lib: ['ES2022', 'DOM'],
  };

  constructor() {
    this.docs.set(VIRTUAL_PATHS.sdkLib, { content: SDK_LIB, version: 1 });
    this.docs.set(VIRTUAL_PATHS.executor, { content: '', version: 1 });
    this.docs.set(VIRTUAL_PATHS.definition, { content: '', version: 1 });
    this.docs.set(VIRTUAL_PATHS.schema, { content: '', version: 1 });

    const host: tsTypes.LanguageServiceHost = {
      getScriptFileNames: () => Array.from(this.docs.keys()),
      getScriptVersion: (fn) => String(this.docs.get(fn)?.version ?? 0),
      getScriptSnapshot: (fn) => {
        const doc = this.docs.get(fn);
        if (doc) return ts.ScriptSnapshot.fromString(doc.content);
        // Fallback: leggi dalle lib TS built-in (es2022.d.ts) via tsLibSource.
        const libPath = ts.getDefaultLibFilePath(this.compilerOptions);
        if (fn.endsWith('lib.d.ts') || fn === libPath) {
          try {
            // ts.sys non disponibile in tutti i runtime sandboxati; usa fs solo
            // se disponibile (l'LSP gira nel runtime container, ha fs read).
            const fs = require('node:fs') as typeof FsNS;
            const src = fs.readFileSync(fn, 'utf8');
            return ts.ScriptSnapshot.fromString(src);
          } catch {
            return undefined;
          }
        }
        return undefined;
      },
      getCurrentDirectory: () => '/virtual',
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (fn) => this.docs.has(fn),
      readFile: (fn) => this.docs.get(fn)?.content,
      readDirectory: () => [],
      directoryExists: () => true,
      getDirectories: () => [],
    };

    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  /** Sostituisce il contenuto di uno dei 3 file dell'editor. */
  update(file: VirtualFile, content: string): void {
    const path = VIRTUAL_PATHS[file];
    const cur = this.docs.get(path);
    this.docs.set(path, {
      content,
      version: (cur?.version ?? 0) + 1,
    });
  }

  /** Estrae diagnostics combinati (semantic + syntactic) per un file. */
  getDiagnostics(file: VirtualFile): LspDiagnostic[] {
    const path = VIRTUAL_PATHS[file];
    const semantic = this.service.getSemanticDiagnostics(path);
    const syntactic = this.service.getSyntacticDiagnostics(path);
    const sourceFile = this.service.getProgram()?.getSourceFile(path);
    if (!sourceFile) return [];

    const result: LspDiagnostic[] = [];
    for (const d of [...syntactic, ...semantic]) {
      const start = d.start ?? 0;
      const lc = sourceFile.getLineAndCharacterOfPosition(start);
      result.push({
        severity:
          d.category === ts.DiagnosticCategory.Error
            ? 'error'
            : d.category === ts.DiagnosticCategory.Warning
              ? 'warning'
              : 'info',
        line: lc.line + 1,
        col: lc.character + 1,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        code: d.code,
        file,
      });
    }
    return result;
  }

  /** Completion at a position (LSP-light shape). */
  getCompletions(file: VirtualFile, line: number, col: number, max = 50): LspCompletionItem[] {
    const path = VIRTUAL_PATHS[file];
    const sourceFile = this.service.getProgram()?.getSourceFile(path);
    if (!sourceFile) return [];
    const pos = sourceFile.getPositionOfLineAndCharacter(
      Math.max(0, line - 1),
      Math.max(0, col - 1),
    );
    const completions = this.service.getCompletionsAtPosition(path, pos, undefined);
    if (!completions) return [];
    return completions.entries.slice(0, max).map((entry) => ({
      label: entry.name,
      kind: entry.kind,
      ...(entry.sortText ? { sortText: entry.sortText } : {}),
      ...(entry.insertText ? { insertText: entry.insertText } : {}),
    }));
  }

  /** Quick info (hover) at a position. */
  getHover(file: VirtualFile, line: number, col: number): LspHover | null {
    const path = VIRTUAL_PATHS[file];
    const sourceFile = this.service.getProgram()?.getSourceFile(path);
    if (!sourceFile) return null;
    const pos = sourceFile.getPositionOfLineAndCharacter(
      Math.max(0, line - 1),
      Math.max(0, col - 1),
    );
    const info = this.service.getQuickInfoAtPosition(path, pos);
    if (!info) return null;
    const displayText = ts.displayPartsToString(info.displayParts);
    const docs = info.documentation ? ts.displayPartsToString(info.documentation) : '';
    const contents = docs ? `${displayText}\n\n${docs}` : displayText;
    if (!contents) return null;
    const startLc = sourceFile.getLineAndCharacterOfPosition(info.textSpan.start);
    const endLc = sourceFile.getLineAndCharacterOfPosition(
      info.textSpan.start + info.textSpan.length,
    );
    return {
      contents,
      range: {
        startLine: startLc.line + 1,
        startCol: startLc.character + 1,
        endLine: endLc.line + 1,
        endCol: endLc.character + 1,
      },
    };
  }

  dispose(): void {
    this.service.dispose();
    this.docs.clear();
  }
}
