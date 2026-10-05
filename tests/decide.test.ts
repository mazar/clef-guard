import { test, expect } from 'claude-code/testing';
import { decide, parseClefAnswers, type ClefAnswers } from '../lib/decide';

const T = { allowThreshold: 0.7, denyThreshold: 0.7, harmThreshold: 0.5 };

const answersOf = (
    choice: string,
    pAllow: number,
    pDeny: number,
    pUncertain: number,
    harm?: number,
    conf = 0.8,
): ClefAnswers => ({
    verdict: {
        type: 'choice',
        choice,
        probabilities: { allow: pAllow, deny: pDeny, uncertain: pUncertain },
        confidence: conf,
    },
    ...(harm === undefined ? {} : { harm: { type: 'noul', noul: harm } }),
});

test('allows a confident benign verdict', () => {
    const out = decide(answersOf('allow', 0.95, 0.03, 0.02, 0.01), T);
    expect(out.decision).toBe('allow');
});

test('a confident harm reading vetoes an allow', () => {
    const out = decide(answersOf('allow', 0.95, 0.03, 0.02, 0.9), T);
    expect(out.decision).toBe('ask');
});

test('denies a confident harmful verdict', () => {
    const out = decide(answersOf('deny', 0.02, 0.93, 0.05, 0.8), T);
    expect(out.decision).toBe('deny');
});

test('deny below threshold but harm high still denies', () => {
    const out = decide(answersOf('deny', 0.2, 0.5, 0.3, 0.8), T);
    expect(out.decision).toBe('deny');
});

test('uncertain verdict falls through to ask', () => {
    const out = decide(answersOf('uncertain', 0.4, 0.35, 0.25, 0.2), T);
    expect(out.decision).toBe('ask');
});

test('allow below threshold falls through to ask', () => {
    const out = decide(answersOf('allow', 0.55, 0.25, 0.2, 0.1), T);
    expect(out.decision).toBe('ask');
});

test('deny below threshold with low harm falls through to ask', () => {
    const out = decide(answersOf('deny', 0.1, 0.5, 0.4, 0.1), T);
    expect(out.decision).toBe('ask');
});

test('missing or mistyped verdict answers fall through to ask', () => {
    expect(decide({}, T).decision).toBe('ask');
    expect(decide({ verdict: { type: 'noul', noul: 0.5 } } as ClefAnswers, T).decision).toBe('ask');
    expect(
        decide({ verdict: { type: 'choice', choice: 'weird', probabilities: {} } }, T).decision,
    ).toBe('ask');
});

test('parses a real clef response body', () => {
    const answers = parseClefAnswers(
        '{"model":"clef","answers":{"harm":{"type":"noul","noul":0.951344590977716}},"usage":{"input_tokens":162,"output_tokens":0}}',
    );
    expect(answers.harm?.noul).toBeGreaterThan(0.9);
});

test('rejects an ollama error body and a non-JSON body', () => {
    expect(() => parseClefAnswers('{"error":"model not found"}')).toThrow(/model not found/);
    expect(() => parseClefAnswers('{"code":"loopback-only","error":"plaintext requests are accepted only from loopback"}')).toThrow(
        /loopback/,
    );
    expect(() => parseClefAnswers('gateway timeout')).toThrow(/not JSON/);
});
