import { test, expect } from 'claude-code/testing';

test('passes rule-derived decisions through untouched', async ($, on) => {
    on('tool.check', () => ({ decision: 'allow', reason: 'settings allowlist' }));
    const ran = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } });
    expect(ran.decision).toBe('allow');
    expect(ran.reason).toBe('settings allowlist');
});

test('passes rule denies through untouched', async ($, on) => {
    on('tool.check', () => ({ decision: 'deny', reason: 'settings denylist' }));
    const ran = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } });
    expect(ran.decision).toBe('deny');
    expect(ran.reason).toBe('settings denylist');
});

test('an unreachable clef leaves an ask to the built-in decider', { options: { transport: 'http', endpoint: 'http://127.0.0.1:9/v1/systemone', timeoutMs: 1000 } }, async ($, on) => {
    on('tool.check', () => ({ decision: 'ask' }));
    on('classic.UserPromptSubmit', () => ({}));
    await $.classic.UserPromptSubmit({ permission_mode: 'auto', prompt: 'hello' });
    const ran = await $.tool.check({
        tool: 'Bash',
        input: { command: 'rm -rf /tmp/scratch' },
    });
    expect(ran.decision).toBe('ask');
});

test('stays out of non-auto modes', async ($, on) => {
    on('tool.check', () => ({ decision: 'ask' }));
    on('classic.UserPromptSubmit', () => ({}));
    await $.classic.UserPromptSubmit({ permission_mode: 'default', prompt: 'hello' });
    const ran = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } });
    expect(ran.decision).toBe('ask');
});
