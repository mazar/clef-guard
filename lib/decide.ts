/**
 * The decision policy over clef's answers.
 *
 * clef's `/v1/systemone` takes `{ model, state, questions }` and answers
 * `{ model, answers: { <name>: <answer> }, usage }`. This mod asks two named
 * questions and reads their answers here:
 *
 *   verdict — `choice` over allow / deny / uncertain:
 *     `{ type: 'choice', choice, probabilities, confidence }`
 *   harm    — `noul`, the probability the statement is true:
 *     `{ type: 'noul', noul }`
 */

export type ClefChoiceAnswer = {
    type?: string;
    choice?: string;
    probabilities?: Record<string, number>;
    confidence?: number;
};

export type ClefNoulAnswer = {
    type?: string;
    noul?: number;
};

export type ClefAnswers = {
    verdict?: ClefChoiceAnswer;
    harm?: ClefNoulAnswer;
    [name: string]: unknown;
};

export type Thresholds = {
    allowThreshold: number;
    denyThreshold: number;
    harmThreshold: number;
};

export type Decision = 'allow' | 'deny' | 'ask';

export type Verdict = {
    decision: Decision;
    reason: string;
};

const fmt = (p: number | undefined): string => (typeof p === 'number' ? p.toFixed(2) : 'n/a');

/**
 * Parses a `/v1/systemone` response body into its answers, or throws naming
 * why it could not. Handles ollama's error bodies (`{ error }`) and the
 * ingress refusal shapes (`{ code, error }`) alike.
 */
export function parseClefAnswers(body: string): ClefAnswers {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error(`response is not JSON: ${body.slice(0, 120)}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(`response is not an object: ${body.slice(0, 120)}`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.error !== undefined) {
        throw new Error(
            typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error).slice(0, 200),
        );
    }
    if (obj.answers === undefined || typeof obj.answers !== 'object' || obj.answers === null) {
        throw new Error(`response has no answers: ${body.slice(0, 120)}`);
    }
    return obj.answers as ClefAnswers;
}

/**
 * The policy, from the two answers:
 *
 *   1. allow — clef chose `allow` at or above `allowThreshold` and harm read
 *      below `harmThreshold` (a confident harm reading vetoes the allow);
 *   2. deny  — clef chose `deny` at or above `denyThreshold`, or harm read at
 *      or above `harmThreshold`;
 *   3. else `ask` — the stock pipeline decides (built-in classifier, dialog).
 *
 * Never denies on a low-signal state: an `uncertain` choice, a missing
 * answer or a verdict below threshold all fall through to `ask`.
 */
export function decide(answers: ClefAnswers, t: Thresholds): Verdict {
    const verdict = answers.verdict;
    if (!verdict || verdict.type !== 'choice' || typeof verdict.choice !== 'string') {
        return { decision: 'ask', reason: 'clef gave no verdict choice' };
    }
    const probs = verdict.probabilities ?? {};
    const pOf = (name: string): number | undefined =>
        typeof probs[name] === 'number' ? probs[name] : undefined;
    const harm =
        answers.harm && answers.harm.type === 'noul' && typeof answers.harm.noul === 'number'
            ? answers.harm.noul
            : undefined;
    const conf = typeof verdict.confidence === 'number' ? verdict.confidence : undefined;

    if (verdict.choice === 'allow') {
        const p = pOf('allow');
        if (p !== undefined && p >= t.allowThreshold && (harm ?? 0) < t.harmThreshold) {
            return {
                decision: 'allow',
                reason: `clef: allow (p=${fmt(p)}, harm=${fmt(harm)}, conf=${fmt(conf)})`,
            };
        }
    }
    if (verdict.choice === 'deny') {
        const p = pOf('deny');
        if ((p !== undefined && p >= t.denyThreshold) || (harm ?? 0) >= t.harmThreshold) {
            return {
                decision: 'deny',
                reason: `clef: deny (p=${fmt(p)}, harm=${fmt(harm)}, conf=${fmt(conf)})`,
            };
        }
    }
    return {
        decision: 'ask',
        reason: `clef: ${verdict.choice} below threshold (harm=${fmt(harm)}, conf=${fmt(conf)})`,
    };
}
