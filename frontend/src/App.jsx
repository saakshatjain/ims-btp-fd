import { useState, useEffect, useRef } from "react";

function App() {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);

  const handleQuery = async () => {
    if (!query.trim()) return;

    const userMessage = { sender: "user", text: query };
    setMessages((prev) => [...prev, userMessage]);
    setLoading(true);

    try {
      const res = await fetch("http://127.0.0.1:8000/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      const data = await res.json();
      const botMessage = { sender: "bot", text: data.answer || "No answer received" };

      setMessages((prev) => [...prev, botMessage]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { sender: "bot", text: "Error: Could not reach backend" },
      ]);
    }

    setLoading(false);
    setQuery("");
  };

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  return (
    <div className="container">
      <h1 className="header">IMS CHATBOT</h1>

      <div className="chat-wrapper">
        <div className="chat-box">
          {messages.map((msg, idx) => {
            const isSource = msg.text.toLowerCase().includes("source:");

            return (
              <div
                key={idx}
                className={`message ${
                  msg.sender === "user" ? "user-msg" : "bot-msg"
                } ${isSource ? "source-msg" : ""}`}
              >
                {msg.text}
              </div>
            );
          })}

          {loading && <div className="bot-msg">Processing…</div>}
          <div ref={endRef}></div>
        </div>

        <div className="input-area">
          <input
            type="text"
            placeholder="Type your question..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={loading}
          />
          <button onClick={handleQuery} disabled={loading}>
            {loading ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
