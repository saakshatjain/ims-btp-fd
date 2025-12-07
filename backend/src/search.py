import os
import json
import requests
import re
import time
from dotenv import load_dotenv
from langchain_groq import ChatGroq  # <--- CHANGED: Import Groq
from src.base_prompt import build_base_prompt

load_dotenv()

SIMILARITY_THRESHOLD = float(os.getenv("SIMILARITY_THRESHOLD", 0.85))
MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", 100000))
NOTICE_OCR_TRUNC = int(os.getenv("NOTICE_OCR_TRUNC", 500))

STOPWORDS = {
    "when", "what", "which", "who", "where", "how", "why",
    "is", "are", "was", "were", "will", "shall", "can", "could",
    "please", "tell", "me", "about", "the", "a", "an", "of", "for"
}


def normalize_query(q: str) -> str:
    q = (q or "").strip().lower()
    if not q:
        return ""
    if q.endswith("?"):
        q = q[:-1]
    tokens = [t for t in q.split() if t not in STOPWORDS]
    base = " ".join(tokens)
    return base.strip()


def title_match_boost(title: str, normalized_query: str) -> float:
    if not title or not normalized_query:
        return 0.0
    title_l = title.lower()
    tokens = [t for t in normalized_query.split() if t]
    if not tokens:
        return 0.0
    matches = sum(1 for t in tokens if t in title_l)
    if matches == 0:
        return 0.0
    frac = matches / len(tokens)
    return min(0.15, 0.05 + 0.15 * frac)


class RAGSearch:
    # ---------------------------------------------------------
    # CHANGED: Default model is now Llama 4 Scout (on Groq)
    # ---------------------------------------------------------
    def __init__(self, llm_model: str = "meta-llama/llama-4-scout-17b-16e-instruct"):
        self.retriever_url = os.getenv("RETRIEVER_URL")
        self.retriever_api_key = os.getenv("RETRIEVER_API_KEY")
        if not self.retriever_api_key or not self.retriever_url:
            raise ValueError("RETRIEVER_URL and RETRIEVER_API_KEY must be set in .env")

        # --- CHANGED: Load GROQ keys instead of Google keys ---
        keys = []
        
        # Check for single GROQ_API_KEY
        first = os.getenv("GROQ_API_KEY")
        if first:
            keys.append(first.strip())
        
        # Check for GROQ_API_KEY_2 to 5
        for i in range(2, 6):
            k = os.getenv(f"GROQ_API_KEY_{i}")
            if k:
                keys.append(k.strip())

        if not keys:
            raise ValueError("No Groq API keys found. Set GROQ_API_KEY in .env")

        self.groq_api_keys = keys
        self.current_key_index = 0
        self.llm_model_name = llm_model

        print("[INFO] Loaded Groq API keys")
        for idx, k in enumerate(self.groq_api_keys):
            print(f"  index={idx} prefix={k[:8]}...")

        self._init_llm_with_current_key()
        print(
            f"[INFO] Initialized Groq LLM {llm_model} using key index 0 "
            f"of {len(self.groq_api_keys)} available keys"
        )

    def _init_llm_with_current_key(self):
        key = self.groq_api_keys[self.current_key_index]
        print(f"[DEBUG] Initializing Groq LLM with key index {self.current_key_index} prefix={key[:8]}...")
        
        # --- CHANGED: Initialize ChatGroq ---
        self.llm = ChatGroq(
            api_key=key,
            model_name=self.llm_model_name,
            temperature=0.1, # Lower temp is better for factual summaries
            max_retries=0,   # We handle retries manually
        )

    def _rotate_and_reinit(self):
        if len(self.groq_api_keys) <= 1:
            print("[WARN] _rotate_and_reinit called but only one key configured")
            return False
        old_index = self.current_key_index
        self.current_key_index = (self.current_key_index + 1) % len(self.groq_api_keys)
        print(f"[WARN] Rotating Groq API key from index {old_index} to {self.current_key_index}")
        self._init_llm_with_current_key()
        return True

    def _call_retriever(self, query: str, prefetch_k: int = 50):
        headers = {
            "api-key": self.retriever_api_key,
            "Content-Type": "application/json"
        }

        normalized = normalize_query(query)

        payload = {
            "query": query,
            "search_query": normalized,
            "prefetch_k": prefetch_k
        }

        resp = requests.post(self.retriever_url, headers=headers, json=payload, timeout=60)
        resp.raise_for_status()
        return resp.json()

    def _select_chunks(self, chunks: list, top_k: int, normalized_query: str = ""):
        if not chunks:
            return []

        scored = []
        for c in chunks:
            sim = float(c.get("similarity", 0.0) or 0.0)
            title = c.get("notice_title") or ""
            boost = title_match_boost(title, normalized_query)
            adjusted = sim + boost
            scored.append((adjusted, sim, c))

        scored.sort(key=lambda t: t[0], reverse=True)

        combined = ""
        final = []
        for adjusted, sim, c in scored:
            text = (c.get("chunk_text") or "").strip()
            if not text:
                continue

            candidate = combined + "\n\n---\n\n" + text if combined else text
            if len(candidate) > MAX_CONTEXT_CHARS:
                break

            combined = candidate
            final.append(c)
            if len(final) >= max(top_k, 1):
                break

        return final

    def debug_log_chunks(self, chunks: list):
        print("[DEBUG] Retrieved chunks")
        for i, c in enumerate(chunks):
            sim = c.get("similarity", 0.0)
            fn = c.get("filename", "unknown")
            nid = c.get("notice_id", "-")
            link = c.get("notice_link", "N/A")
            title = c.get("notice_title") or ""
            print(f"CHUNK {i} | sim={sim:.4f} file={fn} notice_id={nid} title={title} link={link}")
            print((c.get("chunk_text", "") or "")[:400].replace("\n", " "))
            if c.get("notice_ocr"):
                print("[DEBUG] notice_ocr truncated:", str(c.get("notice_ocr"))[:200].replace("\n", " "))
            print("=" * 80)

    def _build_prompt(self, query: str, selected_chunks: list) -> str:
        chunk_blocks = []
        for i, c in enumerate(selected_chunks, start=1):
            chunk_text = (c.get("chunk_text") or "").strip()
            filename = c.get("filename", "unknown")
            notice_link = c.get("notice_link", "N/A")
            sim = c.get("similarity", 0.0)
            notice_id = c.get("notice_id", "UNKNOWN")
            title = c.get("notice_title") or ""

            block = [
                f"--- CONTEXT CHUNK {i} ---",
                f"NOTICE_ID: {notice_id}",
                f"TITLE: {title}",
                f"FILENAME: {filename}",
                f"SOURCE_LINK: {notice_link}",
                f"SCORE: {sim:.4f}",
                "",
                "CHUNK_TEXT:",
                chunk_text,
                f"--- END CONTEXT CHUNK {i} ---",
            ]
            chunk_blocks.append("\n".join(block))

        chunk_section = "\n\n".join(chunk_blocks)
        used_chars = len(chunk_section)

        notices = {}
        for c in selected_chunks:
            nid = c.get("notice_id") or "UNKNOWN"
            if nid not in notices:
                notices[nid] = {
                    "filename": c.get("filename", "unknown"),
                    "notice_link": c.get("notice_link", "N/A"),
                    "ocr": c.get("notice_ocr") or "",
                    "title": c.get("notice_title") or "",
                    "max_similarity": c.get("similarity", 0.0),
                }
            else:
                sim = c.get("similarity", 0.0)
                if sim > notices[nid]["max_similarity"]:
                    notices[nid]["max_similarity"] = sim

        ordered_notices = sorted(
            notices.items(),
            key=lambda kv: kv[1]["max_similarity"],
            reverse=True,
        )

        ocr_blocks = []
        for j, (nid, info) in enumerate(ordered_notices, start=1):
            ocr_text = info["ocr"] or ""
            if not ocr_text:
                continue

            filename = info["filename"]
            link = info["notice_link"]
            title = info.get("title", "")

            if NOTICE_OCR_TRUNC and NOTICE_OCR_TRUNC > 0:
                ocr_part = ocr_text[:NOTICE_OCR_TRUNC]
            else:
                ocr_part = ocr_text

            notice_block = (
                f"--- FULL NOTICE {j} ---\n"
                f"NOTICE_ID: {nid}\n"
                f"TITLE: {title}\n"
                f"FILENAME: {filename}\n"
                f"SOURCE_LINK: {link}\n"
                f"FULL_NOTICE_OCR:\n{ocr_part}\n"
                f"--- END FULL NOTICE {j} ---\n"
            )

            if used_chars + len(notice_block) > MAX_CONTEXT_CHARS:
                break

            ocr_blocks.append(notice_block)
            used_chars += len(notice_block)

        if ocr_blocks:
            context_text = chunk_section + "\n\n" + "\n\n".join(ocr_blocks)
        else:
            context_text = chunk_section

        return build_base_prompt(context_text, query)

    def _parse_sources_from_response(self, response: str) -> dict:
        try:
            parsed = json.loads(response)

            answer = parsed.get("answer", "").strip()
            sources = parsed.get("sources", [])

            if not isinstance(sources, list):
                sources = []

            lower_answer = answer.lower()
            if "i don't know" in lower_answer or "don't know" in lower_answer or "no specific question" in lower_answer:
                sources = []

            return {
                "answer": answer,
                "sources": sources if sources else []
            }
        except json.JSONDecodeError:
            json_match = re.search(r"\{[\s\S]*\}", response)
            if json_match:
                try:
                    parsed = json.loads(json_match.group(0))
                    answer = parsed.get("answer", response).strip()
                    sources = parsed.get("sources", [])
                    if not isinstance(sources, list):
                        sources = []
                    lower_answer = answer.lower()
                    if "i don't know" in lower_answer or "don't know" in lower_answer or "no specific question" in lower_answer:
                        sources = []
                    return {
                        "answer": answer,
                        "sources": sources if sources else []
                    }
                except json.JSONDecodeError:
                    pass

            return {
                "answer": response,
                "sources": []
            }

    # ---------------------------------------------------------
    # CALL LLM WITH ROTATION (Adapted for Groq)
    # ---------------------------------------------------------
    def _call_llm(self, prompt: str):
        attempts = 0
        max_attempts = len(self.groq_api_keys)
        last_exception = None

        while attempts < max_attempts:
            print(f"[DEBUG] Groq attempt {attempts + 1} using key index {self.current_key_index}")
            try:
                response = self.llm.invoke([prompt])
                if hasattr(response, "content"):
                    return response.content
                if isinstance(response, dict):
                    return response.get("text") or response.get("output") or str(response)
                return str(response)

            except Exception as e:
                last_exception = e
                msg = str(e)
                msg_lower = msg.lower()

                print(f"[ERROR] Groq call failed on key index {self.current_key_index}: {msg[:200]}...")

                # Check if it is a Quota/Rate Limit error
                # Groq rate limits often contain "rate limit" or "429"
                if (
                    "429" in msg_lower
                    or "rate limit" in msg_lower
                    or "too many requests" in msg_lower
                ):
                    # --- PARSE WAIT TIME ---
                    wait_seconds = 1.0 
                    # Regex to find "try again in 2.4s" or similar
                    match = re.search(r"in (\d+(\.\d+)?)s", msg_lower)
                    if match:
                        wait_seconds = float(match.group(1)) + 1.0
                    
                    print(f"[WARN] Groq Rate limit hit. Sleeping for {wait_seconds:.2f}s before rotating...")
                    time.sleep(wait_seconds) 

                    # Now rotate
                    rotated = self._rotate_and_reinit()
                    attempts += 1
                    
                    if rotated:
                        print(f"[INFO] Retrying with new key index {self.current_key_index}")
                        continue
                    else:
                        print("[WARN] No other keys to rotate to. Aborting.")
                        break

                # Context length errors
                if "context_length" in msg_lower or "too large" in msg_lower:
                    raise e

                print(f"[ERROR] Unknown error type. Aborting attempts.")
                raise e

        raise RuntimeError(
            f"Groq invoke failed after trying {attempts} keys. last error: {last_exception}"
        )

    def search_and_generate(self, query: str, top_k: int = 10, prefetch_k: int = 100) -> dict:
        try:
            data = self._call_retriever(query, prefetch_k=prefetch_k)
        except Exception as e:
            return {"answer": f"[ERROR] Retriever call failed: {e}", "sources": []}

        chunks = data.get("chunks", []) if isinstance(data, dict) else []
        if not chunks:
            return {"answer": "No relevant documents found.", "sources": []}

        normalized = normalize_query(query)
        selected = self._select_chunks(chunks, top_k=top_k, normalized_query=normalized)
        if not selected:
            return {"answer": "No relevant documents found after selection.", "sources": []}

        prompt = self._build_prompt(query, selected)

        try:
            answer = self._call_llm(prompt)
            print("[DEBUG] Raw Groq answer:", answer)
            parsed = self._parse_sources_from_response(answer)
            return {
                "answer": parsed["answer"],
                "sources": parsed["sources"]
            }
        except Exception as e:
            msg = str(e)
            lower = msg.lower()

            if "rate limit" in lower or "429" in lower:
                return {
                    "answer": (
                        "The Groq API quota appears to be exhausted for all configured keys. "
                        "Please check your Groq Cloud console."
                    ),
                    "sources": []
                }

            if "context_length" in lower or "too large" in lower:
                # If context is too big, remove OCR text and try again
                for c in selected:
                    if "notice_ocr" in c:
                        c["notice_ocr"] = None
                prompt2 = self._build_prompt(query, selected)
                try:
                    answer = self._call_llm(prompt2)
                    parsed = self._parse_sources_from_response(answer)
                    return {
                        "answer": parsed["answer"],
                        "sources": parsed["sources"]
                    }
                except Exception as e2:
                    return {"answer": f"[ERROR] Groq call failed after truncation: {e2}", "sources": []}

            return {"answer": f"[ERROR] Groq call failed: {e}", "sources": []}