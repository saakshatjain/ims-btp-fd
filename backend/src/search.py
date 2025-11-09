# src/search.py
import os
import requests
from dotenv import load_dotenv
from langchain_groq import ChatGroq   # keep using your existing wrapper
from src.base_prompt import build_base_prompt

load_dotenv()

# Simple selection/config
SIMILARITY_THRESHOLD = 0.45
MAX_CONTEXT_CHARS = 4000  # crude guard to keep prompt size reasonable

class RAGSearch:
    def __init__(self, llm_model: str = "llama-3.3-70b-versatile"): #llama-3.1-8b-instant
        # Retriever config from environment
        self.retriever_url = os.getenv("RETRIEVER_URL")
        self.retriever_api_key = os.getenv("RETRIEVER_API_KEY")
        if not self.retriever_api_key:
            raise ValueError("RETRIEVER_API_KEY is not set in .env")

        # LLM (Groq) initialization
        groq_api_key = os.getenv("GROQ_API_KEY")
        if not groq_api_key:
            raise ValueError("GROQ_API_KEY is not set in .env")
        self.llm = ChatGroq(groq_api_key=groq_api_key, model_name=llm_model)
        print(f"[INFO] Initialized LLM: {llm_model}")

    def _call_retriever(self, query: str, prefetch_k: int = 30):
        headers = {
            "api-key": self.retriever_api_key,
            "Content-Type": "application/json"
        }
        payload = {"query": query, "prefetch_k": prefetch_k}
        resp = requests.post(self.retriever_url, headers=headers, json=payload, timeout=60)
        resp.raise_for_status()
        return resp.json()

    def _select_chunks(self, chunks: list, top_k: int):
        # Expect chunks to have keys: chunk_text, filename, notice_id, similarity
        sorted_chunks = sorted(chunks, key=lambda c: c.get("similarity", 0), reverse=True)
        if not sorted_chunks:
            return []

        top_sim = sorted_chunks[0].get("similarity", 0)
        if top_sim >= SIMILARITY_THRESHOLD:
            selected = [sorted_chunks[0]]
        else:
            selected = sorted_chunks[:top_k]

        # enforce crude char-length budget
        combined = ""
        final = []
        for c in selected:
            text = c.get("chunk_text", "").strip()
            if not text:
                continue
            candidate = combined + "\n\n---\n\n" + text if combined else text
            if len(candidate) > MAX_CONTEXT_CHARS:
                break
            combined = candidate
            final.append(c)
        return final

    def _build_prompt(self, query: str, chunks: list) -> str:
        """
        Combine the retrieved chunks into a single context string,
        then build the final LLM prompt using the external base_prompt template.
        """
        blocks = []
        for i, c in enumerate(chunks, start=1):
            blocks.append(
                f"--- CONTEXT CHUNK {i} ---\n"
                f"{c.get('chunk_text','')}\n"
                f"SOURCE: {c.get('filename','unknown')} "
                f"(notice_id: {c.get('notice_id','-')})\n"
                f"SCORE: {c.get('similarity', 0):.4f}\n"
                f"--- END CONTEXT CHUNK {i} ---"
            )

        context_text = "\n\n".join(blocks)
        # Use your base prompt builder instead of inline string
        return build_base_prompt(context_text, query)


    def _call_llm(self, prompt: str):
        # Using the same invocation pattern you had earlier
        response = self.llm.invoke([prompt])
        # Try to extract text content in a couple of common shapes
        if hasattr(response, "content"):
            return response.content
        if isinstance(response, dict):
            # some wrappers return dicts
            return response.get("text") or response.get("output") or str(response)
        return str(response)

    def search_and_generate(self, query: str, top_k: int = 3, prefetch_k: int = 30) -> str:
        # 1) Call retriever
        try:
            data = self._call_retriever(query, prefetch_k=prefetch_k)
        except Exception as e:
            return f"[ERROR] Retriever call failed: {e}"

        chunks = data.get("chunks", []) if isinstance(data, dict) else []
        if not chunks:
            return "No relevant documents found."

        # 2) Select chunks
        selected = self._select_chunks(chunks, top_k=top_k)
        if not selected:
            return "No relevant documents found after selection."

        # 3) Build prompt
        prompt = self._build_prompt(query, selected)

        # 4) Call LLM
        try:
            answer = self._call_llm(prompt)
        except Exception as e:
            return f"[ERROR] LLM call failed: {e}"

        return answer.strip()
