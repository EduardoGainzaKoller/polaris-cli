/**
 * What the user's request authorises, for this task only.
 *
 * A request to implement, fix, refactor or test something authorises the
 * ordinary edits that work needs; a request to analyse, explain or look at
 * something does not. The authorisation is derived from the user's own
 * message by Polaris — the model's output never feeds it, so a model cannot
 * grant itself write access by saying it needs it.
 *
 * It reads the request's shape, not its keywords: each clause is checked for
 * an instruction (an imperative, or "can you…", "quiero que…") to change
 * something, questions and hypotheticals are not instructions, and a
 * negation ("don't change anything") wins. When unsure it says "analysis":
 * an edit then asks, which costs one approval — never an unwanted change.
 *
 * ponytail: a lexicon of English and Spanish verbs, not a language model.
 * A request phrased some other way lands on "analysis" and asks for edits.
 */
export type Intent =
  | 'implementation'
  | 'bugfix'
  | 'refactor'
  | 'testing'
  | 'analysis'
  | 'explanation'
  | 'verification';

export interface TaskAuthorization {
  readonly intent: Intent;
  readonly inspectWorkspace: true;
  /** Ordinary edits inside the workspace, without asking. */
  readonly modifyWorkspace: boolean;
  readonly createFiles: boolean;
  /**
   * Running project code (tests, builds). Never granted by intent yet: every
   * such command still asks. Kept so the shape does not change when it is.
   */
  readonly executeProjectCode: false;
  /** True when this request continued the previous task rather than starting one. */
  readonly continued: boolean;
}

export const ANALYSIS: TaskAuthorization = task('analysis', false);

export function task(intent: Intent, modify: boolean, continued = false): TaskAuthorization {
  return {
    intent,
    inspectWorkspace: true,
    modifyWorkspace: modify,
    createFiles: modify,
    executeProjectCode: false,
    continued,
  };
}

/** Authorises the task a user request asks for, given the one before it. */
export function authorizeTask(
  request: string,
  previous: TaskAuthorization | null,
): TaskAuthorization {
  const text = normalize(request);
  const words = text.split(/\s+/).filter(Boolean);

  // "Sigue", "go ahead", "ok": the same task, with the same scope.
  if (words.length <= 6 && words.length > 0 && isContinuation(text)) {
    return previous ? { ...previous, continued: true } : ANALYSIS;
  }
  if (NEGATION.test(text)) return classifyReading(text);

  let found: Intent | null = null;
  for (const clause of clauses(text)) {
    const intent = changeIn(clause);
    if (intent && (!found || RANK[intent] > RANK[found])) found = intent;
  }
  if (found) return task(found, true);
  return classifyReading(text);
}

// ------------------------------------------------------------- the rules

/** Accents and case folded, so "Corrígela" and "corrigela" read the same. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[`"'*_]/g, ' ')
    .trim();
}

function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?;:\n])|,|\s(?:y|and|then|luego|despues|tambien|also)\s/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/** Words that open a request to change something: imperative or polite. */
const REQUEST = /^(?:please|por favor|pls)\s+/;
const POLITE =
  /^(?:(?:can|could|would|will) you|i (?:want|need|would like) you to|(?:puedes|podrias|quieres|puede|podria)|(?:quiero|necesito|me gustaria) que)\s+/;

/**
 * Change verbs as they open a clause: English imperative, Spanish imperative
 * and infinitive, and — after "quiero que" / "puedes" — Spanish subjunctive.
 * Each maps to the intent it most often means.
 */
const VERBS: Array<[RegExp, Intent]> = [
  [
    /^(?:fix|repair|debug|patch|corrig\w*|corrij\w*|arregl\w*|repar\w*|soluciona\w*|solucion\w*)$/,
    'bugfix',
  ],
  [
    /^(?:refactor\w*|rename|renombr\w*|simplif\w*|clean|limpia\w*|extract|extrae\w*|reorganiz\w*)$/,
    'refactor',
  ],
  [/^(?:test|testea\w*)$/, 'testing'],
  [
    /^(?:implement\w*|add|anad\w*|agreg\w*|create|crea|crear|cree\w*|write|escrib\w*|update|actualiz\w*|actualic\w*|modify|modific\w*|modifiqu\w*|change|cambi\w*|remove|delete|elimin\w*|borr\w*|quit\w*|replace|reemplaz\w*|sustitu\w*|move|muev\w*|mover|generate|genera\w*|integrate|integra\w*|migrate|migra\w*|convert|conviert\w*|convertir|make|haz|hacer|build|construy\w*|adjust|ajust\w*|improve|mejora\w*|optimi[sz]e\w*|optimiz\w*|complete|complet\w*|finish|termin\w*|edit|edita\w*|bump|upgrade|set up|configura\w*|pon|poner|document\w*|support)$/,
    'implementation',
  ],
];

/** Which intent wins when a request has several: the most specific. */
const RANK: Record<Intent, number> = {
  analysis: 0,
  explanation: 0,
  verification: 0,
  implementation: 1,
  refactor: 2,
  bugfix: 2,
  testing: 3,
};

/** Enclitic pronouns: "corrígela", "impleméntalo", "añádeselo". */
const CLITIC = /(?:selo|sela|selos|selas|melo|mela|lo|la|los|las|le|les|me|nos)$/;

function changeIn(clause: string): Intent | null {
  const question = clause.endsWith('?') || clause.startsWith('¿') || QUESTION.test(clause);
  let rest = clause.replace(/^[¿¡\s]+/, '').replace(REQUEST, '');
  const polite = POLITE.test(rest);
  // A question is not an instruction — unless it is a polite one.
  if (question && !polite) return null;
  rest = rest.replace(POLITE, '');
  const first = (rest.split(/\s+/)[0] ?? '').replace(/[.,;:!?¡¿]+$/, '');
  const candidates = [first, first.replace(CLITIC, '')];
  for (const word of candidates) {
    for (const [pattern, intent] of VERBS) {
      if (!pattern.test(word)) continue;
      // "Add tests", "crea los tests": the testing kind of change.
      if (intent === 'implementation' && /\b(?:tests?|pruebas?|specs?)\b/.test(clause))
        return 'testing';
      return intent;
    }
  }
  // "I'd like tests for X" and friends are left to the conservative default.
  return null;
}

const QUESTION =
  /^(?:how|what|why|which|where|when|who|is|are|does|do|should|como|que|por que|porque|cual|cuales|donde|cuando|quien|es|son|deberia|hay)\b/;

/** "Don't change anything", "sin modificar": the request says so itself. */
const NEGATION =
  /\b(?:(?:do not|don t|dont|never|without) (?:change|modify|edit|touch|write)\w*|no (?:modifiques|cambies|toques|edites|escribas|modifique|cambie)|sin (?:modificar|cambiar|tocar|editar)|read[- ]only|solo lectura)\b/;

const EXPLAIN =
  /\b(?:explain\w*|explica\w*|what does|que hace|como funciona|how does|describe\w*|describ\w*|teach|ensena\w*)\b/;

function classifyReading(text: string): TaskAuthorization {
  return EXPLAIN.test(text) ? task('explanation', false) : ANALYSIS;
}

const CONTINUE =
  /^(?:sigue|continua|continue|go on|go ahead|carry on|keep going|proceed|adelante|dale|hazlo|do it|ok|okay|vale|yes|si|sure|perfecto|venga)\b/;

function isContinuation(text: string): boolean {
  return CONTINUE.test(text.replace(/^[¿¡\s]+/, ''));
}
