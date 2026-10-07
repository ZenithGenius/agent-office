import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSendMessages, isLeadAlive, needsYou } from "./jsonl-scanner";

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

test("needsYou is true for waitingFor or known waiting statuses", () => {
  expect(needsYou(undefined, "approve")).toBe(true);
  expect(needsYou(undefined, "")).toBe(false);
  expect(needsYou("waiting", undefined)).toBe(true);
  expect(needsYou("blocked", undefined)).toBe(true);
  expect(needsYou("needs_user", undefined)).toBe(true);
  expect(needsYou("needs_trust", undefined)).toBe(true);
  expect(needsYou("running", undefined)).toBe(false);
  expect(needsYou("idle", undefined)).toBe(false);
});

test("extractSendMessages finds every SendMessage tool_use block", () => {
  const rec = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "pinging" },
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/tmp/x" },
        },
        {
          type: "tool_use",
          name: "SendMessage",
          input: {
            to: "Yumi",
            message: "hello teammate\nsecond line",
          },
        },
        {
          type: "tool_use",
          name: "SendMessage",
          input: { to: "Dev", message: "a".repeat(250) },
        },
      ],
    },
  };

  const events = extractSendMessages(
    rec,
    "Odoo-Manager",
    "2026-01-01T00:00:00.000Z",
  );
  expect(events).toEqual([
    {
      from: "Odoo-Manager",
      to: "Yumi",
      text: "hello teammate",
      time: "2026-01-01T00:00:00.000Z",
    },
    {
      from: "Odoo-Manager",
      to: "Dev",
      text: "a".repeat(200),
      time: "2026-01-01T00:00:00.000Z",
    },
  ]);
  expect(extractSendMessages({ type: "user" }, "X")).toEqual([]);
});
