import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedAdmin } from "@/lib/admin-auth";

describe("admin auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects the published demo key when ADMIN_RESET_KEY is unset", () => {
    vi.stubEnv("ADMIN_RESET_KEY", "");
    const req = new Request("http://localhost/api/metrics", {
      headers: { "x-admin-reset": "demo-reset-key" },
    });
    expect(isAuthorizedAdmin(req)).toBe(false);
  });

  it("accepts only the configured key", () => {
    vi.stubEnv("ADMIN_RESET_KEY", "real-secret");
    const ok = new Request("http://localhost/api/config", {
      headers: { "x-admin-reset": "real-secret" },
    });
    const bad = new Request("http://localhost/api/config", {
      headers: { "x-admin-reset": "demo-reset-key" },
    });
    expect(isAuthorizedAdmin(ok)).toBe(true);
    expect(isAuthorizedAdmin(bad)).toBe(false);
  });
});
