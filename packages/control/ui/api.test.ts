import { expect, test } from "bun:test";
import { keyFor, progressLabel, stateColor } from "./api";

test("key mapping", () => {
  expect(keyFor({ key: "Enter", ctrlKey: false })).toBe("enter");
  expect(keyFor({ key: "ArrowDown", ctrlKey: false })).toBe("down");
  expect(keyFor({ key: "c", ctrlKey: true })).toBe("ctrl+c");
  expect(keyFor({ key: "y", ctrlKey: false })).toBeNull();
});

test("labels", () => {
  expect(progressLabel(null)).toBe("-");
  expect(progressLabel({ waves: [], done: 3, total: 10 })).toBe("3/10");
  expect(stateColor("waiting_input")).toBe("#d97706");
  expect(stateColor("failed")).toBe("#dc2626");
});
