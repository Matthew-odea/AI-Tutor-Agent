import { describe, it, expect } from 'vitest';

// Channel tokens hold bare `R G B` triplets for Tailwind's alpha modifiers, so a raw
// var(--color-x) in an SVG attribute or inline style is not a valid colour and renders
// nothing. Such uses must go through rgb(var(...)) or a *-solid token.
const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Every token Tailwind wraps as rgb(var(--x) / <alpha-value>) is a channel triplet.
// (Read from the config because Vitest stubs CSS imports, even with ?raw.)
const tailwindConfig = Object.values(
  import.meta.glob('../../tailwind.config.js', { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
  >
)[0] ?? '';

function channelTokens(): string[] {
  const names = new Set<string>();
  for (const m of tailwindConfig.matchAll(/rgb\(var\((--[\w-]+)\) \/ <alpha-value>\)/g)) names.add(m[1]);
  return [...names];
}

describe('colour token usage', () => {
  it('finds the channel tokens in the Tailwind config', () => {
    expect(channelTokens()).toContain('--color-accent');
  });

  it('never uses a channel token as a bare var() outside rgb()', () => {
    const tokens = channelTokens();
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      for (const token of tokens) {
        const bare = new RegExp(`(?<!rgb\\()var\\(${token}\\)`, 'g');
        if (bare.test(src)) offenders.push(`${file}: var(${token})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
