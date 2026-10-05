/**
 * clef-guard: replaces the built-in auto-mode safety classifier with a local
 * clef decision model.
 *
 * Where it stands: `tool.check` fires after the `tool.call` and PreToolUse
 * hooks and before the mode settles an ask. Its hook's answer is the last
 * word, and the engine only asks the auto-mode classifier when the settled
 * decision is `ask`. So this module lets rule-derived `allow`/`deny` verdicts
 * through untouched, and when the verdict is `ask` in `auto` mode it consults
 * clef instead and answers `allow`/`deny` from its probabilities. Anything
 * clef cannot answer — unreachable, error, below threshold — falls through as
 * `ask`, and the stock pipeline (built-in classifier or dialog) decides.
 *
 * A `classic.PermissionRequest` hook is the backstop: when a dialog is about
 * to open in `auto` mode anyway, clef gets one more chance before the person
 * is asked. `/clef` prints the state of it all.
 *
 * `$` flows only through this file's own top-level functions (the engine's
 * scanner requires it): `contextOf`, `clefPost` and `consult`.
 */

import type { Register } from 'claude-code';
import { buildState, QUESTIONS, type ClefConfig } from '../lib/clef';
import { decide, parseClefAnswers, type Thresholds, type Verdict } from '../lib/decide';

const PREFIX = 'clef-guard';

/** Tools whose ask is the person's to answer, whatever clef thinks. */
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** The slice of `$` the consult path needs. */
type ConsultEngine = {
    clock: { now: () => Promise<number> };
    http: {
        fetch: (
            url: string,
            init?: { method?: string; headers?: Record<string, string>; body?: string },
        ) => Promise<{ ok: boolean; status: number; text: string }>;
    };
    process: {
        run: (
            argv: readonly string[],
            init?: { timeoutMs?: number },
        ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };
    session: {
        cwd: () => Promise<string>;
        messages: (args?: unknown) => Promise<unknown>;
    };
    ui: {
        status: (text: string | undefined) => void;
        log: (text: string, options?: { to?: string }) => void;
    };
};

/** The conversation around a call, as clef reads it. */
const contextOf = async ($: ConsultEngine): Promise<string> => {
    try {
        const cwd = await $.session.cwd();
        const rows = (await $.session.messages()) as { role?: string; text?: string }[] | undefined;
        const recent = (Array.isArray(rows) ? rows.slice(-4) : [])
            .map((m) => `${m.role ?? '?'}: ${String(m.text ?? '').slice(0, 300)}`)
            .join('\n');
        return `cwd: ${cwd}${recent ? `\nrecent conversation:\n${recent}` : ''}`;
    } catch {
        return '';
    }
};

/** The transport: POST the request body, return the response body as text. */
const clefPost = async (
    $: ConsultEngine,
    config: ClefConfig,
    body: string,
): Promise<string> => {
    if (config.transport === 'http') {
        const r = await $.http.fetch(config.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
        return r.text;
    }
    const argv = [
        'curl',
        '-sS',
        '--max-time',
        String(Math.ceil(config.timeoutMs / 1000)),
        '-X',
        'POST',
        '-H',
        'Content-Type: application/json',
        '--data-binary',
        body,
    ];
    if (config.caCert) argv.push('--cacert', config.caCert);
    if (config.clientCert) argv.push('--cert', config.clientCert);
    if (config.clientKey) argv.push('--key', config.clientKey);
    argv.push(config.endpoint);
    const { exitCode, stdout, stderr } = await $.process.run(argv, {
        timeoutMs: config.timeoutMs + 2000,
    });
    if (exitCode !== 0) {
        throw new Error(`curl exit ${exitCode}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`);
    }
    return stdout;
};

/** One clef consult, timed; throws naming the cause and how long it took. */
const consult = async (
    $: ConsultEngine,
    config: ClefConfig,
    thresholds: Thresholds,
    call: { tool: string; input: unknown },
): Promise<{ outcome: Verdict; ms: number }> => {
    const startedAt = await $.clock.now();
    const context = await contextOf($);
    const body = JSON.stringify({
        model: config.model,
        state: buildState({ ...call, context }, config),
        questions: QUESTIONS,
    });
    let text: string;
    try {
        text = await clefPost($, config, body);
    } catch (err) {
        const ms = Math.round((await $.clock.now()) - startedAt);
        throw new Error(`${(err as Error).message} (after ${ms}ms)`);
    }
    const outcome = decide(parseClefAnswers(text), thresholds);
    const ms = Math.round((await $.clock.now()) - startedAt);
    $.ui.log(`${call.tool} -> ${outcome.decision} in ${ms}ms (${outcome.reason})`, { to: 'debug' });
    return { outcome, ms };
};

const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.length > 0 ? v : fallback;
const raw = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

export const register: Register = (on, options) => {
    const config: ClefConfig = {
        endpoint: str(options.endpoint, 'http://192.168.86.86:11434/v1/systemone'),
        model: str(options.model, 'clef'),
        transport: str(options.transport, 'curl'),
        caCert: raw(options.caCert, ''),
        clientCert: raw(options.clientCert, ''),
        clientKey: raw(options.clientKey, ''),
        timeoutMs: num(options.timeoutMs, 8000),
        maxStateChars: num(options.maxStateChars, 48000),
    };
    const thresholds: Thresholds = {
        allowThreshold: num(options.allowThreshold, 0.7),
        denyThreshold: num(options.denyThreshold, 0.7),
        harmThreshold: num(options.harmThreshold, 0.5),
    };
    const enforce = bool(options.enforce, true);

    // The session's permission mode, as the classic hooks last saw it (they
    // carry `permission_mode`; the native `tool.check` input does not). The
    // next prompt refreshes it; a reload resets it to unknown, and unknown
    // never intercepts — the stock pipeline stands.
    let mode: string | undefined;
    let modeAt = '';
    let last: { at: string; tool: string; decision: string; reason: string; ms: number } | undefined;
    let lastError: string | undefined;

    const setMode = (value: unknown): void => {
        if (typeof value === 'string') {
            mode = value;
            modeAt = new Date().toISOString();
        }
    };

    const record = (tool: string, decision: string, reason: string, ms: number): void => {
        last = { at: new Date().toISOString(), tool, decision, reason, ms };
    };

    on('tool.check', async ($, e, next) => {
        const verdict = await next(e);
        if (verdict.decision !== 'ask') return verdict;
        if (INTERACTIVE_TOOLS.has(e.tool)) return verdict;
        if (mode !== 'auto') return verdict;

        try {
            const { outcome, ms } = await consult($, config, thresholds, {
                tool: e.tool,
                input: e.input,
            });
            record(e.tool, outcome.decision, outcome.reason, ms);
            lastError = undefined;
            if (!enforce) {
                $.ui.status(`${PREFIX}: would ${outcome.decision} ${e.tool} — ${outcome.reason}`);
                return verdict;
            }
            if (outcome.decision === 'ask') {
                $.ui.status(`${PREFIX}: uncertain ${e.tool} — ${outcome.reason}`);
                return verdict;
            }
            $.ui.status(`${PREFIX}: ${outcome.decision} ${e.tool} — ${outcome.reason}`);
            return { decision: outcome.decision, reason: outcome.reason };
        } catch (err) {
            lastError = (err as Error).message;
            record(e.tool, 'ask', lastError, 0);
            $.ui.status(`${PREFIX}: unreachable — the built-in decider handles this ask`);
            return verdict;
        }
    });

    on('classic.PermissionRequest', async ($, e, next) => {
        setMode(e.permission_mode);
        if (mode !== 'auto') return next(e);
        // A dialog is about to open in auto mode: clef decided nothing on
        // tool.check (unreachable, or its verdict fell below threshold). One
        // more chance before the person is asked; the dialog is the fallback.
        try {
            const { outcome } = await consult($, config, thresholds, {
                tool: e.tool_name,
                input: e.tool_input,
            });
            if (!enforce || outcome.decision === 'ask') return next(e);
            record(e.tool_name, outcome.decision, outcome.reason, 0);
            $.ui.status(`${PREFIX}: ${outcome.reason}`);
            if (outcome.decision === 'allow') return { decision: { behavior: 'allow' as const } };
            return { decision: { behavior: 'deny' as const, message: outcome.reason } };
        } catch (err) {
            lastError = (err as Error).message;
            return next(e);
        }
    });

    on('classic.UserPromptSubmit', async ($, e, next) => {
        setMode(e.permission_mode);
        return next(e);
    });

    on('session.start', async ($, e, next) => {
        await $.command.register({
            name: 'clef',
            description: 'Show clef-guard status: endpoint, mode, last verdict',
        });
        $.ui.log(
            `${PREFIX} active: ${config.endpoint} (transport ${config.transport}, model ${config.model}, enforce ${enforce})`,
            { to: 'debug' },
        );
        return next(e);
    });

    on('command.run', { command: 'clef' }, async () => {
        const lines = [
            `(enforce: ${enforce})`,
            `endpoint:   ${config.endpoint}`,
            `transport:  ${config.transport}${config.clientCert ? ' (mTLS)' : ''}, model: ${config.model}`,
            `thresholds: allow>=${thresholds.allowThreshold}, deny>=${thresholds.denyThreshold}, harm>=${thresholds.harmThreshold}`,
            `mode:       ${mode ?? 'unknown yet (set on the next prompt)'}${modeAt ? ` (as of ${modeAt})` : ''}`,
        ];
        if (last) {
            lines.push(
                `last:       ${last.at} ${last.tool} -> ${last.decision} in ${last.ms}ms — ${last.reason}`,
            );
        }
        if (lastError) lines.push(`last error: ${lastError}`);
        return { text: lines.join('\n') };
    });
};
