import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("native workflow administration source contract", () => {
  it("requires a safe n8n production webhook before exposure", () => {
    const source = readFileSync(
      join(process.cwd(), "apps/web/src/pages/admin/Workflows.tsx"),
      "utf8",
    );
    expect(source).toContain("Production webhook path");
    expect(source).toContain("/webhook/your-production-path");
    expect(source).toContain("Test webhook paths are refused");
    expect(source).toContain("/n8n-webhook");
    expect(source).toContain("Register webhook");
    expect(source).toContain("!w.execution_ref");
  });
});
