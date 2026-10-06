import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLeadAlive } from "./jsonl-scanner";

test("isLeadAlive reads Claude Code's sessions/<pid>.json registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  const live = crypto.randomUUID();
  const dead = crypto.randomUUID();
  writeFileSync(
    join(dir, "1.json"),
    JSON.stringify({ pid: process.pid, sessionId: live }),
  );
  writeFileSync(
    join(dir, "2.json"),
    JSON.stringify({ pid: 2 ** 22 + 1, sessionId: dead }), // above pid_max
  );
  writeFileSync(join(dir, "3.json"), "not json");
  const cfg = (id: string) => ({ name: "t", leadSessionId: id, members: [] });

  expect(isLeadAlive(cfg(live), dir)).toBe(true);
  expect(isLeadAlive(cfg(dead), dir)).toBe(false);
  expect(isLeadAlive(cfg(crypto.randomUUID()), dir)).toBe(false);
});
