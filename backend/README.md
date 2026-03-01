# NSUT Bot — Backend

FastAPI-powered RAG backend that processes natural language queries about NSUT notices using semantic search and Groq-hosted Llama 4 Scout 17B.

## Quick Start

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
# Configure .env (see root README for all variables)
uvicorn app:app --reload --port 8000
```

## Architecture

```
Request → Rate Limiter → RAG Search Engine
                            ├── 1. Query Transform (LLM keyword extraction)
                            ├── 2. Retriever API call (ims-semantic-search.onrender.com/retrieve)
                            ├── 3. Chunk re-ranking (similarity + title-match boost)
                            ├── 4. Prompt assembly (chunks + OCR context)
                            └── 5. LLM generation (Groq — Llama 4 Scout 17B)
```

## Key Files

| File | Purpose |
|------|---------|
| `app.py` | FastAPI app, CORS, security middleware, rate limiting |
| `extensions.py` | Shared SlowAPI limiter |
| `src/search.py` | RAGSearch class — full pipeline |
| `src/base_prompt.py` | LLM prompt template with JSON schema |
| `src/routes/rag_routes.py` | `/api/query` and `/api/feedback` endpoints |

## API Endpoints

- `POST /api/query` — Send a question, get a structured answer with sources
- `POST /api/feedback` — Submit answer quality ratings (stored in Supabase)

See the [root README](../README.md) for full API documentation.
