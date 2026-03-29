"""
Agentic RAG pipeline using OpenAI function calling + ReAct loop.

Flow for each user message:
  1. Sanitise & injection-check input
  2. Enter ReAct loop (max iterations from config):
       a. Call GPT-4o with tool schemas + conversation history
       b. If model returns tool_calls → execute each tool, feed results back
       c. Yield [THINKING] and [TOOL_CALL]/[TOOL_RESULT] SSE events to frontend
       d. If model returns a plain text finish_reason="stop" → stream final answer
  3. Yield [SOURCES], [DONE] events

SSE event protocol:
  [THINKING]{text}         — agent reasoning step shown in collapsible UI
  [TOOL_CALL]{json}        — tool being invoked: {name, args}
  [TOOL_RESULT]{json}      — tool result: {name, result_preview}
  [SOURCES]{json}          — final citations list
  [ESCALATE]               — low confidence, no useful results
  [INJECTION_DETECTED]     — unsafe input blocked
  [DONE]{ms}|{score}       — stream complete
  <token>                  — plain GPT-4o output token
"""
from __future__ import annotations

import json
import time
from typing import AsyncGenerator

import structlog
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam

from app.config import settings
from app.rag.pipeline import detect_injection, sanitise_input
from app.rag.tools import TOOL_SCHEMAS, execute_tool

logger = structlog.get_logger()
openai_client = AsyncOpenAI(api_key=settings.openai_api_key)

AGENT_SYSTEM_PROMPT = """You are an intelligent customer support agent with access to a set of tools.

Your goal is to give accurate, helpful answers to customer questions. Follow these rules:

1. ALWAYS start by using search_knowledge_base or get_faq_answer to look up relevant information before answering. Never answer from memory alone.
2. If the customer mentions an order ID, use check_order_status to look it up.
3. If you cannot find a satisfactory answer after searching, create a support ticket using create_support_ticket and inform the customer.
4. Cite the specific documents and pages your answer is based on.
5. Be concise, professional, and empathetic.
6. Never fabricate information. If you don't know, say so and create a ticket.
7. You may call multiple tools in sequence if needed to fully answer the question."""


async def run_agent(
    query: str,
    history: list[dict] | None = None,
) -> AsyncGenerator[str, None]:
    """
    Main agentic entry point. Yields SSE-formatted strings.
    """
    sanitised = sanitise_input(query)

    if detect_injection(sanitised):
        yield "data: [INJECTION_DETECTED]\n\n"
        return

    messages: list[ChatCompletionMessageParam] = [
        {"role": "system", "content": AGENT_SYSTEM_PROMPT},
    ]

    # Inject recent conversation history
    for h in (history or [])[-6:]:
        if h["role"] in ("user", "assistant"):
            messages.append({"role": h["role"], "content": h["content"]})  # type: ignore

    messages.append({"role": "user", "content": sanitised})

    start_time = time.monotonic()
    top_score: float = 0.0
    all_sources: list[dict] = []
    iteration = 0
    max_iterations = settings.agent_max_iterations

    while iteration < max_iterations:
        iteration += 1
        logger.info("Agent iteration", iteration=iteration)

        # ── Call GPT-4o ────────────────────────────────────────────────────
        response = await openai_client.chat.completions.create(
            model=settings.openai_chat_model,
            messages=messages,
            tools=TOOL_SCHEMAS,          # type: ignore[arg-type]
            tool_choice="auto",
            temperature=0.3,
            max_tokens=1500,
        )

        choice = response.choices[0]
        assistant_message = choice.message

        # Add assistant turn to messages (required for multi-turn tool use)
        messages.append(assistant_message)  # type: ignore[arg-type]

        # ── No tool calls — final answer ready ────────────────────────────
        if choice.finish_reason == "stop" or not assistant_message.tool_calls:
            final_text = assistant_message.content or ""

            # Stream the final answer token by token (simulate streaming
            # by yielding whole response — real streaming below)
            if final_text:
                # Stream as a single final answer event
                # For real token streaming we'd use stream=True on last call
                yield f"data: [THINKING]Formulating final answer…\n\n"
                for token in _split_into_tokens(final_text):
                    yield f"data: {token.replace(chr(10), '<br>')}\n\n"
            break

        # ── Tool calls present — execute each one ─────────────────────────
        thinking_text = _extract_thinking(assistant_message.content)
        if thinking_text:
            yield f"data: [THINKING]{thinking_text}\n\n"

        tool_result_messages = []

        for tool_call in assistant_message.tool_calls:
            fn_name = tool_call.function.name
            try:
                fn_args = json.loads(tool_call.function.arguments)
            except json.JSONDecodeError:
                fn_args = {}

            # Notify frontend: tool is being called
            yield f"data: [TOOL_CALL]{json.dumps({'name': fn_name, 'args': fn_args})}\n\n"

            # Execute the tool
            try:
                result = await execute_tool(fn_name, fn_args)
            except Exception as exc:
                result = f"Tool execution error: {exc}"
                logger.error("Tool error", tool=fn_name, error=str(exc))

            # Extract sources from knowledge base searches
            if fn_name in ("search_knowledge_base", "get_faq_answer"):
                score, sources = _extract_sources_from_result(result)
                if score > top_score:
                    top_score = score
                all_sources.extend(sources)

            # Notify frontend: tool result received
            preview = result[:200] + "…" if len(result) > 200 else result
            yield f"data: [TOOL_RESULT]{json.dumps({'name': fn_name, 'result': preview})}\n\n"

            tool_result_messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result,
            })

        # Add all tool results back into messages
        messages.extend(tool_result_messages)  # type: ignore[arg-type]

    else:
        # Max iterations reached without a stop — escalate
        yield "data: [ESCALATE]\n\n"
        return

    # ── Emit sources and done ──────────────────────────────────────────────
    if all_sources:
        unique_sources = _deduplicate_sources(all_sources)
        yield f"data: [SOURCES]{json.dumps(unique_sources)}\n\n"

    if top_score > 0 and top_score < settings.min_similarity_score and not all_sources:
        yield "data: [ESCALATE]\n\n"
        return

    elapsed_ms = int((time.monotonic() - start_time) * 1000)
    yield f"data: [DONE]{elapsed_ms}|{top_score:.4f}\n\n"


# ── Helpers ────────────────────────────────────────────────────────────────────

def _split_into_tokens(text: str, chunk_size: int = 4) -> list[str]:
    """
    Split text into small chunks to simulate token streaming.
    In production you'd use stream=True on the final OpenAI call instead.
    """
    words = text.split(" ")
    chunks = []
    buf = []
    for word in words:
        buf.append(word)
        if len(buf) >= chunk_size:
            chunks.append(" ".join(buf))
            buf = []
    if buf:
        chunks.append(" ".join(buf))
    return [c + " " for c in chunks]


def _extract_thinking(content: str | None) -> str:
    """
    If the model prefixes its reasoning before a tool call, surface it.
    """
    if not content:
        return ""
    content = content.strip()
    if len(content) > 10:
        return content[:300] + ("…" if len(content) > 300 else "")
    return ""


def _extract_sources_from_result(result: str) -> tuple[float, list[dict]]:
    """
    Parse knowledge-base search results to extract source citations and
    the top relevance score.
    """
    sources = []
    top_score = 0.0
    lines = result.split("\n")
    for line in lines:
        if line.startswith("[Result") and "Source:" in line:
            try:
                # Format: [Result N] Source: <name> | Page <n> | Relevance: X%
                parts = line.split("|")
                src_part = parts[0].split("Source:")[-1].strip()
                page_part = parts[1].strip().replace("Page", "").strip() if len(parts) > 1 else "1"
                rel_part = parts[2].strip().replace("Relevance:", "").strip().replace("%", "") if len(parts) > 2 else "0"
                score = float(rel_part) / 100.0
                if score > top_score:
                    top_score = score
                sources.append({
                    "document_name": src_part,
                    "document_id": "",
                    "page": int(page_part) if page_part.isdigit() else 1,
                    "score": round(score, 4),
                })
            except (IndexError, ValueError):
                pass
    return top_score, sources


def _deduplicate_sources(sources: list[dict]) -> list[dict]:
    seen: set[str] = set()
    unique = []
    for s in sorted(sources, key=lambda x: x["score"], reverse=True):
        key = f"{s['document_name']}:{s['page']}"
        if key not in seen:
            seen.add(key)
            unique.append(s)
    return unique[:8]
