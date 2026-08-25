/**
 * `community_github` — GitHub REST API (issues + PRs + commits).
 *
 * Credentials: { token: "ghp_..." | "github_pat_..." } via integration vault.
 *
 * @module actions/community-github
 */

import type { NodeModule } from '../types.js';

export const communityGithubNode: NodeModule = {
  def: {
    id: 'community_github',
    type: 'action',
    label: 'GitHub: Issues / PRs / Commits',
    icon: 'github',
    color: '#181717',
    description:
      'Connettore enterprise per GitHub.com (la piattaforma DevOps Microsoft con 100M+ developer attivi, ' +
      'standard de-facto per code hosting open-source e privato, alimentata da una solida API REST stabilizzata ' +
      'dal 2008 e ora estesa con GraphQL v4 per query rich) via API REST v3 ufficiale. Sette operazioni atomiche ' +
      'gestiscono il ciclo di vita issue+PR+commit: createIssue (apertura nuova segnalazione con title, body ' +
      'markdown, labels array, assignees array, milestone, reactions iniziali), listIssues (paginated con filtri ' +
      'compound state/labels/assignee/since per dashboard interne), createPullRequest (apertura PR con head→base ' +
      'branch, draft mode optional, body markdown con auto-link a issue tramite "Closes #N", reviewers + ' +
      'team_reviewers assegnati), listCommits (storico commit di un branch/path per audit/changelog auto), ' +
      'getIssue (fetch puntuale con full body + comments + timeline events), closeIssue (con motivazione "completed" ' +
      'o "not planned" GitHub 2023+), addComment (markdown body con embedded link e mentioni @user/@team che ' +
      'triggerano notify GitHub). ' +
      'Auth via Personal Access Token classico (formato ghp_xxxxxxxx, scopes: repo, workflow) o fine-grained ' +
      '(formato github_pat_xxxxxxxx, scopes per-repository granular: contents read/write, issues read/write, pull_requests ' +
      'read/write, metadata read — raccomandato per security minima esposizione 2024+). Token stored nel vault ' +
      'integration FlowForge con label leggibile (es. "github-org-acme-prod-bot"). ' +
      'Rate limiting GitHub: 5000 req/h authenticated (1.4 RPS sustained) per user/PAT, 15000 req/h per ' +
      'GitHub App, 60 req/h anonymous (mai usato in produzione). Header X-RateLimit-Remaining tracked dal nodo, ' +
      'auto-backoff quando < 100 remaining per evitare burst saturation, retry exponential su 429 con header ' +
      'Retry-After. ' +
      'Conditional requests (ETag + If-None-Match) usate quando possibile per non consumare rate limit su risorse ' +
      'invariate (es. listCommits del mainstream). ' +
      'GraphQL API NON usata da questo nodo (più powerful per query annidate ma 5× più complessa da configurare ' +
      'per non-developer — disponibile via action_http custom per power user). ' +
      'API docs: docs.github.com/en/rest (REST API v3 stable). ' +
      'Use case: bug report automatico da error handler workflow → createIssue su repo "support" con title "{{error.code}}: ' +
      '{{summary}}" body markdown con stack trace + run_id link al run viewer dashboard tenant; PR auto-creation ' +
      'post-commit successful tramite CI workflow del flow upgrade automatic; sync bidirezionale issue tra Linear ' +
      'workspace e GitHub repository (label sync, status sync, assignee sync con OAuth user mapping); monitoraggio ' +
      'commit storia su mainstream per audit di compliance ISO 27001 (chi ha committato cosa quando); creation ' +
      'automatic di changelog markdown da listCommits filtrati per merge commit del release branch tra due tag.',
    configFields: [
      {
        key: 'integrationLabel',
        label: 'Etichetta integration (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'main-account',
        help: 'Default null. Per multi-account usa label.',
      },
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        defaultValue: 'createIssue',
        options: [
          'createIssue',
          'listIssues',
          'getIssue',
          'closeIssue',
          'addComment',
          'createPullRequest',
          'listCommits',
        ],
        help: 'Tipo di azione GitHub da eseguire.',
      },
      {
        key: 'owner',
        label: 'Owner (user/org)',
        type: 'expression',
        required: true,
        placeholder: 'flowforge',
        help: 'Owner del repo (user o organization). Required.',
      },
      {
        key: 'repo',
        label: 'Nome repository',
        type: 'expression',
        required: true,
        placeholder: 'flowforge-platform',
        help: 'Nome del repo (no owner prefix). Required.',
      },
      {
        key: 'title',
        label: 'Titolo (per createIssue/createPullRequest)',
        type: 'expression',
        required: false,
        help: 'Required per createIssue + createPullRequest.',
      },
      {
        key: 'body',
        label: 'Body markdown (per createIssue/PR/addComment)',
        type: 'expression',
        required: false,
        help: 'Markdown supportato. Required per createIssue/createPullRequest/addComment.',
      },
      {
        key: 'issueNumber',
        label: 'Issue/PR number (per getIssue/closeIssue/addComment)',
        type: 'expression',
        required: false,
        placeholder: '42',
        help: 'Numero issue o PR. Required per getIssue/closeIssue/addComment.',
      },
      {
        key: 'labels',
        label: 'Labels (comma-separated, per createIssue)',
        type: 'expression',
        required: false,
        placeholder: 'bug,production',
        help: 'Labels da applicare a createIssue. Labels inesistenti skip (warning).',
      },
      {
        key: 'assignees',
        label: 'Assignees (comma-separated logins)',
        type: 'expression',
        required: false,
        placeholder: 'alice,bob',
        help: 'GitHub usernames da assegnare a issue/PR.',
      },
      {
        key: 'baseBranch',
        label: 'Base branch (per createPullRequest)',
        type: 'expression',
        required: false,
        defaultValue: 'main',
        help: 'Branch target del PR (default main).',
      },
      {
        key: 'headBranch',
        label: 'Head branch (per createPullRequest)',
        type: 'expression',
        required: false,
        placeholder: 'feature/xyz',
        help: 'Branch sorgente del PR. Required per createPullRequest.',
      },
      {
        key: 'perPage',
        label: 'Items per page (per list operations)',
        type: 'number',
        required: false,
        defaultValue: '30',
        help: 'Max 100 (hard cap GitHub). Default 30.',
      },
      {
        key: 'state',
        label: 'Filtro state (per listIssues)',
        type: 'select',
        required: false,
        defaultValue: 'open',
        options: ['open', 'closed', 'all'],
        help: 'State filter per listIssues.',
      },
    ],
    outputs: ['ok', 'data', 'count', 'rateLimitRemaining'],
    outputContract: {
      notes: 'La risposta di GitHub sta tal quale in `data`: la sua forma dipende dall\'operazione, e i campi si leggono da li` — `{{$node.<id>.json.data.<campo>}}`. `rateLimitRemaining` va guardato nei cicli: a zero le chiamate successive falliscono.',
      fields: [
        { name: 'ok', type: 'boolean', desc: 'Se la chiamata e` riuscita.' },
        { name: 'data', type: 'object|array', desc: 'La risposta di GitHub, con la forma che ha per quell\'operazione.' },
        { name: 'count', type: 'number', desc: 'Quanti elementi, quando la risposta e` una lista.' },
        { name: 'rateLimitRemaining', type: 'number|null', desc: 'Quante chiamate restano prima del limite. Null se GitHub non l\'ha dichiarato.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 500 },
  },
};
