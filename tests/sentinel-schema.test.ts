import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("standalone watcher schema", () => {
  it("includes deliveryTargets and watcher id format constraints", () => {
    const schemaPath = path.join(process.cwd(), "schema", "sentinel.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

    const watcher = schema?.$defs?.watcher;
    expect(watcher?.properties?.deliveryTargets?.items?.$ref).toBe("#/$defs/deliveryTarget");
    expect(watcher?.properties?.id?.pattern).toBe("^[A-Za-z0-9_-]{1,128}$");
    expect(schema?.$defs?.fire?.properties?.operatorGoal?.maxLength).toBe(20000);
  });

  it("includes evmCall definition and evm-call strategy", () => {
    const schemaPath = path.join(process.cwd(), "schema", "sentinel.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

    expect(schema.$defs.evmCall).toBeDefined();
    expect(schema.$defs.evmCall.properties.to.pattern).toBe("^0x[0-9a-fA-F]{40}$");
    expect(schema.$defs.evmCall.properties.signature).toBeDefined();
    expect(schema.$defs.evmCall.properties.args).toBeDefined();
    expect(schema.$defs.evmCall.properties.blockTag).toBeDefined();

    const watcher = schema.$defs.watcher;
    expect(watcher.properties.evmCall.$ref).toBe("#/$defs/evmCall");
    expect(watcher.properties.strategy.enum).toContain("evm-call");
  });
});
