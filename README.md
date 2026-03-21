# AI Customer Support Assistant

A production-grade RAG (Retrieval-Augmented Generation) customer support system. Upload documents to build a knowledge base, then let customers ask questions and receive accurate, cited answers streamed in real time. Built with FastAPI, OpenAI GPT-4o, Pinecone, LangChain, React, PostgreSQL, and Redis.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        React Frontend                            │
│   Chat UI (SSE streaming) │ Admin Documents │ Analytics          │
└───────────────────────────┬──────────────────────────────────────┘
                            │ HTTP / SSE
┌───────────────────────────▼──────────────────────────────────────┐
│                       FastAPI Backend                            │
│                                                                  │
│  ┌─────────────┐   ┌──────────────────────────────────────────┐  │
│  │  JWT Auth   │   │             RAG Pipeline                 │  │
│  │  bcrypt     │   │                                          │  │
│  └─────────────┘   │  Query → Embed → Pinecone → GPT-4o      │  │
│                    │  Injection detection                      │  │
│                    │  Confidence scoring + escalation          │  │
│                    │  SSE token streaming                      │  │
│                    └──────────────────────────────────────────┘  │
└──────┬─────────────────────────────┬────────────────────────────┘
       │                             │
┌──────▼──────────┐   ┌─────────────▼──────────────────────────────┐
│   PostgreSQL    │   │              Pinecone                       │
│  Users          │   │  Serverless index (cosine, dim=3072)        │
│  Sessions       │   │  text-embedding-3-large vectors             │
│  Messages       │   │  Metadata: doc name, page, chunk index      │
│  Query logs     │   └────────────────────────────────────────────┘
│  Documents      │
└─────────────────┘
```

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
2. Click **Indexes → Create index → Configure manually**
3. Set:
   - **Index name:** `ai-support-index`
   - **Vector type:** Dense
   - **Dimensions:** `3072`
   - **Metric:** Cosine
   - **Hosting:** Serverless → AWS → us-east-1
4. Click **API Keys** in the sidebar → **Create API key** → copy it immediately

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
# Or PowerShell: -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
JWT_SECRET=<64-char hex string>
JWT_REFRESH_SECRET=<another 64-char hex string>
```

### 4. Start the application

```bash
docker-compose up --build
```

Once running:
- **Frontend:** http://localhost:3000
- **API docs:** http://localhost:8000/docs
- **Health:** http://localhost:8000/health

### 5. Create admin account

Register at http://localhost:3000/register, then:

```bash
docker exec -it acs_postgres psql -U acs_user -d ai_support \
  -c "UPDATE users SET role='admin' WHERE email='your@email.com';"
```

Log out and back in. You'll see the Admin Dashboard link in the sidebar.

### 6. Upload documents

Go to **Admin → Knowledge Base** and upload PDF, DOCX, or TXT files. The system will chunk them, embed them with OpenAI, and index them in Pinecone. Once indexed, users can ask questions and get answers sourced from those documents.

## How the RAG Pipeline Works

### Document Ingestion

When a document is uploaded:

1. Text is extracted using PyPDF / Docx2txt / TextLoader
2. Split into chunks (512 tokens, 50 token overlap) using `RecursiveCharacterTextSplitter`
3. Each chunk is embedded using `text-embedding-3-large` (3072 dimensions)
4. Vectors are upserted to Pinecone with metadata: `document_name`, `page`, `chunk_index`

### Query Pipeline

When a user sends a message:

1. **Injection detection** — regex scans for prompt injection patterns (`ignore previous instructions`, `jailbreak`, etc.)
2. **Input sanitisation** — bleach strips HTML, truncates to 2000 chars
3. **Embedding** — query is embedded with the same model
4. **Retrieval** — top-5 most similar chunks fetched from Pinecone (cosine similarity)
5. **Confidence check** — if top score < 0.75, response is escalated to human agent
6. **Generation** — GPT-4o generates an answer grounded only in retrieved context
7. **Streaming** — response streams back to the client via SSE

### SSE Protocol

The stream sends structured events before text tokens:

| Event | Meaning |
|---|---|
| `[SOURCES]{json}` | Citation metadata for the retrieved documents |
| `[ESCALATE]` | Confidence too low — human handoff triggered |
| `[INJECTION_DETECTED]` | Unsafe input blocked |
| `[DONE]{ms}\|{score}` | Stream complete with timing and confidence |
| `<text token>` | Individual GPT-4o output tokens |

## API Reference

### Auth
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/auth/register` | Register |
| POST | `/api/v1/auth/login` | Login |
| POST | `/api/v1/auth/refresh` | Refresh access token |
| POST | `/api/v1/auth/logout` | Revoke refresh token |
| GET  | `/api/v1/auth/me` | Current user |

### Chat
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/chat/sessions` | Create conversation session |
| GET  | `/api/v1/chat/sessions` | List user's sessions |
| GET  | `/api/v1/chat/sessions/{id}/messages` | Get session messages |
| POST | `/api/v1/chat/stream` | Stream a chat response (SSE) |

### Admin
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/admin/documents` | Upload and index a document |
| GET  | `/api/v1/admin/documents` | List all documents |
| DELETE | `/api/v1/admin/documents/{id}` | Delete document and its vectors |
| GET  | `/api/v1/admin/analytics` | Dashboard analytics |

Full interactive docs at http://localhost:8000/docs

## Running Tests

```bash
cd backend

pip install -r requirements.txt
pip install pytest pytest-asyncio pytest-dotenv httpx aiosqlite

pytest tests/ -v
```

Expected output:
```
tests/test_auth.py::test_register_success PASSED
tests/test_auth.py::test_login_success PASSED
...
tests/test_rag.py::test_injection_detection PASSED
tests/test_rag.py::test_sanitise_input PASSED
...
====== N passed in X.XXs ======
```

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, react-markdown |
| Backend | FastAPI, SQLAlchemy (async), asyncpg |
| LLM | OpenAI GPT-4o |
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
├── .gitignore
├── README.md
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── pytest.ini
│   └── app/
│       ├── main.py
│       ├── config.py
│       ├── auth/
│       │   ├── security.py       ← JWT, bcrypt, token hashing
│       │   ├── dependencies.py   ← FastAPI auth dependencies
│       │   └── router.py         ← register, login, refresh, logout
│       ├── database/
│       │   ├── session.py        ← async SQLAlchemy engine
│       │   └── models.py         ← User, Session, Message, Document, QueryLog
│       ├── rag/
│       │   ├── ingestion.py      ← chunking, embedding, Pinecone upsert
│       │   ├── pipeline.py       ← injection detection, retrieval, streaming
│       │   └── pinecone_client.py
│       ├── chat/
│       │   └── router.py         ← sessions, messages, SSE stream
│       └── admin/
│           └── router.py         ← document upload, analytics
│   └── tests/
│       ├── conftest.py
│       ├── test_auth.py
│       ├── test_rag.py
│       └── test_api.py
└── frontend/
    └── src/
        ├── pages/
        │   ├── ChatPage.tsx
        │   ├── LoginPage.tsx
        │   ├── RegisterPage.tsx
        │   └── admin/
        └── api/client.ts
```
