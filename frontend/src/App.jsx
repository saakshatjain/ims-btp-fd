import React, { useState, useRef } from "react";


const API_URL = "http://127.0.0.1:8000/api/query";

export default function ChatFrontend() {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState([]); 
  const [loading, setLoading] = useState(false);
  const containerRef = useRef(null);

  function extractLinksFromRaw(raw) {
    if (!raw) return [];
    const links = [];

    // 1) Markdown-style links: [label](https://...)
    const mdRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
    let m;
    while ((m = mdRegex.exec(raw)) !== null) {
      try {
        const url = m[2];
        if (!links.includes(url)) links.push(url);
      } catch (e) {
        console.error("Error extracting markdown link:", e);
      }
    }

    // 2) Plain URLs (http/https)
    const urlRegex = /https?:\/\/[^\s)]+/gi;
    while ((m = urlRegex.exec(raw)) !== null) {
      const url = m[0];
      if (!links.includes(url)) links.push(url);
    }

    // 3) Fallback: words that start with http (very conservative)
    if (links.length === 0 && raw) {
      const words = raw.split(/\s+/);
      for (const w of words) {
        if (w.toLowerCase().startsWith("http")) {
          const clean = w.replace(/[",.;:]*$/, ""); // trim trailing punctuation
          if (!links.includes(clean)) links.push(clean);
        }
      }
    }

    return links;
  }

  function stripSourcesBlock(raw) {
    if (!raw) return "";
    // Cut off at the first occurrence of a line that begins with 'Sources:' (case-insensitive)
    const idx = raw.search(/\n\s*Sources\s*:/i);
    if (idx >= 0) {
      return raw.slice(0, idx).trim();
    }
    return raw.trim();
  }

  function stripFilenamesBeforeLinks(raw) {
    if (!raw) return raw;
    // Remove occurrences like `something.pdf, https://...` so filenames don't show before urls
    return raw.replace(/\b[\w\-\.]{3,}\.pdf\b\s*,?\s*(?=https?:\/\/)/gi, "");
  }

  function cleanLink(url) {
    try {
      const u = new URL(url);
      // keep only origin + pathname (strip query + fragment)
      return u.origin + u.pathname;
    } catch (e) {
      return url.split("?")[0];
    }
  }

  async function sendQuery(e) {
    e && e.preventDefault();
    if (!query.trim()) return;

    const userMsg = { id: Date.now() + "_u", role: "user", text: query.trim(), links: [] };
    setMessages((m) => [...m, userMsg]);
    setLoading(true);
    setQuery("");

    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: userMsg.text }),
      });

      if (!resp.ok) {
        const txt = await resp.text();
        console.error("Backend HTTP error", resp.status, txt);
        setMessages((m) => [
          ...m,
          { id: Date.now() + "_err", role: "bot", text: "An internal error occurred. Please try again later.", links: [] },
        ]);
        setLoading(false);
        scrollToBottom();
        return;
      }

      const contentType = resp.headers.get("content-type") || "";
      let rawAnswer = "";
      if (contentType.includes("application/json")) {
        const j = await resp.json();
        rawAnswer = j.answer || j.output || j.text || (typeof j === "string" ? j : JSON.stringify(j));
      } else {
        rawAnswer = await resp.text();
      }

      // If backend returned an error-like string starting with [ERROR], log it and show friendly message
      if (rawAnswer && rawAnswer.trim().startsWith("[ERROR]")) {
        console.error("Server error:", rawAnswer);
        setMessages((m) => [...m, { id: Date.now() + "_e", role: "bot", text: "An internal error occurred. Please try again later.", links: [] }]);
        setLoading(false);
        scrollToBottom();
        return;
      }

      // Remove any filenames preceding URLs
      rawAnswer = stripFilenamesBeforeLinks(rawAnswer);

      // visible text (without appended Sources block)
      const visible = stripSourcesBlock(rawAnswer);

      // extract raw links and clean them
      let links = extractLinksFromRaw(rawAnswer).map(cleanLink);
      // ensure uniqueness and preserve order
      links = Array.from(new Set(links));

      // Build bot message object with a sources toggle state
      setMessages((m) => [
        ...m,
        { id: Date.now() + "_b", role: "bot", text: visible || (links.length ? "" : "No content."), links, showSources: false },
      ]);
    } catch (err) {
      console.error("Fetch / parsing error:", err);
      setMessages((m) => [...m, { id: Date.now() + "_err2", role: "bot", text: "An internal error occurred. Please try again later.", links: [] }]);
    } finally {
      setLoading(false);
      scrollToBottom();
    }
  }

  function toggleSources(index) {
    setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, showSources: !m.showSources } : m)));
  }

  function scrollToBottom() {
    setTimeout(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    }, 50);
  }

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <header style={styles.header}>IMS CHATBOT</header>
        <div ref={containerRef} style={styles.chatArea}>
          {messages.map((m, idx) => (
            <div key={m.id} style={m.role === "user" ? styles.userBubble : styles.botBubble}>
              <div style={styles.messageText}>
                {/* Bot/user text */}
                {m.text && m.text.split("\n").map((line, i) => (
                  <p key={i} style={{ margin: "6px 0" }}>{line}</p>
                ))}

                {/* Sources pill + toggled link list */}
                {m.links && m.links.length > 0 && (
                  <div style={styles.sourcesBlock}>
                    <div style={styles.sourcesHeader}>
                      <span style={styles.sourcesPill}>Sources</span>
                      <button
                        onClick={() => toggleSources(idx)}
                        style={styles.sourcesToggle}
                        aria-label={`Toggle sources for message ${idx + 1}`}
                      >
                        {m.showSources ? "Hide" : `Show (${m.links.length})`}
                      </button>
                    </div>

                    {m.showSources && (
                      <div style={styles.linksContainer}>
                        {m.links.map((l, i) => (
                          <a key={i} href={l} target="_blank" rel="noopener noreferrer" style={styles.link}>
                            <div style={styles.linkLabel}>Notice {i + 1}</div>
                            <div style={styles.linkUrl}>{l}</div>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <form style={styles.form} onSubmit={sendQuery}>
          <input
            aria-label="Type your question"
            placeholder={loading ? "Thinking..." : "Type your question here..."}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={styles.input}
            disabled={loading}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                sendQuery(e);
              }
            }}
          />
          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? "..." : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  page: {
    display: "flex",
    justifyContent: "center",
    padding: 20,
    background: "#0b0b0c",
    minHeight: "100vh",
    boxSizing: "border-box",
  },
  container: {
    width: "75%",
    maxWidth: 980,
    background: "#0f1720",
    borderRadius: 12,
    boxShadow: "0 6px 30px rgba(0,0,0,0.6)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    color: "#fff",
    fontSize: 20,
    padding: "12px 18px",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    fontWeight: 600,
  },
  chatArea: {
    padding: 16,
    flex: 1,
    overflowY: "auto",
    maxHeight: "65vh",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  userBubble: {
    alignSelf: "flex-end",
    background: "#1f2937",
    color: "#fff",
    padding: "10px 14px",
    borderRadius: 12,
    maxWidth: "80%",
    wordBreak: "break-word",
    overflowWrap: "anywhere",
  },
  botBubble: {
    alignSelf: "flex-start",
    background: "#0b1220",
    color: "#e6eef8",
    padding: "10px 14px",
    borderRadius: 12,
    maxWidth: "80%",
    wordBreak: "break-word",
    overflowWrap: "anywhere",
  },
  messageText: {
    fontSize: 14,
    lineHeight: "1.4",
    maxHeight: "40vh",
    overflowY: "auto",
  },

  /* Sources UI */
  sourcesBlock: {
    marginTop: 10,
  },
  sourcesHeader: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    marginBottom: 8,
  },
  sourcesPill: {
    background: "rgba(11,132,255,0.14)",
    color: "#0b84ff",
    padding: "4px 8px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
  },
  sourcesToggle: {
    marginLeft: "auto",
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.06)",
    color: "#a8d1ff",
    padding: "6px 8px",
    borderRadius: 6,
    cursor: "pointer",
  },

  linksContainer: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  link: {
    display: "block",
    padding: "8px 10px",
    borderRadius: 6,
    background: "rgba(255,255,255,0.03)",
    color: "#9fd1ff",
    textDecoration: "none",
    maxWidth: "100%",
    overflow: "hidden",
  },
  linkLabel: {
    fontSize: 13,
    fontWeight: 700,
  },
  linkUrl: {
    fontSize: 12,
    color: "#cfeeff",
    opacity: 0.9,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },

  form: {
    display: "flex",
    gap: 8,
    padding: 12,
    borderTop: "1px solid rgba(255,255,255,0.04)",
    alignItems: "center",
  },
  input: {
    flex: 1,
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.06)",
    background: "#061122",
    color: "#fff",
    outline: "none",
    fontSize: 14,
  },
  button: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "none",
    background: "#0b84ff",
    color: "white",
    cursor: "pointer",
    fontWeight: 600,
  },
};
