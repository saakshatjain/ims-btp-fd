import streamlit as st
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import os

# Set page config
st.set_page_config(page_title="RAG Evaluation Dashboard", layout="wide")

st.title("📊 RAG Evaluation Dashboard")

# Load data
csv_path = os.path.join(os.path.dirname(__file__), "results.csv")

if not os.path.exists(csv_path):
    st.error(f"Results file not found at: {csv_path}")
    st.info("Please run `python backend/evaluation/evaluate.py` first to generate results.")
    st.stop()

df = pd.read_csv(csv_path)

# Metrics to visualize
metrics = ["faithfulness", "answer_relevancy", "context_precision", "context_recall"]
available_metrics = [m for m in metrics if m in df.columns]

if not available_metrics:
    st.error("No Ragas metrics found in the results file.")
    st.stop()

# --- Top Level Stats ---
st.header("📈 Overall Performance")
cols = st.columns(len(available_metrics))
for i, metric in enumerate(available_metrics):
    avg_score = df[metric].mean()
    cols[i].metric(label=metric.replace("_", " ").title(), value=f"{avg_score:.4f}")

# --- Charts ---
col1, col2 = st.columns(2)

with col1:
    st.subheader("Average Scores by Metric")
    avg_scores = df[available_metrics].mean().reset_index()
    avg_scores.columns = ["Metric", "Score"]
    fig_bar = px.bar(avg_scores, x="Metric", y="Score", color="Metric", range_y=[0, 1])
    st.plotly_chart(fig_bar, use_container_width=True)

with col2:
    st.subheader("Radar Chart (Holistic View)")
    fig_radar = go.Figure()
    fig_radar.add_trace(go.Scatterpolar(
        r=avg_scores["Score"],
        theta=avg_scores["Metric"],
        fill='toself',
        name='Average'
    ))
    fig_radar.update_layout(
        polar=dict(radialaxis=dict(visible=True, range=[0, 1])),
        showlegend=False
    )
    st.plotly_chart(fig_radar, use_container_width=True)

# --- Detailed Data ---
st.header("📝 Detailed Results")

# Filter option
min_score = st.slider("Filter by Minimum Score (Show rows where ANY metric is below this)", 0.0, 1.0, 0.5)

def filter_low_scores(row, threshold):
    return any(row[m] < threshold for m in available_metrics)

low_performing = df[df.apply(lambda x: filter_low_scores(x, min_score), axis=1)]

st.write(f"Showing {len(low_performing)} / {len(df)} rows")
st.dataframe(low_performing)

# Expandable details
with st.expander("🔍 Inspect Individual Query"):
    selected_query = st.selectbox("Select Query", df["question"].unique())
    row = df[df["question"] == selected_query].iloc[0]
    
    st.markdown(f"**Question:** {row['question']}")
    st.markdown(f"**Answer:** {row['answer']}")
    st.markdown(f"**Ground Truth:** {row['ground_truth']}")
    
    st.markdown("### Scores")
    score_cols = st.columns(len(available_metrics))
    for i, metric in enumerate(available_metrics):
        score_cols[i].metric(metric, f"{row[metric]:.4f}")
        
    st.markdown("### Retrieved Contexts")
    # Contexts are stored as string representation of list in CSV, need to parse if possible
    # Or just display raw for now
    st.text(row['contexts'])
