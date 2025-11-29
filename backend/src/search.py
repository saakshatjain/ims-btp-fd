# src/search.py
import os
import json
import requests
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from src.base_prompt import build_base_prompt

load_dotenv()

# Config
SIMILARITY_THRESHOLD = float(os.getenv("SIMILARITY_THRESHOLD", 0.85))
MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", 100000))      # total char budget for context sent to LLM
# If retriever returns notice_ocr, include only this many chars per notice_ocr in prompt
NOTICE_OCR_TRUNC = int(os.getenv("NOTICE_OCR_TRUNC", 500))

# -------------------------
# Query normalization (for better retrieval)
# -------------------------
STOPWORDS = {
    "when", "what", "which", "who", "where", "how", "why",
    "is", "are", "was", "were", "will", "shall", "can", "could",
    "please", "tell", "me", "about", "the", "a", "an", "of", "for"
}

def normalize_query(q: str) -> str:
    """
    Deterministic normalization to convert natural question forms into
    keyword-dense search queries appropriate for FTS + vector hybrid retrieval.

    Examples:
      "When is responsible AI exam?" -> "responsible ai exam date schedule time notice"
    """
    q = (q or "").strip().lower()
    if not q:
        return ""
    if q.endswith("?"):
        q = q[:-1]
    tokens = [t for t in q.split() if t not in STOPWORDS]
    base = " ".join(tokens)
    return base.strip()


class RAGSearch:
    # ---------------------------------------------------------
    # CHANGED: Default model set to Gemini 2.0 Flash Lite
    # ---------------------------------------------------------
    def __init__(self, llm_model: str = "gemini-2.0-flash-lite-preview-02-05"):
        # Retriever config (external microservice)
        self.retriever_url = os.getenv("RETRIEVER_URL")
        self.retriever_api_key = os.getenv("RETRIEVER_API_KEY")
        if not self.retriever_api_key or not self.retriever_url:
            raise ValueError("RETRIEVER_URL and RETRIEVER_API_KEY must be set in .env")

        # ---------------------------------------------------------
        # CHANGED: Google Gemini Initialization
        # ---------------------------------------------------------
        google_api_key = os.getenv("GOOGLE_API_KEY")
        if not google_api_key:
            raise ValueError("GOOGLE_API_KEY is not set in .env")
        
        # Initialize Gemini
        # Temperature 0.0 is usually best for RAG tasks to reduce hallucinations
        self.llm = ChatGoogleGenerativeAI(
            google_api_key=google_api_key, 
            model=llm_model,
            temperature=0.0
        )
        print(f"[INFO] Initialized LLM: {llm_model}")

    # -------------------------
    # Retriever Call
    # -------------------------
    def _call_retriever(self, query: str, prefetch_k: int = 50):
        """
        Calls the external retriever microservice.

        Payload includes:
          - "query": raw user query (for logging / backward compatibility)
          - "search_query": normalized keyword-dense query (for FTS/vector hybrid)
          - "prefetch_k": number of candidates to fetch lexically before vector re-rank

        The retriever is expected to return JSON with a top-level "chunks" list
        where each chunk is a dict containing keys such as:
          chunk_text, filename, notice_id, similarity, notice_link (optional), notice_ocr (optional)
        """
        headers = {
            "api-key": self.retriever_api_key,
            "Content-Type": "application/json"
        }

        # Normalize and send both raw + normalized forms; retriever can choose which to use.
        normalized = normalize_query(query)

        payload = {
            "query": query,
            "search_query": normalized,
            "prefetch_k": prefetch_k
        }

        resp = requests.post(self.retriever_url, headers=headers, json=payload, timeout=60)
        resp.raise_for_status()
        return resp.json()

    # -------------------------
    # Chunk selection
    # -------------------------
    def _select_chunks(self, chunks: list, top_k: int):
        sorted_chunks = sorted(chunks, key=lambda c: c.get("similarity", 0.0), reverse=True)
        if not sorted_chunks:
            return []

        combined = ""
        final = []

        for c in sorted_chunks[:max(top_k, 1)]:
            text = (c.get("chunk_text") or "").strip()
            if not text:
                continue

            candidate = combined + "\n\n---\n\n" + text if combined else text
            if len(candidate) > MAX_CONTEXT_CHARS:
                break

            combined = candidate
            final.append(c)

        return final

    def debug_log_chunks(self, chunks: list):
        print("[DEBUG] Retrieved chunks:")
        for i, c in enumerate(chunks):
            sim = c.get('similarity', 0.0)
            fn = c.get('filename', 'unknown')
            nid = c.get('notice_id', '-')
            link = c.get('notice_link', 'N/A')
            print(f"CHUNK {i} — sim={sim:.4f} file={fn} notice_id={nid} link={link}")
            print(c.get("chunk_text", "")[:400].replace("\n", " "))
            # if retriever included a small OCR excerpt, print a bit of it for debug
            if c.get("notice_ocr"):
                print("[DEBUG] notice_ocr (truncated):", str(c.get("notice_ocr"))[:200].replace("\n", " "))
            print("-" * 80)

    # -------------------------
    # Prompt Building (OCR-free / retriever-driven)
    # -------------------------
    def _build_prompt(self, query: str, selected_chunks: list) -> str:
        """
        Strategy:
        1) Always include all selected chunk_text blocks (top-K chunks).
        2) Then, add full OCR text per notice_id, as long as we stay under MAX_CONTEXT_CHARS.
           This way, even if OCR is too long, the key chunks are never dropped.
        """

        # -------- Phase 1: chunk-level blocks (always included) --------
        chunk_blocks = []
        for i, c in enumerate(selected_chunks, start=1):
            chunk_text = (c.get("chunk_text") or "").strip()
            filename = c.get("filename", "unknown")
            notice_link = c.get("notice_link", "N/A")
            sim = c.get("similarity", 0.0)
            notice_id = c.get("notice_id", "UNKNOWN")

            block = [
                f"--- CONTEXT CHUNK {i} ---",
                f"NOTICE_ID: {notice_id}",
                f"FILENAME: {filename}",
                f"SOURCE_LINK: {notice_link}",
                f"SCORE: {sim:.4f}",
                "",
                f"CHUNK_TEXT:",
                chunk_text,
                f"--- END CONTEXT CHUNK {i} ---",
            ]
            chunk_blocks.append("\n".join(block))

        chunk_section = "\n\n".join(chunk_blocks)
        used_chars = len(chunk_section)

        # -------- Phase 2: notice-level OCR blocks (best-effort) --------
        # Group chunks by notice_id
        notices = {}  # notice_id -> dict
        for c in selected_chunks:
            nid = c.get("notice_id") or "UNKNOWN"
            if nid not in notices:
                notices[nid] = {
                    "filename": c.get("filename", "unknown"),
                    "notice_link": c.get("notice_link", "N/A"),
                    "ocr": c.get("notice_ocr") or "",
                    "max_similarity": c.get("similarity", 0.0),
                }
            else:
                sim = c.get("similarity", 0.0)
                if sim > notices[nid]["max_similarity"]:
                    notices[nid]["max_similarity"] = sim

        # Order notices by how relevant they are (best chunk similarity)
        ordered_notices = sorted(
            notices.items(),
            key=lambda kv: kv[1]["max_similarity"],
            reverse=True,
        )

        ocr_blocks = []
        for j, (nid, info) in enumerate(ordered_notices, start=1):
            ocr_text = info["ocr"] or ""
            if not ocr_text:
                continue  # no OCR available for this notice

            filename = info["filename"]
            link = info["notice_link"]

            # If you want to hard-limit OCR per notice, you can slice here, e.g.:
            # ocr_text = ocr_text[:NOTICE_OCR_TRUNC]
            notice_block = (
                f"--- FULL NOTICE {j} ---\n"
                f"NOTICE_ID: {nid}\n"
                f"FILENAME: {filename}\n"
                f"SOURCE_LINK: {link}\n"
                f"FULL_NOTICE_OCR:\n{ocr_text}\n"
                f"--- END FULL NOTICE {j} ---\n"
            )

            # Enforce global char budget only for OCR expansions
            if used_chars + len(notice_block) > MAX_CONTEXT_CHARS:
                break

            ocr_blocks.append(notice_block)
            used_chars += len(notice_block)

        # -------- Build final context text --------
        # Always have chunk_section; OCR section is best-effort
        if ocr_blocks:
            context_text = chunk_section + "\n\n" + "\n\n".join(ocr_blocks)
        else:
            context_text = chunk_section

        return build_base_prompt(context_text, query)

    # -------------------------
    # LLM call
    # -------------------------
    def _call_llm(self, prompt: str):
        response = self.llm.invoke([prompt])
        if hasattr(response, "content"):
            return response.content
        if isinstance(response, dict):
            return response.get("text") or response.get("output") or str(response)
        return str(response)

    # -------------------------
    # Main flow
    # -------------------------
    def search_and_generate(self, query: str, top_k: int = 10, prefetch_k: int = 30) -> dict:
        # 1) Call retriever
        try:
            data = self._call_retriever(query, prefetch_k=prefetch_k)
        except Exception as e:
            return {"answer": f"[ERROR] Retriever call failed: {e}", "sources": []}

        chunks = data.get("chunks", []) if isinstance(data, dict) else []
        if not chunks:
            return {"answer": "No relevant documents found.", "sources": []}

        # 2) Select top_k chunks (by similarity) - enforces MAX_CONTEXT_CHARS
        selected = self._select_chunks(chunks, top_k=top_k)
        if not selected:
            return {"answer": "No relevant documents found after selection.", "sources": []}

        # Debug log retrieved chunks (call this to inspect)
        self.debug_log_chunks(selected)

        # 3) Build prompt using retriever-provided data only
        prompt = self._build_prompt(query, selected)

        # 4) Call LLM with safe retry if it errors out (simple retry with smaller OCR snippet)
        try:
            answer = self._call_llm(prompt)
            return {"answer": answer.strip(), "sources": selected}
        except Exception as e:
            msg = str(e)
            # if model complains about context length, attempt a fallback by stripping notice_ocr
            if "context_length" in msg or "reduce the length" in msg.lower() or "400" in msg:
                # remove notice_ocr temporarily and retry
                for c in selected:
                    if "notice_ocr" in c:
                        c["notice_ocr"] = None
                prompt2 = self._build_prompt(query, selected)
                try:
                    answer = self._call_llm(prompt2)
                    return {"answer": answer.strip(), "sources": selected}
                except Exception as e2:
                    return {"answer": f"[ERROR] LLM call failed after truncation: {e2}", "sources": selected}
            
            return {"answer": f"[ERROR] LLM call failed: {e}", "sources": selected}