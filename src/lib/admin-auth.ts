/**
 * Shared admin secret for dashboard mutations (metrics reset, live config).
 */
export function expectedAdminKey(): string {
  if (!process.env.ADMIN_RESET_KEY) {
    console.warn(
      "[admin] ADMIN_RESET_KEY is not set; using insecure demo default 'demo-reset-key'."
    );
  }
  return process.env.ADMIN_RESET_KEY || "demo-reset-key";
}

export function isAuthorizedAdmin(req: Request): boolean {
  const header = req.headers.get("x-admin-reset");
  return header === expectedAdminKey();
}
