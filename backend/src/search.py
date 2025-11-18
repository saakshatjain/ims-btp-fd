# src/search.py
import os
import re
import json
import requests
from dotenv import load_dotenv
from langchain_groq import ChatGroq   # keep using your existing wrapper
from src.base_prompt import build_base_prompt
from dateutil import parser as dateparser

load_dotenv()

# Config
SIMILARITY_THRESHOLD = float(os.getenv("SIMILARITY_THRESHOLD", 0.85))
MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", 4000))      # total char budget for context sent to LLM
MAX_NOTICE_SNIPPET = int(os.getenv("MAX_NOTICE_SNIPPET", 2000))    # how much of full OCR notice to attach per notice
TOP_NOTICE_FETCH = int(os.getenv("TOP_NOTICE_FETCH", 5))           # how many top notices to fetch full OCR for
KEYWORD_WINDOW = int(os.getenv("KEYWORD_WINDOW", 200))             # chars around keyword match to include

# Regexes
date_regex = r"(\b(?:\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?))"
roll_regex = r"\b\d{4}[A-Z]{0,3}\d{3,4}[A-Z]{0,3}\b"  # adjust to your roll patterns


class RAGSearch:
    def __init__(self, llm_model: str = "llama-3.3-70b-versatile"):
        # Retriever config
        self.retriever_url = os.getenv("RETRIEVER_URL")
        self.retriever_api_key = os.getenv("RETRIEVER_API_KEY")
        if not self.retriever_api_key or not self.retriever_url:
            raise ValueError("RETRIEVER_URL and RETRIEVER_API_KEY must be set in .env")

        # Supabase config (for fetching OCR/full notice text)
        self.supabase_url = os.getenv("SUPABASE_URL")    # e.g., https://<proj>.supabase.co
        self.supabase_key = os.getenv("SUPABASE_KEY")    # service_role or anon with read access

        # LLM (Groq) initialization
        groq_api_key = os.getenv("GROQ_API_KEY")
        if not groq_api_key:
            raise ValueError("GROQ_API_KEY is not set in .env")
        self.llm = ChatGroq(groq_api_key=groq_api_key, model_name=llm_model)
        print(f"[INFO] Initialized LLM: {llm_model}")

    # -------------------------
    # Retriever / Supabase calls
    # -------------------------
    def _call_retriever(self, query: str, prefetch_k: int = 50):
        headers = {
            "api-key": self.retriever_api_key,
            "Content-Type": "application/json"
        }
        payload = {"query": query, "prefetch_k": prefetch_k}
        resp = requests.post(self.retriever_url, headers=headers, json=payload, timeout=60)
        resp.raise_for_status()
        return resp.json()

    def _fetch_notice_ocr(self, notice_id: str):
        """
        Return a dict with keys 'ocr_text' and 'ocr_tables' (json) and filename for the notice.
        Returns empty dict on failure.
        """
        if not (self.supabase_url and self.supabase_key):
            return {}
        try:
            endpoint = f"{self.supabase_url}/rest/v1/notices"
            params = {
                "id": f"eq.{notice_id}",
                "select": "ocr_text,ocr_tables,filename"
            }
            headers = {
                "apikey": self.supabase_key,
                "Authorization": f"Bearer {self.supabase_key}",
                "Accept": "application/json"
            }
            r = requests.get(endpoint, headers=headers, params=params, timeout=30)
            if r.status_code != 200:
                print(f"[WARN] Supabase fetch failed for {notice_id}: status {r.status_code}")
                return {}
            data = r.json()
            if not data:
                return {}
            row = data[0]
            return {
                "ocr_text": row.get("ocr_text") or "",
                "ocr_tables": row.get("ocr_tables") or None,
                "filename": row.get("filename") or None
            }
        except Exception as e:
            print(f"[WARN] Failed to fetch OCR for {notice_id}: {e}")
            return {}

    # -------------------------
    # snippet extraction utils
    # -------------------------
    def _find_keyword_snippets(self, text: str, keywords: list, max_chars_per_hit=KEYWORD_WINDOW):
        text_lower = text.lower() if text else ""
        snippets = []
        for kw in keywords:
            if not kw or not text:
                continue
            for m in re.finditer(re.escape(kw.lower()), text_lower):
                start = max(0, m.start() - max_chars_per_hit//2)
                end = min(len(text), m.end() + max_chars_per_hit//2)
                snippet = text[start:end].strip()
                snippets.append(snippet)
        # deduplicate near-identical snippets
        unique = []
        seen = set()
        for s in snippets:
            key = s[:200]
            if key not in seen:
                seen.add(key)
                unique.append(s)
        return unique

    def _extract_date_snippets(self, text: str, max_hits=3):
        if not text:
            return []
        hits = []
        for m in re.finditer(date_regex, text, flags=re.I):
            s = m.group(0)
            try:
                dt = dateparser.parse(s, fuzzy=True, dayfirst=False)
                if dt:
                    start = max(0, m.start() - 40)
                    end = min(len(text), m.end() + 40)
                    hits.append((s, text[start:end].strip()))
            except Exception:
                pass
            if len(hits) >= max_hits:
                break
        return hits

    def _extract_roll_snippets(self, text: str, max_hits=3):
        if not text:
            return []
        rolls = re.findall(roll_regex, text)
        unique = []
        for r in rolls:
            if r not in unique:
                unique.append(r)
            if len(unique) >= max_hits:
                break
        return unique

    def _table_to_text(self, table_obj, max_cells=30):
        if not table_obj:
            return ""
        rows = table_obj if isinstance(table_obj, list) else []
        out_rows = []
        cell_count = 0
        for r in rows:
            out_rows.append(" | ".join([str(c).strip() for c in r][:10]))
            cell_count += len(r)
            if cell_count >= max_cells:
                break
        return "\n".join(out_rows)

    # -------------------------
    # selection / building
    # -------------------------
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
        # enforce char-length budget when merging selected chunk_texts
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

    def debug_log_chunks(self, chunks: list):
        print("[DEBUG] Retrieved chunks:")
        for i, c in enumerate(chunks):
            sim = c.get('similarity', 0.0)
            fn = c.get('filename', 'unknown')
            nid = c.get('notice_id', '-')
            print(f"CHUNK {i} — sim={sim:.4f} file={fn} notice_id={nid}")
            print(c.get("chunk_text", "")[:400].replace("\n", " "))
            print("-" * 80)

    def _build_prompt(self, query: str, selected_chunks: list, full_notice_info: dict) -> str:
        """
        Build prompt from:
         - selected_chunks: list of chunk dicts (already selected)
         - full_notice_info: mapping notice_id -> dict with ocr_text, ocr_tables, filename
        """
        blocks = []
        supabase_public_prefix = (self.supabase_url + "/storage/v1/object/public/") if self.supabase_url else None

        # derive keywords from query for targeted snippet search
        q_lower = query.lower()
        tokens = [t for t in re.split(r"\W+", q_lower) if len(t) > 2]
        question_words = ["when", "where", "deadline", "exam", "register", "last", "apply", "seat", "venue", "roll"]
        keywords = list(dict.fromkeys(tokens + question_words))

        for i, c in enumerate(selected_chunks, start=1):
            chunk_text = c.get("chunk_text", "").strip()
            filename = c.get("filename", "unknown")
            notice_id = c.get("notice_id", "-")
            sim = c.get("similarity", 0.0)

            notice_data = full_notice_info.get(notice_id, {})
            full_text = notice_data.get("ocr_text", "") or ""
            ocr_tables = notice_data.get("ocr_tables", None)

            snippet_parts = []
            # date hits
            date_hits = self._extract_date_snippets(full_text)
            for s, ctx in date_hits:
                snippet_parts.append(f"[DATE MATCH: '{s}'] ... {ctx}")
            # roll hits
            rolls = self._extract_roll_snippets(full_text)
            for r in rolls:
                snippet_parts.append(f"[ROLL MATCH: {r}]")
            # keyword hits
            kw_snips = self._find_keyword_snippets(full_text, keywords, max_chars_per_hit=KEYWORD_WINDOW)
            for s in kw_snips[:3]:
                snippet_parts.append(s)
            # fallback snippet
            if not snippet_parts and full_text:
                snippet_parts.append(full_text[:MAX_NOTICE_SNIPPET])

            table_snippets = []
            if ocr_tables:
                try:
                    # if ocr_tables stored as JSON string, parse
                    if isinstance(ocr_tables, str):
                        ocr_tables_obj = json.loads(ocr_tables)
                    else:
                        ocr_tables_obj = ocr_tables
                    for t in (ocr_tables_obj if isinstance(ocr_tables_obj, list) else []):
                        table_snippets.append(self._table_to_text(t))
                        if len(table_snippets) >= 2:
                            break
                except Exception:
                    pass

            file_url = None
            if supabase_public_prefix and filename:
                file_url = f"{supabase_public_prefix}notices/{filename}"

            block_lines = [
                f"--- CONTEXT CHUNK {i} ---",
                f"CHUNK: {chunk_text}",
                f"SOURCE_FILE: {filename}",
                f"SOURCE_LINK: {file_url or 'N/A'}",
                f"SCORE: {sim:.4f}"
            ]
            if snippet_parts:
                block_lines.append("--- RELEVANT SNIPPETS FROM FULL NOTICE ---")
                block_lines.extend(snippet_parts[:3])
            if table_snippets:
                block_lines.append("--- TABLE SNIPPET ---")
                block_lines.extend(table_snippets[:2])
            block_lines.append(f"--- END CONTEXT CHUNK {i} ---")
            blocks.append("\n".join(block_lines))

        context_text = "\n\n".join(blocks)
        return build_base_prompt(context_text, query)

    def _call_llm(self, prompt: str):
        response = self.llm.invoke([prompt])
        if hasattr(response, "content"):
            return response.content
        if isinstance(response, dict):
            return response.get("text") or response.get("output") or str(response)
        return str(response)

    # --------------- Main flow ---------------
    def search_and_generate(self, query: str, top_k: int = 3, prefetch_k: int = 50) -> str:
        # 1) Call retriever (get candidate chunks with similarity)
        try:
            data = self._call_retriever(query, prefetch_k=prefetch_k)
        except Exception as e:
            return f"[ERROR] Retriever call failed: {e}"

        chunks = data.get("chunks", []) if isinstance(data, dict) else []
        if not chunks:
            return "No relevant documents found."

        # 2) Select top_k chunks (by similarity)
        selected = self._select_chunks(chunks, top_k=top_k)
        if not selected:
            selected = chunks[:top_k]

        # Debug log retrieved chunks (call this to inspect)
        self.debug_log_chunks(selected)

        # 3) Identify unique notice_ids to fetch full OCR for (top TOP_NOTICE_FETCH from entire candidate list)
        notice_order = []
        for c in chunks:
            nid = c.get("notice_id")
            if nid and nid not in notice_order:
                notice_order.append(nid)
        notice_order = notice_order[:TOP_NOTICE_FETCH]

        # 4) Fetch full OCR & tables for those notices
        full_notice_info = {}
        for nid in notice_order:
            info = self._fetch_notice_ocr(nid)
            if info:
                text = info.get("ocr_text") or ""
                # keep a larger working copy to extract snippets; final snippet attached to chunks will be truncated
                full_notice_info[nid] = {
                    "ocr_text": text[:MAX_NOTICE_SNIPPET * 3],
                    "ocr_tables": info.get("ocr_tables"),
                    "filename": info.get("filename")
                }

        # 5) Attach full_notice_snippet to selected chunks (optional)
        for c in selected:
            nid = c.get("notice_id")
            if nid and nid in full_notice_info:
                c["full_notice_snippet"] = full_notice_info[nid]["ocr_text"][:MAX_NOTICE_SNIPPET]
                c["ocr_tables"] = full_notice_info[nid].get("ocr_tables")
                c["filename"] = c.get("filename") or full_notice_info[nid].get("filename")

        # 6) Build prompt (includes chunk + small snippets from full notices + table snippets)
        prompt = self._build_prompt(query, selected, full_notice_info)

        # 7) Call LLM with safe retry if context too long: try once, if context error occurs, reduce snippet sizes and retry.
        try:
            answer = self._call_llm(prompt)
            return answer.strip()
        except Exception as e:
            msg = str(e)
            if "context_length_exceeded" in msg or "reduce the length" in msg.lower():
                # aggressive fallback: reduce each full notice snippet to 500 chars and rebuild
                for nid in full_notice_info:
                    full_notice_info[nid]["ocr_text"] = (full_notice_info[nid]["ocr_text"][:500])
                prompt2 = self._build_prompt(query, selected, full_notice_info)
                try:
                    answer = self._call_llm(prompt2)
                    return answer.strip()
                except Exception as e2:
                    return f"[ERROR] LLM call failed after truncation: {e2}"
            return f"[ERROR] LLM call failed: {e}"

