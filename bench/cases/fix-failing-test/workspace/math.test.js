import assert from "node:assert/strict";
import test from "node:test";
import { add } from "./math.js";

test("add sums positive numbers", () => {
	assert.equal(add(2, 3), 5);
});

test("add handles negative numbers", () => {
	assert.equal(add(-2, 3), 1);
});
