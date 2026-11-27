/** Text returned to the client. Connection strings stay off the response. */
export function publicErrorMessage(
  err: { message?: string } | null | undefined,
  status: number,
): string {
  let message = err?.message?.trim() ?? "";
  message = message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://…");
  if (message.length > 300) message = `${message.slice(0, 300)}…`;
  if (status >= 500) {
    if (!message || message === "Internal Server Error") return "Internal Server Error";
    return message;
  }
  return message || `Request failed (${status})`;
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}
