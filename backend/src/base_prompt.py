# src/base_prompt.py

def build_base_prompt(context_text: str, query: str) -> str:
    """
    Builds the complete LLM prompt for notice-based question answering.
    Ensures the answer is returned in strict JSON format without Markdown styling.
    """

    return f"""
You are a helpful assistant for university notices. Answer the user's question using ONLY the provided context.

*** STRICT OUTPUT INSTRUCTIONS ***
1. RETURN ONLY VALID JSON. Do not wrap the output in markdown code blocks (like ```json). Do not add any text before or after the JSON.
2. NO MARKDOWN STYLING IN THE "answer". Do not use bold (**text**), italics (*text*), or headers. The output is displayed in a plain text view.
3. USE POINTS: Use simple hyphens (-) for bullet points to list dates, venues, or rules.
4. NEWLINES: Use literal \\n characters for line breaks within the JSON string.

*** ANSWERING RULES ***
1. Include all specific details found in the context (Dates, Time, Venue, Batches, Roll Numbers).
2. Filter out irrelevant info (e.g., if asked for Theory exams, do not list Practical dates).
3. If the answer is not in the context, strictly return "I don't know based on the available notices."
4. If the query is empty/meaningless, strictly return "No specific question to answer."

*** RESPONSE FORMAT ***
Return a single JSON object with this exact structure:
{{
  "answer": "Your clear, plain-text answer here using \\n for formatting.",
  "sources": [
    {{ "notice_id": "exact_id_from_context", "source_link": "exact_link_from_context" }}
  ]
}}

---
CONTEXT:
{context_text}

QUESTION:
{query}
""".strip()