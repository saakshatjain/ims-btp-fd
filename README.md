<p align="center">
  <img src="frontend/nsutlogo.png" alt="NSUT Logo" width="80" />
</p>

<h1 align="center">NSUT Bot — AI-Powered University Notice Assistant</h1>

<p align="center">
  A Retrieval-Augmented Generation (RAG) chatbot that lets students instantly search and ask questions about official NSUT notices.
</p>

<p align="center">
  <a href="https://nsutbot.vercel.app"><strong>🌐 Live Demo → nsutbot.vercel.app</strong></a>
</p>

---

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [How It Works — End-to-End Flow](#how-it-works--end-to-end-flow)
- [Tech Stack](#tech-stack)
- [Retrieval Service Communication](#retrieval-service-communication)
- [Backend Deep Dive](#backend-deep-dive)
- [Frontend Deep Dive](#frontend-deep-dive)
- [API Reference](#api-reference)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [Evaluation](#evaluation)

---

## Overview

**NSUT Bot** is a full-stack RAG chatbot built as a B.Tech Project (BTP). It enables students at Netaji Subhas University of Technology (NSUT) to ask natural-language questions about university notices — exams, schedules, circulars, results — and get accurate, source-cited answers in real time.

Instead of manually browsing through hundreds of PDFs on the university website, students simply type a question and receive a structured answer with direct links to the original notice documents.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          USER (Browser)                             │
│                     https://nsutbot.vercel.app                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  HTTPS (POST /api/query)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     BACKEND  (FastAPI on Render)                     │
│              https://ims-btp-backend.onrender.com                   │
│                                                                     │
│  ┌───────────┐   ┌──────────────┐   ┌───────────────────────────┐  │
│  │ Rate      │──▶│  RAG Search  │──▶│  LLM (Groq — Llama 4     │  │
│  │ Limiter   │   │  Engine      │   │  Scout 17B)               │  │
│  │ (SlowAPI) │   │              │   └───────────────────────────┘  │
│  └───────────┘   │  1. Query    │                                   │
│                  │     Transform│   ┌───────────────────────────┐  │
│                  │  2. Retrieve │──▶│  Retriever Service        │  │
│                  │  3. Re-rank  │   │  (Semantic Search API)    │  │
│                  │  4. Build    │   │  ims-semantic-search      │  │
│                  │     Prompt   │   │  .onrender.com/retrieve   │  │
│                  │  5. Generate │   └───────────────────────────┘  │
│                  └──────────────┘                                   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Supabase (Feedback Storage)                                 │   │
│  │  Table: answer_feedback                                      │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## How It Works — End-to-End Flow

```
User Question
     │
     ▼
┌─────────────────────┐
│ 1. Query Transform  │  LLM extracts core keywords from the user's question
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 2. Semantic Search   │  Keywords are sent to the Retriever Service at
│    (Retriever API)   │  RETRIEVER_URL = https://ims-semantic-search.onrender.com/retrieve
│                      │  which performs vector similarity search over
│                      │  pre-embedded NSUT notice chunks (embeddings stored
│                      │  in Qdrant). Returns top-K most relevant chunks.
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 3. Chunk Selection   │  Chunks are re-ranked using:
│    & Re-ranking      │   - Cosine similarity score
│                      │   - Title-match boost (keyword overlap with notice title)
│                      │   - Context budget (MAX_CONTEXT_CHARS = 100K)
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 4. Prompt Building   │  Selected chunks + OCR text are assembled into a
│                      │  structured prompt with strict JSON output instructions
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 5. LLM Generation   │  Prompt is sent to Groq (Llama 4 Scout 17B) which
│                      │  returns a JSON response with:
│                      │   - answer (plain text)
│                      │   - sources (notice_id, title, link)
│                      │   - suggested_follow_up (pre-computed Q&A pairs)
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 6. Response Parsing  │  JSON is validated, cleaned, and forwarded to the
│    & Delivery        │  frontend for rendering
└─────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 19 + Vite 7 | SPA with responsive chat UI, dark/light themes |
| **Styling** | Vanilla CSS + inline styles | ChatGPT-style clean design, no CSS framework |
| **Backend** | FastAPI (Python) | REST API server with async middleware |
| **LLM** | Groq Cloud — Llama 4 Scout 17B | Ultra-fast inference for answer generation |
| **LangChain** | `langchain-groq` | LLM orchestration and invocation |
| **Retriever** | External Semantic Search API | Vector similarity search over notice embeddings |
| **Embeddings** | Sentence-Transformers (in retriever) | `all-MiniLM-L6-v2` for document chunk embeddings |
| **Vector DB** | Qdrant (in retriever) | Stores and indexes document embeddings |
| **Feedback DB** | Supabase (PostgreSQL) | Stores user feedback (answer/source ratings) |
| **Rate Limiting** | SlowAPI | 10 req/min per IP for queries, 20/min for feedback |
| **Security** | CORS, TrustedHost, CSP, HSTS | Production-grade HTTP security headers |
| **Hosting** | Vercel (frontend) + Render (backend) | Serverless frontend, managed backend |
| **Analytics** | Vercel Analytics + Speed Insights | Performance monitoring and usage tracking |

---

## Retrieval Service Communication

The backend communicates with a **separate Retriever microservice** that handles the semantic search over NSUT notice documents.

### Retriever Endpoint

```
POST https://ims-semantic-search.onrender.com/retrieve
```

### Request Format

```json
{
  "query": "original user question",
  "search_query": "normalized keywords extracted from question",
  "prefetch_k": 50
}
```

### Request Headers

```
Content-Type: application/json
api-key: <RETRIEVER_API_KEY>
```

### Response Format

The retriever returns a list of semantically relevant document chunks:

```json
{
  "chunks": [
    {
      "chunk_text": "The mid-semester examination for B.Tech 3rd semester...",
      "similarity": 0.8742,
      "filename": "notice_2024_001.pdf",
      "notice_id": "NSUT-2024-001",
      "notice_title": "Mid-Semester Exam Schedule",
      "notice_link": "https://imsnsit.org/imsnsit/notifications/...",
      "notice_ocr": "Full OCR text of the notice..."
    }
  ]
}
```

### How the Backend Uses It

1. **Query Transformation** — The LLM first converts the user's natural language question into optimized search keywords
2. **API Call** — The backend sends both the original query and normalized keywords to the retriever
3. **Chunk Selection** — Returned chunks are re-ranked using similarity scores + title-match boosting
4. **Context Assembly** — Top chunks (within 100K char budget) are formatted into a structured prompt
5. **LLM Generation** — The assembled context is sent to Groq's Llama 4 Scout for answer generation

---

## Backend Deep Dive

### Core Modules

| File | Description |
|------|-------------|
| `app.py` | FastAPI app initialization, CORS, security headers, rate limiting |
| `extensions.py` | Shared `SlowAPI` rate limiter instance |
| `src/search.py` | `RAGSearch` class — query transform, retrieval, re-ranking, LLM calls |
| `src/base_prompt.py` | Prompt template builder with strict JSON output instructions |
| `src/routes/rag_routes.py` | API route handlers (`/api/query`, `/api/feedback`) |

### RAG Search Pipeline (`src/search.py`)

The `RAGSearch` class encapsulates the entire RAG pipeline:

- **Query Normalization** — Removes stopwords, lowercases, strips punctuation
- **Title-Match Boosting** — Adds up to +0.15 similarity boost if notice title contains query keywords
- **Multi-Key Rotation** — Supports multiple Groq API keys with automatic rotation on rate limits
- **Rate Limit Handling** — Parses wait times from Groq error messages and sleeps accordingly
- **Context Length Fallback** — If prompt exceeds Groq context limit, retries without OCR text
- **Robust JSON Parsing** — Handles malformed LLM output by extracting JSON objects from raw text

### Security Features

- **CORS** — Configured allowed origins via `ALLOWED_ORIGINS` env var
- **Trusted Host** — Only allows requests from `ALLOWED_HOSTS`
- **Security Headers** — `X-Content-Type-Options`, `X-Frame-Options`, `HSTS`, `CSP`
- **Rate Limiting** — IP-based rate limits using SlowAPI (10 queries/min, 20 feedback/min)

---

## Frontend Deep Dive

### Features

- **Multi-chat Support** — Create, switch between, and delete multiple chat sessions
- **Chat Persistence** — All chats saved to `localStorage`
- **Dark / Light Themes** — Toggle between clean dark and light modes
- **Answer Styles** — Choose between "Detailed" and "Precise" answer modes
- **Suggested Follow-ups** — Pre-computed follow-up questions with instant answers (no API call)
- **Source Citations** — Expandable source links with notice title and direct PDF download
- **User Feedback** — Star-based rating system (answer quality + source relevance + satisfaction)
- **Loading States** — Progressive status indicators: Thinking → Retrieving docs → Formatting answer
- **Rate Limit Handling** — Friendly error messages when rate limit is exceeded
- **Responsive Design** — Mobile-friendly with collapsible sidebar
- **Abort Support** — Stop button to cancel in-flight requests
- **Copy to Clipboard** — One-click copy for source links

---

## API Reference

### `POST /api/query`

Send a natural language question about NSUT notices.

**Request Body:**
```json
{
  "query": "When is the mid-semester exam for 3rd semester?",
  "deep_search": false,
  "answer_style": "detailed"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | `string` | (required) | The user's question |
| `deep_search` | `bool` | `false` | If `true`, fetches more chunks (top_k=40, prefetch_k=100) |
| `answer_style` | `string` | `"detailed"` | `"detailed"` or `"precise"` |

**Response:**
```json
{
  "query": "When is the mid-semester exam?",
  "answer": "The mid-semester examination...",
  "sources": [
    {
      "notice_id": "NSUT-2024-001",
      "notice_title": "Mid-Semester Exam Schedule",
      "source_link": "https://imsnsit.org/..."
    }
  ],
  "suggested_follow_up": [
    {
      "question": "What is the venue for the exam?",
      "answer": "The exam will be held at...",
      "sources": [{ "notice_id": "...", "notice_title": "...", "source_link": "..." }]
    }
  ]
}
```

### `POST /api/feedback`

Submit user feedback for a bot response.

**Request Body:**
```json
{
  "message_id": "1709123456789_b",
  "prompt": "Original user question",
  "response": "Bot's answer text",
  "links": ["https://..."],
  "answer_score": 4,
  "source_score": 5,
  "satisfied": true
}
```

**Rate Limits:**
- `/api/query` — 10 requests/minute per IP
- `/api/feedback` — 20 requests/minute per IP

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description | Example |
|----------|-------------|---------|
| `RETRIEVER_URL` | Semantic search retriever endpoint | `https://ims-semantic-search.onrender.com/retrieve` |
| `RETRIEVER_API_KEY` | API key for the retriever service | `your-api-key` |
| `GROQ_API_KEY` | Primary Groq Cloud API key | `gsk_...` |
| `GROQ_API_KEY_2` to `_5` | Additional Groq keys for rotation | `gsk_...` |
| `SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `SUPABASE_KEY` | Supabase service role key | `eyJ...` |
| `GOOGLE_API_KEY` | Google API key (legacy/fallback) | `AIza...` |
| `ALLOWED_ORIGINS` | Comma-separated allowed CORS origins | `http://localhost:5173,https://nsutbot.vercel.app` |
| `ALLOWED_HOSTS` | Comma-separated trusted hostnames | `localhost,127.0.0.1` |

### Frontend (`frontend/.env`)

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_API_URL` | Backend query endpoint | `https://ims-btp-backend.onrender.com/api/query` |
| `VITE_FEEDBACK_URL` | Backend feedback endpoint | `https://ims-btp-backend.onrender.com/api/feedback` |

---

## Project Structure

```
ARSBTP/
├── backend/
│   ├── app.py                    # FastAPI app, middleware, security config
│   ├── extensions.py             # Shared rate limiter instance
│   ├── requirements.txt          # Python dependencies
│   ├── .env                      # Environment variables (not committed)
│   ├── src/
│   │   ├── search.py             # RAGSearch — retrieval + LLM pipeline
│   │   ├── base_prompt.py        # LLM prompt template builder
│   │   └── routes/
│   │       └── rag_routes.py     # /api/query & /api/feedback endpoints
│   └── evaluation/
│       ├── evaluate.py           # RAGAS evaluation script
│       └── dashboard.py          # Streamlit evaluation dashboard
│
├── frontend/
│   ├── index.html                # Entry HTML
│   ├── vite.config.js            # Vite configuration
│   ├── package.json              # Node dependencies
│   ├── .env                      # Frontend env vars (VITE_API_URL, etc.)
│   ├── nsutlogo.png              # NSUT logo asset
│   └── src/
│       ├── App.jsx               # Main chat application component
│       └── index.css             # Global styles
│
├── .gitignore
└── README.md                     # ← You are here
```

---

## Local Development

### Prerequisites

- Python 3.11+
- Node.js 18+
- npm

### Backend

```bash
cd backend

# Create virtual environment
python -m venv .venv
.venv\Scripts\activate       # Windows
# source .venv/bin/activate  # macOS/Linux

# Install dependencies
pip install -r requirements.txt

# Set up your .env file (see Environment Variables section)

# Run the dev server
uvicorn app:app --reload --port 8000
```

### Frontend

```bash
cd frontend

# Install dependencies
npm install

# Run the dev server
npm run dev
# → Opens at http://localhost:5173
```

---

## Deployment

| Component | Platform | URL |
|-----------|----------|-----|
| **Frontend** | Vercel | [https://nsutbot.vercel.app](https://nsutbot.vercel.app) |
| **Backend** | Render | `https://ims-btp-backend.onrender.com` |
| **Retriever** | Render | `https://ims-semantic-search.onrender.com` |
| **Feedback DB** | Supabase | Managed PostgreSQL |

---

## Evaluation

The project includes a RAGAS-based evaluation framework in `backend/evaluation/`:

- **`evaluate.py`** — Runs automated evaluation metrics (faithfulness, answer relevancy, context precision)
- **`dashboard.py`** — Streamlit dashboard for visualizing evaluation results

---

<p align="center">
  Built as a B.Tech Project (BTP) at NSUT 🎓
</p>
