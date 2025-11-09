import { useState } from "react";

function App() {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");

  const handleQuery = async () => {
    try {
      const res = await fetch("http://127.0.0.1:8000/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      setAnswer(data.answer || "No answer received");
    } catch (err) {
      setAnswer("Error: Could not reach backend");
      console.error(err);
    }
  };

  return (
    <div style={{ padding: "40px", textAlign: "center" }}>
      <h2>ARSBTP RAG Connection Test</h2>
      <input
        type="text"
        placeholder="Ask something..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ width: "300px", padding: "8px" }}
      />
      <button onClick={handleQuery} style={{ marginLeft: "10px", padding: "8px 16px" }}>
        Send
      </button>

      <div style={{ marginTop: "20px", textAlign: "left", maxWidth: "600px", marginInline: "auto" }}>
        <h4>Response:</h4>
        <pre>{answer}</pre>
      </div>
    </div>
  );
}

export default App;
