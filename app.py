# app.py
from dotenv import load_dotenv
load_dotenv()

from src.search import RAGSearch

if __name__ == "__main__":
    rag = RAGSearch()
    query = "tell me about innovation tech fest"
    print("[INFO] Query:", query)
    result = rag.search_and_generate(query, top_k=3, prefetch_k=20)
    print("\n=== MODEL ANSWER ===\n")
    print(result)
    print("\n====================\n")
