# AI Customer Support Assistant

A production-grade RAG-powered customer support system. Upload documents to a knowledge base and let GPT-4o answer user questions with source citations, confidence scoring, and human escalation fallback.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        React Frontend                        │
│   Chat UI (SSE streaming) │ Admin Dashboard │ Auth pages    │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP / SSE
┌──────────────────────────▼──────────────────────────────────┐
│                      FastAPI Backend                         │
│                                                             │
│  ┌──────────┐  ┌──────────────────────────────────────────┐ │
│  │   Auth   │  │              RAG Pipeline                │ │
│  │  JWT     │  │                                          │ │
│  │  bcrypt  │  │  Query → Embed → Pinecone → GPT-4o      │ │
│  └──────────┘  │  → Stream response with citations        │ │
│                └──────────────────────────────────────────┘ │
└────────┬──────────────────────┬──────────────────────────────┘
         │                      │
┌────────▼───────┐   ┌──────────▼──────────────────────────────┐
│   PostgreSQL   │   │              Pinecone                    │
│  Users         │   │  Document embeddings (3072-dim)          │
│  Sessions      │   │  Cosine similarity retrieval             │
│  Messages      │   └─────────────────────────────────────────┘
│  Query logs    │
└────────────────┘
         │
┌────────▼───────┐
│     Redis      │
│  Token cache   │
│  Rate limiting │
└────────────────┘
```

## Prerequisites

- Docker Desktop
- Node.js 20+ (for local frontend dev)
- Python 3.11+ (for local backend dev)
- OpenAI account with API key
- Pinecone account (free tier works)

## Setup

### 1. Clone and configure environment

```bash
git clone https://github.com/DavidLivingstoneHini/ai-customer-support.git
cd ai-customer-support
cp .env.example .env
```

Open `.env` and fill in:

```bash
# Generate secure secrets
openssl rand -hex 32   # use for JWT_SECRET
openssl rand -hex 32   # use for JWT_REFRESH_SECRET

# Add your API keys
OPENAI_API_KEY=sk-...
PINECONE_API_KEY=pcsk_...
```

### 2. Create Pinecone index

1. Log in to [pinecone.io](https://pinecone.io)
2. Create a new index:
   - **Name:** `ai-support-index`
   - **Dimensions:** `3072`
   - **Metric:** `cosine`
   - **Cloud:** AWS, Region: us-east-1
3. Copy the API key into your `.env`

### 3. Start the application

```bash
docker-compose up --build
```

Wait for all services to be healthy. You'll see:
```
acs_backend  | INFO: Application startup complete
acs_frontend | Accepting connections at http://localhost:3000
```

### 4. Create your admin account

The first step is to create a user via the API and manually promote them to admin:

```bash
# Register via the API
curl -X POST http://localhost:8000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","full_name":"Admin","password":"yourpassword"}'

# Connect to postgres and set admin role
docker exec -it acs_postgres psql -U acs_user -d ai_support \
  -c "UPDATE users SET role='admin' WHERE email='admin@example.com';"
```

### 5. Upload a document and test

1. Open [http://localhost:3000](http://localhost:3000)
2. Log in with your admin credentials
3. Navigate to **Admin → Documents**
4. Upload any PDF (product manual, FAQ doc, policy document)
5. Wait for "Indexed" status to appear
6. Go to **Chat** and ask a question about the document
7. You should see a streamed response with source citations

## API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Register new user |
| POST | `/api/v1/auth/login` | Login |
| POST | `/api/v1/auth/refresh` | Refresh access token |
| POST | `/api/v1/auth/logout` | Revoke refresh token |
| GET  | `/api/v1/auth/me` | Get current user |

### Chat
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/chat/sessions` | Create new session |
| GET  | `/api/v1/chat/sessions` | List user sessions |
| GET  | `/api/v1/chat/sessions/:id/messages` | Get session messages |
| POST | `/api/v1/chat/stream` | Stream a chat response (SSE) |

### Admin
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST   | `/api/v1/admin/documents` | Upload document |
| GET    | `/api/v1/admin/documents` | List all documents |
| DELETE | `/api/v1/admin/documents/:id` | Delete document |
| GET    | `/api/v1/admin/analytics` | Get analytics data |

Full interactive API docs: [http://localhost:8000/docs](http://localhost:8000/docs)

## How the RAG pipeline works

1. **Ingestion:** Uploaded documents are split into 512-token chunks with 50-token overlap using LangChain's `RecursiveCharacterTextSplitter`
2. **Embedding:** Each chunk is embedded using OpenAI's `text-embedding-3-large` (3072 dimensions)
3. **Storage:** Embeddings are stored in Pinecone with document metadata
4. **Query:** User message is embedded, top-5 most similar chunks are retrieved via cosine similarity
5. **Confidence check:** If top score < 0.75, the query is escalated to a human agent instead of answered
6. **Generation:** GPT-4o synthesises an answer grounded in the retrieved chunks, citing sources
7. **Streaming:** Response is streamed token by token to the frontend via Server-Sent Events

## Local development (without Docker)

```bash
# Backend
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload

# Frontend
cd frontend
npm install
npm run dev
```

Make sure you have local PostgreSQL and Redis running, or update `DATABASE_URL` and `REDIS_URL` to point to the Docker services.

## Tech stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, Recharts |
| Backend | FastAPI, SQLAlchemy (async), Alembic |
| AI | OpenAI GPT-4o, text-embedding-3-large, LangChain |
| Vector DB | Pinecone (cosine similarity, 3072 dimensions) |
| Database | PostgreSQL 16 |
| Cache | Redis 7 |
| Auth | JWT (RS256), bcrypt |
| Infrastructure | Docker, Docker Compose |
