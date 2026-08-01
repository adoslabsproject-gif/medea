/**
 * ast-security-scan — analizzatore di sicurezza AST per i custom-node del marketplace.
 *
 * Il `securityScan` regex-blocklist (compile.service.ts) è una rete a maglie larghe:
 * lavora riga-per-riga su STRINGHE → un autore ostile la aggira banalmente con
 *   - bracket notation:      `process['env']`        (la regex cerca `process.env`)
 *   - aliasing:              `const p = process; p.env`
 *   - global indiretto:      `globalThis['process']`
 *   - eval/Function:         `eval(x)`, `new Function(x)`
 *   - import dinamico:       `import(x)`
 *
 * Questo modulo parsa il sorgente con il compiler TypeScript e CAMMINA l'AST: riconosce
 * il GLOBALE proibito ovunque sia REFERENZIATO (non solo nella forma `a.b` testuale),
 * a prescindere da notazione/alias. È il gate AST che decide la pubblicabilità — la
 * regex resta come messaggistica veloce, ma la decisione di sicurezza passa di qui.
 *
 * NB: difesa-in-PROFONDITÀ. Il confine reale resta l'isolated-vm (niente require/process
 * nel realm). Questo scan alza il muro a publish-time così il codice ostile non entra
 * nemmeno nel registry.
 *
 * @module services/custom-nodes/ast-security-scan
 */

// ⚠️ typescript è un modulo CJS ENORME. Importarlo EAGER a top-level lo carica a
// BOOT (questo file è raggiunto dalla catena custom-nodes → routes): nel bundle ESM
// di produzione su Node 22 questo crasha con ERR_AMBIGUOUS_MODULE_SYNTAX → il
// container non bootta (pre-flight su src/tsx NON lo becca: gira i sorgenti, mai il
// bundle dist). Lo carichiamo LAZY, solo quando si scansiona davvero un community
// node (pubblicazione marketplace), mai a boot.
import type * as tsNS from 'typescript'; // namespace ts (tipi: tsNS.Node… E `typeof tsNS` per il modulo) — zero runtime
import type { CompileDiagnostic } from './types.js';

// Valore runtime di typescript, caricato lazy (vedi sopra). `tsLoaded` evita la
// ricompilazione del check ed è un boolean esplicito (no `??=` su valore !-asserito).
let ts!: typeof tsNS;
let tsLoaded = false;
async function ensureTs(): Promise<void> {
  if (!tsLoaded) {
    ts = (await import('typescript')).default;
    tsLoaded = true;
  }
}

type FileName = 'executor' | 'definition' | 'schema';

/** Globali la cui SOLA referenza (in qualunque notazione) è un escape del sandbox. */
const FORBIDDEN_GLOBALS = new Map<string, string>([
  ['process', 'process è vietato nel sandbox (usa la config injection, non process.env)'],
  ['require', 'require() è vietato (solo import statici degli SDK)'],
  ['module', 'module è vietato (no manipolazione del modulo CommonJS)'],
  ['exports', 'exports è vietato (no manipolazione CommonJS)'],
  ['global', 'global è vietato (sandbox)'],
  ['globalThis', 'globalThis è vietato (può raggiungere globali proibiti, es. globalThis.process)'],
  ['__dirname', '__dirname è vietato (leak di path del filesystem)'],
  ['__filename', '__filename è vietato (leak di path del filesystem)'],
  ['eval', 'eval() è vietato (code injection)'],
  ['Function', 'il costruttore Function è vietato (code injection come eval)'],
]);

/** `true` se l'Identifier è una REFERENZA al valore (non un nome di proprietà, un binding
 *  di dichiarazione, o una posizione di TIPO — quei casi non sono un uso del globale). */
function isValueReference(id: tsNS.Identifier): boolean {
  const p = id.parent as tsNS.Node | undefined;
  if (!p) return true;
  // `foo.process` → `process` è il nome della proprietà, non il globale.
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  // Nomi in posizione di DICHIARAZIONE/binding.
  if (
    (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) ||
      ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) || ts.isEnumDeclaration(p) || ts.isModuleDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeParameterDeclaration(p)) &&
    (p as { name?: tsNS.Node }).name === id
  ) {
    return false;
  }
  // Specifier di import/export (nomi, non valori).
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isNamespaceImport(p) || ts.isImportClause(p)) {
    return false;
  }
  // Chiave di property assignment in object literal (la SHORTHAND invece è una referenza).
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  // Posizione di TIPO (es. `x: Function`) — non è un uso del valore.
  if (ts.isTypeReferenceNode(p) && p.typeName === id) return false;
  return true;
}

/** Diagnostica per un import statico/dinamico vietato. `null` se lecito. */
function forbiddenImportReason(spec: string): string | null {
  if (spec.startsWith('node:')) return `import da "${spec}" vietato (no Node builtins nel sandbox)`;
  return null;
}

function scanOne(file: FileName, code: string): CompileDiagnostic[] {
  const violations: CompileDiagnostic[] = [];
  // `setParentNodes=true` → serve `node.parent` per `isValueReference`.
  let sf: tsNS.SourceFile;
  try {
    sf = ts.createSourceFile(`${file}.ts`, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    // Parse fail (sintassi) → lo segnala esbuild a valle: qui non blocchiamo.
    return violations;
  }

  const report = (node: tsNS.Node, message: string, code2: string): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({ severity: 'error', line: line + 1, col: character + 1, message, code: code2, file });
  };

  const visit = (node: tsNS.Node): void => {
    // 1) Referenza a un globale proibito (qualunque notazione/alias).
    if (ts.isIdentifier(node)) {
      const reason = FORBIDDEN_GLOBALS.get(node.text);
      if (reason !== undefined && isValueReference(node)) {
        report(node, reason, 'SECURITY_AST_FORBIDDEN_GLOBAL');
      }
    }
    // 2) Import statico `node:*`.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const r = forbiddenImportReason(node.moduleSpecifier.text);
      if (r !== null) report(node, r, 'SECURITY_AST_FORBIDDEN_IMPORT');
    }
    // 3) `import(...)` dinamico (qualunque specifier: non staticamente verificabile).
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      report(node, 'import() dinamico vietato (solo import statici)', 'SECURITY_AST_DYNAMIC_IMPORT');
    }
    // 4) `__proto__` in property-access O element-access computed (prototype pollution).
    if (ts.isPropertyAccessExpression(node) && node.name.text === '__proto__') {
      report(node.name, '__proto__ vietato (prototype pollution)', 'SECURITY_AST_PROTO');
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === '__proto__'
    ) {
      report(node, "accesso computed a '__proto__' vietato (prototype pollution)", 'SECURITY_AST_PROTO');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

/**
 * Scan AST dei 3 sorgenti del custom-node. Ritorna i violations (mai throw — il caller
 * decide hard-fail). Complementare a `securityScan` regex: questa è la rete fine.
 */
export async function astSecurityScan(sources: { executor: string; definition: string; schema: string }): Promise<CompileDiagnostic[]> {
  await ensureTs(); // carica typescript SOLO ora (mai a boot)
  return [
    ...scanOne('executor', sources.executor),
    ...scanOne('definition', sources.definition),
    ...scanOne('schema', sources.schema),
  ];
}
