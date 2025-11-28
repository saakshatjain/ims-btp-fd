import os
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from supabase import create_client, Client

from src.search import RAGSearch

# 1. Load Environment Variables
load_dotenv()

# 2. Initialize Supabase Client
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("[WARNING] Supabase credentials not found in .env. Feedback endpoint will fail.")
    supabase = None
else:
    try:
        supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as e:
        print(f"[ERROR] Failed to initialize Supabase client: {e}")
        supabase = None

router = APIRouter()
rag = RAGSearch()

# --- Pydantic Models ---

class QueryRequest(BaseModel):
    query: str

class FeedbackRequest(BaseModel):
    message_id: str
    prompt: Optional[str] = None
    response: Optional[str] = None
    links: Optional[List[str]] = []
    answer_score: int = Field(..., ge=1, le=5, description="Score between 1 and 5")
    source_score: int = Field(..., ge=1, le=5, description="Score between 1 and 5")
    satisfied: bool

# --- Routes ---

@router.get("/")
def home():
    """Simple health endpoint for testing."""
    return {"message": "RAG backend API is live and ready!"}

@router.post("/query")
def query_rag(payload: QueryRequest):
    """
    POST /api/query
    """
    query_text = payload.query.strip()
    if not query_text:
        return {"error": "Query cannot be empty."}

    print(f"[INFO] Received query: {query_text}")
    
    try:
        result = rag.search_and_generate(query_text, top_k=3, prefetch_k=30)
        
        # Extract answer and sources
        answer = result.get("answer", "No answer generated.")
        sources = result.get("sources", [])

        return {
            "query": query_text,
            "answer": answer,
            "sources": sources
        }
    except Exception as e:
        print(f"[ERROR] RAG generation failed: {e}")
        # Return a generic error so the frontend handles it gracefully
        return {"answer": "[ERROR] An internal error occurred.", "sources": []}

@router.post("/feedback")
def submit_feedback(feedback: FeedbackRequest):
    """
    POST /api/feedback
    Inserts user feedback into Supabase 'answer_feedback' table.
    """
    if not supabase:
        raise HTTPException(status_code=503, detail="Database service unavailable")

    try:
        # Convert Pydantic model to dict
        data = feedback.model_dump() # Use .dict() if using Pydantic v1
        
        # Insert into Supabase
        # .data returns the inserted row(s) on success
        response = supabase.table("answer_feedback").insert(data).execute()
        
        print(f"[INFO] Feedback submitted for message {feedback.message_id}")
        return {"status": "success", "id": feedback.message_id}

    except Exception as e:
        print(f"[ERROR] Feedback submission failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))