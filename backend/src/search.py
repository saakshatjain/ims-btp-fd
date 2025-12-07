import os
import json
import requests
import re
import time  # <--- Added for sleep
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
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
    # FIX 1: Changed default model to 'gemini-1.5-flash'
    # which has a generous free tier compared to 2.0-preview
    # ---------------------------------------------------------
    def __init__(self, llm_model: str = "gemini-1.5-flash"):
        self.retriever_url = os.getenv("RETRIEVER_URL")
        self.retriever_api_key = os.getenv("RETRIEVER_API_KEY")
        if not self.retriever_api_key or not self.retriever_url:
            raise ValueError("RETRIEVER_URL and RETRIEVER_API_KEY must be set in .env")

        keys = []
        env_keys_csv = os.getenv("GOOGLE_API_KEYS")
        if env_keys_csv:
            keys = [k.strip() for k in env_keys_csv.split(",") if k.strip()]

        if not keys:
            first = os.getenv("GOOGLE_API_KEY")
            if first:
                keys.append(first.strip())
            for i in range(2, 5):
                k = os.getenv(f"GOOGLE_API_KEY_{i}")
                if k:
                    keys.append(k.strip())

        if not keys:
            raise ValueError("No Google API key found in environment. Set GOOGLE_API_KEY or GOOGLE_API_KEYS")

        self.google_api_keys = keys
        self.current_key_index = 0
        self.llm_model_name = llm_model

        print("[INFO] Loaded Google API keys")
        for idx, k in enumerate(self.google_api_keys):
            print(f"  index={idx} prefix={k[:8]}...")

        self._init_llm_with_current_key()
        print(
            f"[INFO] Initialized LLM model {llm_model} using key index 0 "
            f"of {len(self.google_api_keys)} available keys"
        )

    def _init_llm_with_current_key(self):
        key = self.google_api_keys[self.current_key_index]
        print(f"[DEBUG] Initializing LLM with key index {self.current_key_index} prefix={key[:8]}...")
        self.llm = ChatGoogleGenerativeAI(
            google_api_key=key,
            model=self.llm_model_name,
            temperature=0.0,
            max_retries=0,     # let our wrapper handle retries and rotation
            timeout=None,
        )

    def _rotate_and_reinit(self):
        if len(self.google_api_keys) <= 1:
            print("[WARN] _rotate_and_reinit called but only one key configured")
            return False
        old_index = self.current_key_index
        self.current_key_index = (self.current_key_index + 1) % len(self.google_api_keys)
        print(f"[WARN] Rotating Google API key from index {old_index} to {self.current_key_index}")
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
    # FIX 2: Completely rewrote _call_llm to handle 429 logic
    # ---------------------------------------------------------
    def _call_llm(self, prompt: str):
        attempts = 0
        max_attempts = len(self.google_api_keys)
        last_exception = None

        while attempts < max_attempts:
            print(f"[DEBUG] LLM attempt {attempts + 1} using key index {self.current_key_index}")
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

                print(f"[ERROR] LLM call failed on key index {self.current_key_index}: {msg[:200]}...")

                # Check if it is a Quota/Rate Limit error
                if (
                    "429" in msg_lower
                    or "resourceexhausted" in msg_lower
                    or "quota" in msg_lower
                    or "rate limit" in msg_lower
                ):
                    # --- PARSE WAIT TIME ---
                    # Look for "Please retry in 18.822659908s" or similar
                    wait_seconds = 1.0  # default backoff
                    match = re.search(r"retry in (\d+(\.\d+)?)s", msg_lower)
                    if match:
                        wait_seconds = float(match.group(1)) + 1.0  # Add 1s buffer
                    
                    print(f"[WARN] Rate limit hit. Sleeping for {wait_seconds:.2f}s before rotating...")
                    time.sleep(wait_seconds)  # <--- CRITICAL FIX: ACTUAL SLEEP

                    # Now rotate
                    rotated = self._rotate_and_reinit()
                    attempts += 1
                    
                    if rotated:
                        print(f"[INFO] Retrying with new key index {self.current_key_index}")
                        continue
                    else:
                        # No more keys to rotate, but we just slept, so maybe try same key one last time?
                        # Or break to avoid infinite loop if single key.
                        print("[WARN] No other keys to rotate to. Aborting.")
                        break

                # If it's a context length error, we can't fix it by rotation/sleeping
                if "context_length" in msg_lower or "too large" in msg_lower:
                    raise e

                # For other unknown errors, you might want to retry or just raise
                print(f"[ERROR] Unknown error type. Aborting attempts.")
                raise e

        raise RuntimeError(
            f"LLM invoke failed after trying {attempts} keys. last error: {last_exception}"
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
            print("[DEBUG] Raw LLM answer:", answer)
            parsed = self._parse_sources_from_response(answer)
            return {
                "answer": parsed["answer"],
                "sources": parsed["sources"]
            }
        except Exception as e:
            msg = str(e)
            lower = msg.lower()

            if (
                "resourceexhausted" in lower
                or "quota" in lower
                or "rate limit" in lower
                or "too many requests" in lower
            ):
                return {
                    "answer": (
                        "The language model quota appears to be exhausted for the current Gemini setup. "
                        "Please update billing or switch to a different model in the backend configuration."
                    ),
                    "sources": []
                }

            if "context_length" in lower or "reduce the length" in lower or "400" in lower:
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
                    return {"answer": f"[ERROR] LLM call failed after truncation: {e2}", "sources": []}

            return {"answer": f"[ERROR] LLM call failed: {e}", "sources": []}