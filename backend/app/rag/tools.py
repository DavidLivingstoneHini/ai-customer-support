"""
Agent tool definitions.

Each tool has:
  - A JSON schema (passed to OpenAI function calling)
  - An async execute() function the agent calls during the ReAct loop

Tools available:
  1. search_knowledge_base  — semantic RAG search over uploaded documents
  2. create_support_ticket  — log a structured support ticket
  3. check_order_status     — mock order lookup (replace with real API)
  4. get_faq_answer         — targeted FAQ retrieval with stricter scoring
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime

import structlog

from app.rag.ingestion import retrieve_context

logger = structlog.get_logger()

# ── Tool schemas (OpenAI function-calling format) ─────────────────────────────

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "search_knowledge_base",
            "description": (
                "Search the company knowledge base for relevant information. "
                "Use this whenever you need to answer a question about products, "
                "policies, services, or procedures. Returns ranked document chunks."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query — be specific and descriptive.",
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Number of results to retrieve (1-10). Default 5.",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_support_ticket",
            "description": (
                "Create a support ticket when the user has an unresolved issue "
                "that needs human attention, or when you cannot confidently answer "
                "from the knowledge base. Returns a ticket reference number."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "subject": {
                        "type": "string",
                        "description": "Short summary of the issue (max 100 chars).",
                    },
                    "description": {
                        "type": "string",
                        "description": "Full description of the customer's issue.",
                    },
                    "priority": {
                        "type": "string",
                        "enum": ["low", "medium", "high", "urgent"],
                        "description": "Ticket priority based on issue severity.",
                    },
                    "category": {
                        "type": "string",
                        "enum": [
                            "billing", "technical", "account",
                            "product", "shipping", "general",
                        ],
                        "description": "Issue category for routing.",
                    },
                },
                "required": ["subject", "description", "priority", "category"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_order_status",
            "description": (
                "Look up the status of a customer order by order ID. "
                "Use when the customer asks about their order, delivery, or shipment."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "order_id": {
                        "type": "string",
                        "description": "The order ID or reference number provided by the customer.",
                    },
                },
                "required": ["order_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_faq_answer",
            "description": (
                "Retrieve a direct FAQ answer for common questions about pricing, "
                "returns, shipping, account management, or general policies. "
                "Faster and more targeted than a full knowledge base search."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The customer's FAQ-style question.",
                    },
                },
                "required": ["question"],
            },
        },
    },
]

# ── Tool execution functions ───────────────────────────────────────────────────

async def execute_tool(tool_name: str, tool_args: dict) -> str:
    """
    Dispatch a tool call and return the result as a string.
    The agent will receive this string as the tool result.
    """
    logger.info("Agent executing tool", tool=tool_name, args=tool_args)

    if tool_name == "search_knowledge_base":
        return await _search_knowledge_base(**tool_args)

    if tool_name == "create_support_ticket":
        return await _create_support_ticket(**tool_args)

    if tool_name == "check_order_status":
        return await _check_order_status(**tool_args)

    if tool_name == "get_faq_answer":
        return await _get_faq_answer(**tool_args)

    return f"Unknown tool: {tool_name}"


async def _search_knowledge_base(query: str, top_k: int = 5) -> str:
    top_k = min(max(1, top_k), 10)
    chunks = await retrieve_context(query)
    chunks = chunks[:top_k]

    if not chunks:
        return "No relevant documents found for this query."

    results = []
    for i, c in enumerate(chunks):
        results.append(
            f"[Result {i+1}] Source: {c['document_name']} | "
            f"Page {c['page']+1} | Relevance: {c['score']:.2%}\n"
            f"{c['text']}"
        )
    return "\n\n---\n\n".join(results)


async def _create_support_ticket(
    subject: str,
    description: str,
    priority: str,
    category: str,
) -> str:
    ticket_id = f"TKT-{uuid.uuid4().hex[:8].upper()}"
    created_at = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    return json.dumps({
        "ticket_id": ticket_id,
        "subject": subject[:100],
        "priority": priority,
        "category": category,
        "status": "open",
        "created_at": created_at,
        "message": (
            f"Ticket {ticket_id} created successfully. "
            f"A support agent will respond within "
            f"{'1 hour' if priority == 'urgent' else '4 hours' if priority == 'high' else '1 business day'}."
        ),
    })


async def _check_order_status(order_id: str) -> str:
    """
    Mock implementation — replace with a real order API call in production.
    """
    import hashlib
    seed = int(hashlib.md5(order_id.encode()).hexdigest(), 16) % 4
    statuses = [
        {
            "order_id": order_id,
            "status": "processing",
            "message": "Your order is being prepared for shipment.",
            "estimated_delivery": "2–3 business days",
        },
        {
            "order_id": order_id,
            "status": "shipped",
            "message": "Your order has been dispatched.",
            "tracking_number": f"TRK{order_id[-6:].upper()}",
            "estimated_delivery": "Tomorrow by 8pm",
        },
        {
            "order_id": order_id,
            "status": "delivered",
            "message": "Your order was delivered.",
            "delivered_at": "Today at 2:34pm",
        },
        {
            "order_id": order_id,
            "status": "not_found",
            "message": f"No order found with ID '{order_id}'. Please check the order number.",
        },
    ]
    return json.dumps(statuses[seed])


async def _get_faq_answer(question: str) -> str:
    chunks = await retrieve_context(question)
    if chunks and chunks[0]["score"] >= 0.70:
        best = chunks[0]
        return (
            f"From '{best['document_name']}' (page {best['page']+1}, "
            f"relevance {best['score']:.0%}):\n\n{best['text']}"
        )
    return (
        "No direct FAQ match found. "
        "Try search_knowledge_base for a broader search."
    )
