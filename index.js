
import { ChatOllama } from "@langchain/ollama";
import { tool } from "@langchain/core/tools";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  StateGraph,
  StateSchema,
  MessagesValue,
  START,
  END,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ==================================================
// STEP 1: Mock database
// ==================================================

const orders = {
  ORD101: {
    orderId: "ORD101",
    status: "Shipped",
    location: "Delhi",
    estimatedDelivery: "2026-10-31",
    items: [
      { itemId: "ITEM101", name: "Keyboard", quantity: 1, price: 1500 },
      { itemId: "ITEM102", name: "Mouse", quantity: 1, price: 500 },
      { itemId: "ITEM103", name: "Mouse", quantity: 1, price: 500 },
    ],
  },

  ORD102: {
    orderId: "ORD102",
    status: "In transit",
    location: "Mumbai",
    estimatedDelivery: "2026-11-02",
    items: [
      { itemId: "ITEM201", name: "Laptop", quantity: 1, price: 55000 },
    ],
  },
};

// ==================================================
// STEP 2: Shared validation
// ==================================================

function normalizeOrderId(orderId) {
  const id = String(orderId ?? "").trim().toUpperCase();

  if (!/^ORD\d+$/.test(id)) {
    return null;
  }

  return id;
}

function findOrder(orderId) {
  const id = normalizeOrderId(orderId);

  if (!id) {
    return {
      error: "A valid order ID is required, such as ORD101.",
    };
  }

  const order = orders[id];

  if (!order) {
    return {
      error: `Order ${id} was not found.`,
    };
  }

  return { order };
}

// ==================================================
// STEP 3: Tool - Get shipping status
// ==================================================

const getShippingStatus = tool(
  async ({ orderId }) => {
    console.log(`\n🔧 TOOL: get_shipping_status(${orderId})`);

    const result = findOrder(orderId);

    if (result.error) {
      return JSON.stringify(result);
    }

    const { order } = result;

    return JSON.stringify({
      orderId: order.orderId,
      status: order.status,
      location: order.location,
      estimatedDelivery: order.estimatedDelivery,
    });
  },
  {
    name: "get_shipping_status",
    description:
      "Read the shipping status, current location, and estimated " +
      "delivery date of a specific order. Use for shipping questions.",
    schema: z.object({
      orderId: z.string().describe("Order ID such as ORD101"),
    }),
  }
);

// ==================================================
// STEP 4: Tool - Get order details
// ==================================================

const getOrderDetails = tool(
  async ({ orderId }) => {
    console.log(`\n🔧 TOOL: get_order_details(${orderId})`);

    const result = findOrder(orderId);

    if (result.error) {
      return JSON.stringify(result);
    }

    const { order } = result;

    const totalItems = order.items.reduce(
      (sum, item) => sum + item.quantity,
      0
    );

    const totalPrice = order.items.reduce(
      (sum, item) => sum + item.quantity * item.price,
      0
    );

    return JSON.stringify({
      orderId: order.orderId,
      items: order.items,
      totalItems,
      totalPrice,
    });
  },
  {
    name: "get_order_details",
    description:
      "Read the items, item IDs, quantities, prices, total quantity, " +
      "and total price for a specific order. Use for questions about " +
      "what was ordered or how many items are in an order.",
    schema: z.object({
      orderId: z.string().describe("Order ID such as ORD101"),
    }),
  }
);

// ==================================================
// STEP 5: Tool - List all orders
// ==================================================

const listOrders = tool(
  async () => {
    console.log("\n🔧 TOOL: list_orders()");

    const result = Object.values(orders).map((order) => ({
      orderId: order.orderId,
      status: order.status,
      location: order.location,
      estimatedDelivery: order.estimatedDelivery,
      totalItems: order.items.reduce(
        (sum, item) => sum + item.quantity,
        0
      ),
    }));

    return JSON.stringify({
      count: result.length,
      orders: result,
    });
  },
  {
    name: "list_orders",
    description:
      "List all orders in the mock database. Use when asked to list " +
      "orders, show order IDs, or count the orders. Takes no arguments.",
    schema: z.object({}),
  }
);

// ==================================================
// STEP 6: Register only supported tools
// ==================================================

const tools = [
  getShippingStatus,
  getOrderDetails,
  listOrders,
];

const supportedToolNames = new Set(tools.map((t) => t.name));

// ==================================================
// STEP 7: Configure Ollama
// ==================================================

const model = new ChatOllama({
  model: "llama3.2:latest",
  temperature: 0,
  baseUrl: "http://127.0.0.1:11434",
});

const modelWithTools = model.bindTools(tools);

// ==================================================
// STEP 8: Graph state
// ==================================================

const AgentState = new StateSchema({
  messages: MessagesValue,
});

// ==================================================
// STEP 9: System prompt
// ==================================================

const systemPrompt = new SystemMessage(`
You are EVOL, a helpful order-support assistant.

AVAILABLE CAPABILITIES:
1. get_shipping_status: read shipping and delivery information.
2. get_order_details: read order items, quantities, IDs, and prices.
3. list_orders: list orders in the mock database.

STRICT RULES:
- You do not have a cancellation tool.
- Never claim that you can cancel orders or items.
- Never claim a cancellation or other modification was performed.
- Do not invent tools, APIs, item IDs, policies, or database results.
- Do not invent restrictions based on an item's position in an order.
- Only describe capabilities explicitly available in this prompt and tools.
- Use tool results as the source of truth for order facts.
- Do not call a tool for greetings or ordinary small talk.
- Use list_orders for requests to list or count orders.
- Use get_order_details for item names, quantities, or prices.
- Use get_shipping_status for shipping and delivery questions.
- If a required order ID is missing, ask the user for it.
- Never use an entire sentence as an order ID.
- Use conversation history to resolve follow-up questions.
- If a user says "that order" or "the same order", resolve the ID
  from the conversation when it is unambiguous.
- If the order is ambiguous, ask a clarification question.
- If a request is unsupported, explain the limitation clearly.
- Never present tool-call JSON as the final user-facing answer.
- Never claim a tool succeeded without a successful tool result.

Be natural, helpful, and concise.
`);

// ==================================================
// STEP 10: Deterministic intent guards
// ==================================================

function detectIntent(text) {
  const value = text.toLowerCase();

  // Reject unsupported modifications before asking the model.
  const mentionsCancellation =
    /\b(cancel|cancellation|cancelled|canceled)\b/i.test(value);

  const asksToPerformAction =
    /\b(can i|could i|can you|could you|please|i want to|i would like to|let me|do it|go ahead|cancel)\b/i.test(value);

  if (mentionsCancellation && asksToPerformAction) {
    return "unsupported_cancel";
  }

  // Casual conversation should not trigger order tools.
  if (
    /^(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|ok|okay|cool|bye)[!. ]*$/i.test(
      text.trim()
    )
  ) {
    return "smalltalk";
  }

  return "model";
}

// ==================================================
// STEP 11: Agent node
// ==================================================

async function agent(state) {
  console.log("\n🤖 NODE: agent");
  console.log("Messages in state:", state.messages.length);

  const lastMessage = state.messages.at(-1);

  if (lastMessage.getType() === "human") {
    const text = String(lastMessage.content);
    const intent = detectIntent(text);

    if (intent === "unsupported_cancel") {
      return {
        messages: [
          new AIMessage(
            "EVOL cannot cancel orders or individual items because " +
            "the current system has no cancellation capability. " +
            "I can look up your order details or shipping status instead."
          ),
        ],
      };
    }

    if (intent === "smalltalk") {
      return {
        messages: [
          new AIMessage(
            /^(thanks|thank you)/i.test(text.trim())
              ? "You're welcome! How else can I help?"
              : /^(bye)/i.test(text.trim())
                ? "Goodbye! Have a great day."
                : "Hi! I'm EVOL. I can help you check shipping, view order details, or list available orders."
          ),
        ],
      };
    }
  }

  const response = await modelWithTools.invoke([
    systemPrompt,
    ...state.messages,
  ]);

  // Reject tool names that were not registered.
  const invalidCalls = (response.tool_calls ?? []).filter(
    (call) => !supportedToolNames.has(call.name)
  );

  if (invalidCalls.length > 0) {
    console.warn(
      "⚠️ Unsupported tool calls rejected:",
      invalidCalls.map((call) => call.name)
    );

    return {
      messages: [
        new AIMessage(
          "I can't perform that action because it isn't supported " +
          "by the tools available to EVOL."
        ),
      ],
    };
  }

  if (response.tool_calls?.length) {
    console.log("🔧 Tool calls requested:");

    for (const call of response.tool_calls) {
      console.log("Tool:", call.name);
      console.log("Arguments:", JSON.stringify(call.args));
    }
  } else {
    console.log("💬 No tool call requested");
  }

  return { messages: [response] };
}

// ==================================================
// STEP 12: Router
// ==================================================

function route(state) {
  const lastMessage = state.messages.at(-1);
  const calls = lastMessage.tool_calls ?? [];

  console.log("\n🔀 ROUTER ACTIVATED");

  if (calls.length > 0) {
    console.log("🔀 ROUTE: agent -> tools");
    return "tools";
  }

  console.log("🏁 ROUTE: agent -> END");
  return END;
}

// ==================================================
// STEP 13: Build graph
// ==================================================

const builder = new StateGraph(AgentState);

builder.addNode("agent", agent);
builder.addNode("tools", new ToolNode(tools));

builder.addEdge(START, "agent");

builder.addConditionalEdges("agent", route, [
  "tools",
  END,
]);

builder.addEdge("tools", "agent");

const graph = builder.compile();

// ==================================================
// STEP 14: Interactive terminal
// ==================================================

const rl = readline.createInterface({
  input,
  output,
});

const messages = [];

console.log("\n" + "#".repeat(55));
console.log("🤖 EVOL INTERACTIVE ASSISTANT");
console.log("Ask questions repeatedly.");
console.log("Try: hi");
console.log("Try: Where is my order ORD102?");
console.log("Try: How many items are in ORD101?");
console.log("Try: List all orders");
console.log("Try: Can I cancel an item?");
console.log("Type exit or quit to stop.");
console.log("#".repeat(55));

try {
  while (true) {
    let question;

    try {
      question = await rl.question("\n👤 You: ");
    } catch {
      // Handles Ctrl+C / closed terminal input.
      console.log("\n👋 EVOL session ended.");
      break;
    }

    const text = question.trim();

    if (!text) continue;

    if (["exit", "quit"].includes(text.toLowerCase())) {
      console.log("\n👋 Goodbye! EVOL session ended.");
      break;
    }

    const previousLength = messages.length;

    messages.push(new HumanMessage(text));

    try {
      console.log("\n🤖 EVOL is thinking...");

      const result = await graph.invoke({
        messages: [...messages],
      });

      messages.splice(0, messages.length, ...result.messages);

      const answer = result.messages.at(-1)?.content;

      console.log(
        "\n🤖 EVOL:",
        typeof answer === "string"
          ? answer
          : JSON.stringify(answer)
      );
    } catch (error) {
      messages.splice(previousLength);

      console.error("\n❌ Request failed:", error.message);
      console.log("Please try again.");
    }
  }
} finally {
  rl.close();
}
