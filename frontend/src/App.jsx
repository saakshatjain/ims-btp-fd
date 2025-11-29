import React, { useState, useRef, useEffect } from "react";

const API_URL = "http://127.0.0.1:8000/api/query";
const FEEDBACK_URL = "http://127.0.0.1:8000/api/feedback";

export default function ChatFrontend() {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef(null);
  const [copiedLink, setCopiedLink] = useState(null);

  /* ---------------------- FEEDBACK STATE ---------------------- */
  const [feedbackOpenFor, setFeedbackOpenFor] = useState(null);
  const [feedbackDraft, setFeedbackDraft] = useState({
    answer: null, // 1..5
    source: null, // 1..5
    satisfied: null, // boolean
  });
  const [feedbackLoading, setFeedbackLoading] = useState(false);

  /* ---------------------- Helpers ---------------------- */

  function extractLinksFromRaw(raw) {
    if (!raw) return [];
    const links = [];
    const mdRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
    let m;
    while ((m = mdRegex.exec(raw)) !== null) {
      try {
        const url = m[2];
        if (!links.includes(url)) links.push(url);
      } catch (e) { console.error(e); }
    }
    const urlRegex = /https?:\/\/[^\s)]+/gi;
    while ((m = urlRegex.exec(raw)) !== null) {
      if (!links.includes(m[0])) links.push(m[0]);
    }
    if (links.length === 0 && raw) {
      const words = raw.split(/\s+/);
      for (const w of words) {
        if (w.toLowerCase().startsWith("http")) {
          const clean = w.replace(/[",.;:]*$/, "");
          if (!links.includes(clean)) links.push(clean);
        }
      }
    }
    return links;
  }

  function cleanAndUniqueLinks(rawLinks) {
    if (!rawLinks?.length) return [];
    const unique = new Map();
    rawLinks.forEach((url) => {
      const base = url.split("?")[0];
      if (!unique.has(base)) unique.set(base, url);
    });
    return Array.from(unique.values());
  }

  function normalizeLink(raw) {
    if (!raw) return raw;
    let s = String(raw).trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
    if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);
    s = s.replace(/[\u2014\u2013]+$/, "").replace(/[),.?!;:]+$/g, "");
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = "https://" + s;
    try {
      const u = new URL(s);
      if (u.searchParams.has("download") && !u.searchParams.get("download")) {
        u.searchParams.set("download", "source.pdf");
      }
      if (u.pathname && /\/download\/?$/.test(u.pathname)) {
        if (!u.pathname.endsWith("/")) u.pathname += "/";
        u.pathname += "source.pdf";
      }
      return u.href;
    } catch (err) {
      return s.replace(/[",]+$/g, "");
    }
  }

  function shortenUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      const path = u.pathname === "/" ? "" : u.pathname;
      const truncatedPath = path.length > 20 ? path.slice(0, 15) + "..." : path;
      return `${host}${truncatedPath}`;
    } catch (e) {
      return url.length > 30 ? url.slice(0, 28) + "..." : url;
    }
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLink(text);
      setTimeout(() => setCopiedLink(null), 1400);
    } catch (e) { console.error(e); }
  }

  /* ---------------------- Feedback Helpers ---------------------- */

  function shouldShowFeedback(m) {
    if (!m || m.role !== "bot") return false;
    // Removed the "feedbackSubmitted" check here so we can show the "Submitted" badge
    const txt = (m.text || "").toLowerCase();
    if (txt.includes("internal error") || txt.includes("i don't know") || txt.includes("specific question to answer")) return false;
    return true;
  }

  function openFeedbackPopupFor(m) {
    setFeedbackOpenFor(m.id);
    setFeedbackDraft({ answer: null, source: null, satisfied: null });
  }

  async function submitFeedback(messageObj) {
    if (!messageObj) return;

    const ans = Number(feedbackDraft.answer);
    const src = Number(feedbackDraft.source);
    const sat = feedbackDraft.satisfied;

    if (!ans || ans < 1 || ans > 5) {
      alert("Please rate the Answer (1–5).");
      return;
    }
    if (!src || src < 1 || src > 5) {
      alert("Please rate the Sources (1–5).");
      return;
    }
    if (typeof sat !== "boolean") {
      alert("Please indicate if you are satisfied.");
      return;
    }

    const payload = {
      message_id: messageObj.id,
      prompt: (() => {
        const idx = messages.findIndex((x) => x.id === messageObj.id);
        if (idx > 0) {
          for (let i = idx - 1; i >= 0; i--) {
            if (messages[i].role === "user") return messages[i].text;
          }
        }
        return "";
      })(),
      response: messageObj.text,
      links: messageObj.links || [],
      answer_score: ans,
      source_score: src,
      satisfied: sat,
      comment: null,
    };

    setFeedbackLoading(true);
    try {
      const res = await fetch(FEEDBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageObj.id ? { ...m, feedbackSubmitted: true, feedback: payload } : m
        )
      );
      setFeedbackOpenFor(null);
    } catch (err) {
      console.error("Feedback failed", err);
      alert("Failed to submit feedback.");
    } finally {
      setFeedbackLoading(false);
    }
  }

  /* ---------------------- Networking ---------------------- */

  async function submit(text) {
    const trimmed = text?.trim();
    if (!trimmed) return;
    const userId = Date.now() + "_u";
    const userMsg = { id: userId, role: "user", text: trimmed, links: [], ts: new Date().toISOString() };
    
    setMessages((m) => [...m, userMsg]);
    setLoading(true);

    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });

      if (!resp.ok) throw new Error("Backend error");
      console.log(resp);
      
      let rawAnswer = "";
      let sourcesFromAPI = [];
      const contentType = resp.headers.get("content-type") || "";
      
      if (contentType.includes("application/json")) {
        const j = await resp.json();
        rawAnswer = j.answer || j.output || j.text || JSON.stringify(j);
        // Extract sources from API response
        sourcesFromAPI = j.sources || [];
      } else {
        rawAnswer = await resp.text();
      }

      if (rawAnswer && rawAnswer.trim().startsWith("[ERROR]")) throw new Error("Server Error");

      rawAnswer = stripFilenamesBeforeLinks(rawAnswer);
      const visible = stripSourcesBlock(rawAnswer);

      // Convert API sources to link format
      const normalized = [];
      if (sourcesFromAPI && sourcesFromAPI.length > 0) {
        const seen = new Set();
        sourcesFromAPI.forEach((src) => {
          const link = src.source_link || src.link || "";
          if (link && !seen.has(link)) {
            seen.add(link);
            normalized.push(link);
          }
        });
      } else {
        // Fallback: extract from answer text if no API sources
        const rawLinks = extractLinksFromRaw(rawAnswer);
        const cleanLinks = cleanAndUniqueLinks(rawLinks);
        const seen = new Set();
        for (const rl of cleanLinks) {
          const n = normalizeLink(rl);
          if (!seen.has(n)) {
            seen.add(n);
            normalized.push(n);
          }
        }
      }

      setMessages((m) => [
        ...m,
        {
          id: Date.now() + "_b",
          role: "bot",
          text: visible || (normalized.length ? "" : "No content."),
          links: normalized,
          showSources: false,
          ts: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      console.log(err);
      setMessages((m) => [
        ...m,
        {
          id: Date.now() + "_err",
          role: "bot",
          text: "An internal error occurred. Please try again later.",
          links: [],
          ts: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function sendQuery(e) {
    e && e.preventDefault();
    if (!query.trim()) return;
    const text = query;
    setQuery("");
    await submit(text);
  }

  function toggleSources(id) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, showSources: !m.showSources } : m)));
  }

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTo({ top: containerRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages, loading]);

  /* ---------------------- Render ---------------------- */

  return (
    <div style={styles.page}>
      <style>
        {`
          @keyframes slideIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes pulse {
            0% { opacity: 0.4; } 50% { opacity: 1; } 100% { opacity: 0.4; }
          }
        `}
      </style>

      <div style={styles.container}>
        <header style={styles.headerRow}>
          <div style={styles.header}>
            <span style={{color: "#3b82f6"}}>IMS</span> Chatbot
          </div>
          <button style={styles.clearBtn} onClick={() => setMessages([])}>
            Clear Chat
          </button>
        </header>

        <div ref={containerRef} style={styles.chatArea}>
          {messages.length === 0 && (
            <div style={styles.emptyState}>
              <h2 style={{color: "#e2e8f0", marginBottom: 8}}>How can I help you?</h2>
            </div>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                ...styles.messageWrapper,
                justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <div style={m.role === "user" ? styles.userBubble : styles.botBubble}>
                <div style={styles.messageTextInner}>
                  {m.text && m.text.split("\n").map((line, i) => (
                    <p key={i} style={{ margin: "4px 0", minHeight: line.trim() ? "auto" : 8 }}>{line}</p>
                  ))}
                </div>
                
                {/* Meta Row: Feedback Button + Timestamp */}
                <div style={styles.metaRow}>
                  {shouldShowFeedback(m) && (
                    <>
                      {m.feedbackSubmitted ? (
                        <span style={styles.feedbackSubmitted} title="Feedback submitted">
                          <span style={{fontSize: "14px", marginRight: "4px"}}>✓</span>
                          Submitted
                        </span>
                      ) : (
                        <button
                          style={styles.feedbackBtn}
                          onClick={() => openFeedbackPopupFor(m)}
                          title="Provide Feedback"
                        >
                          <span style={{fontSize: "14px", marginRight: "3px"}}>✎</span> Feedback
                        </button>
                      )}
                    </>
                  )}
                  
                  <span style={styles.ts}>
                    {m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                  </span>
                </div>

                {/* Sources Section */}
                {m.links && m.links.length > 0 && (
                  <div style={styles.sourcesBlock}>
                    <div style={styles.separator} />
                    <div
                      style={styles.sourcesHeaderCompact}
                      onClick={() => toggleSources(m.id)}
                    >
                      <span style={styles.sourcesLabel}>
                        Sources ({m.links.length})
                      </span>
                      <span style={{ transform: m.showSources ? "rotate(180deg)" : "rotate(0deg)", transition: "0.2s" }}>
                        ▼
                      </span>
                    </div>

                    {m.showSources && (
                      <div style={styles.linksGrid}>
                        {m.links.map((l, i) => (
                          <div key={i} style={styles.linkCard}>
                            <a href={l} target="_blank" rel="noopener noreferrer" style={styles.linkTitle} title={l}>
                              {shortenUrl(l)}
                            </a>
                            <button
                              style={styles.iconBtn}
                              onClick={() => copyToClipboard(l)}
                              title="Copy URL"
                            >
                              {copiedLink === l ? "✓" : "❐"}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div style={styles.messageWrapper}>
               <div style={{...styles.botBubble, padding: "12px 20px"}}>
                <div style={styles.typingIndicator}>
                  <div style={{...styles.dot, animationDelay: "0s"}} />
                  <div style={{...styles.dot, animationDelay: "0.2s"}} />
                  <div style={{...styles.dot, animationDelay: "0.4s"}} />
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={styles.inputArea}>
          <form style={styles.form} onSubmit={sendQuery}>
            <input
              placeholder={loading ? "Thinking..." : "Type your question..."}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={styles.input}
              disabled={loading}
            />
            <button type="submit" style={styles.sendButton} disabled={loading || !query.trim()}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13M22 2L15 22L11 13M11 13L2 9L22 2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </form>
        </div>
      </div>

      {/* FEEDBACK MODAL */}
      {feedbackOpenFor && (
        <div style={styles.modalBackdrop} onClick={() => setFeedbackOpenFor(null)}>
          <div style={styles.modal} onClick={(ev) => ev.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h3 style={styles.modalTitle}>Feedback</h3>
              <button style={styles.closeModalBtn} onClick={() => setFeedbackOpenFor(null)}>✕</button>
            </div>
            
            {/* Updated Text */}
            <p style={styles.modalSub}>Feedback is collected for research and analysis.</p>

            {/* Answer Rating */}
            <div style={styles.modalSection}>
              <div style={styles.modalLabelRow}>
                 <span style={styles.modalLabel}>Answer Quality</span>
                 <span style={styles.modalLabelNote}>(1 = Poor, 5 = Excellent)</span>
              </div>
              <div style={styles.ratingContainer}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    style={feedbackDraft.answer === n ? styles.ratingBtnActive : styles.ratingBtn}
                    onClick={() => setFeedbackDraft(p => ({ ...p, answer: n }))}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Source Rating */}
            <div style={styles.modalSection}>
              <div style={styles.modalLabelRow}>
                 <span style={styles.modalLabel}>Source Relevance</span>
                 <span style={styles.modalLabelNote}>(1 = Irrelevant, 5 = Relevant)</span>
              </div>
              <div style={styles.ratingContainer}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    style={feedbackDraft.source === n ? styles.ratingBtnActive : styles.ratingBtn}
                    onClick={() => setFeedbackDraft(p => ({ ...p, source: n }))}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Satisfied Toggle */}
            <div style={styles.modalSection}>
              <span style={styles.modalLabel}>Are you satisfied with this result?</span>
              <div style={styles.satisfiedRow}>
                <button
                  style={feedbackDraft.satisfied === true ? styles.satBtnActiveYes : styles.satBtn}
                  onClick={() => setFeedbackDraft(p => ({ ...p, satisfied: true }))}
                >
                  Yes
                </button>
                <button
                  style={feedbackDraft.satisfied === false ? styles.satBtnActiveNo : styles.satBtn}
                  onClick={() => setFeedbackDraft(p => ({ ...p, satisfied: false }))}
                >
                  No
                </button>
              </div>
            </div>

            {/* Action Buttons */}
            <div style={styles.modalActions}>
              <button
                style={styles.feedbackSubmit}
                onClick={() => submitFeedback(messages.find(x => x.id === feedbackOpenFor))}
                disabled={feedbackLoading}
              >
                {feedbackLoading ? "Sending..." : "Submit Feedback"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------- Helpers ---------------------- */

function stripSourcesBlock(raw) {
  if (!raw) return "";
  const idx = raw.search(/\n\s*Sources\s*:/i);
  return idx >= 0 ? raw.slice(0, idx).trim() : raw.trim();
}

function stripFilenamesBeforeLinks(raw) {
  if (!raw) return raw;
  return raw.replace(/(\b[\w\-\.]{3,}\.pdf\b)(?=\s*,\s*https?:\/\/)/gi, "");
}

/* ---------------------- Styles ---------------------- */

const styles = {
  page: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    height: "100vh",
    background: "linear-gradient(135deg, #0f172a 0%, #020617 100%)",
    fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    color: "#f1f5f9",
  },
  container: {
    width: "100%",
    maxWidth: "900px",
    height: "90vh",
    background: "#1e293b",
    borderRadius: "20px",
    boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.05)",
  },
  
  /* Header */
  headerRow: {
    padding: "20px 24px",
    background: "rgba(15, 23, 42, 0.6)",
    backdropFilter: "blur(10px)",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    zIndex: 10,
  },
  header: {
    fontSize: "18px",
    fontWeight: "700",
    letterSpacing: "-0.025em",
  },
  clearBtn: {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "#94a3b8",
    padding: "6px 12px",
    borderRadius: "6px",
    fontSize: "12px",
    cursor: "pointer",
    transition: "all 0.2s",
  },

  /* Chat Area */
  chatArea: {
    flex: 1,
    padding: "24px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "24px",
  },
  emptyState: {
    textAlign: "center",
    marginTop: "auto",
    marginBottom: "auto",
    opacity: 0.8,
  },
  messageWrapper: {
    display: "flex",
    gap: "8px",
    alignItems: "flex-end",
    animation: "slideIn 0.3s ease-out forwards",
  },
  
  /* Bubbles */
  userBubble: {
    background: "#3b82f6",
    color: "#fff",
    padding: "12px 18px",
    borderRadius: "18px 18px 2px 18px",
    maxWidth: "85%",
    boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
    lineHeight: "1.5",
    fontSize: "15px",
  },
  botBubble: {
    background: "#334155",
    color: "#f1f5f9",
    padding: "16px",
    borderRadius: "18px 18px 18px 2px",
    maxWidth: "85%",
    boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
    lineHeight: "1.5",
    fontSize: "15px",
  },
  messageTextInner: {
    wordBreak: "break-word",
  },
  metaRow: {
    display: "flex",
    justifyContent: "space-between", 
    alignItems: "center",
    marginTop: "8px",
    borderTop: "1px solid rgba(255,255,255,0.05)",
    paddingTop: "6px",
  },
  ts: {
    fontSize: "10px",
    opacity: 0.6,
    marginLeft: "auto", 
  },
  feedbackBtn: {
    background: "transparent",
    border: "none",
    color: "#94a3b8",
    fontSize: "11px",
    cursor: "pointer",
    padding: "2px 6px",
    borderRadius: "4px",
    display: "flex",
    alignItems: "center",
    transition: "color 0.2s, background 0.2s",
  },
  /* New style for submitted state */
  feedbackSubmitted: {
    color: "#10b981", // Green
    fontSize: "11px",
    display: "flex",
    alignItems: "center",
    padding: "2px 6px",
    cursor: "default",
  },

  /* Sources */
  sourcesBlock: {
    marginTop: "12px",
  },
  separator: {
    height: "1px",
    background: "rgba(255,255,255,0.1)",
    margin: "8px 0",
  },
  sourcesHeaderCompact: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    cursor: "pointer",
    padding: "4px 0",
    color: "#93c5fd",
    fontSize: "13px",
    fontWeight: "600",
    userSelect: "none",
  },
  linksGrid: {
    display: "grid",
    gap: "8px",
    marginTop: "8px",
  },
  linkCard: {
    background: "rgba(0,0,0,0.2)",
    padding: "8px 12px",
    borderRadius: "6px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: "12px",
  },
  linkTitle: {
    color: "#bae6fd",
    textDecoration: "none",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginRight: "10px",
  },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: "#94a3b8",
    cursor: "pointer",
    padding: "0",
    fontSize: "14px",
  },

  /* Loading Dots */
  typingIndicator: {
    display: "flex",
    gap: "6px",
  },
  dot: {
    width: "6px",
    height: "6px",
    background: "#fff",
    borderRadius: "50%",
    animation: "pulse 1.4s infinite ease-in-out both",
  },

  /* Input Area */
  inputArea: {
    padding: "20px",
    background: "rgba(15, 23, 42, 0.8)",
    borderTop: "1px solid rgba(255,255,255,0.05)",
  },
  form: {
    display: "flex",
    gap: "10px",
    position: "relative",
  },
  input: {
    width: "100%",
    padding: "14px 50px 14px 20px",
    borderRadius: "99px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "#0f172a",
    color: "white",
    fontSize: "15px",
    outline: "none",
    boxShadow: "inset 0 2px 4px rgba(0,0,0,0.3)",
  },
  sendButton: {
    position: "absolute",
    right: "6px",
    top: "6px",
    bottom: "6px",
    width: "40px",
    borderRadius: "50%",
    border: "none",
    background: "#3b82f6",
    color: "white",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background 0.2s",
  },

  /* Modal */
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.7)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  modal: {
    width: "100%",
    maxWidth: "420px",
    background: "#1e293b",
    borderRadius: "16px",
    padding: "28px",
    boxShadow: "0 25px 50px -12px rgba(0,0,0,0.5)",
    border: "1px solid rgba(255,255,255,0.1)",
    animation: "slideIn 0.2s ease-out",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "10px",
  },
  modalTitle: { margin: 0, fontSize: "20px", fontWeight: "700" },
  closeModalBtn: {
    background: "transparent",
    border: "none",
    color: "#94a3b8",
    fontSize: "20px",
    cursor: "pointer",
    padding: "4px",
  },
  modalSub: {
    fontSize: "14px",
    color: "#94a3b8",
    marginBottom: "24px",
    lineHeight: "1.5",
  },
  modalSection: { marginBottom: "24px" },
  
  modalLabelRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "12px",
  },
  modalLabel: {
    fontSize: "14px",
    fontWeight: "600",
    color: "#e2e8f0",
    display: "block",
  },
  modalLabelNote: {
    fontSize: "11px",
    color: "#64748b",
  },
  
  /* Rating Buttons (Circular) */
  ratingContainer: {
    display: "flex",
    justifyContent: "space-between",
    gap: "10px",
  },
  ratingBtn: {
    flex: 1,
    height: "42px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.03)",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: "600",
    transition: "all 0.2s",
  },
  ratingBtnActive: {
    flex: 1,
    height: "42px",
    borderRadius: "8px",
    border: "none",
    background: "#3b82f6",
    color: "white",
    fontWeight: "bold",
    cursor: "pointer",
    boxShadow: "0 0 15px rgba(59, 130, 246, 0.4)",
    transform: "scale(1.05)",
  },

  /* Satisfied Toggle */
  satisfiedRow: { display: "flex", gap: "12px", marginTop: "10px" },
  satBtn: {
    flex: 1,
    padding: "12px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.03)",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "14px",
    transition: "all 0.2s",
  },
  satBtnActiveYes: {
    flex: 1,
    padding: "12px",
    borderRadius: "8px",
    border: "none",
    background: "#10b981", // Green
    color: "white",
    fontWeight: "600",
    cursor: "pointer",
  },
  satBtnActiveNo: {
    flex: 1,
    padding: "12px",
    borderRadius: "8px",
    border: "none",
    background: "#ef4444", // Red
    color: "white",
    fontWeight: "600",
    cursor: "pointer",
  },

  /* Submit Action */
  modalActions: { marginTop: "12px" },
  feedbackSubmit: {
    width: "100%",
    padding: "14px",
    borderRadius: "8px",
    border: "none",
    background: "#3b82f6",
    color: "white",
    fontWeight: "600",
    cursor: "pointer",
    fontSize: "15px",
    transition: "background 0.2s",
  },
};