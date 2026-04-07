# Resolvr AI - AI Customer Support Assistant (Agentic)

A production-grade **agentic AI customer support system** built with FastAPI, OpenAI GPT-4o function calling, Pinecone, LangChain, React, PostgreSQL, and Redis.

The system uses a **ReAct (Reason → Act → Observe → Reason) loop** — the agent autonomously decides which tools to call, executes them, observes the results, and reasons again before producing a final answer. Every step is streamed live to the chat UI.

## What Makes It Agentic

Unlike a basic RAG chatbot that just retrieves and generates, this system:

- **Reasons before acting** — the agent decides whether to search the knowledge base, look up an order, or create a ticket based on the question
- **Uses tools autonomously** — calls multiple tools in sequence when needed (e.g. search KB, then create ticket if no answer found)
- **Observes and adapts** — feeds tool results back into the reasoning loop before generating a response
- **Shows its work** — streams reasoning steps, tool calls, and results to the frontend in real time via a collapsible "Agent reasoning" panel

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         React Frontend                               │
│  Chat UI · Agent reasoning panel · Tool call timeline · Sources      │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │ SSE streaming
┌────────────────────────────────▼─────────────────────────────────────┐
│                        FastAPI Backend                               │
│                                                                      │
│  ┌─────────────┐   ┌────────────────────────────────────────────┐   │
│  │  JWT Auth   │   │           Agentic RAG Pipeline              │   │
│  │  bcrypt     │   │                                            │   │
│  └─────────────┘   │  User query                               │   │
│                    │       ↓                                   │   │
│                    │  Sanitise + injection check               │   │
│                    │       ↓                                   │   │
│                    │  ┌─────────────────────────────────┐     │   │
│                    │  │      ReAct Loop (max 6 iter)    │     │   │
│                    │  │                                 │     │   │
│                    │  │  GPT-4o (function calling)      │     │   │
│                    │  │       ↓ tool_calls              │     │   │
│                    │  │  Execute tools in parallel      │     │   │
│                    │  │       ↓ results                 │     │   │
│                    │  │  Feed back → reason again       │     │   │
│                    │  │       ↓ finish_reason=stop      │     │   │
│                    │  │  Stream final answer            │     │   │
│                    │  └─────────────────────────────────┘     │   │
│                    └────────────────────────────────────────────┘   │
└──────┬──────────────────────────────┬────────────────────────────────┘
       │                              │
┌──────▼──────────┐   ┌──────────────▼──────────────────────────────┐
│   PostgreSQL    │   │              Pinecone                        │
│  Users          │   │  Serverless index (cosine, dim=3072)         │
│  Sessions       │   │  text-embedding-3-large vectors              │
│  Messages       │   │  Metadata: doc_name, page, chunk_index       │
│  Query logs     │   └─────────────────────────────────────────────┘
│  Documents      │
└─────────────────┘
```

## Agent Tools

The agent has access to 4 tools it can call autonomously:

| Tool | Description |
|---|---|
| `search_knowledge_base` | Semantic search over uploaded company documents using Pinecone |
| `get_faq_answer` | Fast targeted retrieval for common questions |
| `check_order_status` | Look up order status by order ID |
| `create_support_ticket` | Create a structured ticket for issues needing human attention |

## SSE Event Protocol

The backend streams structured events before text tokens:

| Event | Meaning |
|---|---|
| `[THINKING]{text}` | Agent reasoning step — shown in collapsible UI panel |
| `[TOOL_CALL]{json}` | Tool being invoked: `{name, args}` |
| `[TOOL_RESULT]{json}` | Tool result received: `{name, result}` |
| `[SOURCES]{json}` | Citation metadata for retrieved documents |
| `[ESCALATE]` | Agent could not find a confident answer |
| `[INJECTION_DETECTED]` | Unsafe input blocked |
| `[DONE]{ms}\|{score}` | Stream complete with timing and confidence |
| `<token>` | Plain GPT-4o output token |

## Prerequisites

- Docker Desktop (running)
- OpenAI API key — [platform.openai.com](https://platform.openai.com)
- Pinecone account — [pinecone.io](https://pinecone.io) (free tier works)

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/DavidLivingstoneHini/ai-customer-support.git
cd ai-customer-support
cp .env.example .env
```

### 2. Create Pinecone index

1. Log in to [pinecone.io](https://pinecone.io)
2. **Indexes → Create index → Configure manually**
3. Set:
   - **Index name:** `ai-support-index`
   - **Dimensions:** `3072`
   - **Metric:** Cosine
   - **Hosting:** Serverless → AWS → us-east-1
4. Copy your API key from the API Keys sidebar

### 3. Fill in `.env`

```env
OPENAI_API_KEY=sk-...
PINECONE_API_KEY=pcsk_...
PINECONE_INDEX_NAME=ai-support-index

POSTGRES_PASSWORD=choose_strong_password
DATABASE_URL=postgresql+asyncpg://acs_user:choose_strong_password@postgres:5432/ai_support

REDIS_PASSWORD=choose_redis_password
REDIS_URL=redis://:choose_redis_password@redis:6379/0

# Generate with: openssl rand -hex 32
JWT_SECRET=<64-char hex string>
JWT_REFRESH_SECRET=<another 64-char hex string>

# Agent configuration (optional — defaults shown)
AGENT_MAX_ITERATIONS=6
```

### 4. Generate lock file and start

```bash
# First time only — generate package-lock.json
cd frontend && npm install && cd ..

# Start everything
docker-compose up --build
```

Once running:
- **Frontend:** http://localhost:3000
- **API docs:** http://localhost:8000/docs
- **Health:** http://localhost:8000/health

### 5. Make yourself admin

```bash
docker exec -it acs_postgres psql -U acs_user -d ai_support \
  -c "UPDATE users SET role='ADMIN' WHERE email='your@email.com';"
```

Log out and back in. You will see the Admin Dashboard link.

### 6. Upload documents

Go to **Admin → Knowledge Base** and upload PDF, DOCX, or TXT files. The agent will search these documents automatically when answering questions.

## How The ReAct Loop Works

For each user message:

1. **Sanitise** — strip HTML, truncate to 2000 chars, check for prompt injection
2. **Enter loop** (max `AGENT_MAX_ITERATIONS` iterations, default 6):
   - Call GPT-4o with all 4 tool schemas + conversation history
   - If model returns `tool_calls`:
     - Execute each tool (Pinecone search / ticket creation / order lookup)
     - Stream `[TOOL_CALL]` and `[TOOL_RESULT]` events to frontend
     - Append tool results back to message history
     - Loop again
   - If model returns `finish_reason=stop`:
     - Stream the final answer token by token
     - Break out of loop
3. **Emit** `[SOURCES]`, `[DONE]` — persist to PostgreSQL

## Frontend Agent Panel

Each assistant message has a collapsible **"Agent reasoning"** section showing:

- 💭 **Thinking steps** — what the agent was reasoning about
- 🔍 **Tool calls** — which tool was invoked and with what arguments
- 📋 **Tool results** — what the tool returned (first 200 chars)

Click "Agent reasoning · N tools used" to expand/collapse.

## Running Tests

```bash
cd backend
pip install -r requirements.txt
pip install pytest pytest-asyncio pytest-dotenv httpx aiosqlite

pytest tests/ -v
```

Expected: **105 passed, 0 failed**

```
tests/test_api.py        — 29 tests  (health, auth, chat, admin, security)
tests/test_auth.py       — 19 tests  (register, login, refresh, logout, /me)
tests/test_rag.py        — 57 tests  (injection, sanitise, chunks, tools, agent)
```

## API Reference

### Auth
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/auth/register` | Register |
| POST | `/api/v1/auth/login` | Login |
| POST | `/api/v1/auth/refresh` | Refresh token |
| POST | `/api/v1/auth/logout` | Revoke token |
| GET  | `/api/v1/auth/me` | Current user |

### Chat (Agentic)
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/chat/sessions` | Create conversation session |
| GET  | `/api/v1/chat/sessions` | List sessions |
| GET  | `/api/v1/chat/sessions/{id}/messages` | Get messages |
| POST | `/api/v1/chat/stream` | Stream agentic response (SSE) |

### Admin
| Method | Endpoint | Description |
|---|---|---|
| POST   | `/api/v1/admin/documents` | Upload and index document |
| GET    | `/api/v1/admin/documents` | List documents |
| DELETE | `/api/v1/admin/documents/{id}` | Delete document |
| GET    | `/api/v1/admin/analytics` | Dashboard analytics |

Full interactive docs at http://localhost:8000/docs

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, react-markdown |
| Backend | FastAPI, SQLAlchemy (async), asyncpg |
| Agent | OpenAI GPT-4o function calling, ReAct loop |
| Embeddings | OpenAI text-embedding-3-large (3072 dims) |
| Vector DB | Pinecone (Serverless, cosine similarity) |
| Chunking | LangChain RecursiveCharacterTextSplitter |
| Database | PostgreSQL 16 |
| Cache | Redis 7 |
| Auth | JWT (HS256) + bcrypt, refresh token rotation |
| Infra | Docker, Docker Compose, Nginx |

## Project Structure

```
ai-customer-support/
├── docker-compose.yml
├── .env.example
├── README.md
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── pytest.ini
│   ├── .env.test
│   └── app/
│       ├── main.py
│       ├── config.py              ← agent_max_iterations setting
│       ├── auth/
│       │   ├── security.py
│       │   ├── dependencies.py
│       │   └── router.py
│       ├── database/
│       │   ├── session.py
│       │   └── models.py
│       ├── rag/
│       │   ├── agent.py           ← ReAct loop, tool orchestration ★
│       │   ├── tools.py           ← 4 tool definitions + execute() ★
│       │   ├── pipeline.py        ← injection detection, sanitisation
│       │   ├── ingestion.py       ← chunking, embedding, Pinecone upsert
│       │   └── pinecone_client.py
│       ├── chat/
│       │   └── router.py          ← SSE stream endpoint (uses agent)
│       └── admin/
│           └── router.py
│   └── tests/
│       ├── conftest.py
│       ├── test_auth.py
│       ├── test_rag.py            ← includes tool schema + execution tests
│       └── test_api.py
└── frontend/
    └── src/
        ├── pages/
        │   ├── ChatPage.tsx       ← agent reasoning panel, tool timeline ★
        │   ├── LoginPage.tsx
        │   ├── RegisterPage.tsx
        │   └── admin/
        └── api/client.ts
```

★ = new agentic files added in v2
