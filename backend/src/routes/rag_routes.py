# backend/src/routes/rag_routes.py
from fastapi import APIRouter
from src.search import RAGSearch

router = APIRouter()
rag = RAGSearch()

@router.get("/")
def home():
    """Simple health endpoint for testing."""
    return {"message": "RAG backend API is live and ready!"}

@router.post("/query")
def query_rag(payload: dict):
    """
    POST /api/query
    Example body:
    {
      "query": "When is the chemistry practical exam for MSc?"
    }
    """
    query = payload.get("query", "").strip()
    if not query:
        return {"error": "Query cannot be empty."}

    print(f"[INFO] Received query: {query}")
    result = rag.search_and_generate(query, top_k=3, prefetch_k=30)
    
    # Extract answer and sources
    answer = result.get("answer", "No answer generated.")
    sources = result.get("sources", [])

    return {
        "query": query,
        "answer": answer,
        "sources": sources  # Optional: send sources to frontend
    }
