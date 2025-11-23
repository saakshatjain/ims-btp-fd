import os
import sys
import pandas as pd
from datasets import Dataset
from ragas import evaluate
from ragas.metrics import (
    faithfulness,
    answer_relevancy,
    context_precision,
    context_recall,
)
from langchain_groq import ChatGroq
from langchain_community.embeddings import HuggingFaceEmbeddings

# Add parent directory to path to import src
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.search import RAGSearch

def run_evaluation():
    # 1. Initialize RAG pipeline
    rag = RAGSearch()
    
    # 2. Load test dataset from CSV
    csv_path = os.path.join(os.path.dirname(__file__), "data", "test_data.csv")
    if not os.path.exists(csv_path):
        print(f"Error: CSV file not found at {csv_path}")
        return

    print(f"Loading test data from {csv_path}...")
    df_input = pd.read_csv(csv_path)
    
    if "question" not in df_input.columns or "ground_truth" not in df_input.columns:
        print("Error: CSV must contain 'question' and 'ground_truth' columns.")
        return

    results = {
        "question": [],
        "answer": [],
        "contexts": [],
        "ground_truth": []
    }

    print("Running RAG pipeline on test questions...")
    for index, row in df_input.iterrows():
        query = row["question"]
        ground_truth = row["ground_truth"]
        print(f"Processing Q{index+1}: {query}")
        
        # 1. & 2. Retrieve and Generate
        try:
            result = rag.search_and_generate(query, top_k=3)
            answer = result.get("answer", "")
            sources = result.get("sources", [])
            contexts = [c.get("chunk_text", "") for c in sources]
        except Exception as e:
            print(f"Error processing query '{query}': {e}")
            answer = "Error generating answer"
            contexts = []

        results["question"].append(query)
        results["answer"].append(answer)
        results["contexts"].append(contexts)
        results["ground_truth"].append(ground_truth)

    # 3. Convert to HuggingFace Dataset
    dataset = Dataset.from_dict(results)

    # 4. Configure Ragas with Groq LLM
    from dotenv import load_dotenv
    load_dotenv()
    
    # Use separate key for evaluation if available, otherwise fallback to standard key
    ragas_api_key = os.getenv("RAGAS_GROQ_API_KEY")
    if not ragas_api_key:
        print("Error: No API key found. Please set RAGAS_GROQ_API_KEY or GROQ_API_KEY in .env")
        return

    eval_llm = ChatGroq(
        model_name="llama-3.3-70b-versatile", 
        temperature=0,
        groq_api_key=ragas_api_key
    )
    embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")

    # 5. Run Evaluation
    print("Running Ragas evaluation...")
    scores = evaluate(
        dataset=dataset,
        metrics=[
            faithfulness,
            answer_relevancy,
            context_precision,
            context_recall,
        ],
        llm=eval_llm,
        embeddings=embeddings
    )

    print("\nEvaluation Scores:")
    print(scores)
    
    # Save results
    output_path = os.path.join(os.path.dirname(__file__), "results.csv")
    df_scores = scores.to_pandas()
    df_scores.to_csv(output_path, index=False)
    print(f"Results saved to {output_path}")

if __name__ == "__main__":
    run_evaluation()
