/**
 * Read a setting from the real environment.
 *
 * Deliberately `process.env` only: reading `import.meta.env[name]` makes Vite
 * inline the whole env object into the server bundle, baking a local `.env`
 * into the build. `pnpm dev` sources `.env` into the environment instead.
 *
 * Values pasted into a hosting dashboard keep their quotes and pick up stray
 * newlines; both would silently break a comparison, so they are normalised.
 */
export function env(name: string): string | undefined {
  const value = process.env[name]
    ?.trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .trim();
  return value || undefined;
}
