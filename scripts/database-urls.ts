const isPlaceholder = (value: string) => /\[(?:SENSITIVE|REDACTED)\]|<[^>]+>|\*{4,}|^(?:redacted|changeme|your[_ -].*)$/i.test(value);

export function sourceDatabaseUrl(environment: Record<string, string | undefined> = process.env) {
  for (const name of ["DATABASE_READ_URL", "DATABASE_URL_UNPOOLED", "DATABASE_URL"]) {
    const value = environment[name]?.trim();
    if (!value || isPlaceholder(value)) continue;
    try {
      const parsed = new URL(value);
      if (["postgres:", "postgresql:"].includes(parsed.protocol) && parsed.hostname && parsed.username && parsed.password && !isPlaceholder(decodeURIComponent(parsed.password))) return value;
    } catch { /* Skip invalid candidates without exposing connection values. */ }
  }
  throw new Error("A usable DATABASE_READ_URL, DATABASE_URL_UNPOOLED or DATABASE_URL is required; empty, redacted and invalid values are not accepted");
}
