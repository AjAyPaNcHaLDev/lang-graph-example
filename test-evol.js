
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const APP = new URL("./index.js", import.meta.url);

// Increase this if your local Ollama model is slow.
const TIMEOUT_MS = 120_000;

/**
 * Run EVOL with terminal input and capture its output.
 */
function runEVOL(questions) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [APP.pathname],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }
    );

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        new Error(`EVOL timed out after ${TIMEOUT_MS} ms`)
      );
    }, TIMEOUT_MS);

    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => finish(error));

    child.on("close", (code) => {
      finish(null, {
        code,
        stdout,
        stderr,
        output: stdout + "\n" + stderr,
      });
    });

    // Feed the entire conversation into the interactive terminal.
    child.stdin.end([...questions, "exit"].join("\n") + "\n");
  });
}

function toolCalls(output) {
  return [
    ...output.matchAll(/Tool:\s*([a-zA-Z0-9_]+)/g),
  ].map((match) => match[1]);
}

function executedTools(output) {
  return [
    ...output.matchAll(/🔧 TOOL:\s*([a-zA-Z0-9_]+)/g),
  ].map((match) => match[1]);
}

function assertNoFakeCancellation(output) {
  assert.doesNotMatch(
    output,
    /\b(?:I can use|I have|I will use|I've used)\s+(?:the\s+)?`?cancel_(?:item|order)`?\s+tool\b/i,
    "EVOL must not claim a cancellation tool exists."
  );

  assert.doesNotMatch(
    output,
    /\b(?:cancelled|canceled)\s+(?:successfully|your order|the order|the item)\b/i,
    "EVOL must not claim an unimplemented cancellation succeeded."
  );
}

// ==================================================
// TEST 1: Greeting must not trigger a tool
// ==================================================

test("Greeting does not call order tools", async () => {
  const result = await runEVOL(["hi"]);

  assert.equal(result.code, 0, result.output);

  assert.deepEqual(
    executedTools(result.output),
    [],
    "A greeting should not execute any tools."
  );

  assert.match(
    result.output,
    /Hi!|Hello|How can I help/i,
    "EVOL should answer the greeting naturally."
  );
});

// ==================================================
// TEST 2: List orders uses the correct tool
// ==================================================

test("Listing orders uses list_orders", async () => {
  const result = await runEVOL([
    "list out all orders",
  ]);

  assert.equal(result.code, 0, result.output);

  assert.ok(
    executedTools(result.output).includes("list_orders"),
    "EVOL should execute list_orders."
  );

  assert.ok(
    !executedTools(result.output).includes("get_shipping_status"),
    "EVOL must not use shipping lookup to list orders."
  );

  assert.match(
    result.output,
    /ORD101/,
    "The order list should include ORD101."
  );

  assert.match(
    result.output,
    /ORD102/,
    "The order list should include ORD102."
  );
});

// ==================================================
// TEST 3: Item questions use order details
// ==================================================

test("Item question uses get_order_details", async () => {
  const result = await runEVOL([
    "How many items did I order in ORD101?",
  ]);

  assert.equal(result.code, 0, result.output);

  assert.ok(
    executedTools(result.output).includes("get_order_details"),
    "EVOL should retrieve the order details."
  );

  assert.match(
    result.output,
    /ORD101/,
    "The answer should refer to ORD101."
  );

  assert.match(
    result.output,
    /\b3\b/,
    "ORD101 contains three individual items."
  );
});

// ==================================================
// TEST 4: Unsupported cancellation is rejected
// ==================================================

test("Cancellation is rejected without calling a tool", async () => {
  const result = await runEVOL([
    "Can I cancel the first item in ORD101?",
  ]);

  assert.equal(result.code, 0, result.output);

  assert.deepEqual(
    executedTools(result.output),
    [],
    "Cancellation must not execute any tool."
  );

  assert.match(
    result.output,
    /cannot cancel|not supported|no cancellation capability/i,
    "EVOL should explain that cancellation is unsupported."
  );

  assertNoFakeCancellation(result.output);
});

// ==================================================
// TEST 5: Asking about a nonexistent tool
// ==================================================

test("EVOL does not claim cancel_item exists", async () => {
  const result = await runEVOL([
    "Do you have a tool to cancel a mouse?",
  ]);

  assert.equal(result.code, 0, result.output);

  assert.deepEqual(
    executedTools(result.output),
    [],
    "The unsupported action should not execute a tool."
  );

  assertNoFakeCancellation(result.output);

  assert.match(
    result.output,
    /cannot cancel|not supported|no cancellation capability/i,
    "EVOL should explain its actual limitations."
  );
});

// ==================================================
// TEST 6: Follow-up refers to the correct order
// ==================================================

test("Follow-up uses ORD102, not ORD101", async () => {
  const result = await runEVOL([
    "Where is my order ORD101?",
    "Where is my order ORD102?",
    "How many items are in that order?",
  ]);

  assert.equal(result.code, 0, result.output);

  const calls = result.output.match(
    /Tool:\s*get_order_details[\s\S]*?Arguments:\s*(\{[^\n]*\})/
  );

  assert.ok(
    calls,
    "EVOL should request order details for the follow-up."
  );

  const args = JSON.parse(calls[1]);

  assert.equal(
    args.orderId,
    "ORD102",
    "The follow-up must use the most recently discussed order."
  );

  assert.match(
    result.output,
    /Laptop/,
    "ORD102 contains a Laptop."
  );
});

// ==================================================
// TEST 7: Switching orders does not mix up item names
// ==================================================

test("Order details stay associated with the correct order", async () => {
  const result = await runEVOL([
    "List all orders",
    "Give me all item names in ORD101",
    "Now give me the item names in ORD102",
  ]);

  assert.equal(result.code, 0, result.output);

  const calls = [
    ...result.output.matchAll(
      /Tool:\s*get_order_details\s*\nArguments:\s*(\{[^\n]*\})/g
    ),
  ].map((match) => JSON.parse(match[1]).orderId);

  assert.ok(
    calls.includes("ORD101"),
    "EVOL should look up ORD101."
  );

  assert.ok(
    calls.includes("ORD102"),
    "EVOL should then look up ORD102."
  );

  assertNoFakeCancellation(result.output);
});
